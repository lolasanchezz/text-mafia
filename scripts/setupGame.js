// Creates the real group chat and assigns roles, without needing the Express
// server running. Useful for a quick end-to-end check against the sandbox.
//
// Usage: node scripts/setupGame.js players.json
// players.json: [{ "phone": "+15551234567", "name": "Priya" }, ...]

import "dotenv/config";
import { readFile } from "node:fs/promises";
import { createChat, normalizePhone } from "../src/linq.js";
import { assignRoles, MIN_PLAYERS } from "../src/roles.js";
import { emptyGame, saveState } from "../src/state.js";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/setupGame.js players.json");
  process.exit(1);
}

async function main() {
  const rawPlayers = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(rawPlayers) || rawPlayers.length < MIN_PLAYERS) {
    throw new Error(`need at least ${MIN_PLAYERS} players in ${file}`);
  }

  const normalized = rawPlayers.map((p) => ({
    phone: normalizePhone(p.phone),
    name: p.name ?? p.phone,
  }));

  const withRoles = assignRoles(normalized);
  console.log("Assigned roles:");
  for (const p of withRoles) {
    console.log(`  seat ${p.seat}  ${p.name.padEnd(12)} ${p.role}`);
  }

  console.log("\nCreating group chat...");
  const created = await createChat({
    to: withRoles.map((p) => p.phone),
    message: "Welcome to Mafia. Roles are being assigned now.",
  });
  console.log("chatId:", created.chatId, "messageId:", created.messageId);
  console.log("raw:", JSON.stringify(created.raw, null, 2));

  const game = emptyGame();
  game.groupChatId = created.chatId;
  game.phase = "lobby";
  for (const p of withRoles) {
    game.players[p.phone] = {
      phone: p.phone,
      name: p.name,
      seat: p.seat,
      role: p.role,
      alive: true,
      dmChatId: null,
    };
  }
  await saveState(game);
  console.log("\nSaved to data/state.json");
}

main().catch((err) => {
  console.error("setupGame failed:", err.body ?? err.message ?? err);
  process.exit(1);
});
