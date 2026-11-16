# Handoff: who owns what, what it costs, and how to hand it over

Written 2026-11-16. Facts marked **not checked** were not verified when this was written. Account and billing details live in the Cloudflare dashboard, not here (this repo is public).

## 1. What exists today

**The domain.** `cmscookieco3more.com` is registered through Cloudflare Registrar, inside the Cloudflare account below. It renews by itself and next expires on **2027-10-20**. Today it's billed to whatever card is on that Cloudflare account. Cost: Cloudflare charges the registry price with no markup, about $10–11 a year for a .com (**exact renewal price not checked**).

**The Cloudflare account.** It's a dedicated account, signed in with Tom's Cloudflare login, and it holds only this site. It contains:
- **Worker `cms-cookie-co`**: the website and the Kitchen, on `cmscookieco3more.com` (www redirects to it). It runs a daily job at 09:17 UTC that renews the Square connection; that job does nothing until Square is set up.
- **D1 database `cms`**: every order, signup, request, menu item, special, event and setting. It was 193 kB on 2026-11-16.
- **R2 bucket `cms-media`**: Shaun's photos and videos (**size not checked**).
- **Email Routing**: `orders@` and `hello@cmscookieco3more.com` forward to Shaun's Gmail, and the Worker emails her each new order, signup and request. Her Gmail was verified on 2026-11-13.
- **Access app "CMS Admin"**: the sign-in in front of the Kitchen (one-time code by email, stays signed in for a month).
  - According to the Oct 20 setup notes, the policy "Shaun and Tom" allows Shaun's Gmail and Tom's email (**not re-checked since**).
  - The Worker also checks its own list, the `ADMIN_EMAILS` secret.
- **Worker secrets (names only):** `ADMIN_EMAILS`, `RATE_LIMIT_SALT`, and the Square set `SQUARE_APP_ID`, `SQUARE_APP_SECRET`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_TOKEN_ENC_KEY` (added 2026-11-16).
- **Card payments are staged, not on.** The Kitchen shows Connect Square, Card is switched off, and no Square account is connected. Customers see no card button.

Cost: Workers, D1, R2, Email Routing and Access (up to 50 people) all have free tiers that cover a site this size, so it should be $0 a year. **Which Workers plan the account is on was not checked.** If it's Workers Paid, that's $5 a month. Owner today: Tom.

**The GitHub repo** is `github.com/ncypher/cms-cookie-co`. It's public, holds all the code and the Help pictures, and belongs to Tom's GitHub account. Cost: $0. The live site doesn't deploy from GitHub; it deploys from a PC (see section 4).

**The Square developer app** is Tom's. It's the "card payments plug" the site uses to talk to Square, and Tom can reuse it for other clients. It never holds money. When Shaun taps Connect Square, her own Square seller account lets the app make payment links for her, and the money goes to her Square account. Cost: $0. Square takes its card fee from each sale (her Square app shows the rate).

**What Shaun owns no matter what:** her Gmail, her Square seller account (when she opens one), her Venmo and Cash App, and her content: the photos, menu, words and customer list.

## 2. Path A: Tom keeps running it

**Yearly (about an hour):**
- Check the domain shows auto-renew on and the card on the Cloudflare account is current before October.
- Run `npm test` and update Wrangler.
- Take a backup (section 3, step 1) and give Shaun a copy.
- Check the Kitchen sign-in still lets Shaun in.

**When something changes:**
- Add flavors, events and prices? Shaun does that in the Kitchen. No developer needed.
- New features, a new card, or a new email address go through Tom.
- To turn card payments on: Shaun opens her Square account, taps Connect Square → Allow in the Kitchen, and switches Card on. Then she and Tom do one $1 test payment and refund (DEPLOY.md §8). The secrets are already set.

**A plain agreement they could both keep:**
> Tom hosts and looks after cmscookieco3more.com. The domain, the website and everything on it are Shaun's. Shaun pays the domain renewal (about $11 a year) [or: Tom covers it]. Tom fixes anything that breaks within a few days and makes small changes when asked. Either of them can end this with 30 days' notice, and then Tom hands everything over using Path B, including a full copy of her data. Money from customers always goes straight to Shaun's own accounts, never through Tom.

## 3. Path B: hand it to Shaun

The account holds only her site, so handing over means making her the owner of the account and then taking Tom off. Do the steps in this order. **Tom is removed last.**

1. **Make a full copy of her data first.**
   - Database: `npx wrangler d1 export cms --remote --output cms-backup-YYYY-MM-DD.sql`
   - Photos and videos: in the dashboard, **R2 → Manage API tokens**, make a read-only token for `cms-media`. Then copy the whole bucket with any S3 tool, e.g. `rclone copy r2:cms-media ./cms-media`. Delete the token afterwards.
   - Give Shaun both, on a USB stick or in her Google Drive.
   - *Could break:* nothing; this only reads.
   - *Check:* the .sql file isn't empty, and the number of photo files looks right against what's in the Kitchen's Media tab.
2. **Shaun makes her own Cloudflare login** at dash.cloudflare.com with her Gmail.
   - *Could break:* nothing.
   - *Check:* she can sign in. She'll see an empty account of her own; that's fine.
3. **Tom invites her as Super Administrator:** Manage Account → Members → Invite → her Gmail → role **Super Administrator**. She clicks the link in the email.
   - *Could break:* nothing.
   - *Check:* signed in as herself, she can switch to this account and see cmscookieco3more.com and the Worker.
4. **Billing and the domain contact move to her.**
   - She adds her card under **Billing → Payment info**, then Tom removes his.
   - Under **Domain Registration → cmscookieco3more.com**, update the contact details to hers and confirm **auto-renew is on**.
   - *Could break:* if no valid card is on file when the domain renews (October 2027), the renewal fails, and after the grace period the site and email stop.
   - *Check:* Billing shows her card, and the domain page shows auto-renew on and her name as contact.
5. **Kitchen sign-in becomes hers alone** (only if she wants Tom out of the Kitchen too).
   - Edit the Access policy (Zero Trust → Access → Applications → CMS Admin → policy) to remove Tom's email.
   - Set `ADMIN_EMAILS` to just her Gmail: `npx wrangler secret put ADMIN_EMAILS`. This needs whoever still has a Wrangler login.
   - *Could break:* a typo locks her out of the Kitchen. The site itself keeps working.
   - *Check:* she signs in to the Kitchen on her phone right after the change.
6. **Transfer the GitHub repo.** She makes a GitHub account. Tom goes to repo **Settings → Danger zone → Transfer ownership** and enters her username, and she accepts.
   - *Could break:* nothing on the live site, because it doesn't deploy from GitHub. Old links to the repo redirect.
   - *Check:* the repo shows under her name.
7. **Decide about the Square connection.** Card payments use Tom's Square developer app. Its ID and secret are Worker secrets.
   - **Option 1, keep it:** card payments keep working as long as Tom keeps that app. If he deletes it or resets its secret, card payments stop and customers just see Venmo, Cash App and cash.
   - **Option 2, give her her own app:** whoever develops for her makes a new Square developer app and replaces `SQUARE_APP_ID`, `SQUARE_APP_SECRET` and `SQUARE_WEBHOOK_SIGNATURE_KEY`. Then she taps Connect Square once more.
   - Either way her money and her Square account are untouched. The production secrets set on 2026-11-16 are for Tom's app, so Option 1 is what happens unless someone changes them.
   - *Check:* after any change, a $1 card test shows "Paid by card".
8. **Remove Tom.** Manage Account → Members → Tom → Remove.
   - *Could break:* doing this before steps 3 and 4 would leave nobody able to pay for or change the account.
   - *Check:* Shaun still sees everything. Tom's `wrangler deploy` now fails, which is expected.
9. **Afterwards:** anyone who changes the site for her gets their own invite (Administrator role is enough) and runs `npx wrangler login` on their own PC.

## 4. If Tom's laptop dies

**Nothing on the live site depends on the laptop:**
- The code is on GitHub.
- The data is in Cloudflare.
- The secrets are stored in Cloudflare.

**What's only on the laptop:**
- The Wrangler sign-in. Fix: on any PC, run `git clone`, `cd site`, `npm ci`, `npx wrangler login`, and deploys work again.
- `square.env` and `.dev.vars`: sandbox test values, re-creatable from the Square developer console.
- If Square goes live, the copy of `SQUARE_TOKEN_ENC_KEY`. If that's lost, nothing breaks until it's needed; at worst Shaun taps Connect Square again.

**Option (not set up): deploy automatically from GitHub.** Then any change merged on GitHub goes live with no PC involved.
1. Dashboard: **Workers & Pages → cms-cookie-co → Settings → Builds → Connect**, then pick GitHub, the repo, and branch `main`.
2. Root directory `site`, build command `npm ci && npm test`, deploy command `npx wrangler deploy`.
3. Leave database migrations manual: back up, run `npx wrangler d1 migrations apply cms --remote`, then merge. Automatic migrations without a backup are a bad trade for a database this small.
4. Test it with a harmless change (a comment) and watch it appear in **Deployments**.

The trade-off: anyone who can push to `main` can change the live site, so keep the repo's write access to one or two people.

---

## For Shaun

**What's yours**
- Your website name, **cmscookieco3more.com**.
- Everything on the website: your photos, menu, prices, events, and your customers' orders.
- Your Gmail, where orders and messages arrive.
- Your Venmo and Cash App. Card payments, when they're turned on, go into your own Square account. Nobody else ever holds your money.

**What it costs**
- About **$11 a year** for the website name. It renews by itself every October (next: October 2027).
- The website itself is **free** to run at its size.
- If you take cards, Square keeps a small fee from each card sale. Your Square app shows how much.

**Who to call**
- **The website or the Kitchen isn't working, or you want something changed:** Tom.
- **A card payment, a refund, or money from card sales:** Square. Use the help button in your Square app.
- **Venmo or Cash App money:** Venmo or Cash App, as usual.

**Two habits that help**
- Once a year, ask Tom for a copy of your website's photos and orders to keep.
- If you change your card, tell Tom (or whoever looks after the site) so the website name keeps renewing.
