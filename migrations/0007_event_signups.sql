-- Event signups (Shaun asked in October): an event can take reservations with a price per spot and a
-- limit, and can be kept as a Draft while she checks it. Existing events stay published with signups off,
-- so the site looks the same after this runs.
ALTER TABLE events ADD COLUMN published INTEGER NOT NULL DEFAULT 1 CHECK (published IN (0, 1)); -- 0 = Draft (admin only)
ALTER TABLE events ADD COLUMN ticket_price_cents INTEGER;   -- per spot; NULL = no signup on the site
ALTER TABLE events ADD COLUMN capacity INTEGER;             -- spots; NULL = no limit
ALTER TABLE events ADD COLUMN signup_closes TEXT;           -- YYYY-MM-DD, last day to sign up; NULL = the event date
ALTER TABLE events ADD COLUMN signups_open INTEGER NOT NULL DEFAULT 0 CHECK (signups_open IN (0, 1));

CREATE TABLE registrations (
  id           TEXT PRIMARY KEY,                -- reservation number EV-MMDD-XXXX
  event_id     INTEGER NOT NULL REFERENCES events (id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  name         TEXT NOT NULL,
  phone        TEXT NOT NULL,
  email        TEXT,                            -- optional
  seats        INTEGER NOT NULL CHECK (seats BETWEEN 1 AND 10),
  notes        TEXT,
  price_cents  INTEGER NOT NULL,                -- per spot, priced by the server when they signed up
  total_cents  INTEGER NOT NULL,
  paid         INTEGER NOT NULL DEFAULT 0 CHECK (paid IN (0, 1)),
  checked_in   INTEGER NOT NULL DEFAULT 0 CHECK (checked_in IN (0, 1)),
  client_hash  TEXT,                            -- salted IP hash, same per-device limit as orders
  email_status TEXT,                            -- sent | failed | skipped
  updated_at   TEXT,
  updated_by   TEXT
);
CREATE INDEX registrations_event ON registrations (event_id, created_at);
CREATE INDEX registrations_client_recent ON registrations (client_hash, created_at);
