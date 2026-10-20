# CMS Cookie Co. & More

Website for Shaun Marie Schwartz's home bakery in South Lyon, MI: **cmscookieco3more.com**.

It runs as a Cloudflare Worker with static assets, D1 for data, R2 for photos and videos, and Email Routing for order notifications. Shaun manages specials, events, media, menu prices and orders at `/admin`, which Cloudflare Access protects.

## Layout

```
public/                  static site (served by the Worker's assets binding)
  index.html             home page, the flyer design (formerly Concept 2)
  admin/index.html       phone-first admin app
  concepts/modern/       Concept 1, kept for reference (unlinked, noindex)
  assets/                logo, flavor photos, flyer images
src/worker.js            routes: /api/content, /api/orders, /media/*, /admin, /api/admin/*
src/access.js            Cloudflare Access JWT verification
migrations/              D1 schema + seeded menu
seed/, scripts/          local-only demo content (never run against production)
test/                    node --test suite for the Access gate
DEPLOY.md                one-time production setup, step by step
```

## Run it locally

```sh
cd site
npm install
cp .dev.vars.example .dev.vars   # lets /admin work on localhost without Access
npm run seed:dev                 # local D1 migrations + demo specials/events/media + local R2 files
npm run dev                      # http://localhost:8787  and  http://localhost:8787/admin/
npm test
```

Local D1 and R2 data live in `.wrangler/state` (gitignored). Order emails don't send locally. Wrangler logs each one and saves a copy under `.wrangler/tmp/email`.

## How things work

- **Prices** live in the D1 `menu` table. The page shows the flyer prices first, then updates them from `/api/content`. Checkout sends only item types and quantities, and the Worker re-prices every order from D1, so a tampered browser can't change a total.
- **Orders** are validated, stored in D1, and emailed to Shaun from orders@cmscookieco3more.com. If the API is unreachable, the checkout's text, email and copy buttons still work. Venmo is @CmsCookieCo.
- **Cookie of the Month and Specials** are rows in `specials` (`kind` = `cotm` or `special`). They show while `active` is on and today falls within their `starts`/`ends` dates.
- **Events** show until their date passes.
- **Tip of the Week** is the newest featured video or Instagram link in `media`. Featured photos show in a strip under it.
- **Admin security:** Cloudflare Access sits in front of `/admin` and `/api/admin/*`, and the Worker separately verifies the Access JWT on every request (signature, audience, issuer, expiry). Admin writes must also be same-origin.

## Edit contact info

Phone, email and Venmo are in the `CONFIG` block near the top of the `<script>` in `public/index.html`. The notification addresses are in `wrangler.jsonc` (`NOTIFY_TO`, `NOTIFY_FROM`, and the `send_email` allowlist).
