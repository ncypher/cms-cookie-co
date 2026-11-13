# Overnight report: fixes, payments page, event signups

All three stages are live on cmscookieco3more.com. Tests: 65 → 98, all passing. Shaun's live content (specials, events, media, menu, flavors, treats) was checked before and after every stage, by row count and a checksum of every row, and nothing changed. No test records are left in production.

## ⚠️ Read this first: order emails can't reach Shaun yet

I checked Email Routing (read-only, nothing changed). **cmscookieco3more@gmail.com is still "pending", not verified.** It has been pending since Oct 20. Until Shaun clicks the link in Cloudflare's verification email, every order and signup email will fail. They fail softly: the order is still saved and shows in admin with an "Email failed" tag. There are also no orders@/hello@ routing rules yet (DEPLOY.md step 1.3), and they can only be created after the address is verified. Production has had 0 orders so far, so no email has been lost yet.

To fix it: in Cloudflare → cmscookieco3more.com → Email → Email Routing → Destination addresses, resend the verification. Shaun clicks the link.

## What shipped

| Stage | Commit | What |
|---|---|---|
| 1 Fixes | `8ee7b81` | Take photo on Android, kitchen splash, Android steps, mp4 codec check |
| 2 Payments | `fac2109` | Payments tab, payment settings drive checkout + contact panel, generated Venmo QR |
| 3 Signups | `fdb5f1e` | Draft/Published events, signups, Signups view, spreadsheets |

### Stage 1
- **Take photo "low memory".** That message isn't in our code. It's Chrome's own message. I fixed both likely causes:
  1. *Big camera photos.* The studio now reads the photo's size and rotation from the file header and decodes it straight to a small size: 2400 px for the kept original, 2048 px for editing. It never holds the full photo. Bitmaps and canvases are freed as soon as they're done, and Undo stores settings, not pixels. A synthetic 50-megapixel camera JPEG now peaks about 200 MB lower in the browser (801 MB → 597 MB, measured). If a photo still won't open, the message says "Try again, or pick it from your gallery."
  2. *Android closing the page while the camera is open.* Every admin form now saves as she types, in that browser tab only. If the page reloads, the form comes back with a kind note: "Your phone closed this page while the camera was open… Everything you typed is still here. Tap Take photo to try again, or Choose photo to pick it from your gallery." Tested by reloading in the middle of a pick, for event, special and media forms.
- **Android home-screen steps** on /kitchen and in Help now read: ⋮ → Add to Home screen → Create shortcut → Add. The clip was re-recorded.
- **/kitchen** shows the cookie icon and "Opening your kitchen…" while it forwards, instead of a blank page. Admin also shows "Opening your kitchen…" while it loads.
- **.mp4 uploads** get the same H.264 check as .mov. HEVC, or no video track, is refused with the same friendly message and deleted from R2.

### Stage 2: Payments
- New admin tab **Payments**. It has Venmo (name), Cash App ($cashtag), Cash at pickup, each with an on/off switch, and a greyed "Card (Square) — Coming soon" row that customers never see. It's seeded from what was live: Venmo @CmsCookieCo on, cash on, Cash App off.
- Checkout and the contact panel show only what's switched on. The Venmo pay link keeps the old format, with amount and note. The Cash App button opens cash.app/$tag/amount.
- **The Venmo QR is now generated** from the stored name, by a small QR maker I wrote (`public/assets/qr.js`, no CDN). It reproduces the old hand-made QR module for module, checked live. A test decoder reads back every code it makes.
- Names are checked on the server: letters, numbers, - and _ only. A leading @ or $ is dropped.
- Help: "How customers pay you".

### Stage 3: Event signups + spreadsheets
- Events are **Draft or Published**, and drafts never reach the home page or /api/content. Each event can have a price per spot, a number of spots, a closing date and a signups switch. The flyer still goes through the Photo Studio.
- Public: "Reserve your spot" asks for name, phone, spots, and optional email and notes. It has a honeypot and the same per-device limit as orders. The server prices the spots and refuses after the closing date. The capacity check is inside the single INSERT, so the last spot can't go to two people. Cards show "X spots left", "Sold out" or "Signups closed". The confirmation shows the reservation number (EV-MMDD-XXXX) and the switched-on pay buttons, with the note "<Event> – <Name> – <res#>". Shaun gets an email (see the warning above).
- Admin: **Signups** on each event shows spots taken / capacity, $ expected, $ marked paid, tap-to-text, Paid and Checked in switches, and Remove. **Preview** on a draft opens the real signup form for a signed-in admin only.
- **Download spreadsheet**: one for an event's signups, and one for orders by date range (default last 30 days, under the Orders list). They're CSV files with BOM, readable dates and dollars, under /api/admin.
- Help: "Take signups for an event" (Draft → check → Publish) and "Download a spreadsheet".

## Choices I made for you
1. **New events default to Published**, so Shaun's usual "Add an event" works as before. The signups Help card tells her to pick Draft first.
2. **Signups and orders share one per-device limit**: 5 per 10 minutes in total.
3. **The checkout wording changed slightly** because Cash App is off. It now says "Use Venmo below, or pay at pickup" instead of mentioning Cash App.
4. **The HEVC refusal message is the same one as before**, as asked. It talks about iPhone settings, which may confuse an Android uploader. Easy to reword if you want.
5. **Spreadsheet cells that start with = + - @ get a leading '** so Excel won't run them as formulas. Phone numbers typed as "+1 …" show that apostrophe.
6. Deleting an event deletes its signups too (the confirm box says so). Removing one signup frees its spots.
7. The QR maker scores masks the same way the old QR's generator did. That's why it matches exactly, and both ways are valid.

## Skipped or blocked
- **Live check of the admin preview in a real signed-in browser.** Admin needs the Access email code, so I couldn't sign in. I also tried running the new code locally against the production database, but that needs a workers.dev subdomain, which is a dashboard change, so I skipped it. What I did instead on production:
  - Created the DRAFT "TEST - ignore" ($5, 3 spots) in the production database.
  - Confirmed the deployed site hid it (/api/content and the home page) and refused a public signup (404).
  - Ran the worker's own reservation SQL on production for 2 + 1 (accepted) and a 4th (refused, sold out).
  - Marked one paid.
  - Built the spreadsheet with the worker's own CSV code from the production rows. Correct: 2 rows, $10 Yes / $5 No.
  - Deleted the event and its signups. Verified 0 left.

  The full browser flow (draft form with flyer → Preview → reserve 2 + 1 → 4th "Sold out" → mark paid → download and open CSV → delete) passed on local dev, with screenshots s3-01…s3-07.
- Admin screens (Payments, Signups, the draft-restore note) were checked on local dev, because live admin needs the sign-in.
- No Stage 3 changes needed a dashboard change.

## Please try on your Android
1. **Take photo first:** Admin → Specials → + New special → 📷 Take photo → take a picture → frame it → Use this photo → Save. It should go through. If the page reloads after the camera, your typing should still be there, with a note.
2. Remove the CMS Admin icon and add it again from /kitchen: ⋮ → Add to Home screen → **Create shortcut** → Add. Tap it and you should see the cookie + "Opening your kitchen…" instead of a blank page.
3. Admin → Payments: look it over (don't change Venmo unless you mean to).
4. Admin → Events → + New event as **Draft**, switch on signups, Save, tap **Preview**, reserve a spot, then Signups → Download spreadsheet → Remove → delete the event.

## Backups
I made two production backups, before Stage 2 and before Stage 3. Both were outside the repo and both are **deleted**. The old `prod-before-B.sql` and `prod-before-C.sql` weren't anywhere on this machine. I searched C:\Users, C:\dev, the old repo backup folder and the Recycle Bin, so there's nothing left of those to delete.

## Screenshots (390 px), in this folder
- s1-*: studio with the 50 MP photo, the form coming back after a camera reload, the kitchen splash (local + live), the live Android steps.
- s2-*: the Payments tab, the contact panel (live QR identical), the checkout with Venmo and with Venmo + Cash App.
- s3-*: the draft form, event card, preview, reserve form, confirmation, sold out, Signups view, a published event with signups (local), the live home page with the draft hidden.
