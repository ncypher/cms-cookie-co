# Deploying cmscookieco3more.com

This takes the site from GitHub Pages to a Cloudflare Worker with D1 (database), R2 (photos and videos), Email Routing and Cloudflare Access. Do the steps in order. Plan on about 45 minutes, most of it waiting on DNS and verification emails.

Wrangler commands are exact. Email Routing and Access have no Wrangler commands, so those steps are dashboard click paths.

> **Never run `npm run seed:dev` against production.** It's local demo content and every command in it uses `--local`. Shaun adds real specials, events and media in `/admin`.

## 0. Before you start

- `cmscookieco3more.com` is registered with Cloudflare Registrar, so the zone already exists in the account.
- Node 20 or newer.
- In DNS (**dash.cloudflare.com → cmscookieco3more.com → DNS → Records**), delete any `A`, `AAAA` or `CNAME` records on `@` and `www` (registrar parking records, or anything pointing at GitHub Pages). `wrangler deploy` can't attach custom domains while those exist. Leave `MX`/`TXT` records alone.

```sh
cd site
npm ci
npx wrangler login
npx wrangler whoami        # confirm it's the account that owns cmscookieco3more.com
npm test                   # Access/JWT tests, no account needed
```

## 1. Email Routing (orders@ and hello@ → Shaun's Gmail)

Do this first. The Worker's `send_email` binding only delivers to verified Email Routing destinations.

1. **cmscookieco3more.com → Email → Email Routing → Get started / Enable.** Accept the MX and TXT (SPF) records it offers to add.
2. **Destination addresses → Add destination address** → `cmscookieco3more@gmail.com`. Shaun clicks the link in the verification email Cloudflare sends her. The status must read **Verified**.
3. **Routing rules → Create address:**
   - Custom address `orders` → Action **Send to an email** → `cmscookieco3more@gmail.com` → Save.
   - Custom address `hello` → Action **Send to an email** → `cmscookieco3more@gmail.com` → Save.
4. Test: from another account, email `hello@cmscookieco3more.com`. It should land in Shaun's Gmail within a minute.

Order notifications are sent **from** `orders@cmscookieco3more.com` **to** `cmscookieco3more@gmail.com`. Both are already allow-listed in `wrangler.jsonc` (`send_email` binding, `NOTIFY_FROM`, `NOTIFY_TO`). If Shaun replies to a notification, the reply goes to orders@, which forwards to her Gmail.

## 2. D1 database `cms`

```sh
npx wrangler d1 create cms
```

Copy the printed `database_id` into `wrangler.jsonc`, replacing `00000000-0000-0000-0000-000000000000`. Then commit that change.

```sh
npx wrangler d1 migrations apply cms --remote
npx wrangler d1 execute cms --remote --command "SELECT key, price_cents, active FROM menu ORDER BY sort"
```

You should see the 7 menu items (dozen 2500, half 1300, single 400, flight 1000, mini12 1200, mini24 2000, gram 900) and the 4 flavors.

## 3. R2 bucket `cms-media`

If R2 has never been used on this account, enable it once under **R2 Object Storage** in the dashboard. That's the free tier, though it may ask for a payment method.

```sh
npx wrangler r2 bucket create cms-media
npx wrangler r2 bucket list
```

The bucket stays private. The Worker serves files at `/media/...`. Uploads are limited to mp4, jpg, png and webp, 100 MB maximum, and the Worker checks each file's actual bytes, not just its name.

## 4. Cloudflare Access for /admin

1. **dash.cloudflare.com → Zero Trust.** The first time, pick a team name (for example `cmscookie`, giving the team domain `cmscookie.cloudflareaccess.com`) and choose the **Free** plan (up to 50 users).
2. **Settings → Authentication → Login methods:** keep **One-time PIN** (works with any email, including Gmail). You can also add Google so Shaun can tap "Sign in with Google".
3. **Access → Applications → Add an application → Self-hosted:**
   - Application name: `CMS Admin`
   - Session duration: `1 month`, so Shaun isn't asked for a PIN every day on her phone
   - Public hostname 1: domain `cmscookieco3more.com`, path `admin`
   - Public hostname 2: domain `cmscookieco3more.com`, path `api/admin`
   - Policy: name `Shaun and Tom`, action **Allow**, Include → **Emails** → `cmscookieco3more@gmail.com` and `<TOM_EMAIL>`
   - Save.
4. Open the application's **Overview** and copy the **Application Audience (AUD) Tag**.
5. Put both values in `wrangler.jsonc` under `vars` and commit. Neither is secret:

   ```jsonc
   "ACCESS_TEAM_DOMAIN": "cmscookie.cloudflareaccess.com",
   "ACCESS_AUD": "<the AUD tag>"
   ```

6. Optional second lock: an allowlist checked by the Worker itself, kept out of the public repo:

   ```sh
   npx wrangler secret put ADMIN_EMAILS
   # paste: cmscookieco3more@gmail.com,<TOM_EMAIL>
   ```

The Worker doesn't trust the route. Every `/admin` and `/api/admin/*` request must carry a `Cf-Access-Jwt-Assertion` token signed by your team's Access keys, with the right AUD and issuer, and not expired. If `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is empty, admin returns 503 (fails closed). `ACCESS_DEV_BYPASS` is only honored on `localhost`; never set it in production.

## 5. Deploy

Orders are rate-limited per device: the `ORDER_LIMITER` binding allows 5 attempts per minute, and D1 caps it at 5 orders per 10 minutes. The device is identified by a salted hash of its IP; the raw IP is never stored. Set the salt once:

```sh
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))" | npx wrangler secret put RATE_LIMIT_SALT
```

```sh
npx wrangler deploy --dry-run    # builds and validates; creates nothing
npx wrangler deploy
```

`wrangler deploy` uploads the Worker and the `public/` assets and attaches both custom domains from `wrangler.jsonc` (`cmscookieco3more.com` and `www.cmscookieco3more.com`). Cloudflare creates the DNS records and certificates for them. The Worker 301-redirects `www` to the apex.

## 6. Check it's live

```sh
curl -s https://cmscookieco3more.com/api/content | head -c 400; echo
curl -sI https://www.cmscookieco3more.com/ | grep -iE "^HTTP|^location"        # 301 → https://cmscookieco3more.com/
curl -sI https://cmscookieco3more.com/api/admin/me | grep -iE "^HTTP|^location" # 302 → ...cloudflareaccess.com (Access login), never JSON
```

Then on a phone:

1. Open `https://cmscookieco3more.com/admin`. Enter Shaun's email, then the PIN, and the Orders screen loads.
2. On the home page, place a small test order and tap **Send order now**. Shaun should get "Cookie order CMS-… from …" in Gmail, and the order should appear in Admin → Orders.
3. Remove the test order:

   ```sh
   npx wrangler d1 execute cms --remote --command "DELETE FROM orders WHERE name = 'Test Order'"
   ```

## 7. Retire GitHub Pages

After the Cloudflare site is live, go to **github.com/ncypher/cms-cookie-co → Settings → Pages → Unpublish site** (or set Source to None). After this branch merges there's no `index.html` at the repo root, so the github.io copy would 404 anyway.

## Day to day

```sh
npx wrangler tail                       # live logs
npx wrangler deployments list
npx wrangler rollback                   # back to the previous version
npx wrangler d1 export cms --remote --output backup.sql   # backup of orders and content
```

Schema changes go in a new file in `migrations/`, then run `npx wrangler d1 migrations apply cms --remote` before `wrangler deploy`.
