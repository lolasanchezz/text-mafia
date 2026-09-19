// Phases, ballots, roles, win conditions. NO HTTP — every outbound effect
// goes through the transport injected via setTransport(tx), per CLAUDE.md §2
// rule 2. This is what makes src/sim.js possible.
//
// tx contract: send(chatId, text), createChat({ to, message }), react(messageId,
// type, operation), editMessage(messageId, parts), updateGroup(chatId, opts),
// typing(chatId). See CLAUDE.md §5.

import { assignRoles } from "./roles.js";

const DAWN_PAUSE_MS = 2500;

let tx = null;
let rng = Math.random;

export function setTransport(next) {
  tx = next;
}

// Injectable so the simulator can replay a failing seed exactly (CLAUDE.md §9).
export function setRng(next) {
  rng = next;
}

function requireTx() {
  if (!tx) throw new Error("game.js: call setTransport(tx) before starting a game");
  return tx;
}

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safe(fn) {
  try {
    await fn();
  } catch (err) {
    console.error("[game] theater action failed (ignored):", err.message);
  }
}

async function announce(game, chatId, text) {
  if (!chatId) return;
  try {
    await tx.send(chatId, text);
  } catch (err) {
    console.error(`[game] announce(${chatId}) failed:`, err.message);
  }
}

export function alivePlayers(game) {
  return Object.values(game.players).filter((p) => p.alive);
}

export function checkWinCondition(game) {
  const alive = alivePlayers(game);
  const mafia = alive.filter((p) => p.role === "mafia").length;
  const town = alive.length - mafia;
  if (mafia === 0) return "town";
  if (mafia >= town) return "mafia";
  return null;
}

async function finishIfWon(game) {
  const winner = checkWinCondition(game);
  if (winner) {
    game.phase = "over";
    await announce(
      game,
      game.groupChatId,
      winner === "town"
        ? "🏆 All mafia have been eliminated. The town wins!"
        : "🏆 The mafia equal or outnumber the town. The mafia win!",
    );
  }
  return winner;
}

// --- ballots --------------------------------------------------------------

// One message per candidate (CLAUDE.md §6 "the ballot mechanic"). `candidates`
// map is an implementation convenience beyond the documented ballot shape —
// it lets recordVote/tally work without reverse-scanning msgIndex.
async function postBallot(game, kind, { chatId, allowed, candidates }) {
  const ballotId = `${kind}:${game.phaseId}`;
  const ballot = {
    kind,
    chatId,
    allowed: [...allowed],
    candidates: {},
    open: true,
    tallyMessageId: null,
  };

  let n = 1;
  for (const c of candidates) {
    try {
      const sent = await tx.send(chatId, `${n}. ${c.name}`);
      const messageId = sent?.messageId ?? null;
      if (messageId) {
        ballot.candidates[c.phone] = messageId;
        game.msgIndex[messageId] = { ballotId, target: c.phone };
      }
    } catch (err) {
      console.error(`[game] postBallot(${kind}) failed to post candidate ${c.name}:`, err.message);
    }
    n += 1;
  }

  game.ballots[ballotId] = ballot;
  game.votes[ballotId] = {};
  return ballot;
}

function closeBallot(game, ballotId) {
  const ballot = game.ballots[ballotId];
  if (ballot) ballot.open = false;
}

function tallyCounts(game, ballotId) {
  const votes = game.votes[ballotId] ?? {};
  const counts = {};
  for (const target of Object.values(votes)) {
    counts[target] = (counts[target] ?? 0) + 1;
  }
  return counts;
}

// Plurality; a tie returns null (CLAUDE.md §6: "a tie means no elimination").
function pluralityTarget(game, ballotId) {
  const entries = Object.entries(tallyCounts(game, ballotId));
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  if (entries.length > 1 && entries[0][1] === entries[1][1]) return null;
  return entries[0][0];
}

async function refreshTally(game, ballotId) {
  const ballot = game.ballots[ballotId];
  if (!ballot) return;
  const counts = tallyCounts(game, ballotId);
  const lines = Object.entries(ballot.candidates).map(([phone, _msgId], i) => {
    const name = game.players[phone]?.name ?? phone;
    return `${i + 1}. ${name} — ${counts[phone] ?? 0}`;
  });
  const text = `Tally:\n${lines.join("\n")}`;

  // PATCH /messages/{id} is confirmed broken on real Linq (CLAUDE.md §4.2 /
  // §14) — try it, but the real fallback is posting a fresh tally message,
  // and the whole thing is swallowed if even that fails (rule 5: theater
  // never breaks the game).
  try {
    if (ballot.tallyMessageId) {
      await tx.editMessage(ballot.tallyMessageId, [{ type: "text", value: text }]);
      return;
    }
  } catch {
    // fall through to posting a fresh message
  }
  try {
    const sent = await tx.send(ballot.chatId, text);
    ballot.tallyMessageId = sent?.messageId ?? ballot.tallyMessageId;
  } catch (err) {
    console.error(`[game] refreshTally(${ballotId}) failed:`, err.message);
  }
}

// Records an inbound reaction against whatever ballot its message belongs to.
// This is the single entry point both the real webhook handler (server.js,
// M1+) and the simulator's fake AI voters call — so sim exercises the exact
// same vote-recording path a real tapback would.
export async function applyReaction(game, { messageId, voterPhone, operation = "add" }) {
  const entry = game.msgIndex[messageId];
  if (!entry) return { ignored: true, reason: "not-a-ballot-message" };

  const { ballotId, target } = entry;
  const ballot = game.ballots[ballotId];
  if (!ballot || !ballot.open) return { ignored: true, reason: "ballot-closed" };
  if (!ballot.allowed.includes(voterPhone)) return { ignored: true, reason: "not-allowed" };

  const targetPlayer = game.players[target];
  if (targetPlayer && !targetPlayer.alive) {
    // CLAUDE.md §7 theater + §11 failure mode: ignore, tapback a laugh.
    await safe(() => tx.react(messageId, "laugh", "add"));
    return { ignored: true, reason: "dead-target" };
  }

  const votes = game.votes[ballotId] ?? (game.votes[ballotId] = {});
  if (operation === "remove") {
    if (votes[voterPhone] === target) delete votes[voterPhone];
  } else {
    votes[voterPhone] = target; // newest reaction wins
  }

  await refreshTally(game, ballotId);
  return { ignored: false, ballotId, target };
}

// --- graveyard --------------------------------------------------------------

async function growGraveyard(game) {
  const dead = Object.values(game.players).filter((p) => !p.alive);
  // Groups need 3 handles including the bot (CLAUDE.md §3), so wait for a
  // 2nd death, and only spawn once — the tx contract has no addParticipant
  // yet (CLAUDE.md §5 lists send/createChat/react/editMessage/updateGroup/
  // typing only), so later deaths aren't added until that's extended.
  if (dead.length < 2 || game.graveyardChatId) return;
  try {
    const created = await tx.createChat({
      to: dead.map((p) => p.phone),
      message: "Welcome to the graveyard. You can watch, but you can't speak to the living.",
    });
    game.graveyardChatId = created.chatId;
    await safe(() => tx.updateGroup(game.graveyardChatId, { displayName: "The Graveyard" }));
  } catch (err) {
    console.error("[game] graveyard chat creation failed (cosmetic, continuing):", err.message);
  }
}

async function killPlayer(game, phone) {
  const player = game.players[phone];
  if (!player) return;
  player.alive = false;
  await announce(game, game.groupChatId, `💀 ${player.name} was found dead. They were the ${player.role}.`);
  await growGraveyard(game);
}

// --- game lifecycle ---------------------------------------------------------

// players: [{ phone, name, dmChatId? }]
export async function startGame(game, players) {
  requireTx();
  const withRoles = assignRoles(players, rng);

  if (!game.groupChatId) {
    const created = await tx.createChat({
      to: withRoles.map((p) => p.phone),
      message: "Welcome to Mafia. Roles are being assigned now.",
    });
    game.groupChatId = created.chatId;
  }

  game.players = {};
  for (const p of withRoles) {
    game.players[p.phone] = {
      phone: p.phone,
      name: p.name,
      seat: p.seat,
      role: p.role,
      alive: true,
      dmChatId: p.dmChatId ?? null,
    };
  }

  for (const player of Object.values(game.players)) {
    if (player.dmChatId) {
      await announce(game, player.dmChatId, `You are the ${player.role}.`);
      continue;
    }
    try {
      const created = await tx.createChat({ to: [player.phone], message: `You are the ${player.role}.` });
      player.dmChatId = created.chatId;
    } catch (err) {
      console.error(`[game] failed to DM ${player.name}:`, err.message);
    }
  }

  const mafia = Object.values(game.players).filter((p) => p.role === "mafia");
  game.mafiaChatId = null;
  if (mafia.length >= 2) {
    try {
      const created = await tx.createChat({
        to: mafia.map((p) => p.phone),
        message: "You are the mafia. Coordinate here.",
      });
      game.mafiaChatId = created.chatId;
      await safe(() => tx.updateGroup(game.mafiaChatId, { displayName: "The Family" }));
    } catch (err) {
      // CLAUDE.md §11: mafia group chat creation fails -> fall back to DMs.
      console.error("[game] mafia chat creation failed, falling back to DMs:", err.message);
    }
  }

  game.phaseId = 0;
  game.day = 0;
  game.phase = "lobby";
  return game;
}

export async function beginNight(game) {
  game.phaseId += 1;
  game.day += 1;
  game.phase = "night";
  game.deadline = null;

  const alive = alivePlayers(game);
  const mafia = alive.filter((p) => p.role === "mafia");
  const doctor = alive.find((p) => p.role === "doctor");
  const detective = alive.find((p) => p.role === "detective");

  await announce(game, game.groupChatId, `🌙 Night ${game.day} falls. Everyone, go to sleep.`);

  if (mafia.length) {
    const chatId = game.mafiaChatId ?? mafia[0].dmChatId;
    const candidates = alive.filter((p) => p.role !== "mafia");
    await postBallot(game, "mafiaKill", { chatId, allowed: mafia.map((p) => p.phone), candidates });
  }
  if (doctor) {
    await postBallot(game, "doctorSave", { chatId: doctor.dmChatId, allowed: [doctor.phone], candidates: alive });
  }
  if (detective) {
    const candidates = alive.filter((p) => p.phone !== detective.phone);
    await postBallot(game, "detectiveInvestigate", {
      chatId: detective.dmChatId,
      allowed: [detective.phone],
      candidates,
    });
  }
}

export async function resolveNight(game, { pauseMs = DAWN_PAUSE_MS } = {}) {
  const mafiaBallotId = `mafiaKill:${game.phaseId}`;
  const doctorBallotId = `doctorSave:${game.phaseId}`;
  const detectiveBallotId = `detectiveInvestigate:${game.phaseId}`;
  closeBallot(game, mafiaBallotId);
  closeBallot(game, doctorBallotId);
  closeBallot(game, detectiveBallotId);

  const mafiaAlive = alivePlayers(game).filter((p) => p.role === "mafia");
  let killTarget = mafiaAlive.length ? pluralityTarget(game, mafiaBallotId) : null;
  if (mafiaAlive.length && !killTarget) {
    // No vote or a tie among the mafia — pick a random non-mafia target so
    // the game never stalls (CLAUDE.md §11).
    const candidates = alivePlayers(game).filter((p) => p.role !== "mafia");
    if (candidates.length) killTarget = candidates[Math.floor(rng() * candidates.length)].phone;
  }
  const saveTarget = pluralityTarget(game, doctorBallotId);
  const investigateTarget = pluralityTarget(game, detectiveBallotId);

  await announce(game, game.groupChatId, "🌅 Dawn breaks over the town...");
  await sleep(pauseMs);

  if (killTarget && killTarget !== saveTarget) {
    await killPlayer(game, killTarget);
  } else if (killTarget) {
    await announce(game, game.groupChatId, "The doctor saved them. Nobody died last night.");
  } else {
    await announce(game, game.groupChatId, "Nobody died last night.");
  }

  const detective = alivePlayers(game).find((p) => p.role === "detective");
  if (detective && investigateTarget) {
    const suspect = game.players[investigateTarget];
    await safe(() => tx.typing(detective.dmChatId));
    await announce(
      game,
      detective.dmChatId,
      `Your investigation: ${suspect.name} is ${suspect.role === "mafia" ? "mafia 🔪" : "not mafia ✅"}.`,
    );
  }

  return finishIfWon(game);
}

export async function beginDay(game) {
  game.phaseId += 1;
  game.phase = "day";
  game.deadline = null;
  await announce(game, game.groupChatId, `☀️ Day ${game.day}. Discuss who you suspect.`);
}

export async function beginVote(game) {
  game.phaseId += 1;
  game.phase = "vote";
  game.deadline = null;
  const candidates = alivePlayers(game);
  await announce(game, game.groupChatId, "Time to vote. React to a name below to vote them out.");
  await postBallot(game, "lynch", {
    chatId: game.groupChatId,
    allowed: candidates.map((p) => p.phone),
    candidates,
  });
}

export async function resolveVote(game) {
  const ballotId = `lynch:${game.phaseId}`;
  closeBallot(game, ballotId);
  const target = pluralityTarget(game, ballotId);

  if (target) {
    await killPlayer(game, target);
  } else {
    await announce(game, game.groupChatId, "The vote was tied, or nobody voted. Nobody is lynched today.");
  }

  return finishIfWon(game);
}
