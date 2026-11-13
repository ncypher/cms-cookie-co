-- LOCAL DEMO CONTENT ONLY. Applied by `npm run seed:dev` and `npm run guide` (always --local).
-- Never run this against the production database; Shaun adds real content in /admin.
-- Image/video keys match objects uploaded to local R2 by scripts/seed-dev.mjs.
DELETE FROM registrations; DELETE FROM specials; DELETE FROM events; DELETE FROM media;

INSERT INTO specials (kind, title, body, price_cents, image_key, starts, ends, active) VALUES
  ('cotm', 'Pumpkin Spice Sugar Cookie',
   'Soft sugar cookie with cinnamon cream cheese frosting and a sprinkle of pumpkin spice. October only!',
   450, 'img/2026/11111111-1111-4111-8111-111111111111.webp', NULL, NULL, 1),
  ('special', 'Spooky Sugar Box', 'Half dozen frosted sugar cookies in Halloween colors. Order by Oct 29.',
   1500, NULL, NULL, date('now', '+11 days'), 1),
  ('special', 'Expired sample special', 'Should never show on the site.', 500, NULL, date('now', '-60 days'), date('now', '-30 days'), 1);

INSERT INTO events (title, date, body, flyer_key, rsvp_url) VALUES
  ('South Lyon Farmers Market', date('now', '+5 days'), 'Find Shaun''s table by the gazebo, 9am to 1pm. Cookie flights while they last!',
   'img/2026/22222222-2222-4222-8222-222222222222.jpg', NULL),
  ('Holiday Cookie Decorating Class', date('now', '+47 days'), 'Decorate a dozen to take home. Ages 6 and up, all supplies included.',
   NULL, 'https://www.instagram.com/cmscookieco/'),
  ('Past sample event', date('now', '-10 days'), 'Should never show on the site.', NULL, NULL);

INSERT INTO media (kind, key_or_url, caption, featured, content_type, size_bytes) VALUES
  ('photo', 'img/2026/33333333-3333-4333-8333-333333333333.webp', 'Tasting flights boxed for the market', 1, 'image/webp', NULL),
  ('instagram', 'https://www.instagram.com/cmscookieco/', 'Follow along on Instagram', 0, NULL, NULL),
  ('video', 'video/2026/44444444-4444-4444-8444-444444444444.mp4', 'Tip of the Week: chill your dough 30 minutes for thicker, chewier cookies.', 1, 'video/mp4', NULL);

-- Reset the menu to the flyer and drop anything added in admin, so `npm run guide` always starts the same way.
DELETE FROM treats;
DELETE FROM menu WHERE kind = 'flavor' AND key NOT IN ('flavor-cc', 'flavor-dcc', 'flavor-dcss', 'flavor-fs');
UPDATE menu SET active = 1, starts = NULL, ends = NULL, in_flight = 1, photo_key = NULL, photo_orig_key = NULL WHERE kind = 'flavor';
UPDATE menu SET active = 1, price_cents = CASE key
  WHEN 'dozen' THEN 2500 WHEN 'half' THEN 1300 WHEN 'single' THEN 400 WHEN 'flight' THEN 1000
  WHEN 'mini12' THEN 1200 WHEN 'mini24' THEN 2000 WHEN 'gram' THEN 900 END
  WHERE kind = 'item';
UPDATE menu SET sort = CASE key WHEN 'flavor-cc' THEN 110 WHEN 'flavor-dcc' THEN 120 WHEN 'flavor-dcss' THEN 130 WHEN 'flavor-fs' THEN 140 ELSE sort END;

-- One open sample order (made-up customer) for the "confirm an order" guide.
DELETE FROM orders;
INSERT INTO orders (id, name, phone, wanted_date, fulfillment, dietary, notes, items_json, total_cents, email_status, created_at) VALUES
  ('CMS-1114-2048', 'Sample Customer', '(555) 555-0100', date('now', '+4 days'), 'pickup', NULL, 'Birthday! Pink sprinkles please.',
   '[{"type":"box","name":"Dozen box","detail":"6 Choc Chip, 6 Frosted Sugar","qty":1,"unit_cents":2500,"line_cents":2500},{"type":"gram","name":"Cookie Gram","detail":null,"qty":1,"unit_cents":900,"line_cents":900}]',
   3400, 'sent', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours'));

-- Ways to pay back to the launch settings (Venmo @CmsCookieCo + cash at pickup on, Cash App off).
UPDATE payment_methods SET enabled = CASE id WHEN 'venmo' THEN 1 WHEN 'cash' THEN 1 ELSE 0 END,
  handle = CASE id WHEN 'venmo' THEN 'CmsCookieCo' ELSE NULL END, updated_at = NULL, updated_by = NULL;

-- The class takes signups on the site ($35 a spot, 12 spots), with two made-up people signed up.
UPDATE events SET signups_open = 1, ticket_price_cents = 3500, capacity = 12 WHERE title = 'Holiday Cookie Decorating Class';
INSERT INTO registrations (id, event_id, name, phone, email, seats, notes, price_cents, total_cents, paid, email_status, created_at)
  SELECT 'EV-1110-3141', id, 'Sample Parent', '(555) 555-0142', NULL, 2, 'Two kids, ages 7 and 9', 3500, 7000, 1, 'sent', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day') FROM events WHERE title = 'Holiday Cookie Decorating Class';
INSERT INTO registrations (id, event_id, name, phone, email, seats, notes, price_cents, total_cents, paid, email_status, created_at)
  SELECT 'EV-1111-2718', id, 'Sample Friend', '(555) 555-0177', 'friend@example.com', 1, NULL, 3500, 3500, 0, 'sent', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 hours') FROM events WHERE title = 'Holiday Cookie Decorating Class';

-- Requests + catering back to the launch state: catering off, no packages, two made-up requests to answer.
DELETE FROM requests; DELETE FROM catering_packages;
UPDATE catering SET enabled = 0, notice_days = 7, updated_at = NULL, updated_by = NULL,
  intro = 'Cookies for your party, shower, office or wedding. Tell Shaun about your event and she''ll text you a quote.',
  items_json = '["Cookie trays","Cookie cake bites","Mini cookie cakes","Cookie cupcakes","Cookie sheet cakes","Custom designs & colors"]';
INSERT INTO requests (id, kind, name, phone, email, event_date, headcount, fulfillment, interests, budget, notes, status, email_status, created_at) VALUES
  ('REQ-1112-5150', 'catering', 'Sample Neighbor', '(555) 555-0188', NULL, date('now', '+20 days'), 40, 'delivery', '["Cookie trays","Mini cookie cakes"]', 'about $150',
   'Baby shower, pink and gold please.', 'new', 'sent', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 hours')),
  ('REQ-1111-4242', 'custom', 'Sample Coworker', '(555) 555-0199', NULL, date('now', '+9 days'), 12, NULL, '["Cookie Cupcakes"]', NULL,
   'Office birthday.', 'quoted', 'sent', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'));

-- Square: always start "not connected" (the Help guide connects to a local mock Square).
DELETE FROM square_connection; DELETE FROM square_links; DELETE FROM square_oauth_states; DELETE FROM square_events;
