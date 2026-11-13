// A pretend Square for the Help guide (`npm run guide`), so the pictures and clips never touch the real
// Square API. Listens on 127.0.0.1 only. Implements just what src/square.js calls: OAuth authorize/token/
// revoke, merchant + locations, payment links, orders and payments, plus the two pages a person sees
// (the Allow screen and the checkout page), drawn plainly and marked as practice screens.
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.SQUARE_MOCK_PORT || 8790);
const SITE = process.env.GUIDE_BASE || "http://localhost:8787";
const ME = `http://127.0.0.1:${PORT}`;
const links = new Map(), orders = new Map(), payments = new Map(), tokens = new Set();
const id = (p) => p + crypto.randomBytes(6).toString("hex").toUpperCase();
const send = (res, status, body, type = "application/json") => { res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(type === "application/json" ? JSON.stringify(body) : body); };
const readBody = (req) => new Promise((r) => { let s = ""; req.on("data", (d) => (s += d)); req.on("end", () => { try { r(s ? JSON.parse(s) : {}); } catch { r(Object.fromEntries(new URLSearchParams(s))); } }); });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const usd = (c) => "$" + (c / 100).toFixed(2);
const page = (title, inner) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f4f5;color:#1a1a1a}
main{max-width:420px;margin:0 auto;padding:28px 20px}.logo{font-weight:800;font-size:22px;letter-spacing:-.02em;margin-bottom:22px}
.box{background:#fff;border-radius:14px;padding:22px;box-shadow:0 1px 3px rgba(0,0,0,.08)}h1{font-size:21px;margin:0 0 10px}
ul{padding-left:20px;margin:10px 0 18px}button{width:100%;font:600 17px system-ui;border:0;border-radius:10px;padding:15px;margin-top:10px;cursor:pointer}
.go{background:#006aff;color:#fff}.no{background:#eceef0;color:#1a1a1a}.f{border:1px solid #d5d7da;border-radius:10px;padding:13px;margin:8px 0;color:#555}
.row{display:flex;justify-content:space-between;margin:6px 0}.note{font-size:12.5px;color:#777;text-align:center;margin-top:18px}</style></head>
<body><main><div class="logo">Square</div>${inner}<p class="note">Practice screen for the Help pictures. The real Square page looks a little different.</p></main></body></html>`;

function sellerOk(req) { return tokens.has((req.headers.authorization || "").replace(/^Bearer /, "")); }

http.createServer(async (req, res) => {
  const u = new URL(req.url, ME);
  const p = u.pathname;
  try {
    if (p === "/health") return send(res, 200, { ok: true, mock: true });
    if (p === "/oauth2/authorize" && req.method === "GET") {
      const back = new URL("/api/admin/square/callback", SITE);
      back.searchParams.set("state", u.searchParams.get("state") || "");
      const deny = new URL(back); deny.searchParams.set("error", "access_denied");
      back.searchParams.set("code", "mock-code-" + crypto.randomBytes(4).toString("hex"));
      return send(res, 200, page("Allow access", `<div class="box"><h1>CMS Cookie Co. website would like to:</h1>
        <ul><li>Make payment links</li><li>See payments made through them</li><li>See your business name and location</li></ul>
        <form action="${esc(back)}" method="get">${[...back.searchParams].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("")}
        <button class="go" id="allow" type="submit">Allow</button></form>
        <form action="${esc(deny)}" method="get">${[...deny.searchParams].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("")}
        <button class="no" id="deny" type="submit">Deny</button></form></div>`), "text/html; charset=utf-8");
    }
    if (p === "/oauth2/token" && req.method === "POST") {
      const t = "MOCK-ACCESS-" + crypto.randomBytes(8).toString("hex"); tokens.add(t);
      return send(res, 200, { access_token: t, token_type: "bearer", expires_at: new Date(Date.now() + 30 * 864e5).toISOString(), merchant_id: "MOCKMERCHANT", refresh_token: "MOCK-REFRESH", short_lived: false });
    }
    if (p === "/oauth2/revoke" && req.method === "POST") return send(res, 200, { success: true });
    // The checkout page a customer sees (GET) and paying on it (POST).
    let m = p.match(/^\/pay\/([A-Z0-9]+)$/);
    if (m) {
      const link = links.get(m[1]);
      if (!link) return send(res, 404, "No such link", "text/plain");
      const li = link.order.line_items[0], amount = li.base_price_money.amount;
      if (req.method === "POST") {
        const o = orders.get(link.order_id);
        if (!o.tenders.length) {
          const pay = { id: id("PAY"), order_id: o.id, status: "COMPLETED", amount_money: { amount, currency: "USD" }, location_id: o.location_id };
          payments.set(pay.id, pay); o.tenders.push({ id: pay.id, payment_id: pay.id }); o.state = "OPEN";
        }
        res.writeHead(303, { Location: link.redirect_url }); return res.end();
      }
      return send(res, 200, page("Checkout", `<div class="box"><h1>CMS Cookie Co. &amp; More</h1>
        <div class="row"><span>${esc(li.name)}</span><b>${usd(amount)}</b></div><hr>
        <div class="f">Card number &nbsp; 4111 1111 1111 1111</div><div class="f">MM/YY &nbsp; 12/30 &nbsp;&nbsp; CVV &nbsp; 111 &nbsp;&nbsp; ZIP &nbsp; 48178</div>
        <form method="post"><button class="go" id="pay" type="submit">Pay ${usd(amount)}</button></form></div>`), "text/html; charset=utf-8");
    }
    // Seller API: needs a token we issued.
    if (!sellerOk(req)) return send(res, 401, { errors: [{ code: "UNAUTHORIZED" }] });
    if (p === "/v2/merchants/me") return send(res, 200, { merchant: { id: "MOCKMERCHANT", business_name: "CMS Cookie Co. & More", main_location_id: "MOCKLOC" } });
    if (p === "/v2/locations") return send(res, 200, { locations: [{ id: "MOCKLOC", name: "South Lyon", status: "ACTIVE", currency: "USD", capabilities: ["CREDIT_CARD_PROCESSING"] }] });
    if (p === "/v2/online-checkout/payment-links" && req.method === "POST") {
      const b = await readBody(req);
      const linkId = id("PL"), orderId = id("ORD");
      orders.set(orderId, { id: orderId, location_id: b.order.location_id, reference_id: b.order.reference_id, state: "DRAFT", tenders: [] });
      links.set(linkId, { ...b, order_id: orderId, redirect_url: b.checkout_options?.redirect_url || SITE });
      return send(res, 200, { payment_link: { id: linkId, version: 1, order_id: orderId, url: `${ME}/pay/${linkId}` } });
    }
    if ((m = p.match(/^\/v2\/orders\/(.+)$/))) { const o = orders.get(decodeURIComponent(m[1])); return o ? send(res, 200, { order: o }) : send(res, 404, { errors: [{ code: "NOT_FOUND" }] }); }
    if ((m = p.match(/^\/v2\/payments\/(.+)$/))) { const x = payments.get(decodeURIComponent(m[1])); return x ? send(res, 200, { payment: x }) : send(res, 404, { errors: [{ code: "NOT_FOUND" }] }); }
    return send(res, 404, { errors: [{ code: "NOT_FOUND" }] });
  } catch (e) {
    return send(res, 500, { errors: [{ code: "MOCK_ERROR", detail: e.message }] });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Mock Square on ${ME} (sends people back to ${SITE})`));
