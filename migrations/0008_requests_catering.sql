-- Requests are saved: catering quotes and "Upon Request" custom orders land in Admin -> Requests
-- instead of only going out as a text/email. Catering is switched OFF until Shaun turns it on, so the
-- public site looks the same after this runs.
CREATE TABLE requests (
  id           TEXT PRIMARY KEY,                -- REQ-MMDD-XXXX
  kind         TEXT NOT NULL CHECK (kind IN ('catering', 'custom')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  name         TEXT NOT NULL,
  phone        TEXT NOT NULL,
  email        TEXT,
  event_date   TEXT,                            -- YYYY-MM-DD (required for catering)
  headcount    INTEGER,                         -- people / servings
  fulfillment  TEXT CHECK (fulfillment IN ('pickup', 'delivery')),
  interests    TEXT NOT NULL DEFAULT '[]',      -- JSON list of what they'd like
  budget       TEXT,
  notes        TEXT,
  package_id   INTEGER,                         -- the package they tapped "Ask about this" on, if any
  status       TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'quoted', 'booked', 'done', 'declined')),
  quote_cents  INTEGER,
  admin_notes  TEXT,                            -- private, only in admin
  client_hash  TEXT,                            -- salted IP hash, same per-device limit as orders
  email_status TEXT,
  updated_at   TEXT,
  updated_by   TEXT
);
CREATE INDEX requests_created ON requests (created_at DESC);
CREATE INDEX requests_client_recent ON requests (client_hash, created_at);

-- One row of catering settings.
CREATE TABLE catering (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  enabled     INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  intro       TEXT,
  notice_days INTEGER NOT NULL DEFAULT 7 CHECK (notice_days BETWEEN 0 AND 90),
  items_json  TEXT NOT NULL DEFAULT '[]',        -- the things she caters (checkboxes on the form)
  updated_at  TEXT,
  updated_by  TEXT
);
INSERT INTO catering (id, enabled, intro, notice_days, items_json) VALUES (1, 0,
  'Cookies for your party, shower, office or wedding. Tell Shaun about your event and she''ll text you a quote.', 7,
  '["Cookie trays","Cookie cake bites","Mini cookie cakes","Cookie cupcakes","Cookie sheet cakes","Custom designs & colors"]');

CREATE TABLE catering_packages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  description    TEXT,
  from_cents     INTEGER,                       -- "from $X"; NULL = ask
  serves         INTEGER,                       -- "serves N"; NULL = not shown
  photo_key      TEXT,                          -- 4:3 photo from the Photo Studio
  photo_orig_key TEXT,
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort           INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX catering_packages_sort ON catering_packages (sort, id);
