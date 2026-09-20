import express from 'express';
import { createClient } from '@supabase/supabase-js';
import LinqAPIV3 from '@linqapp/sdk';
import Anthropic from '@anthropic-ai/sdk';
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

// Narration and reply-parsing are both best-effort: no key, a timeout, or an
// API error should never stall the game — every call site falls back to a
// plain deterministic string.
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

const NARRATOR_SYSTEM =
  'You are the narrator for a text-message game of Mafia. Write one or two ' +
  'short, punchy sentences of flavor for the moment described. No emoji, no ' +
  'markdown, plain text only — this is sent as a real text message. Keep it ' +
  'tasteful and non-graphic: no ropes, hangings, knives. A player being ' +
  'removed from the game is BANISHED or EXILED from the village, never ' +
  'killed — describe it that way even when the prompt says "eliminated" or ' +
  '"killed". Be specific and unusual rather than generic: give each moment a ' +
  'concrete, small, memorable detail (something they were carrying, a habit, ' +
  'a rumor about them) instead of a stock phrase — no two deaths or reveals ' +
  'should read alike. If earlier messages in this conversation described this ' +
  'game, this is the same ongoing story: keep the tone and world consistent, ' +
  'and callback to a specific earlier detail or character when it fits ' +
  'naturally, rather than restarting the scene from nothing each time.';

type NarrationTurn = { role: 'user' | 'assistant'; content: string };

// Flavor text for a moment in the game. Never used for anything a player
// needs to act on precisely — those stay plain text. Pass gameID to thread
// this into the game's ongoing public story (dawn/vote/win beats only — never
// pass gameID for anything containing secret info, like a role or a night
// target, since that history is reused for later PUBLIC group messages).
async function narrate(prompt: string, fallback: string, gameID?: number): Promise<string> {
  if (!anthropic) return fallback;
  try {
    let history: NarrationTurn[] = [];
    if (gameID != null) {
      const { data } = await supabase.from('games').select('narration').eq('id', gameID).maybeSingle();
      history = (data?.narration as NarrationTurn[] | null) ?? [];
    }

    const messages: NarrationTurn[] = [...history, { role: 'user', content: prompt }];
    const message = await withTimeout(
      anthropic.messages.create({
        model: 'claude-opus-5',
        max_tokens: 1024,
        output_config: { effort: 'low' }, // short, latency-sensitive — depth isn't needed here
        system: NARRATOR_SYSTEM,
        messages,
      }),
      8000,
    );
    const text = message.content.find((b) => b.type === 'text')?.text?.trim();
    if (!text) return fallback;

    if (gameID != null) {
      // Capped so the transcript sent on every call stays small and cheap —
      // recent beats matter far more than the opening of a long game.
      const updated = [...messages, { role: 'assistant', content: text }].slice(-40);
      await supabase.from('games').update({ narration: updated }).eq('id', gameID);
    }

    return text;
  } catch (err) {
    console.warn('narrate() failed, using fallback:', err);
    return fallback;
  }
}

// Turns a casual reply ("kill sam i guess", "who's still alive?") into one of
// the valid choices, or null if it isn't a clear pick — a question, a joke, or
// genuinely unclear. Exact matches never reach this; it's only the fallback.
async function interpretReply(raw: string, choices: string[]): Promise<string | null> {
  if (!anthropic) return null;
  try {
    const message = await withTimeout(
      anthropic.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 20,
        system:
          'A player in a Mafia game was asked to name one of these people: ' +
          `${choices.join(', ')}. Reply with exactly one name from that list if their ` +
          'message clearly picks someone, matching case exactly as given. If their ' +
          "message is a question, a joke, or doesn't clearly pick anyone from the list, " +
          'reply with exactly: NONE. No other text.',
        messages: [{ role: 'user', content: raw }],
      }),
      4000,
    );
    const text = message.content.find((b) => b.type === 'text')?.text?.trim();
    if (!text || text === 'NONE') return null;
    return choices.find((c) => c === text) ?? null;
  } catch (err) {
    console.warn('interpretReply() failed:', err);
    return null;
  }
}

const START_MESSAGE = 'i wanna play mafia';
const JOIN_MESSAGE = 'i wanna play!';
const BEGIN_MESSAGE = "let's start";
const CANCEL_MESSAGE = 'end this game';

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

// TEST_PHONE is the whole testing story: every player's private message goes
// to this one number instead of to them, tagged with who it was meant for. No
// chat is ever opened for a stand-in, so Linq never 403s a made-up number.
//
// A game's group messages follow its chat: a real chat id means the real group
// thread, anything else means there is no real group, so those go to
// TEST_PHONE too, tagged [→ group].
//
// Reply as any of them with "Name: message" from that same thread.
let TEST_PHONE = process.env.TEST_PHONE;

// The thread we send test traffic to, opened once and reused.
let testThreadID = process.env.TEST_CHAT_ID ?? null;

async function sendToTestPhone(text: string, intendedFor: string) {
  const tagged = `[→ ${intendedFor}] ${text}`;

  if (testThreadID) {
    await linq.chats.messages.send(testThreadID, {
      message: { parts: [{ type: 'text', value: tagged }] },
    });
    return;
  }

  const created = await linq.chats.create({
    from: process.env.PHONE_NUMBER!,
    to: [TEST_PHONE!],
    message: { parts: [{ type: 'text', value: tagged }] },
  });
  testThreadID = created.chat.id;
  console.log(`test thread with ${TEST_PHONE}: ${testThreadID}`);
  console.log(`  (export TEST_CHAT_ID=${testThreadID} to reuse it across restarts)`);
}

async function reply(
  chatID: string,
  text: string,
  intendedFor = 'group',
  effect?: { type: 'screen' | 'bubble'; name: string },
) {
  // DRY_RUN always wins, so the wiring can be checked without texting anyone.
  if (DRY_RUN) {
    console.log(`  [→ ${intendedFor}] ${text}`);
    return;
  }
  // A real chat id is always used as-is: a real group chat stays real.
  if (isChatID(chatID)) {
    await linq.chats.messages.send(chatID, {
      message: { parts: [{ type: 'text', value: text }], effect },
    });
    return;
  }
  if (TEST_PHONE) {
    await sendToTestPhone(text, intendedFor);
    return;
  }
  console.log(`  reply -> ${text}`);
}

// users.number is a bigint, so store the digits: "+1 (646) 468-4274" -> 16464684274
function toNumber(handle: string) {
  return Number(handle.replace(/\D/g, ''));
}

// users.number has no unique constraint, so this is select-then-insert
// rather than an upsert.
async function ensureUser(number: number) {
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`refusing to create a player for a handle with no number (${number})`);
  }

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
  user: { id: number; number: number; name?: string | null; dm_chat_id: string | null },
  text: string,
  effect?: { type: 'screen' | 'bubble'; name: string },
) {
  const who = user.name ?? `+${user.number}`;

  // Nobody is really messaged in test mode, so no chat is opened and Linq
  // never sees a made-up number. The stored id is a marker, and is what routes
  // an impersonated reply back to the right player.
  if (TEST_PHONE) {
    await sendToTestPhone(text, who);
    const marker = `test:${user.number}`;
    if (user.dm_chat_id !== marker) {
      const { error } = await supabase
        .from('users')
        .update({ dm_chat_id: marker })
        .eq('id', user.id);
      if (error) throw error;
    }
    return marker;
  }

  if (user.dm_chat_id && isChatID(user.dm_chat_id)) {
    try {
      await reply(user.dm_chat_id, text, who, effect);
      return user.dm_chat_id;
    } catch (err) {
      // A stored chat can stop existing — a deleted thread, or one opened from
      // a different sending number. Anything but "gone" is a real failure.
      if ((err as { status?: number })?.status !== 404) throw err;
      console.warn(`dm chat ${user.dm_chat_id} is gone for ${user.number}; opening a new one`);
    }
  }

  try {
    const created = await linq.chats.create({
      from: process.env.PHONE_NUMBER!,
      to: [`+${user.number}`],
      message: { parts: [{ type: 'text', value: text }], effect },
    });
    const { error } = await supabase
      .from('users')
      .update({ dm_chat_id: created.chat.id })
      .eq('id', user.id);
    if (error) throw error;
    return created.chat.id;
  } catch (err) {
    // 403 means Linq will not message them — a made-up number with no
    // TEST_PHONE set to catch it. Carry on dealing rather than abort.
    if ((err as { status?: number })?.status !== 403) throw err;
    console.warn(`cannot message +${user.number} (403) — set TEST_PHONE to catch stand-in players`);
    return null;
  }
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

async function assignRoles(gameID: number) {
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
    // failure part-way should not be hidden behind a batch. No gameID here —
    // this is private and per-player, never shared with the group's story.
    const roleFlavor = await narrate(
      `Privately tell ${label(player)} their secret role in this Mafia game: ` +
        `${role.toUpperCase()}. Their power: "${ROLE_BLURB[role]}" Write this as a short, ` +
        "personal, atmospheric reveal that feels specifically written for them, not a " +
        'generic rules blurb — but keep what they can actually do each night unambiguous.',
      ROLE_BLURB[role]!,
    );
    await dm(player, roleFlavor, { type: 'bubble', name: 'invisible' });
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

  // Prompts go out before the group is told, so that by the time anyone reads
  // "check your messages" the message is already sitting there. Announcing
  // first left the chat silent while these were still being sent.
  const asked: typeof living = [];
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
    );
    asked.push(player);
  }

  await reply(
    chatID,
    `night ${round}. everyone goes to sleep. still with us: ${living.map(label).join(', ')}. ` +
      `${asked.length} of you have something to do tonight — check your messages from me and reply there. ` +
      `you've got ${humanTimeout()}, then i move on without you.`,
  );
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
  // Who this DM is with — only used to tag messages in redirect mode.
  const self = living.find((p) => p.id === userID);
  const who = self ? label(self) : `player ${userID}`;

  const named = living.filter((p): p is typeof p & { name: string } => p.name != null);
  const guess = normalize(raw);
  let target = named.find((p) => normalize(p.name) === guess);

  // Not an exact match — let Claude take a shot at casual phrasing ("kill sam
  // i guess") before giving up. A question or joke correctly resolves to null.
  if (!target) {
    const picked = await interpretReply(raw, named.map((p) => p.name));
    target = picked ? named.find((p) => p.name === picked) : undefined;
  }

  if (!target) {
    await reply(chatID, `i don't know who that is — try one of: ${living.map(label).join(', ')}`, who);
    return;
  }

  const { error: answerError } = await supabase
    .from('actions')
    .update({ target: target.id, answered_at: new Date().toISOString() })
    .eq('id', action.id);
  if (answerError) throw answerError;

  if (action.kind === 'detective_check') {
    // The verdict itself is never left to the model's phrasing — too high-stakes
    // to risk ambiguity — but a narrated line can still frame it atmospherically.
    const verdict = target.role === 'mafia' ? 'IS mafia' : 'is not mafia';
    const flavor = await narrate(
      `Privately tell the detective one atmospheric sentence about investigating ` +
        `${label(target)} tonight — what they noticed, a detail, a feeling. Do not ` +
        'state the verdict itself, that gets appended after your line separately.',
      '',
    );
    await reply(chatID, `${flavor ? flavor + ' ' : ''}${label(target)} ${verdict}.`, who);
  } else {
    await reply(
      chatID,
      await narrate(
        `Privately confirm to a player in a Mafia game that their night action ` +
          `targeted ${label(target)}. Keep it short and in-character for a secret ` +
          'message — do not reveal what kind of action it was.',
        `got it — ${label(target)}.`,
      ),
      who,
    );
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

  const fallback = died
    ? `morning. ${label(died)} didn't make it through the night.`
    : 'morning. somehow, everyone made it through the night.';
  const text = died
    ? await narrate(`It's dawn. ${label(died)} was killed during the night. Announce their death.`, fallback, gameID)
    : await narrate('It\'s dawn and nobody died last night — the doctor saved the target. Announce that.', fallback, gameID);
  await reply(chatID, text);

  if (await checkWinner(gameID, chatID)) return;
  await startDay(gameID, chatID);
}

// Returns true when the game is over, so the caller knows not to start a phase.
async function checkWinner(gameID: number, chatID: string) {
  const living = await livingPlayers(gameID);
  const mafia = living.filter((p) => p.role === 'mafia');
  const rest = living.filter((p) => p.role !== 'mafia');

  if (mafia.length === 0) {
    const fallback = 'the village wins — every mafia is gone!';
    await reply(chatID, await narrate('The village found and eliminated every mafia member. The village has won. Announce the victory — this is the ending of the story you\'ve been telling all game.', fallback, gameID));
    await endGame(gameID);
    return true;
  }
  if (mafia.length >= rest.length) {
    const names = mafia.map(label).join(' and ');
    const fallback = `the mafia win. it was ${names}.`;
    await reply(
      chatID,
      await narrate(`The mafia now equal or outnumber the village. The mafia have won the game. The mafia were: ${names}. Announce their victory and reveal who they were — this is the ending of the story you've been telling all game.`, fallback, gameID),
    );
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

  await reply(
    chatID,
    `time to vote!! tap a name in the poll to vote them out. you've got ${humanTimeout()}, then anyone who hasn't voted is skipped.`,
  );

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

  // One live poll per game, so it lives on the game rather than in a table of
  // its own. A new round overwrites it, which also means a vote cast on a
  // superseded poll no longer resolves — which is what we want.
  const { data: game, error } = await supabase
    .from('games')
    .update({ poll_message_id: pollEnvelope.message_id, poll_option_map: optionMap })
    .eq('id', gameID)
    .select('round')
    .single();
  if (error) throw error;

  // Placeholder rows, target null — same shape as a night action's ask. Without
  // these, a player who never votes leaves nothing for the sweep to find, and
  // resolveVoteIfDone waits on them forever.
  const { error: placeholderError } = await supabase.from('actions').insert(
    living.map((p) => ({ game_id: gameID, round: game.round, phase: 'day', actor: p.id, kind: 'vote' })),
  );
  if (placeholderError) throw placeholderError;
}

// A vote poll only ever lives in the group chat, and every option maps to a
// player id recorded when the poll was created.
async function handleVote(messageID: string, optionID: string, voterHandle: string, added: boolean) {
  const { data: pollGame, error } = await supabase
    .from('games')
    .select('id, poll_option_map')
    .eq('poll_message_id', messageID)
    .maybeSingle();
  if (error) throw error;
  // No match means a vote on a poll from an earlier round, or one for a game
  // that has since ended. Either way there is nothing to record.
  if (!pollGame) return;

  const targetID = (pollGame.poll_option_map as Record<string, number>)[optionID];
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
    .eq('id', pollGame.id)
    .single();
  if (gameError) throw gameError;

  if (added) {
    // At most one recorded vote per voter per round: ticking a second name
    // overwrites the first rather than adding a second ballot.
    const { data: existing } = await supabase
      .from('actions')
      .select('id')
      .eq('game_id', pollGame.id)
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
        game_id: pollGame.id,
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
      .eq('game_id', pollGame.id)
      .eq('round', game.round)
      .eq('kind', 'vote')
      .eq('actor', voter.id)
      .eq('target', targetID);
    if (deleteError) throw deleteError;
  }

  await resolveVoteIfDone(pollGame.id, game.round, game.group_chat_id!);
}

// Runs once every living player has cast a vote.
async function resolveVoteIfDone(gameID: number, round: number, chatID: string) {
  const living = await livingPlayers(gameID);

  // Placeholder rows exist for every living player from the moment the poll
  // opens, so "has everyone voted" must check answered_at, not just existence.
  const { data: votes, error } = await supabase
    .from('actions')
    .select('actor, target')
    .eq('game_id', gameID)
    .eq('round', round)
    .eq('kind', 'vote')
    .not('answered_at', 'is', null);
  if (error) throw error;

  const votedActorIds = new Set((votes ?? []).map((v) => v.actor));
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
    await reply(chatID, await narrate('The village vote ended in a tie, so nobody was voted out this round. Announce that.', "no majority nobody's voted out this round :().", gameID));
  } else {
    const eliminated = living.find((p) => p.id === winner)!;
    const { error: killError } = await supabase.from('users').update({ alive: false }).eq('id', winner);
    if (killError) throw killError;
    const role = (eliminated.role ?? 'unknown').toUpperCase();

    await reply(
      chatID,
      await narrate(
        `The village just voted to eliminate ${label(eliminated)}. Announce that they've been voted out — do not reveal their role yet, that comes next.`,
        `${label(eliminated)} has been voted out.`,
        gameID,
      ),
    );

    await sleep(2000);

    await reply(
      chatID,
      await narrate(
        `${label(eliminated)} was just voted out and their role is about to be revealed: they were ${role}. Write one short, dramatic line revealing this.`,
        `${label(eliminated)} was ${role}.`,
        gameID,
      ),
      'group',
      { type: 'screen', name: 'spotlight' },
    );
  }

  if (await checkWinner(gameID, chatID)) return;
  await startNight(gameID, chatID);
}

// A player who never opens their messages would otherwise stall the game
// forever, since a phase only advances when its last answer arrives.
const NIGHT_TIMEOUT_MS = Number(process.env.NIGHT_TIMEOUT_MS ?? 120_000);
const SWEEP_MS = Number(process.env.SWEEP_MS ?? 15_000);

const humanTimeout = () => {
  const minutes = Math.round(NIGHT_TIMEOUT_MS / 60_000);
  if (minutes >= 1) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `${Math.max(1, Math.round(NIGHT_TIMEOUT_MS / 1000))} seconds`;
};

async function sweepStalledNights() {
  const cutoff = new Date(Date.now() - NIGHT_TIMEOUT_MS).toISOString();

  const { data: stale, error } = await supabase
    .from('actions')
    .select('id, game_id, actor')
    .is('answered_at', null)
    .lt('asked_at', cutoff);
  if (error) throw error;
  if (!stale?.length) return;

  const byGame = new Map<number, typeof stale>();
  for (const row of stale) {
    byGame.set(row.game_id, [...(byGame.get(row.game_id) ?? []), row]);
  }

  for (const [gameID, rows] of byGame) {
    const { data: game, error: gameError } = await supabase
      .from('games')
      .select('status, round, group_chat_id')
      .eq('id', gameID)
      .maybeSingle();
    if (gameError) throw gameError;
    if (!game || !game.group_chat_id) continue;
    if (game.status !== 'night' && game.status !== 'day') continue;

    // Same chain as everything else touching this game, so a sweep cannot run
    // alongside an answer that arrives at the same moment.
    enqueue(game.group_chat_id, async () => {
      // Answered with target still null — both resolvers already read a
      // missing target as "nothing happened" / "didn't vote".
      const { error: skipError } = await supabase
        .from('actions')
        .update({ answered_at: new Date().toISOString() })
        .in('id', rows.map((r) => r.id))
        .is('answered_at', null);
      if (skipError) throw skipError;

      await reply(
        game.group_chat_id!,
        `time's up — ${rows.length === 1 ? 'someone' : `${rows.length} of you`} didn't answer in time, so that ${game.status === 'night' ? 'move is' : 'vote doesn\'t count and is'} skipped.`,
      );
      if (game.status === 'night') await resolveNightIfDone(gameID);
      else await resolveVoteIfDone(gameID, game.round, game.group_chat_id!);
    });
  }
}

// Speak as another player from your own thread: "Lola: Estella", "Lola - Estella"
// or by id, "118: Estella". Only honoured from the redirect number, so a real
// game can never be steered this way.
const IMPERSONATE = /^\s*([A-Za-z0-9 _+]{1,32}?)\s*[:\-]\s*([\s\S]+)$/;

async function findPlayer(nameOrID: string) {
  const query = supabase.from('users').select('id, number, name, current_game, dm_chat_id');
  const { data, error } = /^\d+$/.test(nameOrID)
    ? await query.eq('id', Number(nameOrID))
    : await query.ilike('name', nameOrID.trim());
  if (error) throw error;

  const matches = data ?? [];
  if (matches.length <= 1) return matches[0] ?? null;

  // Names repeat — a real player and a stand-in can both be "Lola". Whoever is
  // actually in a game is the one being spoken for.
  const inGame = matches.filter((m) => m.current_game != null);
  if (inGame.length === 1) return inGame[0]!;

  console.log(
    `  "${nameOrID}" matches ${matches.length} players (${matches.map((m) => m.id).join(', ')}) — use an id`,
  );
  return null;
}

async function speakAs(target: NonNullable<Awaited<ReturnType<typeof findPlayer>>>, body: string, fallbackChat: string) {
  const { data: game } = await supabase
    .from('games')
    .select('group_chat_id')
    .eq('id', target.current_game ?? -1)
    .maybeSingle();
  const groupChat = game?.group_chat_id ?? fallbackChat;

  // An outstanding night prompt means this is the answer to it; otherwise it is
  // an ordinary message in the group chat.
  const { data: open, error } = await supabase
    .from('actions')
    .select('id')
    .eq('actor', target.id)
    .is('answered_at', null)
    .limit(1)
    .maybeSingle();
  if (error) throw error;

  const t = normalize(body);
  const isCommand = [START_MESSAGE, JOIN_MESSAGE, BEGIN_MESSAGE, CANCEL_MESSAGE].some(
    (c) => t === normalize(c),
  );

  enqueue(groupChat, async () => {
    // A command wins over a pending prompt, so a game can still be ended while
    // someone is mid-answer.
    if (open && !isCommand) {
      await handleNightReply(target.id, body, fallbackChat);
      return;
    }
    const asHandle = `+${target.number}`;
    if (t === normalize(START_MESSAGE)) await startGame(groupChat, asHandle);
    else if (t === normalize(JOIN_MESSAGE)) await joinGame(groupChat, asHandle);
    else if (t === normalize(BEGIN_MESSAGE)) await beginGame(groupChat, asHandle);
    else if (t === normalize(CANCEL_MESSAGE)) await cancelGame(groupChat, asHandle);
    else await recordName(groupChat, asHandle, body);
  });
}

// Call it off — works at any point, lobby or mid-round.
async function cancelGame(chatID: string, senderHandle: string) {
  const game = await findGameInChat(chatID);
  if (game == null) {
    await reply(chatID, "there's no game going in here.");
    return;
  }

  // Look up rather than ensureUser: a passer-by should not get a record just
  // for trying to end someone else's game.
  const { data: user, error } = await supabase
    .from('users')
    .select('id')
    .eq('number', toNumber(senderHandle))
    .maybeSingle();
  if (error) throw error;
  if (!user || user.id !== game.creator) {
    await reply(chatID, 'only whoever started the game can end it!');
    return;
  }

  await endGame(game.id);
  await reply(chatID, 'game called off. text "' + START_MESSAGE + '" whenever you want another one.');
}

// Placeholder for the actual mafia game — role assignment, night/day loop, etc.
// When it reaches a win condition it should call endGame(game.id).
async function runGame(game: { id: number; players: number[]; chatID: string }) {
  const dealt = await assignRoles(game.id);
  console.log(
    `game ${game.id}: ` + dealt.map((p) => `${p.name ?? p.number}=${p.role}`).join(', '),
  );
  await startNight(game.id, game.chatID);
}

async function beginGame(chatID: string, senderHandle: string) {
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

  await kickOff(game.id, chatID);
}

// Everything that happens once a lobby closes, with no opinion about what
// closed it — a text command or the /seed-game endpoint.
async function kickOff(gameID: number, chatID: string) {
  const players = await playersIn(gameID);

  const { error } = await supabase
    .from('games')
    .update({ status: 'started', players })
    .eq('id', gameID);
  if (error) throw error;

  await reply(
    chatID,
    `game on — ${players.length} playing. no more joining or name changes! ` +
      `i'm messaging each of you your role privately — go read it.`,
  );
  await runGame({ id: gameID, players, chatID });
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

// Skip the lobby: register the players and deal, without anyone texting.
//   curl -X POST localhost:3000/seed-game -H 'content-type: application/json' \
//     -d '{"chat_id":"<uuid>","players":[{"number":"+1...","name":"Lola"}]}'
app.post('/seed-game', async (req, res) => {
  const token = process.env.ADMIN_TOKEN;
  if (token && req.headers['x-admin-token'] !== token) {
    res.status(401).json({ error: 'bad or missing x-admin-token' });
    return;
  }

  const chatID: string = req.body?.chat_id ?? `sim-${Date.now()}`;
  const players: Array<{ number: string; name?: string }> = req.body?.players ?? [];

  // Send the whole game — group messages and every private dm — to one number.
  // Lasts until the server restarts or another seed overrides it.
  // Set from this request every time, falling back to the environment. Leaving
  // a previous game's value in place meant one seed with redirect_to kept
  // hijacking every later game's group messages.
  // Resolved per request so one game's settings never leak into the next.
  TEST_PHONE = req.body?.test_phone ? String(req.body.test_phone) : process.env.TEST_PHONE;

  console.log(
    TEST_PHONE
      ? `all player dms for this game go to ${TEST_PHONE}` +
          (isChatID(chatID) ? ', group messages to the real chat' : ', group messages too')
      : 'no TEST_PHONE — every player is messaged for real',
  );
  if (players.length < 2) {
    res.status(400).json({ error: 'need at least 2 players' });
    return;
  }

  try {
    const running = await findGameInChat(chatID);
    if (running != null) {
      res.status(409).json({ error: `game ${running.id} is already running in that chat` });
      return;
    }

    const registered = [];
    for (const p of players) {
      const user = await ensureUser(toNumber(p.number));
      if (p.name) {
        const { error } = await supabase.from('users').update({ name: p.name }).eq('id', user.id);
        if (error) throw error;
      }
      registered.push({ id: user.id, number: p.number, name: p.name ?? user.name });
    }

    const { data: game, error } = await supabase
      .from('games')
      .insert({ creator: registered[0]!.id, players: [], group_chat_id: chatID, status: 'lobby' })
      .select('id')
      .single();
    if (error) throw error;

    const { error: joinError } = await supabase
      .from('users')
      .update({ current_game: game.id })
      .in('id', registered.map((r) => r.id));
    if (joinError) throw joinError;

    res.json({
      game_id: game.id,
      chat_id: chatID,
      mode: TEST_PHONE
        ? `dms -> ${TEST_PHONE}; group -> ${isChatID(chatID) ? 'real chat' : TEST_PHONE}`
        : 'everything real',
      players: registered,
    });

    // After responding: dealing sends messages and can take a few seconds.
    enqueue(chatID, () => kickOff(game.id, chatID));
  } catch (err) {
    console.error('seed-game failed:', err);
    if (!res.headersSent) res.status(500).json({ error: String(err) });
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const eventType = req.body.event_type;
  const event = req.body.data;
  console.log(`webhook event_type=${eventType} raw=${JSON.stringify(req.body)}`);
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

  // Only the test phone may speak as someone else, so a real game is safe.
  if (TEST_PHONE && toNumber(handle) === toNumber(TEST_PHONE)) {
    const match = part.value.match(IMPERSONATE);
    if (match) {
      try {
        const target = await findPlayer(match[1]!);
        if (target) {
          console.log(`  speaking as ${target.name ?? target.number}: ${JSON.stringify(match[2])}`);
          await speakAs(target, match[2]!, chatID);
          return;
        }
        console.log(`  no player matching ${JSON.stringify(match[1])}`);
      } catch (err) {
        console.error('impersonation failed:', err);
      }
    }
  }

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
    else if (text === normalize(CANCEL_MESSAGE)) await cancelGame(chatID, handle);
    else await recordName(chatID, handle, part.value);
  });
});

setInterval(() => {
  sweepStalledNights().catch((err) => console.error('sweep failed:', err));
}, SWEEP_MS);

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
