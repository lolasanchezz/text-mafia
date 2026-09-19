// Transport smoke test per CLAUDE.md §9: create a chat, send a message,
// react to it, edit it — printing each raw response. Run this whenever a
// Linq call starts behaving oddly, to separate API problems from game bugs.
//
// Usage: node scripts/smoke.js +15551234567 [+15552223333 ...]

import "dotenv/config";
import { createChat, sendMessage, addReaction, editMessage } from "../src/linq.js";

const recipients = process.argv.slice(2);
if (recipients.length === 0) {
  console.error("Usage: node scripts/smoke.js <phone> [phone ...]");
  process.exit(1);
}

async function main() {
  console.log(`--- createChat (${recipients.length} recipient(s)) ---`);
  const created = await createChat({
    to: recipients,
    message: "text-mafia smoke test: chat created.",
  });
  console.log("chatId:", created.chatId, "messageId:", created.messageId);
  console.log("raw:", JSON.stringify(created.raw, null, 2));

  if (!created.chatId) {
    console.error("No chat id extracted — stopping before further calls.");
    return;
  }

  console.log("\n--- sendMessage ---");
  const sent = await sendMessage(created.chatId, "text-mafia smoke test: follow-up message.");
  console.log("messageId:", sent.messageId);
  console.log("raw:", JSON.stringify(sent.raw, null, 2));

  if (sent.messageId) {
    // Confirmed 2026-09-19 (CLAUDE.md §14): reacting immediately after send
    // 500s with "Cannot send reaction" — the message isn't delivered yet.
    console.log("\n--- addReaction (love), after a delivery delay ---");
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const reacted = await addReaction(sent.messageId, "love", "add");
      console.log("raw:", JSON.stringify(reacted.raw, null, 2));
    } catch (err) {
      console.error("addReaction still failed:", err.body ?? err.message);
    }

    // Confirmed 2026-09-19 (CLAUDE.md §14 / §4.2): PATCH /messages/{id} 500s
    // with a generic internal error regardless of body shape or timing.
    // Kept here only as a canary in case Linq fixes it later — a failure is
    // expected, not a regression.
    console.log("\n--- editMessage (expected to fail per §4.2) ---");
    try {
      const edited = await editMessage(sent.messageId, [
        { type: "text", value: "text-mafia smoke test: edited message." },
      ]);
      console.log("editMessage now works! raw:", JSON.stringify(edited.raw, null, 2));
    } catch (err) {
      console.log("editMessage failed as expected:", err.status, err.body?.error?.code);
    }
  }

  console.log("\nSmoke test done.");
}

main().catch((err) => {
  console.error("Smoke test failed:", err.body ?? err.message ?? err);
  process.exit(1);
});
