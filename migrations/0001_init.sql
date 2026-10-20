-- CMS Cookie Co. schema. Money is stored as integer cents.

CREATE TABLE menu (
  key         TEXT PRIMARY KEY,                 -- dozen, half, single, flight, mini12, mini24, gram, flavor-cc ...
  kind        TEXT NOT NULL CHECK (kind IN ('item', 'flavor')),
  name        TEXT NOT NULL,
  price_cents INTEGER,                          -- NULL for flavors (priced by the item they go in)
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE orders (
  id           TEXT PRIMARY KEY,                -- CMS-MMDD-XXXX
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  name         TEXT NOT NULL,
  phone        TEXT NOT NULL,
  wanted_date  TEXT NOT NULL,                   -- YYYY-MM-DD
  fulfillment  TEXT NOT NULL CHECK (fulfillment IN ('pickup', 'delivery')),
  dietary      TEXT,
  notes        TEXT,
  items_json   TEXT NOT NULL,                   -- server-priced line items
  total_cents  INTEGER NOT NULL,
  confirmed    INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
  paid         INTEGER NOT NULL DEFAULT 0 CHECK (paid IN (0, 1)),
  email_status TEXT,                            -- sent | failed | skipped
  updated_at   TEXT,
  updated_by   TEXT
);
CREATE INDEX orders_created ON orders (created_at DESC);

CREATE TABLE specials (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL DEFAULT 'special' CHECK (kind IN ('special', 'cotm')),  -- cotm = Cookie of the Month
  title       TEXT NOT NULL,
  body        TEXT,
  price_cents INTEGER,
  image_key   TEXT,                             -- R2 key in cms-media
  starts      TEXT,                             -- YYYY-MM-DD, inclusive; NULL = no start
  ends        TEXT,                             -- YYYY-MM-DD, inclusive; NULL = no end
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  date        TEXT NOT NULL,                    -- YYYY-MM-DD
  body        TEXT,
  flyer_key   TEXT,                             -- R2 key in cms-media
  rsvp_url    TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX events_date ON events (date);

CREATE TABLE media (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL CHECK (kind IN ('photo', 'video', 'instagram')),
  key_or_url   TEXT NOT NULL,                   -- R2 key for photo/video, https URL for instagram
  caption      TEXT,
  featured     INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0, 1)),
  content_type TEXT,
  size_bytes   INTEGER,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
