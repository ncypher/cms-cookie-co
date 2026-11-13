-- Ways customers can pay, with an on/off switch each (Admin -> Payments). No card processing yet.
-- Seeded from what the site shows today, so the public site looks the same after this runs:
-- Venmo @CmsCookieCo on, cash at pickup on, Cash App off until Shaun types her cashtag.
-- The card row is a placeholder ("coming soon"): customers never see it and it can't be switched on.
CREATE TABLE payment_methods (
  id         TEXT PRIMARY KEY CHECK (id IN ('venmo', 'cashapp', 'cash', 'card')),
  enabled    INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  handle     TEXT,                              -- Venmo username / Cash App cashtag, without @ or $
  sort       INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by TEXT
);
INSERT INTO payment_methods (id, enabled, handle, sort) VALUES
  ('venmo',   1, 'CmsCookieCo', 10),
  ('cashapp', 0, NULL,          20),
  ('cash',    1, NULL,          30),
  ('card',    0, NULL,          40);
