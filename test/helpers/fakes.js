// In-memory stand-ins for the Worker's bindings so the real worker.js runs under `node --test`.
// D1 -> node:sqlite with the real migrations; R2 -> Map; rate limiter -> counter per key.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const toNamed = (sql) => sql.replace(/\?(\d+)/g, "$$p$1");
const toParams = (vals) => Object.fromEntries(vals.map((v, i) => [`$p${i + 1}`, v === undefined ? null : v]));
const plain = (row) => (row ? { ...row } : null);

class Stmt {
  constructor(db, sql, vals = []) { this.db = db; this.sql = sql; this.vals = vals; }
  bind(...vals) { return new Stmt(this.db, this.sql, vals); }
  _p() { return this.db.prepare(toNamed(this.sql)); }
  async first() { return plain(this._p().get(toParams(this.vals))); }
  async all() { return { results: this._p().all(toParams(this.vals)).map(plain), success: true, meta: {} }; }
  async run() {
    const r = /\breturning\b/i.test(this.sql) ? { changes: this._p().all(toParams(this.vals)).length } : this._p().run(toParams(this.vals));
    return { success: true, meta: { changes: Number(r.changes) } };
  }
}

export function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const dir = path.join(import.meta.dirname, "..", "..", "migrations");
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(fs.readFileSync(path.join(dir, f), "utf8"));
  return {
    raw: db,
    prepare: (sql) => new Stmt(db, sql),
    batch: async (stmts) => Promise.all(stmts.map((s) => s.all())),
  };
}

export function fakeR2() {
  const objects = new Map();
  return {
    objects,
    async put(key, body, opts = {}) {
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, { bytes, contentType: opts.httpMetadata?.contentType });
    },
    async head(key) { const o = objects.get(key); return o ? { size: o.bytes.length, httpMetadata: { contentType: o.contentType } } : null; },
    async get(key) {
      const o = objects.get(key); if (!o) return null;
      return { size: o.bytes.length, arrayBuffer: async () => o.bytes.buffer.slice(0, 16) };
    },
    async delete(key) { objects.delete(key); },
  };
}

export function fakeLimiter(limit) {
  const counts = new Map();
  return {
    counts,
    async limit({ key }) { const n = (counts.get(key) || 0) + 1; counts.set(key, n); return { success: n <= limit }; },
  };
}
