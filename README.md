# CMS Cookie Co. & More

The website for Shaun Marie Schwartz's home bakery in South Lyon, MI: **[cmscookieco3more.com](https://cmscookieco3more.com)**.

- **The site:** a one-page flyer design. Customers browse flavors, treats (some with sizes), Cookie of the Month and specials, then build an order. Orders are saved, emailed to Shaun, and can be paid with Venmo, Cash App or cash at pickup.
- **Events** can take signups with a price per spot and a limit.
- **Catering and "Upon Request" custom orders** arrive as Requests that Shaun quotes.
- **The Kitchen** (`/admin`, behind a sign-in) is Shaun's phone-first admin. It has tabs for Orders, Requests, Specials, Events, Media, Menu, Payments and Help.
  - The **Photo Studio** frames and brightens photos on her phone before upload.
  - **Help** has "Show me" pictures and clips for every task.
  - `/kitchen` shows how to put the Kitchen on her home screen.
- **Spreadsheets:** orders, signups and requests download as spreadsheets.
- **Card payments (Square)** are built and tested, but stay switched off ("Coming soon") until production Square secrets exist. See [DEPLOY.md §8](DEPLOY.md#8-card-payments-with-square-off-until-you-do-this).

Ownership, costs and how to hand the site over are in [HANDOFF.md](HANDOFF.md). Rebuilding production from scratch is in [DEPLOY.md](DEPLOY.md).

## Where everything lives

| What | Where |
|---|---|
| Code | This repo. `public/` is the site and the Kitchen (`public/admin/`), `src/worker.js` routes, `src/access.js` sign-in check, `src/square.js` card payments |
| Hosting | Cloudflare Worker `cms-cookie-co` on `cmscookieco3more.com` (www redirects to it) |
| Database | Cloudflare D1 `cms`: menu, flavors, treats, specials, events, signups, orders, requests, catering, payment settings. Schema in `migrations/` |
| Photos and videos | Cloudflare R2 bucket `cms-media`, served at `/media/…` |
| Email | Cloudflare Email Routing. The Worker sends notifications from `orders@` to Shaun's Gmail (`NOTIFY_TO` in `wrangler.jsonc`). `orders@` and `hello@` forward to the same Gmail |
| Kitchen sign-in | Cloudflare Access app **CMS Admin** on `/admin` and `/api/admin` (one-time code by email). The Worker also checks the Access token itself |
| Secrets (names only) | `ADMIN_EMAILS`, `RATE_LIMIT_SALT`. For card payments later: `SQUARE_APP_ID`, `SQUARE_APP_SECRET`, `SQUARE_TOKEN_ENC_KEY`, `SQUARE_WEBHOOK_SIGNATURE_KEY` |
| Scheduled job | Daily at 09:17 UTC: renews the Square connection (does nothing until Square is set up) |
| Help guide | `guide/tasks.json` holds the words and taps; `npm run guide` makes `public/admin/help/` |

## Run it locally

```sh
cd site
npm install
cp .dev.vars.example .dev.vars   # lets the Kitchen work on localhost without the sign-in
npm run seed:dev                 # local demo content (local only, never production)
npm run dev                      # http://localhost:8787 and http://localhost:8787/admin/
```

Local data lives in `.wrangler/state` (gitignored). Emails don't send locally; Wrangler saves a copy under `.wrangler/tmp/email`. To try card payments locally, put Square **sandbox** values in `.dev.vars` (see `.dev.vars.example`).

## Test

```sh
npm test          # the whole suite; no Cloudflare or Square account needed
npm run guide     # re-make the Help pictures and clips after any Kitchen change
```

`npm run guide` needs ffmpeg on PATH and `npx playwright install chromium` once. It starts its own `wrangler dev` with a pretend Square, so stop any running `npm run dev` first. Change Help words in `guide/tasks.json`, never in the output. The tests fail if they disagree.

## Deploy

```sh
npx wrangler login                          # Tom's Cloudflare login
npx wrangler d1 migrations apply cms --remote   # only when migrations/ has a new file; back up first:
#   npx wrangler d1 export cms --remote --output <somewhere outside the repo>.sql
npx wrangler deploy
```

## Good to know

- **Prices come from the database.** Checkout sends only what was picked, and the Worker re-prices every order, signup and card payment itself.
- **Venmo / Cash App names** are in Kitchen → Payments. **Phone and contact email** are in the `CONFIG` block in `public/index.html`. **Notification addresses** are in `wrangler.jsonc`.
- **The repo is public.** Secrets go in Worker secrets or `.dev.vars` (gitignored), never in files here.
