-- Flavors and treats become data Shaun can add in /admin, instead of lists hard-coded in the site.

-- Flavors stay as menu rows (kind = 'flavor', key = 'flavor-<id>'), so their current on/off state carries over.
ALTER TABLE menu ADD COLUMN short TEXT;            -- name in the box builder ("Choc Chip")
ALTER TABLE menu ADD COLUMN description TEXT;
ALTER TABLE menu ADD COLUMN photo_key TEXT;        -- R2 photo (from the Photo Studio)
ALTER TABLE menu ADD COLUMN photo_orig_key TEXT;   -- untouched original, for "Edit photo"
ALTER TABLE menu ADD COLUMN asset TEXT;            -- built-in photo shipped with the site (the first four flavors)
ALTER TABLE menu ADD COLUMN starts TEXT;           -- YYYY-MM-DD, inclusive; NULL = no start
ALTER TABLE menu ADD COLUMN ends TEXT;             -- YYYY-MM-DD, inclusive; NULL = no end
ALTER TABLE menu ADD COLUMN in_flight INTEGER NOT NULL DEFAULT 1 CHECK (in_flight IN (0, 1)); -- in the Cookie Tasting Flight

-- The four flavors exactly as the site showed them before (names, sort and active are left alone).
UPDATE menu SET short = 'Choc Chip',     asset = '/assets/f-cc.webp',   description = 'The classic. Golden edges, soft middle, chocolate in every bite.' WHERE key = 'flavor-cc';
UPDATE menu SET short = 'Double Choc',   asset = '/assets/f-dcc.webp',  description = 'Chocolate dough loaded with even more chocolate chips.' WHERE key = 'flavor-dcc';
UPDATE menu SET short = 'Sea Salt',      asset = '/assets/f-dcss.webp', description = 'Dark chocolate chunks finished with flaky sea salt.' WHERE key = 'flavor-dcss';
UPDATE menu SET short = 'Frosted Sugar', asset = '/assets/f-fs.webp',   description = 'Soft sugar cookie, a thick swirl of frosting, sprinkles on top.' WHERE key = 'flavor-fs';

-- Extra orderable items ("More treats"). Priced by the server like everything else.
CREATE TABLE treats (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  price_cents    INTEGER NOT NULL,
  description    TEXT,
  category       TEXT,
  photo_key      TEXT,
  photo_orig_key TEXT,
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  starts         TEXT,
  ends           TEXT,
  sort           INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX treats_sort ON treats (sort, id);
