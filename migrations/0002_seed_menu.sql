-- Menu as printed on Shaun's flyer.
INSERT INTO menu (key, kind, name, price_cents, active, sort) VALUES
  ('dozen',  'item', '1 Dozen',                    2500, 1, 10),
  ('half',   'item', '1/2 Dozen',                  1300, 1, 20),
  ('single', 'item', 'Single cookie',               400, 1, 30),
  ('flight', 'item', 'Cookie Tasting Flight',      1000, 1, 40),
  ('mini12', 'item', 'Mini Cookie Lunch Box (12)', 1200, 1, 50),
  ('mini24', 'item', 'Mini Cookie Lunch Box (24)', 2000, 1, 60),
  ('gram',   'item', 'Cookie Gram',                 900, 1, 70),
  ('flavor-cc',   'flavor', 'Chocolate Chip',          NULL, 1, 110),
  ('flavor-dcc',  'flavor', 'Double Chocolate Chip',   NULL, 1, 120),
  ('flavor-dcss', 'flavor', 'Dark Chocolate Sea Salt', NULL, 1, 130),
  ('flavor-fs',   'flavor', 'Frosted Sugar Cookie',    NULL, 1, 140);
