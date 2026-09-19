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
    .select('id')
    .eq('group_chat_id', chatID)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
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
      creator.current_game === running
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
    .insert({ creator: creator.id, players: [], group_chat_id: chatID })
    .select('id')
    .single();
  if (error) throw error;

  await addToGame(game.id, creator.id);
  await reply(chatID, `new game started! anyone who wants in, text "${JOIN_MESSAGE}"`);
}

async function joinGame(chatID: string, senderHandle: string) {
  const user = await ensureUser(toNumber(senderHandle));

  if (user.current_game != null) {
    await reply(chatID, "no, you're already in the game!");
    return;
  }

  const gameID = await findGameInChat(chatID);
  if (gameID == null) {
    await reply(chatID, `no game going yet — text "${START_MESSAGE}" to start one`);
    return;
  }

  await addToGame(gameID, user.id);
  await reply(chatID, user.name ? `you're in, ${user.name}!` : "you're in! what's your name?");
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
  const text = part.value.trim().toLowerCase();

  try {
    if (text === START_MESSAGE) await startGame(chatID, handle);
    else if (text === JOIN_MESSAGE) await joinGame(chatID, handle);
    else await recordName(chatID, handle, part.value);
  } catch (err) {
    console.error('webhook handling failed:', err);
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
