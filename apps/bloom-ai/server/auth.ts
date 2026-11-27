// Password protection for hosted deployments.
// - Set BLOOM_PASSWORD to require a login. Sessions are signed, httpOnly cookies (30 days).
// - When running on a hosting platform (Render, Railway, Fly, or BLOOM_REQUIRE_PASSWORD=1)
//   without a password, the app refuses to serve anything but a setup notice — so a CRM that
//   can send texts is never left open on the internet.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import { DATA_DIR } from "./store.ts";

const COOKIE = "bloom_session";
const MAX_AGE_MS = 30 * 86_400_000;

export const hosted = Boolean(process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME || process.env.BLOOM_REQUIRE_PASSWORD);
const password = process.env.BLOOM_PASSWORD ?? "";
export const authEnabled = Boolean(password);

// Per-install secret so sessions can't be forged even if the password is guessed later; rotating the
// password invalidates every session because it is mixed into the key.
function serverSecret(): Buffer {
  const file = path.join(DATA_DIR, ".session-secret");
  try {
    return Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex");
  } catch {
    const s = crypto.randomBytes(32);
    fs.writeFileSync(file, s.toString("hex"), { mode: 0o600 });
    return s;
  }
}
const key = authEnabled ? crypto.createHmac("sha256", serverSecret()).update(password).digest() : Buffer.alloc(0);

function sign(payload: string) {
  return crypto.createHmac("sha256", key).update(payload).digest("base64url");
}

function readCookie(req: Request, name: string): string {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return "";
}

function validSession(req: Request): boolean {
  const value = readCookie(req, COOKIE);
  const [exp, sig] = value.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = sign(exp);
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function setSession(req: Request, res: Response) {
  const exp = String(Date.now() + MAX_AGE_MS);
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader("Set-Cookie", `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_MS / 1000}${secure ? "; Secure" : ""}`);
}

// Simple brute-force protection: 10 failed attempts per IP per 15 minutes.
const attempts = new Map<string, { n: number; until: number }>();
function limited(ip: string): boolean {
  const a = attempts.get(ip);
  return Boolean(a && a.n >= 10 && a.until > Date.now());
}
function fail(ip: string) {
  const a = attempts.get(ip);
  if (!a || a.until < Date.now()) attempts.set(ip, { n: 1, until: Date.now() + 15 * 60_000 });
  else a.n++;
}

const PUBLIC = [/^\/login$/, /^\/api\/login$/, /^\/api\/health$/, /^\/api\/webhooks\//, /^\/favicon/];

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (PUBLIC.some((r) => r.test(req.path))) return next();
  if (hosted && !authEnabled) {
    res.status(503).type("html").send(page("Set a password to finish setup", `<p>Bloom AI is online but has no password yet, so it's locked to protect your contacts and messaging.</p><p>In your hosting dashboard, add an environment variable named <code>BLOOM_PASSWORD</code> with a strong password, then redeploy.</p>`));
    return;
  }
  if (!authEnabled || validSession(req)) return next();
  if (req.path.startsWith("/api/")) {
    res.status(401).json({ error: "Please log in", login: true });
    return;
  }
  res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
}

export function mountAuthRoutes(app: import("express").Express) {
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/login", (req, res) => {
    if (!authEnabled) return res.redirect("/");
    const next = typeof req.query.next === "string" && req.query.next.startsWith("/") && !req.query.next.startsWith("//") ? req.query.next : "/";
    res.type("html").send(
      page(
        "Welcome back",
        `<form id="f" autocomplete="on">
          <label for="pw">Password</label>
          <input id="pw" name="password" type="password" autocomplete="current-password" autofocus required />
          <button type="submit">Log in</button>
          <p id="err" role="alert"></p>
        </form>
        <script>
          document.getElementById('f').addEventListener('submit', async (e) => {
            e.preventDefault();
            const err = document.getElementById('err');
            err.textContent = '';
            const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: document.getElementById('pw').value }) });
            if (r.ok) location.href = ${JSON.stringify(next)};
            else err.textContent = (await r.json().catch(() => ({}))).error || 'Login failed';
          });
        </script>`,
      ),
    );
  });
  app.post("/api/login", (req, res) => {
    const ip = req.ip ?? "unknown";
    if (!authEnabled) return res.json({ ok: true });
    if (limited(ip)) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
    const given = Buffer.from(String(req.body?.password ?? ""));
    const want = Buffer.from(password);
    const ok = given.length === want.length && crypto.timingSafeEqual(given, want);
    if (!ok) {
      fail(ip);
      return res.status(401).json({ error: "Wrong password" });
    }
    attempts.delete(ip);
    setSession(req, res);
    res.json({ ok: true });
  });
  app.post("/api/logout", (_req, res) => {
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });
}

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bloom AI — ${title}</title>
<style>
  :root { color-scheme: light dark; --g: linear-gradient(135deg,#ff8a4c,#f43f74 52%,#c026d3); }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: radial-gradient(120% 80% at 0% 0%, rgba(244,63,116,.35), transparent 55%), radial-gradient(90% 60% at 100% 100%, rgba(192,38,211,.25), transparent 60%), #1a0f1f; color: #f3ecf5; }
  .card { width: min(380px, 100%); background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); border-radius: 18px; padding: 28px; backdrop-filter: blur(10px); }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; font: 600 22px Georgia, serif; }
  .pill { font: 700 10px ui-sans-serif, system-ui; padding: 2px 7px; border-radius: 999px; background: var(--g); color: #fff; letter-spacing: .06em; }
  h1 { font: 600 20px Georgia, serif; margin: 0 0 14px; }
  label { display: block; font-size: 13px; color: #c9bccd; margin-bottom: 6px; }
  input { width: 100%; height: 44px; border-radius: 10px; border: 1px solid rgba(255,255,255,.18); background: rgba(0,0,0,.25); color: inherit; padding: 0 12px; font-size: 15px; outline: none; }
  input:focus { border-color: #f43f74; box-shadow: 0 0 0 3px rgba(244,63,116,.25); }
  button { margin-top: 14px; width: 100%; height: 44px; border: 0; border-radius: 10px; background: var(--g); color: #fff; font-weight: 600; font-size: 15px; cursor: pointer; }
  #err { color: #ff93b4; min-height: 20px; margin: 10px 0 0; font-size: 13px; }
  code { background: rgba(0,0,0,.3); padding: 1px 5px; border-radius: 4px; }
  p { color: #d9cedc; }
</style></head><body><main class="card">
<div class="brand"><svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">${[0, 72, 144, 216, 288].map((r) => `<ellipse cx="16" cy="9" rx="5.2" ry="8" fill="#f43f74" opacity=".9" transform="rotate(${r} 16 16)"/>`).join("")}<circle cx="16" cy="16" r="3.6" fill="#fff"/></svg>Bloom <span class="pill">AI</span></div>
<h1>${title}</h1>${body}</main></body></html>`;
}
