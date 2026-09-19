# CLAUDE.md — Mafia over iMessage (Linq API)

This file is the build brief. Read it fully before writing code. It contains
verified API facts, explicitly-unverified assumptions, a milestone plan with
acceptance criteria, and rules about how to work on this repo.

Hackathon project. Optimize for a working demo on a stage, not for elegance.

---

## 1. What we're building

A Mafia (werewolf) game that runs entirely inside real iMessage threads.

- The **day phase** happens in a real group chat the players already use.
- The **night phase** happens in 1:1 DMs the bot opens with each player.
- **Voting is tapbacks.** The bot posts one message per candidate; a player
  reacts to a name to vote for that person.
- Mid-game the bot **spawns new group chats**: one for the mafia, one for the
  dead.

The pitch is that this could not exist on any other platform. Strip out group
chats, per-player DMs, or reactions and the game stops working. That framing is
the point of the project — every feature we add should be load-bearing on the
messaging layer, not decorative.

**Non-goals:** a web UI, accounts, a database, persistence beyond a JSON file,
matchmaking, or any game other than Mafia until the core loop is solid.

---

## 2. How to work on this repo

Read these as hard constraints.

1. **Never invent a Linq endpoint or field name.** If it isn't in section 3
   below, either find it in the docs at `docs.linqapp.com` or write the call
   defensively with fallbacks and a `TODO: verify` comment. Silently guessing a
   field name produces bugs that look like game-logic bugs, which wastes hours.
2. **Game logic never makes HTTP calls.** All outbound messaging goes through an
   injected transport object (`tx.send`, `tx.createChat`, `tx.react`,
   `tx.editMessage`, `tx.updateGroup`, `tx.typing`). This is what makes the
   offline simulator possible. Do not import the API client into `game.js`.
3. **Test rules with the simulator, not with phones.** Debugging through real
   handsets costs a full round and four people's attention per bug. If you
   changed game logic, run `npm run sim` before anything else.
4. **Every API response shape is suspect.** Unwrap both `{ data: ... }` and bare
   responses. Extract ids with fallback chains. Log the raw body on any failure.
5. **Never let theater break the game.** Typing indicators, tapbacks from the
   bot, and message edits are all nice-to-have. Wrap each in try/catch and
   continue on failure.
6. **Don't refactor into TypeScript, add a framework, or introduce a database.**
   Plain ESM JavaScript, Express, Node 20+.
7. When you finish a milestone, stop and report what you verified rather than
   racing ahead. Milestones have acceptance criteria for a reason.

---

## 3. Verified Linq API reference

These facts are confirmed from Linq's docs. Use them as-is.

### Auth and base URL

```
Base:   https://api.linqapp.com/api/partner/v3
Header: Authorization: Bearer $LINQ_API_KEY
        Content-Type: application/json
```

There is also a V2 API using an `X-LINQ-INTEGRATION-TOKEN` header and
`/api/partner/v2/...` paths. **Ignore all V2 documentation and snippets.** Many
search results will surface V2; they use integer ids where V3 uses UUIDs.

### Endpoints

| Purpose | Call |
| --- | --- |
| Create chat (and send first message) | `POST /chats` |
| Send to existing chat | `POST /chats/{chatId}/messages` |
| List messages in chat | `GET /chats/{chatId}/messages` |
| Get / edit / delete a message | `GET`, `PATCH`, `DELETE /messages/{messageId}` |
| Add or remove a reaction | `POST /messages/{messageId}/reactions` |
| Update group name/icon | `PUT /chats/{chatId}` |
| Add participant | `POST /chats/{chatId}/participants` |
| Remove participant | `DELETE /chats/{chatId}/participants` |
| Leave a group | `POST /chats/{chatId}/leave` |

### Creating a chat

```bash
curl -X POST https://api.linqapp.com/api/partner/v3/chats \
  -H "Authorization: Bearer $LINQ_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "+14158128786",
    "to": ["+15551110000", "+15552220000"],
    "message": { "parts": [{ "type": "text", "value": "Welcome." }] }
  }'
```

- One recipient in `to` → a DM. Two or more → a group chat.
- `from` must be a Linq number assigned to the account.
- Returns the chat id (UUID) and the sent message id (UUID).

### Message parts

A message body is `{ "message": { "parts": [...] } }`. Each part is one of:

- `text` — `{ "type": "text", "value": "..." }`, up to 10,000 characters
- `media` — image/video/document/audio by public HTTPS `url` (under 10 MB) or a
  pre-uploaded `attachment_id` (up to 100 MB, never expires)
- `link` — a URL up to 2,048 chars that renders a rich preview; **must be the
  only part in its message**

`reply_to: { message_id, part_index }` threads a reply to a specific message.

### Reactions

```bash
curl -X POST https://api.linqapp.com/api/partner/v3/messages/{messageId}/reactions \
  -H "Authorization: Bearer $LINQ_API_KEY" \
  -d '{ "type": "love", "operation": "add" }'
```

- Types: `love` ❤️, `like` 👍, `dislike` 👎, `laugh` 😂, `emphasize` ‼️,
  `question` ❓, plus `custom` with a `custom_emoji` field for any emoji.
- `operation` is `add` or `remove`.
- `part_index` (0-based) targets a specific part of a multipart message.
  Reactions attach to *parts*, not messages — remember this when reading
  inbound reaction webhooks.

### Group chats

- Created by sending a message to 2+ recipients. Max 31 handles in `to`.
- If delivery falls back to SMS/MMS, carriers cap groups near 20 and sometimes
  as low as 10.
- `PUT /chats/{chatId}` sets `display_name` and `group_chat_icon` (a public
  HTTPS URL). Returns error 1006 if called on a DM.
- Participant management is **iMessage-only**.
- Groups must always have **at least 3 members**. You cannot remove a
  participant if that would drop below the minimum. Leaving requires 4+.

### Webhooks

Events to subscribe to: `message.received`, `reaction.added`,
`reaction.removed`, `participant.added`, `participant.removed`.

Envelope:

```json
{
  "api_version": "...",
  "event_type": "message.received",
  "event_id": "uuid",
  "created_at": "ISO-8601",
  "data": { }
}
```

- Signed with HMAC-SHA256 over the raw body, delivered as
  `X-Webhook-Signature: sha256=<hex>`. Use the **raw** body, not a
  re-serialized one.
- Must return HTTP 200 within **10 seconds**. Acknowledge first, process async.
- Implement idempotency on `event_id`; duplicates will arrive.

### Hard platform constraints (these will bite you)

1. **The first outbound message on `POST /chats` must not contain a URL.** Link
   parts and text parts containing URLs are rejected at chat creation. Send
   plain text, then follow up with the returned chat id.
2. **Typing indicators, delivery receipts, and read receipts do not work in
   group chats.** They exist only in 1:1 conversations. `mark_as_read` on a
   group is a no-op. Any presence-based feature must be built on DMs.
3. **Chat creation is find-or-create.** Creating a chat with a set of
   participants that already has a chat returns the *existing* chat, with its
   history. You cannot get a fresh thread for a second game with the same
   people. Reset game state in place with `/new` instead.
4. Phone numbers must be E.164 (`+15551234567`), no spaces, dashes or
   parentheses. Normalize once at the edge, on every inbound handle.
5. Sandbox recipients generally must have texted the Linq number first. Treat
   "text the bot to claim your seat" as a requirement, not just flavor.

---

## 4. Unverified — confirm these empirically before building on them

Do not assume. Each has a fallback plan.

### 4.1 Do tapbacks in a *group chat* produce a webhook that names the reactor?

**This is the single highest-risk unknown.** The entire voting mechanic depends
on it, and since typing indicators and read receipts are documented as DM-only,
it is not safe to assume reactions behave differently.

**Verify:** create a group with two teammates, have the bot send a message, have
someone tapback it, watch the dashboard Logs tab and the server console.
Confirm an event arrives and that it contains both a message id and a handle
identifying who reacted.

**If it fails:** switch voting to numbered text replies in the thread ("vote 3"
or just "3"). Only `postBallot` and the reaction handler change; the rest of the
engine is unaffected. Do not redesign the game.

### 4.2 Does `PATCH /messages/{messageId}` edit a sent message, and what body?

**Confirmed failing as of 2026-09-19 — see §14.** Both body shapes returned a
generic `500`/`3006` regardless of timing. Skip straight to the fallback below
rather than re-testing this.

Used for the live-updating vote tally. Fall back is: post a fresh tally
message on each change, or drop the tally and announce the result only.
`refreshTally` should swallow errors either way. Do not block on this.

### 4.3 Exact webhook payload field names

Unknown whether inbound data uses `from` / `from_phone` / `handle.handle`, and
`chat_id` / `chat.id`. The normalizers in `server.js` try several. After you see
one real event in the Logs tab, **print it, record the real shape in this file,
and delete the dead fallbacks.**

### 4.4 Typing indicator endpoint shape in V3

Guessed as `POST /chats/{chatId}/typing`. Unconfirmed. Wrapped in try/catch that
swallows everything. Confirm or delete.

### 4.5 Can the bot DM a number that has never texted it?

Affects whether the join flow is optional or mandatory. Also check whether such
a message lands in iOS's filtered "Unknown Senders" tab, which would make it
invisible during a demo.

---

## 5. Architecture

```
src/
  linq.js     API client + phone normalization + liveTransport
  game.js     phases, ballots, roles, win conditions — NO HTTP
  server.js   Express webhook, event normalization, 2s tick loop
  state.js    state container + JSON persistence
  sim.js      offline game driver with a fake transport
data/
  state.json  written on every mutation
```

Single Node process. In-memory state with a JSON file behind it so a crash
mid-demo doesn't lose the game. No database.

### Why the transport indirection

`game.js` receives a transport object via `setTransport(tx)`. `server.js` passes
the real Linq client; `sim.js` passes a fake that prints to stdout and returns
incrementing ids. This makes a full game runnable in ~2 seconds with no phones
and no network. It is the most important structural decision in the project.

---

## 6. Data model

```js
game = {
  groupChatId,        // the town square
  mafiaChatId,        // spawned at game start if 2+ mafia
  graveyardChatId,    // spawned when the 2nd player dies
  phase,              // 'lobby' | 'night' | 'day' | 'vote' | 'over'
  phaseId,            // increments every phase; scopes ballot ids
  day,
  deadline,           // epoch ms, or null
  players: {          // keyed by E.164 phone
    "+1555...": { phone, name, seat, dmChatId, role, alive }
  },
  ballots: {          // "kind:phaseId" -> ballot
    "lynch:7": { kind, chatId, allowed: [phone], open, tallyMessageId }
  },
  msgIndex: {         // messageId -> which ballot and which candidate
    "uuid": { ballotId, target }
  },
  votes: {            // ballotId -> { voterPhone: targetPhone }
    "lynch:7": { "+1555...": "+1555..." }
  }
}
```

### The ballot mechanic

This is the core trick. Do not replace it with a single message listing options
keyed to the six reaction types — that caps at six players and is confusing.

1. Post **one message per candidate**: `"3. Priya"`.
2. Store `msgIndex[messageId] = { ballotId, target: priyaPhone }`.
3. On `reaction.added`, look up the message id → you have target and voter.
4. Check `ballot.open` and that the voter is in `ballot.allowed`.
5. Newest reaction wins (overwrite). `reaction.removed` deletes the vote.
6. Recompute the tally and edit the tally message in place.

Plurality decides; a tie means no elimination.

---

## 7. Game rules

- **Minimum 4 players**, ideally 6–8.
- Roles: `mafia` = `max(1, floor(n/4))`. Add `doctor` at n≥5, `detective` at
  n≥6. Everyone else `villager`.
- **Night:** mafia pick a kill (in the mafia group chat if 2+, otherwise the
  lone mafia's DM). Doctor picks a save. Detective picks an investigation and
  receives the result by DM. All via ballots.
- **Dawn:** if kill ≠ save, the target dies and their role is revealed. If the
  mafia submitted no vote, pick a random non-mafia target so the game never
  stalls.
- **Day:** free discussion in the group for a fixed window.
- **Vote:** lynch ballot in the group with a live tally. Plurality out, ties
  mean nobody dies.
- **Win:** mafia = 0 → town wins. mafia ≥ town → mafia win.
- Dead players are added to a graveyard group chat (needs 2+ dead, since a group
  requires 3 handles including the bot). They keep watching, which is what makes
  real Mafia fun and every digital version bad.

### Theater (do these, they're cheap and they're what people remember)

- A 2–3 second pause between "Dawn" and the death announcement.
- Typing indicator in a **DM** before the detective's result.
- Bot tapbacks a 😂 on a player who votes for someone already dead.
- Group display name and icon set at game start ("The Family", "The Graveyard").

---

## 8. Milestones

Work these in order. Do not start a milestone before the previous one's
acceptance criteria pass.

### M0 — Scaffold and simulator

Create the file layout, `package.json` (ESM, Node 20+, express + dotenv),
`.env.example`, and the five `src/` modules. Game logic complete enough to play
a whole game against the fake transport.

**Accept when:** `npm run sim` plays a full six-player game end to end and
reaches a win condition. Run it 5 times; both win conditions should appear
across runs and no run should throw or hang.

### M1 — Webhook plumbing

Express server, `express.raw` on `/webhooks/linq`, HMAC verification behind a
`VERIFY_SIGNATURES` env flag (default off until it's proven), 200-before-process,
`event_id` dedupe, a `GET /debug/state` route, and full raw-event logging.

**Accept when:** ngrok tunnel is up, a webhook subscription points at it, and
texting the Linq number prints a parsed `message.received` with a correctly
normalized E.164 sender and a chat id.

### M2 — Lobby and identity mapping

Handle `participant.added` and inbound group messages to capture
`groupChatId`. Implement the join flow: a player DMs the bot, which stores their
`dmChatId` and confirms the seat in the group.

**Accept when:** three people can each claim a seat from their own phone, the
group chat shows the lobby filling, and `/debug` prints a roster where every
player has a non-null `dmChatId`.

### M3 — Reaction voting (do the 4.1 spike first)

Confirm group tapbacks produce identifiable events. Then implement `postBallot`,
`recordVote`, the tally, and the live edit.

**Accept when:** the bot posts a 3-candidate ballot in the group, three people
tapback different names, and the tally message updates in place with the correct
counts. Changing your vote by reacting to a different name moves the count.

### M4 — Full loop on real phones

Roles, night ballots in DMs, mafia group chat spawn, dawn resolution, day timer,
lynch vote, win detection, graveyard chat.

**Accept when:** a complete game runs to a win condition with 5+ real people
and nobody has to be told to ignore a broken message.

### M5 — Resilience

State survives a process restart mid-game. `/status`, `/debug`, and `/skip`
work from any chat. Every API call failure is caught and logged without killing
the phase. A `DEMO_MODE` env var shortens all timers and seeds role assignment
so night one always produces a kill.

**Accept when:** you can `kill -9` the server mid-night-phase, restart it, and
the game continues from the same phase with the same roster.

### M6 — Playtest with strangers

Run a full game with people who did not build it. Every ambiguity in your
message copy will surface here and nowhere else. Fix the copy, not the code.

**Accept when:** nobody asks "wait, what am I supposed to do?" during a round.

### Stretch (only after M6 passes)

Priority order: an LLM narrator that writes flavor from game state; an
LLM-controlled player that bluffs in the group thread; TTS night narration as a
voice note; a generated image per death; a second game (Spyfall) on the same
engine to make the "platform not toy" argument.

---

## 9. Test strategy

- **Rules:** `npm run sim` only. Never debug game logic through phones.
- **Add a seeded mode** to the simulator (fixed RNG) so a failing game can be
  replayed exactly.
- **Transport:** a `scripts/smoke.js` that creates a chat, sends a message,
  reacts to it, and edits it, printing each raw response. Run this whenever a
  Linq call starts behaving oddly — it separates API problems from game bugs.
- **Webhooks:** log every raw event to `data/events.log` during development.
  When something desyncs, that file tells you what actually arrived.

---

## 10. Commands

| Command | Where | Effect |
| --- | --- | --- |
| `/new` | group | wipe state, open the lobby |
| `join <name>` | DM | claim a seat; registers the DM chat id |
| `/start` | group | assign roles, spawn mafia chat, begin night 1 |
| `/status` | anywhere | current phase and who's alive |
| `/debug` | anywhere | roster with chat-id mapping |
| `/skip` | anywhere | force the current phase to end |

`/debug` and `/skip` are the on-stage recovery tools. Do not remove them for
"polish."

---

## 11. Failure modes to handle explicitly

| Failure | Handling |
| --- | --- |
| Mafia submit no night vote | pick a random non-mafia target |
| Tie in the lynch vote | nobody dies; announce it |
| A player reacts to a dead player's name | ignore; optionally tapback 😂 |
| A non-player reacts to a ballot | ignore silently |
| Message edit fails | swallow; tally stops updating, game continues |
| Mafia group chat creation fails | fall back to the lone mafia's DM |
| Graveyard creation fails | log and continue; it's cosmetic |
| Duplicate webhook | dedupe on `event_id` |
| Process crash | reload `data/state.json` and resume the current phase |

---

## 12. Demo requirements

The demo is the deliverable. Build toward this specific sequence:

1. A judge is added to a real group chat, or texts the number to take a seat.
2. Roles go out. The judge's phone buzzes with a private role.
3. Night one. The mafia group chat materializes on the mafia players' phones.
4. Dawn, a pause, a death announcement with the role revealed.
5. A vote where tapbacks move a live tally in the group.
6. The graveyard chat appears for the dead.

Requirements that follow from this:

- `DEMO_MODE` with ~45s phases so a full round fits in a few minutes.
- Seeded roles guaranteeing a night-one kill.
- The whole thing must survive the judge doing something unexpected — reacting
  twice, texting nonsense, voting for a corpse.
- Have `/debug` ready. Recovering gracefully on stage reads as competence.

---

## 13. Environment

```
LINQ_API_KEY=
LINQ_FROM=+1XXXXXXXXXX
LINQ_WEBHOOK_SECRET=
VERIFY_SIGNATURES=false
PORT=3000
NIGHT_SECS=75
DAY_SECS=120
VOTE_SECS=75
DEMO_MODE=false
```

Sandbox access expires — check the dashboard banner for the date and note it
before a long session.

---

## 14. Running log of confirmed facts

Append here as you verify things. This is how the next session avoids
re-learning what this one figured out.

- [x] **Response envelope is bare, not `{ data: ... }` wrapped** — but the two
  endpoints tested nest differently. `POST /chats` returns
  `{ chat: { id, is_group, handles, message: { id, parts, ... }, ... } }`.
  `POST /chats/{chatId}/messages` returns a flatter
  `{ chat_id, message: { id, parts, ... } }`. `src/linq.js` extracts ids
  accounting for both shapes; re-check when a new endpoint is added.
- [x] **Reactions work, but only after the message has actually sent.**
  Calling `POST /messages/{id}/reactions` immediately after `sendMessage`
  returned `500` / error `3006` ("Cannot send reaction"); the identical call
  ~60s later succeeded (`{ "message": "Reaction processed", "status":
  "accepted" }`); a flat 5s delay was also sufficient on retest, though don't
  trust that exact number as a floor. Sent messages come back with
  `delivery_status: "pending"` and `sent_at: null` at first — treat as
  not-yet-reactable until delivered. Matters for the "tapback a 😂" theater
  bit (§7): don't fire it immediately after the triggering message.
- [x] **`PATCH /messages/{id}` edit is unreliable — do not build the live
  tally on it.** Tried both `{ parts: [...] }` and `{ message: { parts: [...]
  } } }` bodies, immediately and after a 15s delay: all four attempts
  returned `500` / error `3006` ("Internal server error"). Linq's own docs
  describe 3006 as a generic "unhandled failure," not shape-specific, so this
  isn't a body-format problem we can fix by guessing harder. **Go straight to
  the §4.2 fallback**: post a fresh tally message on each vote change instead
  of editing in place, wrapped in try/catch as already planned.
- [x] **Unverified recipients are rejected outright, all-or-nothing, not
  silently dropped.** `POST /chats` with a mix of real (previously-texted)
  and made-up numbers returned `403` / error `2008` ("Recipient not
  allowed") for the whole request — no partial group creation, no silent
  filtering. Also confirmed: `to` must not include the `from` handle itself
  (`400` / error `1005`). `src/server.js` surfaces the real Linq error body
  to the caller rather than swallowing it, which is worth keeping.
- [ ] Group tapbacks emit a webhook: yes / no. Payload shape: (this tests
  *inbound* human reactions via webhook — separate from the outbound
  `addReaction` call confirmed above, and still the highest-risk unknown)
- [ ] Reactor identity field name:
- [ ] Inbound sender field name:
- [ ] Inbound chat id field name:
- [ ] Group detection field:
- [ ] Typing endpoint (V3) confirmed path:
- [ ] Cold DM to a number that never texted us: delivered / filtered / rejected
