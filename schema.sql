-- Roles live on users: current_game already limits a person to one game at a
-- time, so there is never a second live role competing for the row. beginGame
-- overwrites role and resets alive, so nothing needs clearing at game end.
alter table users add column if not exists role text;
alter table users add column if not exists alive boolean not null default true;

-- Linq has no way to look up an existing 1:1 chat, so the id has to be kept
-- from the chats.create call that made it.
alter table users add column if not exists dm_chat_id text;

alter table games add column if not exists round int not null default 0;

-- A prompt sent by DM and the answer to it. Written with target null when the
-- question goes out, filled in when the reply arrives on its own webhook.
-- Doubles as the game log.
create table if not exists actions (
  id          bigint generated always as identity primary key,
  game_id     bigint not null references games(id) on delete cascade,
  round       int    not null,
  phase       text   not null,              -- 'night' | 'day'
  actor       bigint not null references users(id),
  kind        text   not null,              -- 'mafia_kill' | 'doctor_save' | 'detective_check' | 'vote'
  target      bigint references users(id),
  asked_at    timestamptz not null default now(),
  answered_at timestamptz
);

create index if not exists actions_open_idx
  on actions (game_id, round) where answered_at is null;

-- One live poll per game, so the mapping from iMessage poll options to player
-- ids lives on the game rather than in a table of its own.
alter table games add column if not exists poll_message_id text;
alter table games add column if not exists poll_option_map jsonb;
