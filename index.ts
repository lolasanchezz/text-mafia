import express from 'express';
import { createClient } from '@supabase/supabase-js';
import LinqAPIV3 from '@linqapp/sdk';
import { loadEnvFile } from 'node:process';

loadEnvFile();

const app = express();
const port = 3000;

// The service role key bypasses Row Level Security, so this client can read
// and write every table. Server-side only — it must never reach a browser.
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_API_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const linq = new LinqAPIV3({ apiKey: process.env.LINQ_API_V3_API_KEY });

const START_MESSAGE = 'i wanna play mafia';
const JOIN_MESSAGE = 'i wanna play!';
const BEGIN_MESSAGE = "let's start";

// Phones mangle typed text: iOS turns ' into ’, people add "!" or miss it,
// capitalisation varies. Compare on letters and digits only so "let's start",
// "Let’s start" and "lets start!" all land on the same command.
const normalize = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();

// The column has no default, so rows can carry a null status.
const inLobby = (status: string | null) => status == null || status === 'lobby';

function reply(chatID: string, text: string) {
  return linq.chats.messages.send(chatID, {
    message: { parts: [{ type: 'text', value: text }] },
  });
}

// users.number is a bigint, so store the digits: "+1 (646) 468-4274" -> 16464684274
function toNumber(handle: string) {
  return Number(handle.replace(/\D/g, ''));
}

// users.number has no unique constraint, so this is select-then-insert
// rather than an upsert.
async function ensureUser(number: number) {
  const { data: existing, error } = await supabase
    .from('users')
    .select('id, name, current_game')
    .eq('number', number)
    .maybeSingle();
  if (error) throw error;
  if (existing) return existing;

  const { data, error: insertError } = await supabase
    .from('users')
    .insert({ number })
    .select('id, name, current_game')
    .single();
  if (insertError) throw insertError;
  return data;
}

async function findGameInChat(chatID: string) {
  const { data, error } = await supabase
    .from('games')
    .select('id, status, creator, players')
    .eq('group_chat_id', chatID)
    .or('status.is.null,status.neq.finished')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function addToGame(gameID: number, userID: number) {
  const { data: game, error } = await supabase
    .from('games')
    .select('players')
    .eq('id', gameID)
    .single();
  if (error) throw error;

  const players: number[] = game.players ?? [];
  if (!players.includes(userID)) {
    const { error: playersError } = await supabase
      .from('games')
      .update({ players: [...players, userID] })
      .eq('id', gameID);
    if (playersError) throw playersError;
  }

  const { error: joinError } = await supabase
    .from('users')
    .update({ current_game: gameID })
    .eq('id', userID);
  if (joinError) throw joinError;
}

async function startGame(chatID: string, senderHandle: string) {
  const creator = await ensureUser(toNumber(senderHandle));

  // One game per chat, whoever asks for it.
  const running = await findGameInChat(chatID);
  if (running != null) {
    await reply(
      chatID,
      creator.current_game === running.id
        ? "no, you're already in the game!"
        : `there's already a game going in here — text "${JOIN_MESSAGE}" to join it`,
    );
    return;
  }

  if (creator.current_game != null) {
    await reply(chatID, "no, you're already in the game!");
    return;
  }

  const { data: game, error } = await supabase
    .from('games')
    .insert({ creator: creator.id, players: [], group_chat_id: chatID, status: 'lobby' })
    .select('id')
    .single();
  if (error) throw error;

  await addToGame(game.id, creator.id);
  await reply(chatID, `new game started! anyone who wants in, text "${JOIN_MESSAGE}"`);

  // The creator never goes through joinGame, so ask them separately.
  if (creator.name == null) {
    await reply(chatID, `btw, ${senderHandle}, what's your name?`);
  }
}

async function joinGame(chatID: string, senderHandle: string) {
  const user = await ensureUser(toNumber(senderHandle));

  if (user.current_game != null) {
    await reply(chatID, "no, you're already in the game!");
    return;
  }

  const game = await findGameInChat(chatID);
  if (game == null) {
    await reply(chatID, `no game going yet — text "${START_MESSAGE}" to start one`);
    return;
  }
  if (!inLobby(game.status)) {
    await reply(chatID, "too late, that game's already under way!");
    return;
  }

  await addToGame(game.id, user.id);
  await reply(chatID, user.name ? `you're in, ${user.name}!` : "you're in! what's your name?");
}

// Marks the game over and frees its players to start or join another one.
// Call this when the game logic reaches a win condition.
async function endGame(gameID: number) {
  const { data: game, error } = await supabase
    .from('games')
    .select('players')
    .eq('id', gameID)
    .single();
  if (error) throw error;

  const { error: statusError } = await supabase
    .from('games')
    .update({ status: 'finished' })
    .eq('id', gameID);
  if (statusError) throw statusError;

  const { error: freeError } = await supabase
    .from('users')
    .update({ current_game: null })
    .in('id', game.players ?? []);
  if (freeError) throw freeError;
}

// Placeholder for the actual mafia game — role assignment, night/day loop, etc.
// When it reaches a win condition it should call endGame(game.id).
async function runGame(game: { id: number; players: number[] }) {
  console.log(`game ${game.id} started with ${game.players.length} players`);
}

async function beginGame(chatID: string, senderHandle: string) {
  console.log("called")
  const game = await findGameInChat(chatID);
  if (game == null) {
    await reply(chatID, `no game going yet — text "${START_MESSAGE}" to start one`);
    return;
  }
  if (!inLobby(game.status)) {
    await reply(chatID, "the game's already going!");
    return;
  }

  // Look up rather than ensureUser: someone outside the game should not get a
  // record just for saying this.
  const { data: user, error } = await supabase
    .from('users')
    .select('id')
    .eq('number', toNumber(senderHandle))
    .maybeSingle();
  if (error) throw error;
  if (!user || user.id !== game.creator) {
    await reply(chatID, 'only whoever started the game can kick it off!');
    return;
  }

  const { error: statusError } = await supabase
    .from('games')
    .update({ status: 'started' })
    .eq('id', game.id);
  if (statusError) throw statusError;

  const players: number[] = game.players ?? [];
  await reply(chatID, `game on — ${players.length} playing. no more joining or name changes!`);
  await runGame({ id: game.id, players });
}

// Any message from a player who has no name yet is taken as their name.
async function recordName(chatID: string, senderHandle: string, text: string) {
  const { data: user, error } = await supabase
    .from('users')
    .select('id, name, current_game')
    .eq('number', toNumber(senderHandle))
    .maybeSingle();
  if (error) throw error;
  if (!user || user.current_game == null || user.name != null) return;

  // Once the game is under way, messages are no longer names.
  const game = await findGameInChat(chatID);
  if (game == null || !inLobby(game.status)) return;

  const name = text.trim();
  const { error: nameError } = await supabase
    .from('users')
    .update({ name })
    .eq('id', user.id);
  if (nameError) throw nameError;

  await reply(chatID, `got it, ${name}!`);
}

app.use(express.json());

app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.get('/table/:name', async (req, res) => {
  const { data, error } = await supabase.from(req.params.name).select('*');
  if (error) res.status(400).json(error);
  else res.json(data);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const event = req.body.data;
  // Without this the bot reacts to the messages it sends itself.
  if (event?.direction !== 'inbound') return;

  const part = event.parts?.[0];
  if (part?.type !== 'text') return;

  const chatID = event.chat.id;
  const handle = event.sender_handle.handle;
  const text = normalize(part.value);
  console.log(`inbound from ${handle}: ${JSON.stringify(part.value)} -> ${JSON.stringify(text)}`);

  try {
    if (text === normalize(START_MESSAGE)) await startGame(chatID, handle);
    else if (text === normalize(JOIN_MESSAGE)) await joinGame(chatID, handle);
    else if (text === normalize(BEGIN_MESSAGE)) await beginGame(chatID, handle);
    else await recordName(chatID, handle, part.value);
  } catch (err) {
    console.error('webhook handling failed:', err);
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
