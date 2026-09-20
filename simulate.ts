// Drives the webhook with fake players. Start the server with DRY_RUN=1 first:
//   DRY_RUN=1 npm start
// then in another terminal:  node simulate.ts
import { createClient } from '@supabase/supabase-js';
import { loadEnvFile } from 'node:process';

loadEnvFile();

const URL = 'http://localhost:3000/webhook';
const CHAT = process.argv[2] ?? 'sim-chat-1';

const PLAYERS = {
  lola: '+15550001111',
  estella: '+15550002222',
  sam: '+15550003333',
  kim: '+15550004444',
};

// Wipe what a previous run left behind. Scoped to games the fake numbers
// created, so pointing this at a real chat cannot delete a real game.
async function reset() {
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_API_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } });
  const numbers = Object.values(PLAYERS).map((h) => Number(h.replace(/\D/g, '')));

  const { data: fakes } = await supabase.from('users').select('id').in('number', numbers);
  const fakeIDs = (fakes ?? []).map((u) => u.id);
  if (fakeIDs.length === 0) return;

  await supabase.from('users').update({ current_game: null }).in('number', numbers);
  await supabase.from('games').delete().eq('group_chat_id', CHAT).in('creator', fakeIDs);
  await supabase.from('users').delete().in('number', numbers);
}

// chat defaults to the group thread; night replies come in on a DM chat.
async function text(handle: string, value: string, chat = CHAT) {
  console.log(`${handle}${chat === CHAT ? '' : ' (dm)'}: ${value}`);
  await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: {
        direction: 'inbound',
        chat: { id: chat },
        sender_handle: { handle, is_me: false },
        parts: [{ type: 'text', value }],
      },
    }),
  });
  await new Promise((r) => setTimeout(r, 400)); // let the handler finish
}

await reset();

await text(PLAYERS.lola, 'i wanna play mafia');
await text(PLAYERS.lola, 'Lola');
await text(PLAYERS.estella, 'i wanna play!');
await text(PLAYERS.estella, 'Estella');
await text(PLAYERS.sam, 'i wanna play!');
await text(PLAYERS.sam, 'Sam');
await text(PLAYERS.kim, 'i wanna play!');
await text(PLAYERS.kim, 'Kim');
await text(PLAYERS.estella, "let's start");   // not the creator
await text(PLAYERS.lola, "let's start");      // creator

// Play rounds until the game ends. Roles are random, so each phase is driven
// off whatever the database says is still alive.
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_API_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } });
const numbers = Object.values(PLAYERS).map((h) => Number(h.replace(/\D/g, '')));

const settle = () => new Promise((r) => setTimeout(r, 1500));
const cast = async () => (await supabase.from('users')
  .select('id, number, name, role, alive, dm_chat_id').in('number', numbers)).data ?? [];
const game = async () => (await supabase.from('games')
  .select('id, status, round').eq('group_chat_id', CHAT).maybeSingle()).data;

// wait for the deal rather than guessing at a delay
for (let i = 0; i < 60 && !(await cast()).every((p) => p.role); i++) await settle();
console.log('\nroles:', (await cast()).map((p) => `${p.name}=${p.role}`).join(', '));

for (let round = 1; round <= 6; round++) {
  const g = await game();
  if (!g || g.status === 'finished') break;

  if (g.status === 'night') {
    const alive = (await cast()).filter((p) => p.alive);
    // mafia picks a non-mafia; everyone else protects/investigates someone else
    const prey = alive.find((p) => p.role !== 'mafia')!;
    for (const p of alive) {
      if (!['mafia', 'doctor', 'detective'].includes(p.role)) continue;
      const pick = p.role === 'mafia' ? prey : alive.find((o) => o.id !== prey.id) ?? prey;
      await text(`+${p.number}`, pick.name!, p.dm_chat_id!);
    }
    await settle();
  }

  // Day has no resolution yet, so the loop stops once the game reaches it.
  const afterNight = await game();
  if (afterNight?.status === 'day') break;
}

const final = await game();
console.log('\nfinal:', final);
