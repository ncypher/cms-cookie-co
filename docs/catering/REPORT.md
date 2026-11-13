# Catering, requests and item sizes: report

All three stages are live on cmscookieco3more.com. Tests: 98 → 117, all passing. Shaun's live content was compared before and after every stage: specials, events, media, menu, flavors and treats (including "Wine & Cookie Flight"), by row count and a checksum of every row. Nothing changed. Production has no test records left.

## Email Routing: Shaun's Gmail is now verified ✅
- At the start of this session, cmscookieco3more@gmail.com was still **pending**.
- At the end it showed **verified at 2026-11-13 20:45 UTC**. So someone clicked the link today.
- Order, signup and request emails can now reach her. I didn't send one to prove it, as asked.
- None of my checks could have emailed her:
  - the live checks ran at the database level;
  - the one public request I sent was refused before anything was saved;
  - the read-only order check ran with no email connection.
- Still missing: the orders@ / hello@ **forwarding rules** (DEPLOY.md step 1.3). They're only needed for emails *to* those addresses, for example if Shaun replies to a notification. Sending *to her Gmail* doesn't need them. I changed nothing.

## What shipped

| Stage | Commit | What |
|---|---|---|
| 1 Requests are saved | `1e964d7` | Catering + custom requests stored, Requests tab, Catering settings and packages |
| 2 Sizes | `a0eee97` | Sizes on treats and specials, treat groups, three big buttons on Menu |
| 3 Help | `496a0c4` | Three new Help cards and clips; all 16 regenerated |

### Stage 1: Requests are saved
- **Catering is OFF.** Nothing about it shows on the site until Shaun switches it on: Admin → Requests → Catering settings.
- **When it's on:**
  - a pink **Catering** button joins Order / Text / Call;
  - a Catering box shows her intro, the things she caters, and optional package cards (photo, "from $X", "serves N", **Ask about this**);
  - "Ask about this" ticks that package on the form and notes it. Packages never go in the cart.
  - the **Request a quote** form asks for name, phone, date, how many, what they'd like, pickup or delivery, and notes, plus optional email and budget;
  - dates sooner than her notice (7 days unless she changes it) are refused, on the page and on the server.
- **"Upon Request"** (cakes, cupcakes, lessons) is saved the same way, as a custom order.
- **Both forms** show the request number (REQ-MMDD-XXXX) and "Shaun will text you with a quote". Text / Email / Copy stay as extra ways to send it, and as the fallback if the site can't be reached. Requests share the 5-per-10-minutes limit with orders and signups, have a spam trap, and email Shaun (fails softly).
- **Admin → Requests** (new tab with a badge for New):
  - newest first, Open / All;
  - Text / Call / Email buttons;
  - big status buttons: New, Quoted, Booked, Done, Declined;
  - the quote amount, and private notes;
  - **Download a spreadsheet**, same rules as orders.
- **Catering settings:** on/off, the words at the top, days' notice, the list of things she caters, and packages (add / edit / ↑↓ / delete, 4:3 photo through the Photo Studio).

### Stage 2: Sizes and "add something with a price"
- **Optional sizes on treats and specials:** up to 6 rows of name + price.
  - On the site, people tap a size and the price follows.
  - The server prices by size and refuses a missing, unknown or removed size. It never charges a wrong price.
  - Orders, the email and spreadsheets keep the size name.
  - Editing sizes keeps their ids, so carts people already filled still work.
- **Items without sizes are unchanged.** I proved it three ways for her Snickerdoodle, Christmas Cookie Kits and Wine & Cookie Flight:
  1. Same prices in the live data.
  2. The live page drawn with the old code and with the new code gives pixel-identical panels.
  3. The real order code priced all three against production, read-only: $28 + $10 + $12 = $50, the same as before.
- **Treat "Group"** is a pick list (Kits, Gift boxes, Party trays, Other, plus anything she types). "More treats" shows a small heading per group once anything has a group. Until then it looks exactly as before.
- **Menu tab** opens with three big buttons: **+ Add a treat** (always on your menu), **+ Add a special** (for a limited time), **+ Add a flavor** (for boxes and singles).

### Stage 3: Help
New cards and clips:
- "Add something with a price (treat or special, with sizes)"
- "Turn on Catering and add a package"
- "Answer a catering request (text them, set a quote, mark Booked)"

The treat card now says "Group". All 16 cards were regenerated last.

## Choices I made for you
1. **Requests tab placement.** It's an 8th tab, right after Orders, and Catering settings live inside it, so the tab bar didn't need a 9th. The tab labels are slightly smaller (9.5 px) so all eight fit at 390 px.
2. **Budget and email are optional extras** on the quote form. The table had room for them; nothing requires them.
3. **"How many people?" on Upon Request** understands "about 20" as 20. If there's no number, the words go into the notes.
4. **Limits.** Catering needs a date and how many; custom orders don't. Notice can be 0–90 days.
5. **One shared limit.** Requests count toward the same per-device limit as orders and signups: 5 per 10 minutes, combined.
6. **Groups.** Treats with no group show under "Other", but only once some other treat has a group.
7. **Sized items.** With sizes, the item's main price becomes the first size's price, shown as "from $X" in admin. A sized special shows its title, the size chips and an "Add to order" button instead of the one-tap price row.
8. **Database checks.** For live checks I worked at the database level and with read-only runs of the real code, not with public test orders. That's because nothing should show up in Shaun's Requests or Orders, and her email could have become live at any moment (it did).

## Skipped
- **Admin and Help screens weren't checked live.** They need the Access sign-in, so I checked them on local dev at 390 px, screenshots in this folder. Production showed no catering until it's switched on, refused a catering request with "closed right now", and keeps `/api/admin/requests.csv` and the Help files behind the sign-in (302).
- **No real email was sent**, as asked. "Order emails reach her" is expected now but not confirmed.

## Try on your Android
1. **Admin → Requests → Catering settings.** Switch Catering on, add a package with a photo, and look at the home page: Catering button and box. Tap **Ask about this**, then switch Catering off again if Shaun isn't ready.
2. **Fill in "Upon Request"** at the bottom of the home page with your own name. You should get a REQ number, and it should land in Admin → Requests (and Shaun's email). Tap Quoted / Booked, type a quote, then mark it Declined.
3. **Admin → Menu → + Add a treat.** Add two sizes and a Group, Save, and check the home page: pick each size and watch the price change. Then delete it.

## Backups
I made two production backups, before migration 0008 and before 0009. Both were outside the repo, and both are **deleted** (the folder is empty). Stage 3 had no migration, so no backup.

## Screenshots (390 px), in this folder
- `c0-live-home-before.png`: the live home page before any change.
- `c1-*`: Requests tab, Catering settings, masthead with Catering, Catering panel, quote form, request sent, a booked request, live home with catering off.
- `c2-*`: Wine & Cookie Flight unchanged, Menu's three big buttons, the sizes editor, size chips + groups on the site, an admin order showing its size, live More treats.
- `c3-live-home-after.png`: the live home page after everything.
