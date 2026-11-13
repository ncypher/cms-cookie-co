# Square card payments (sandbox build): report

**Card payments are built, tested and live on cmscookieco3more.com, and switched off.** No Square secret is set in production, so customers and Shaun see exactly what they saw before: the card row says "Coming soon", there's no card button anywhere, and Help hides the three Square cards. Tests went from 117 to 140, all passing.

Shaun's live content was compared before and after the migration, table by table (row counts plus a hash of every row). Nothing changed. Production has no test records: the one live checkout check answered the order inside the browser, so nothing reached her database or inbox. The production D1 backup was taken outside the repo before migration 0010 and deleted after the checks.

## What shipped

| Stage | Commit | What |
|---|---|---|
| 1 + 2 | `56fbcb6` | Connect Square, encrypted tokens, refresh/revoke, pay with card, webhook, return check, Send pay link, Paid by card tags, spreadsheet column |
| 1 (fix) | `1be65b1` | Token renewal also runs on page loads; cron ready but off (see "Waiting on you") |
| 3 | `6a23c4d` | Help cards + clips (made against a pretend Square), Payments crash fix, all 19 cards regenerated |

Stages 1 and 2 are one commit because they share one module (`src/square.js`) and one migration.

### Stage 0: credentials
`square.env` was complete and correct. The sandbox token listed one active USD location. The app ID and secret passed Square's OAuth client check: a bogus code got "code not found", where a wrong secret gets "Not Authorized". I generated `SQUARE_TOKEN_ENC_KEY` (32 random bytes) and added it to both `square.env` and `site/.dev.vars`. `git status` never showed either file, and a scan of every file git can see found no secret value.

### Stage 1: Connect Square
- **Admin → Payments → Connect Square** sends Shaun to Square's Allow screen with a one-time state value. The scopes are payments read/write, orders read/write and merchant profile read.
- **The callback** checks the state (one use, 15 minutes), swaps the code for tokens, reads the business name and main location, and stores both tokens AES-GCM encrypted.
- **Disconnect** revokes at Square, deletes the tokens, and switches card off.
- **Renewal** happens every 6 days, with one refresh-and-retry when Square rejects a token.
- **If Square says the connection is gone** (refresh refused, `ACCESS_TOKEN_REVOKED`, or the `oauth.authorization.revoked` webhook), the site marks it disconnected and switches card off.

### Stage 2: Pay with card
- **Checkout.** After an order or a paid signup, customers see **Pay $X with card** first, then Venmo, Cash App and cash as before.
  - The server makes a Square-hosted payment link for its own total, tagged with our order number.
  - The browser can't change the amount, and only the customer who placed the order holds its pay token.
- **Marked paid two ways, exactly once:**
  - Square's signed webhook. The signature is checked against Square's own published test vectors, and replays are ignored.
  - When the customer comes back, our server asks Square itself. The return URL alone proves nothing.
  - Only a COMPLETED payment for the exact amount on the exact Square order counts. It records the Square payment ID and "Paid by card".
- **Send pay link** works on any unpaid order, paid signup, or request with a quote. It offers **Text it to …** (the link is typed into the message) and **Copy link**.
- **Refunds stay in Square.** Paid-by-card orders show **Refund? Open Square**, and Payments has **Open Square**.

### Stage 3: Kitchen screens and Help
- **Payments card row:** Connect Square → "Connected as <business>" with an on/off switch, Open Square, Disconnect (confirms in the page), and the fee note.
- **Orders, signups and requests:** a "Paid by card" tag. All three spreadsheets have a Payment method column.
- **Help cards:** "Connect Square (card payments)", "When a customer pays by card", "Send a pay link". The clips were recorded against `scripts/square-mock.mjs`, a pretend Square that only listens on this PC. The guide refuses to run if `wrangler dev` could reach the real Square.

## What I checked in the sandbox (local wrangler dev, 390 px)
- **Your real Connect Square** (thanks for the Allow tap): the callback stored both tokens encrypted, connected as "Default Test Account".
- **A full card payment through that connection:**
  1. Ordered on the site and tapped Pay with card.
  2. On Square's sandbox page, tapped Test Payment.
  3. Back on our site: "Paid. Thank you!". In admin the order said "Paid by card".
- **Declined card:** Square's declined test card was refused on that order (GENERIC_DECLINE) and our site kept it Unpaid. The customer sees "We haven't seen your payment yet".
- **A real token refresh** against Square: new token, still connected.
- **Send pay link** made a working sandbox link. **Disconnect** revoked and deleted the tokens.

One honest limit: in the sandbox, Square doesn't show a card form on payment links. It shows a "Testing Panel" with a **Test Payment** button. So the success case was Square's simulated payment, and the decline used Square's declined test card through its Payments API.

## Choices I made for you
1. **Who can pay a link.** Each order and signup gets a private pay token, so only the person who placed it, or someone Shaun texts a link to, can open its card payment.
2. **Links are reused.** Asking again for the same amount within 7 days reuses the unused link instead of making a new one. Square checkout has tipping off.
3. **$1 minimum** for card. Free signups never show a card button.
4. **A paid request** gets "Paid by card" but its status (Quoted / Booked) is left to Shaun.
5. **Help hides the Square cards** until the site has Square set up, so Shaun isn't shown a feature she can't use yet.
6. **Local return address.** wrangler dev hides the port from the Worker, so `.dev.vars` has `DEV_ORIGIN=http://localhost:8787`. It's used only on localhost; the live site always uses its own address.

## Waiting on you
- **Daily cron is off.** Cloudflare refused it because this account has no workers.dev subdomain. Renewal still happens on page loads, so nothing breaks. To turn the cron on: open Workers & Pages once in the Cloudflare dashboard (this Worker stays off workers.dev), then uncomment the line in `wrangler.jsonc` and deploy. I didn't change the account myself.
- **No live webhook delivery was tested.** That needs a public address for local dev, and downloading a tunnel tool was blocked. The webhook code is checked against Square's published signatures and the return check covers marking paid, but the first real webhook will be in production. `SQUARE_WEBHOOK_SIGNATURE_KEY` in `square.env` is still empty for the same reason.

## Going live (later)
1. **Production app.** Square Developer Console → your app → **Production**:
   - **OAuth:** Redirect URL `https://cmscookieco3more.com/api/admin/square/callback`
   - **Webhooks → Add subscription:** `https://cmscookieco3more.com/api/square/webhook`, events `payment.created`, `payment.updated`, `oauth.authorization.revoked`. Copy its signature key.
2. **Worker secrets:** `npx wrangler secret put` for `SQUARE_APP_ID`, `SQUARE_APP_SECRET`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, and a **new** `SQUARE_TOKEN_ENC_KEY`. DEPLOY.md §8 has the command to make the key.
3. **Shaun** opens her Square account, then in Admin → Payments taps **Connect Square** → **Allow**, and switches Card on.
4. **One real $1 test.** Make a $1 test item or quote, pay it by card on the live site, check it says **Paid by card**, then refund it in Square (Open Square).
5. *(Optional)* Turn the daily cron on (above).

## Screenshots (390 px, no secrets)
- `s1-*`: live site after shipping: the home page, and the order-placed screen with no card button.
- `s2-*`: sandbox: Pay with card, Square's testing panel, back on the site paid, and declined.
- `s3-*`: Payments connected, an order paid by card, Send pay link, dark Payments ("Coming soon"), live home and contact box unchanged.
- `s4-*`: your real OAuth connection: card on, paid, order tag, Disconnect confirm, after Disconnect.
