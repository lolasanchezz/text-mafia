import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const STATE_PATH = fileURLToPath(
  new URL("../data/state.json", import.meta.url),
);

// Matches the data model in CLAUDE.md §6.
export function emptyGame() {
  return {
    groupChatId: null,
    mafiaChatId: null,
    graveyardChatId: null,
    phase: "lobby",
    phaseId: 0,
    day: 0,
    deadline: null,
    players: {}, // keyed by E.164 phone
    ballots: {}, // "kind:phaseId" -> ballot
    msgIndex: {}, // messageId -> { ballotId, target }
    votes: {}, // ballotId -> { voterPhone: targetPhone }
  };
}

export async function loadState() {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return emptyGame();
    throw err;
  }
}

export async function saveState(game) {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(game, null, 2));
  return game;
}
