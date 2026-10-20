# CMS Cookie Co. & More

Website for Shaun Marie Schwartz's home bakery in South Lyon, MI. One static page (`index.html`) with no build step, made for GitHub Pages.

## What's on the page
- Hero with a cookie visitors can tap to "bite"
- Flavor lineup with one-tap add ($4 singles)
- **Build a box**: half dozen ($13) or dozen ($25), mix flavors by tapping, "Even mix" / "Surprise me"
- Tasting Flight ($10), Mini Cookie Lunch Box (12/$12, 24/$20), Cookie Gram ($9)
- Custom-order request form (cookie cakes, cupcakes, lessons, cooking parties)
- Gluten-free / dairy-free note + allergen notice
- Order drawer → customer details → order is sent to Shaun by text or email → Venmo pay link

## How orders reach Shaun
By default the finished order opens the customer's Messages app (or email) with the whole order typed out, addressed to Shaun. No accounts or fees.

**Recommended upgrade (5 minutes, free):** make a form at https://formspree.io with Shaun's email, then paste the form URL into `CONFIG.orderEndpoint` near the top of the `<script>` in `index.html`. A "Send order now" button then delivers orders straight to her inbox with one tap.

## Edit prices, flavors, contact info
All in the `CONFIG`, `PRICES` and `FLAVORS` blocks at the top of the `<script>` in `index.html`.

## Deploy to GitHub Pages
1. Create a repo (e.g. `cms-cookie-co`) and push these files to `main`.
2. Repo → Settings → Pages → Source: *Deploy from a branch*, Branch: `main` / `(root)`.
3. Live at `https://<user>.github.io/cms-cookie-co/` in a minute or two.

## Custom domain (once it's confirmed)
1. Add a file named `CNAME` containing only the domain, e.g. `cmscookieco.com`.
2. At the domain registrar, add DNS records:
   - `A` records for `@` → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - `CNAME` for `www` → `<user>.github.io`
3. Settings → Pages → enter the domain, wait for the DNS check, then tick **Enforce HTTPS**.
