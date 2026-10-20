-- LOCAL DEMO CONTENT ONLY. Applied by `npm run db:seed:dev` (always --local).
-- Never run this against the production database; Shaun adds real content in /admin.
-- Image/video keys match objects uploaded to local R2 by scripts/seed-dev.mjs.
DELETE FROM specials; DELETE FROM events; DELETE FROM media;

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
