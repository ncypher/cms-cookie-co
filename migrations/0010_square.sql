-- Square card payments. Ships dark: nothing here changes what the site shows until the Worker has
-- Square app credentials AND Shaun taps "Connect Square". Only adds tables and empty columns, so
-- every existing row reads exactly as before.

-- The one Square connection (Shaun's seller account). Tokens are AES-GCM encrypted with
-- SQUARE_TOKEN_ENC_KEY before they get here and are never sent to the browser.
CREATE TABLE square_connection (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  status            TEXT NOT NULL CHECK (status IN ('connected', 'disconnected')),
  merchant_id       TEXT,
  business_name     TEXT,
  location_id       TEXT,                       -- where card payments land (the main location)
  location_name     TEXT,
  access_token_enc  TEXT,
  refresh_token_enc TEXT,
  expires_at        TEXT,                       -- access token expiry (ISO)
  refreshed_at      TEXT,                       -- last time we got a fresh access token
  connected_at      TEXT,
  connected_by      TEXT,
  disconnected_at   TEXT,
  disconnect_reason TEXT,
  last_error        TEXT                        -- plain words, never a token
);

-- One-time "state" values for the Connect Square round trip (CSRF guard). Used once, kept 15 minutes.
CREATE TABLE square_oauth_states (
  state      TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  created_by TEXT
);

-- Square-hosted payment links we made, so a payment can be matched back to the order it pays for.
CREATE TABLE square_links (
  id              TEXT PRIMARY KEY,             -- Square payment link id
  ref_kind        TEXT NOT NULL CHECK (ref_kind IN ('order', 'signup', 'request')),
  ref_id          TEXT NOT NULL,                -- CMS-..., EV-..., REQ-...
  amount_cents    INTEGER NOT NULL,             -- priced by the server when the link was made
  square_order_id TEXT NOT NULL UNIQUE,
  url             TEXT NOT NULL,
  merchant_id     TEXT,
  location_id     TEXT,
  payment_id      TEXT,                         -- set once, when Square says it's paid
  paid_at         TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by      TEXT                          -- 'customer' or the admin's email
);
CREATE INDEX square_links_ref ON square_links (ref_kind, ref_id, created_at DESC);

-- Webhook events already handled (Square can deliver the same event more than once).
CREATE TABLE square_events (
  event_id    TEXT PRIMARY KEY,
  type        TEXT,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- How it was paid. NULL = not by card (Shaun switched Paid on herself, as today).
ALTER TABLE orders ADD COLUMN paid_method TEXT;
ALTER TABLE orders ADD COLUMN square_payment_id TEXT;
ALTER TABLE orders ADD COLUMN paid_at TEXT;
ALTER TABLE orders ADD COLUMN pay_token TEXT;          -- lets the customer who placed it pay by card
CREATE UNIQUE INDEX orders_square_payment ON orders (square_payment_id) WHERE square_payment_id IS NOT NULL;

ALTER TABLE registrations ADD COLUMN paid_method TEXT;
ALTER TABLE registrations ADD COLUMN square_payment_id TEXT;
ALTER TABLE registrations ADD COLUMN paid_at TEXT;
ALTER TABLE registrations ADD COLUMN pay_token TEXT;
CREATE UNIQUE INDEX registrations_square_payment ON registrations (square_payment_id) WHERE square_payment_id IS NOT NULL;

-- Requests had no Paid switch; a quoted request can now be paid by card.
ALTER TABLE requests ADD COLUMN paid INTEGER NOT NULL DEFAULT 0 CHECK (paid IN (0, 1));
ALTER TABLE requests ADD COLUMN paid_method TEXT;
ALTER TABLE requests ADD COLUMN square_payment_id TEXT;
ALTER TABLE requests ADD COLUMN paid_at TEXT;
ALTER TABLE requests ADD COLUMN pay_token TEXT;
CREATE UNIQUE INDEX requests_square_payment ON requests (square_payment_id) WHERE square_payment_id IS NOT NULL;
