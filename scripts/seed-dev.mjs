// Local-only: apply migrations, load demo content, and put demo images/video into local R2.
// Usage: npm run seed:dev   (never touches remote resources; every command uses --local)
import { execFileSync } from "node:child_process";

const wrangler = (...args) => {
  console.log("> wrangler", args.join(" "));
  execFileSync("npx", ["wrangler", ...args], { stdio: "inherit", shell: process.platform === "win32" });
};

const objects = [
  ["img/2026/11111111-1111-4111-8111-111111111111.webp", "public/assets/f-fs.webp", "image/webp"],
  ["img/2026/22222222-2222-4222-8222-222222222222.jpg", "public/assets/shaun-market.jpg", "image/jpeg"],
  ["img/2026/33333333-3333-4333-8333-333333333333.webp", "public/assets/flight.webp", "image/webp"],
  ["video/2026/44444444-4444-4444-8444-444444444444.mp4", "seed/tip-sample.mp4", "video/mp4"],
];

wrangler("d1", "migrations", "apply", "cms", "--local");
wrangler("d1", "execute", "cms", "--local", "--file", "seed/dev-content.sql");
for (const [key, file, type] of objects) {
  wrangler("r2", "object", "put", `cms-media/${key}`, "--local", "--file", file, "--content-type", type);
}
console.log("\nLocal D1 + R2 seeded. Run `npm run dev` and open http://localhost:8787");
