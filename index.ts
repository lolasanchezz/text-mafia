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

// Two texts sent in quick succession arrive as overlapping requests, and the
// second can read state the first has not written yet. One chain per chat keeps
// a chat's messages in order without blocking other chats.
const chains = new Map<string, Promise<void>>();

function enqueue(chatID: string, task: () => Promise<void>) {
  const next = (chains.get(chatID) ?? Promise.resolve())
    .then(task)
    .catch((err) => console.error('webhook handling failed:', err));
  chains.set(chatID, next);
  return next;
}

// Phones mangle typed text: iOS turns ' into ’, people add "!" or miss it,
// capitalisation varies. Compare on letters and digits only so "let's start",
// "Let’s start" and "lets start!" all land on the same command.
const normalize = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();

// The column has no default, so rows can carry a null status.
const inLobby = (status: string | null) => status == null || status === 'lobby';

// DRY_RUN=1 prints replies instead of texting them. Simulated chats are
// printed too: Linq rejects a chatId that is not a uuid (error 1005), so a
// made-up chat id can only ever mean a local test.
const DRY_RUN = process.env.DRY_RUN === '1';
const isChatID = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

async function reply(chatID: string, text: string) {
  if (DRY_RUN || !isChatID(chatID)) {
    console.log(`  reply -> ${text}`);
    return;
  }
  await linq.chats.messages.send(chatID, {
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

// Linq creates a 1:1 chat and sends the first message in one call, and offers
// no way to look one up later — so the id is kept on the user and reused.
// A simulated game gets a fake dm id, which reply() prints instead of sending.
async function dm(
  user: { id: number; number: number; dm_chat_id: string | null },
  text: string,
  simulated: boolean,
) {
  if (user.dm_chat_id) {
    await reply(user.dm_chat_id, text);
    return user.dm_chat_id;
  }

  let chatID: string;
  if (simulated) {
    chatID = `sim-dm-${user.number}`;
    await reply(chatID, text);
  } else {
    const created = await linq.chats.create({
      from: process.env.PHONE_NUMBER!,
      to: [`+${user.number}`],
      message: { parts: [{ type: 'text', value: text }] },
    });
    chatID = created.chat.id;
  }

  const { error } = await supabase
    .from('users')
    .update({ dm_chat_id: chatID })
    .eq('id', user.id);
  if (error) throw error;
  return chatID;
}

// users.current_game is the single source of truth for who is in a game;
// games.players is written once, at kickoff, from this.
async function playersIn(gameID: number) {
  const { data, error } = await supabase
    .from('users')
    .select('id')
    .eq('current_game', gameID);
  if (error) throw error;
  return (data ?? []).map((u) => u.id);
}

async function addToGame(gameID: number, userID: number) {
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
  const players = await playersIn(gameID);

  const { error: statusError } = await supabase
    .from('games')
    .update({ status: 'finished' })
    .eq('id', gameID);
  if (statusError) throw statusError;

  const { error: freeError } = await supabase
    .from('users')
    .update({ current_game: null })
    .in('id', players);
  if (freeError) throw freeError;
}

// Roughly one mafia per four players, then a doctor and a detective once the
// village is big enough to survive them.
function roleSpread(playerCount: number) {
  const mafia = Math.max(1, Math.floor(playerCount / 4));
  const doctor = playerCount >= 4 ? 1 : 0;
  const detective = playerCount >= 5 ? 1 : 0;
  const roles = [
    ...Array<string>(mafia).fill('mafia'),
    ...Array<string>(doctor).fill('doctor'),
    ...Array<string>(detective).fill('detective'),
  ];
  while (roles.length < playerCount) roles.push('villager');
  return roles.slice(0, playerCount);
}

function shuffle<T>(items: T[]) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const ROLE_BLURB: Record<string, string> = {
  mafia: "you're MAFIA. every night you pick someone to take out. don't get caught.",
  doctor: "you're the DOCTOR. every night you pick one person to save.",
  detective: "you're the DETECTIVE. every night you can investigate one person.",
  villager: "you're a VILLAGER. you have no night power — just your vote and your instincts.",
};

async function assignRoles(gameID: number, simulated: boolean) {
  const { data: players, error } = await supabase
    .from('users')
    .select('id, number, name, dm_chat_id')
    .eq('current_game', gameID);
  if (error) throw error;

  const shuffled = shuffle(players ?? []);
  const roles = roleSpread(shuffled.length);

  for (const [i, player] of shuffled.entries()) {
    const role = roles[i]!;
    const { error: roleError } = await supabase
      .from('users')
      .update({ role, alive: true })
      .eq('id', player.id);
    if (roleError) throw roleError;

    // Sequential: these are separate Linq sends, and roles are secret, so a
    // failure part-way should not be hidden behind a batch.
    await dm(player, ROLE_BLURB[role]!, simulated);
  }

  return shuffled.map((p, i) => ({ ...p, role: roles[i]! }));
}

const NIGHT_KINDS: Record<string, string> = {
  mafia: 'mafia_kill',
  doctor: 'doctor_save',
  detective: 'detective_check',
};

const NIGHT_PROMPTS: Record<string, string> = {
  mafia: 'who do you want to take out tonight?',
  doctor: 'who do you want to save tonight?',
  detective: 'who do you want to investigate tonight?',
};

const label = (p: { name: string | null; number: number }) => p.name ?? `+${p.number}`;

async function livingPlayers(gameID: number) {
  const { data, error } = await supabase
    .from('users')
    .select('id, number, name, role, alive, dm_chat_id')
    .eq('current_game', gameID)
    .eq('alive', true);
  if (error) throw error;
  return data ?? [];
}

async function startNight(gameID: number, chatID: string) {
  const simulated = !isChatID(chatID);

  const { data: game, error } = await supabase
    .from('games')
    .select('round')
    .eq('id', gameID)
    .single();
  if (error) throw error;

  const round = (game.round ?? 0) + 1;
  const { error: roundError } = await supabase
    .from('games')
    .update({ round, status: 'night' })
    .eq('id', gameID);
  if (roundError) throw roundError;

  const living = await livingPlayers(gameID);
  await reply(chatID, `night ${round}. everyone goes to sleep. still with us: ${living.map(label).join(', ')}`);

  for (const player of living) {
    const kind = NIGHT_KINDS[player.role ?? ''];
    if (!kind) continue;

    // Written with target null: the answer arrives later on its own webhook.
    const { error: askError } = await supabase
      .from('actions')
      .insert({ game_id: gameID, round, phase: 'night', actor: player.id, kind });
    if (askError) throw askError;

    // Mafia cannot pick themselves; the doctor is allowed to self-save.
    const choices = living.filter((o) => !(player.role === 'mafia' && o.id === player.id));
    await dm(
      player,
      `${NIGHT_PROMPTS[player.role!]} reply with a name — ${choices.map(label).join(', ')}`,
      simulated,
    );
  }
}

// A DM from a player is an answer to whatever we last asked them.
async function handleNightReply(userID: number, raw: string, chatID: string) {
  const { data: action, error } = await supabase
    .from('actions')
    .select('id, game_id, round, kind')
    .eq('actor', userID)
    .is('answered_at', null)
    .order('asked_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!action) return;

  const living = await livingPlayers(action.game_id);
  const guess = normalize(raw);
  const target = living.find((p) => p.name != null && normalize(p.name) === guess);
  if (!target) {
    await reply(chatID, `i don't know who that is — try one of: ${living.map(label).join(', ')}`);
    return;
  }

  const { error: answerError } = await supabase
    .from('actions')
    .update({ target: target.id, answered_at: new Date().toISOString() })
    .eq('id', action.id);
  if (answerError) throw answerError;

  if (action.kind === 'detective_check') {
    const verdict = target.role === 'mafia' ? 'IS mafia' : 'is not mafia';
    await reply(chatID, `${label(target)} ${verdict}.`);
  } else {
    await reply(chatID, `got it — ${label(target)}.`);
  }

  await resolveNightIfDone(action.game_id);
}

// Runs once the last outstanding night action comes in.
async function resolveNightIfDone(gameID: number) {
  const { data: game, error } = await supabase
    .from('games')
    .select('id, round, group_chat_id')
    .eq('id', gameID)
    .single();
  if (error) throw error;

  const { data: actions, error: actionsError } = await supabase
    .from('actions')
    .select('kind, target, answered_at')
    .eq('game_id', gameID)
    .eq('round', game.round);
  if (actionsError) throw actionsError;
  if ((actions ?? []).some((a) => a.answered_at == null)) return;

  const chatID = game.group_chat_id!;
  const killed = actions!.find((a) => a.kind === 'mafia_kill')?.target ?? null;
  const saved = actions!.find((a) => a.kind === 'doctor_save')?.target ?? null;

  let died: { id: number; name: string | null; number: number } | null = null;
  if (killed != null && killed !== saved) {
    const living = await livingPlayers(gameID);
    died = living.find((p) => p.id === killed) ?? null;
    const { error: killError } = await supabase
      .from('users')
      .update({ alive: false })
      .eq('id', killed);
    if (killError) throw killError;
  }

  await reply(
    chatID,
    died
      ? `morning. ${label(died)} didn't make it through the night.`
      : 'morning. somehow, everyone made it through the night.',
  );

  if (await checkWinner(gameID, chatID)) return;
  await startDay(gameID, chatID);
}

// Returns true when the game is over, so the caller knows not to start a phase.
async function checkWinner(gameID: number, chatID: string) {
  const living = await livingPlayers(gameID);
  const mafia = living.filter((p) => p.role === 'mafia');
  const rest = living.filter((p) => p.role !== 'mafia');

  if (mafia.length === 0) {
    await reply(chatID, 'the village wins — every mafia is gone!');
    await endGame(gameID);
    return true;
  }
  if (mafia.length >= rest.length) {
    await reply(chatID, `the mafia win. it was ${mafia.map(label).join(' and ')}.`);
    await endGame(gameID);
    return true;
  }
  return false;
}

async function startDay(gameID: number, chatID: string) {
  const { error } = await supabase.from('games').update({ status: 'day' }).eq('id', gameID);
  if (error) throw error;

  const living = await livingPlayers(gameID);
  await reply(chatID, `talk it out. ${living.length} left: ${living.map(label).join(', ')}`);
  await startVote(gameID, chatID, living);
}

// Opens the vote out. iMessage polls are checkboxes, so a
// voter can tick more than one name — handleVote treats whichever option they
// picked most recently as their vote, which is the closest approximation of
// single-choice the platform allows.
async function startVote(
  gameID: number,
  chatID: string,
  living: Array<{ id: number; name: string | null; number: number }>,
) {
  if (!isChatID(chatID)) {
    console.log(`  poll -> vote off: ${living.map(label).join(', ')}`);
    return;
  }

  await reply(chatID, 'time to vote!! tap a name in the poll to vote them out.');

  const pollEnvelope = await linq.chats.polls.create(chatID, {
    poll: { options: living.map((p) => ({ text: label(p) })) },
  });

  // Options come back in the order they were requested, but matching on text
  // instead of position is one less assumption to rely on.
  const optionMap: Record<string, number> = {};
  for (const option of pollEnvelope.poll.options) {
    const match = living.find((p) => label(p) === option.text);
    if (match) optionMap[option.option_id] = match.id;
  }

  const { error } = await supabase
    .from('vote_polls')
    .insert({ message_id: pollEnvelope.message_id, game_id: gameID, option_map: optionMap });
  if (error) throw error;
}

// A vote poll only ever lives in the group chat, and every option maps to a
// player id recorded when the poll was created.
async function handleVote(messageID: string, optionID: string, voterHandle: string, added: boolean) {
  const { data: pollRow, error } = await supabase
    .from('vote_polls')
    .select('game_id, option_map')
    .eq('message_id', messageID)
    .maybeSingle();
  if (error) throw error;
  if (!pollRow) return;

  const targetID = (pollRow.option_map as Record<string, number>)[optionID];
  if (targetID == null) return;

  const { data: voter } = await supabase
    .from('users')
    .select('id')
    .eq('number', toNumber(voterHandle))
    .maybeSingle();
  if (!voter) return;

  const { data: game, error: gameError } = await supabase
    .from('games')
    .select('round, group_chat_id')
    .eq('id', pollRow.game_id)
    .single();
  if (gameError) throw gameError;

  if (added) {
    // At most one recorded vote per voter per round: ticking a second name
    // overwrites the first rather than adding a second ballot.
    const { data: existing } = await supabase
      .from('actions')
      .select('id')
      .eq('game_id', pollRow.game_id)
      .eq('round', game.round)
      .eq('kind', 'vote')
      .eq('actor', voter.id)
      .maybeSingle();

    if (existing) {
      const { error: updateError } = await supabase
        .from('actions')
        .update({ target: targetID, answered_at: new Date().toISOString() })
        .eq('id', existing.id);
      if (updateError) throw updateError;
    } else {
      const { error: insertError } = await supabase.from('actions').insert({
        game_id: pollRow.game_id,
        round: game.round,
        phase: 'day',
        actor: voter.id,
        kind: 'vote',
        target: targetID,
        answered_at: new Date().toISOString(),
      });
      if (insertError) throw insertError;
    }
  } else {
    // Only clears the recorded vote if this was their current pick — if they
    // had already switched to a different name, that stays recorded.
    const { error: deleteError } = await supabase
      .from('actions')
      .delete()
      .eq('game_id', pollRow.game_id)
      .eq('round', game.round)
      .eq('kind', 'vote')
      .eq('actor', voter.id)
      .eq('target', targetID);
    if (deleteError) throw deleteError;
  }

  await resolveVoteIfDone(pollRow.game_id, game.round, game.group_chat_id!);
}

// Runs once every living player has cast a vote.
async function resolveVoteIfDone(gameID: number, round: number, chatID: string) {
  const living = await livingPlayers(gameID);

  const { data: votes, error } = await supabase
    .from('actions')
    .select('target')
    .eq('game_id', gameID)
    .eq('round', round)
    .eq('kind', 'vote')
    .not('target', 'is', null);
  if (error) throw error;

  const { data: voters, error: votersError } = await supabase
    .from('actions')
    .select('actor')
    .eq('game_id', gameID)
    .eq('round', round)
    .eq('kind', 'vote');
  if (votersError) throw votersError;

  const votedActorIds = new Set((voters ?? []).map((v) => v.actor));
  if (!living.every((p) => votedActorIds.has(p.id))) return;

  const tally = new Map<number, number>();
  for (const v of votes ?? []) {
    tally.set(v.target!, (tally.get(v.target!) ?? 0) + 1);
  }

  let winner: number | null = null;
  let max = 0;
  let tie = false;
  for (const [target, count] of tally) {
    if (count > max) {
      max = count;
      winner = target;
      tie = false;
    } else if (count === max) {
      tie = true;
    }
  }

  if (winner == null || tie) {
    await reply(chatID, "no majority nobody's voted out this round :().");
  } else {
    const eliminated = living.find((p) => p.id === winner)!;
    const { error: killError } = await supabase.from('users').update({ alive: false }).eq('id', winner);
    if (killError) throw killError;
    await reply(
      chatID,
      `${label(eliminated)} has been voted out. they were ${(eliminated.role ?? 'unknown').toUpperCase()}.`,
    );
  }

  if (await checkWinner(gameID, chatID)) return;
  await startNight(gameID, chatID);
}

// Placeholder for the actual mafia game — role assignment, night/day loop, etc.
// When it reaches a win condition it should call endGame(game.id).
async function runGame(game: { id: number; players: number[]; chatID: string }) {
  const simulated = !isChatID(game.chatID);
  const dealt = await assignRoles(game.id, simulated);
  console.log(
    `game ${game.id}: ` + dealt.map((p) => `${p.name ?? p.number}=${p.role}`).join(', '),
  );
  await startNight(game.id, game.chatID);
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

  const players = await playersIn(game.id);

  const { error: statusError } = await supabase
    .from('games')
    .update({ status: 'started', players })
    .eq('id', game.id);
  if (statusError) throw statusError;
  await reply(chatID, `game on — ${players.length} playing. no more joining or name changes!`);
  await runGame({ id: game.id, players, chatID });
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

  const eventType = req.body.event_type;
  const event = req.body.data;
  // Without this the bot reacts to the messages it sends itself.
  if (event?.direction !== 'inbound') return;

  // Vote poll events have a completely different shape (no parts) — handle
  // them before assuming this is a text message below.
  if (eventType === 'poll.vote.added' || eventType === 'poll.vote.removed') {
    enqueue(event.chat.id, () =>
      handleVote(event.message_id, event.option_id, event.sender_handle.handle, eventType === 'poll.vote.added'),
    );
    return;
  }

  const part = event.parts?.[0];
  if (part?.type !== 'text') return;

  const chatID = event.chat.id;
  const handle = event.sender_handle.handle;
  const text = normalize(part.value);
  console.log(`inbound in ${chatID} from ${handle}: ${JSON.stringify(part.value)} -> ${JSON.stringify(text)}`);

  // Everything touching one game must share a chain: the group chat and every
  // player's DM alike. Keying off the sender instead would put someone who has
  // not joined yet on a different chain from the chat they are joining.
  const { data: sender } = await supabase
    .from('users')
    .select('id, current_game, dm_chat_id')
    .eq('number', toNumber(handle))
    .maybeSingle();

  // The key must not change as a game comes and goes, or messages sent either
  // side of its creation land on different chains and race. A game belongs to
  // exactly one group chat, so that id is stable for the whole game: group
  // messages key on themselves, and a DM keys on its game's group chat.
  let key = chatID;
  if (sender && sender.dm_chat_id === chatID && sender.current_game != null) {
    const { data: game } = await supabase
      .from('games')
      .select('group_chat_id')
      .eq('id', sender.current_game)
      .maybeSingle();
    key = game?.group_chat_id ?? chatID;
  }

  enqueue(key, async () => {
    if (sender && sender.dm_chat_id === chatID) {
      await handleNightReply(sender.id, part.value, chatID);
      return;
    }
    if (text === normalize(START_MESSAGE)) await startGame(chatID, handle);
    else if (text === normalize(JOIN_MESSAGE)) await joinGame(chatID, handle);
    else if (text === normalize(BEGIN_MESSAGE)) await beginGame(chatID, handle);
    else await recordName(chatID, handle, part.value);
  });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
