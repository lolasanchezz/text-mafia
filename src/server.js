import "dotenv/config";
import express from "express";
import { createChat, normalizePhone } from "./linq.js";
import { assignRoles, MIN_PLAYERS } from "./roles.js";
import { emptyGame, loadState, saveState } from "./state.js";

const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/debug/state", async (req, res) => {
  const game = await loadState();
  res.json(game);
});

// Creates the town-square group chat via Linq and assigns roles.
// Body: { players: [{ phone, name }], groupName?: string }
app.post("/game/create", async (req, res) => {
  const { players: rawPlayers, groupName } = req.body ?? {};

  if (!Array.isArray(rawPlayers) || rawPlayers.length < MIN_PLAYERS) {
    return res.status(400).json({
      error: `players must be an array of at least ${MIN_PLAYERS} { phone, name } entries`,
    });
  }

  let normalized;
  try {
    normalized = rawPlayers.map((p) => ({
      phone: normalizePhone(p.phone),
      name: p.name ?? p.phone,
    }));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const withRoles = assignRoles(normalized);

  let chatResult;
  try {
    chatResult = await createChat({
      to: withRoles.map((p) => p.phone),
      message:
        groupName
          ? `Welcome to ${groupName}. Roles are being assigned now.`
          : "Welcome to Mafia. Roles are being assigned now.",
    });
  } catch (err) {
    console.error("[server] createChat failed:", err.body ?? err.message);
    return res.status(502).json({
      error: "failed to create group chat via Linq",
      detail: err.body ?? err.message,
    });
  }

  const game = emptyGame();
  game.groupChatId = chatResult.chatId;
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

  res.status(201).json({
    groupChatId: chatResult.chatId,
    // Roles are included here for local testing visibility only — once the
    // DM/join flow exists (CLAUDE.md M2/M4), roles should go out privately
    // per-player instead of being returned over this endpoint.
    players: game.players,
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`text-mafia server listening on :${port}`);
});
