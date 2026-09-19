// Offline game driver with a fake transport (CLAUDE.md §5, M0 acceptance
// criteria). Runs a full game with no network and no phones: fake players
// vote by reacting to whichever candidate their AI picks, driven through the
// exact same applyReaction() path a real tapback webhook would use.
//
// Usage: node src/sim.js [--seed N] [--players N] [--runs N] [--quiet]

import {
  setTransport,
  setRng,
  startGame,
  beginNight,
  resolveNight,
  beginDay,
  beginVote,
  resolveVote,
  applyReaction,
  alivePlayers,
} from "./game.js";
import { emptyGame } from "./state.js";

const NAMES = ["Priya", "Sam", "Jordan", "Kai", "Morgan", "Alex", "Riley", "Taylor"];
const MAX_ROUNDS = 30; // safety net against a genuine hang; should never trigger

function makeRng(seed) {
  let s = seed >>> 0;
  return function rng() {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function makeFakeTransport({ verbose }) {
  let counter = 0;
  const nextId = (prefix) => `${prefix}-${++counter}`;

  return {
    async createChat({ to, message }) {
      const chatId = nextId("chat");
      if (verbose) console.log(`  [tx] createChat(${to.length} recipients) -> ${chatId}: "${message}"`);
      return { chatId, messageId: nextId("msg") };
    },
    async send(chatId, message) {
      const messageId = nextId("msg");
      if (verbose) console.log(`  [tx] send(${chatId}): "${message}"`);
      return { messageId };
    },
    async react(messageId, type, operation) {
      if (verbose) console.log(`  [tx] react(${messageId}, ${type}, ${operation})`);
      return {};
    },
    async editMessage(messageId, parts) {
      if (verbose) console.log(`  [tx] editMessage(${messageId}): "${parts?.[0]?.value ?? ""}"`);
      return {};
    },
    async updateGroup(chatId, { displayName } = {}) {
      if (verbose) console.log(`  [tx] updateGroup(${chatId}) -> "${displayName}"`);
      return {};
    },
    async typing(chatId) {
      if (verbose) console.log(`  [tx] typing(${chatId})`);
      return {};
    },
  };
}

// Casts one vote per allowed voter in a ballot, using the real applyReaction
// path (same one a webhook-driven tapback would hit) rather than mutating
// game.votes directly.
async function castRandomVotes(game, rng, ballotId, voters) {
  const ballot = game.ballots[ballotId];
  if (!ballot) return;
  const targets = Object.keys(ballot.candidates);
  if (!targets.length) return;
  for (const voterPhone of voters) {
    const target = pick(rng, targets);
    const messageId = ballot.candidates[target];
    await applyReaction(game, { messageId, voterPhone, operation: "add" });
  }
}

async function simulateNightVotes(game, rng) {
  const alive = alivePlayers(game);
  const mafia = alive.filter((p) => p.role === "mafia");
  const doctor = alive.find((p) => p.role === "doctor");
  const detective = alive.find((p) => p.role === "detective");

  if (mafia.length) {
    await castRandomVotes(game, rng, `mafiaKill:${game.phaseId}`, mafia.map((p) => p.phone));
  }
  if (doctor) {
    await castRandomVotes(game, rng, `doctorSave:${game.phaseId}`, [doctor.phone]);
  }
  if (detective) {
    await castRandomVotes(game, rng, `detectiveInvestigate:${game.phaseId}`, [detective.phone]);
  }
}

async function simulateLynchVotes(game, rng) {
  const alive = alivePlayers(game);
  await castRandomVotes(game, rng, `lynch:${game.phaseId}`, alive.map((p) => p.phone));
}

export async function runSimulation({ seed, playerCount = 6, verbose = true } = {}) {
  const rng = makeRng(seed);
  setTransport(makeFakeTransport({ verbose }));
  setRng(rng);

  const players = Array.from({ length: playerCount }, (_, i) => ({
    phone: `+15550000${String(i + 1).padStart(3, "0")}`,
    name: NAMES[i] ?? `Player${i + 1}`,
  }));

  const game = emptyGame();
  await startGame(game, players);

  if (verbose) {
    console.log("\nRoles:");
    for (const p of Object.values(game.players)) console.log(`  seat ${p.seat}  ${p.name.padEnd(10)} ${p.role}`);
  }

  let winner = null;
  let rounds = 0;

  while (!winner) {
    rounds += 1;
    if (rounds > MAX_ROUNDS) {
      throw new Error(`simulation exceeded ${MAX_ROUNDS} rounds without a winner (seed ${seed})`);
    }

    await beginNight(game);
    await simulateNightVotes(game, rng);
    winner = await resolveNight(game, { pauseMs: 0 });
    if (winner) break;

    await beginDay(game);
    await beginVote(game);
    await simulateLynchVotes(game, rng);
    winner = await resolveVote(game);
  }

  if (verbose) {
    console.log(`\n[sim] Game over after ${game.day} night(s) — ${winner} wins.`);
    for (const p of Object.values(game.players)) {
      console.log(`  ${p.alive ? "alive" : "dead "}  ${p.name.padEnd(10)} ${p.role}`);
    }
  }

  return { winner, game, seed };
}

function parseArgs(argv) {
  const opts = { seed: null, players: 6, runs: 1, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seed") opts.seed = Number(argv[++i]);
    else if (a === "--players") opts.players = Number(argv[++i]);
    else if (a === "--runs") opts.runs = Number(argv[++i]);
    else if (a === "--quiet") opts.quiet = true;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const results = [];

  for (let i = 0; i < opts.runs; i++) {
    const seed = opts.seed != null ? opts.seed + i : Math.floor(Math.random() * 1e9);
    console.log(`\n===== game ${i + 1}/${opts.runs} (seed ${seed}, players ${opts.players}) =====`);
    const { winner } = await runSimulation({ seed, playerCount: opts.players, verbose: !opts.quiet });
    results.push(winner);
  }

  console.log(`\nResults: ${results.join(", ")}`);
}

main().catch((err) => {
  console.error("sim failed:", err.stack ?? err);
  process.exit(1);
});
