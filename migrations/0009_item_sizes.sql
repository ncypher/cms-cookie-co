-- Optional sizes on treats and specials ("Kit for 2 — $10", "Family kit — $18"), up to 6.
-- JSON list of {id, label, price_cents}. NULL = no sizes: the item behaves exactly as before
-- (one price), so Shaun's existing treats and specials look and price the same after this runs.
ALTER TABLE treats ADD COLUMN sizes_json TEXT;
ALTER TABLE specials ADD COLUMN sizes_json TEXT;
