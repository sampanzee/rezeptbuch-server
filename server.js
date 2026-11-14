"use strict";
/*
 * Rezeptbuch – Server
 * Liefert die App aus, speichert Rezepte und Bilder, lädt Rezeptseiten und spricht mit der KI.
 * Keine Zusatzpakete nötig (nur Node.js ab Version 20).
 */
const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");

const PORT = Number(process.env.PORT) || 8080;
const DATA = process.env.DATA_DIR || "/data";
const APP_DIR = __dirname;
const AI_BASE = (process.env.AI_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
const AI_KEY = (process.env.AI_KEY || "").trim();
const AI_MODEL = (process.env.AI_MODEL || "openrouter/free").trim();
const AI_TIMEOUT = (Number(process.env.AI_TIMEOUT_MIN) || 15) * 60000;
const SESSION_DAYS = Number(process.env.SESSION_DAYS) || 365;
const ALLOW_PRIVATE = process.env.FETCH_ALLOW_PRIVATE === "1"; // nur für Tests
const AI_READY = !!AI_KEY || !/openrouter\.ai/.test(AI_BASE);

const REC_DIR = path.join(DATA, "rezepte");
const IMG_DIR = path.join(DATA, "bilder");
const SESS_FILE = path.join(DATA, "sitzungen.json");

/* ---------- Konten ---------- */
const USERS = {};
for (const part of String(process.env.USERS || "").split(/[;\n]/)) {
  const i = part.indexOf(":");
  if (i < 1) continue;
  const display = part.slice(0, i).trim();
  const pw = part.slice(i + 1).trim();
  if (!display || !pw) continue;
  const salt = crypto.randomBytes(16);
  USERS[display.toLowerCase()] = { display, salt, hash: crypto.scryptSync(pw, salt, 64) };
}
function checkPassword(name, pw){
  const u = USERS[String(name || "").trim().toLowerCase()];
  const salt = u ? u.salt : crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw || ""), salt, 64);
  if (!u) return null;
  return crypto.timingSafeEqual(h, u.hash) ? u.display : null;
}

/* ---------- Sitzungen ---------- */
let sessions = {};
try { sessions = JSON.parse(fs.readFileSync(SESS_FILE, "utf8")); } catch (e) { sessions = {}; }
const tokHash = t => crypto.createHash("sha256").update(t).digest("hex");
async function saveSessions(){
  const now = Date.now();
  for (const [k, v] of Object.entries(sessions)) if (v.exp < now || !USERS[String(v.user).toLowerCase()]) delete sessions[k];
  await writeAtomic(SESS_FILE, JSON.stringify(sessions));
}
function getCookie(req, name){
  const m = String(req.headers.cookie || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : "";
}
function currentUser(req){
  const t = getCookie(req, "rb_session");
  if (!t) return null;
  const s = sessions[tokHash(t)];
  if (!s || s.exp < Date.now() || !USERS[String(s.user).toLowerCase()]) return null;
  return USERS[String(s.user).toLowerCase()].display;
}
function isHttps(req){ return String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https"; }
function sessionCookie(req, token, maxAgeSec){
  return `rb_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isHttps(req) ? "; Secure" : ""}`;
}

/* ---------- Schutz gegen Passwort-Raten ---------- */
const attempts = new Map(); // ip -> {fails, until}
function clientIp(req){
  return String(req.headers["x-real-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0] || req.socket.remoteAddress || "").trim();
}
function lockedFor(ip){ const a = attempts.get(ip); return a && a.until > Date.now() ? Math.ceil((a.until - Date.now()) / 60000) : 0; }
function noteFail(ip){
  const a = attempts.get(ip) || { fails: 0, until: 0 };
  a.fails++;
  if (a.fails >= 5) { a.until = Date.now() + 15 * 60000; a.fails = 0; }
  attempts.set(ip, a);
}

/* ---------- Hilfsfunktionen ---------- */
async function writeAtomic(file, data){
  const tmp = file + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}
function send(res, status, body, headers = {}){
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf ? body : (typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": isBuf ? "application/octet-stream" : (typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8"),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  res.end(data);
}
function readBody(req, max){
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", c => { n += c.length; if (n > max) { reject(Object.assign(new Error("zu groß"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJson(req, max){
  const b = await readBody(req, max);
  try { return JSON.parse(b.toString("utf8") || "{}"); } catch (e) { throw Object.assign(new Error("ungültige Daten"), { status: 400 }); }
}
const validId = id => /^[A-Za-z0-9_-]{1,64}$/.test(id);
function decodeImage(dataUrl){
  const m = String(dataUrl || "").match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/);
  if (!m) return null;
  const buf = Buffer.from(m[2], "base64");
  if (buf.length < 100 || buf.length > 15 * 1024 * 1024) return null;
  return buf;
}
function imgType(buf){
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf.slice(8, 12).toString() === "WEBP") return "image/webp";
  return "application/octet-stream";
}

/* ---------- Rezepte ---------- */
async function listRecipes(){
  const files = (await fsp.readdir(REC_DIR)).filter(f => f.endsWith(".json"));
  const out = [];
  for (const f of files) { try { out.push(JSON.parse(await fsp.readFile(path.join(REC_DIR, f), "utf8"))); } catch (e) {} }
  return out;
}
async function putRecipe(id, rec, user){
  const clean = { ...rec, id, updatedAt: Date.now(), updatedBy: user };
  if (!clean.createdAt) clean.createdAt = Date.now();
  for (const k of Object.keys(clean)) if (k.startsWith("_")) delete clean[k];
  await writeAtomic(path.join(REC_DIR, id + ".json"), JSON.stringify(clean));
  return clean;
}
async function putImage(id, buf){ await writeAtomic(path.join(IMG_DIR, id + ".img"), buf); }
async function delFile(f){ try { await fsp.unlink(f); } catch (e) {} }

/* ---------- Abruf fremder Seiten (nur öffentliche Adressen) ---------- */
function isPrivateIp(ip){
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  const m = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return isPrivateIp(m[1]);
  return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe8") || l.startsWith("fe9") || l.startsWith("fea") || l.startsWith("feb");
}
const UA = "Mozilla/5.0 (Linux; Android 14; SM-S916B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
async function safeFetch(url, accept){
  let u = url;
  for (let i = 0; i < 6; i++) {
    const p = new URL(u);
    if (!/^https?:$/.test(p.protocol)) throw Object.assign(new Error("Adresse nicht erlaubt"), { status: 400 });
    const host = p.hostname.replace(/^\[|\]$/g, "");
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
    if (!addrs.length || (!ALLOW_PRIVATE && addrs.some(a => isPrivateIp(a.address)))) throw Object.assign(new Error("Adresse nicht erlaubt"), { status: 400 });
    const r = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(25000), headers: { "User-Agent": UA, "Accept": accept, "Accept-Language": "de-DE,de;q=0.9,en;q=0.7" } });
    const loc = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && loc) { u = new URL(loc, u).toString(); continue; }
    return r;
  }
  throw Object.assign(new Error("Zu viele Weiterleitungen"), { status: 502 });
}
async function readLimited(r, max){
  if (!r.body) return Buffer.alloc(0);
  const reader = r.body.getReader(); const chunks = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { try { await reader.cancel(); } catch (e) {} throw Object.assign(new Error("Datei zu groß"), { status: 413 }); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/* ---------- KI ---------- */
async function aiCall(prompt, images){
  let content = String(prompt || "");
  if (Array.isArray(images) && images.length) content = [{ type: "text", text: content }, ...images.slice(0, 6).map(u => ({ type: "image_url", image_url: { url: String(u) } }))];
  const headers = { "Content-Type": "application/json" };
  if (AI_KEY) headers.Authorization = "Bearer " + AI_KEY;
  if (/openrouter\.ai/.test(AI_BASE)) headers["X-Title"] = "Rezeptbuch";
  let r;
  try {
    r = await fetch(AI_BASE + "/chat/completions", {
      method: "POST", headers, signal: AbortSignal.timeout(AI_TIMEOUT),
      body: JSON.stringify({ model: AI_MODEL, messages: [{ role: "user", content }], temperature: 0.2, stream: true })
    });
  } catch (e) { return { status: 502, body: { code: "network", message: "KI nicht erreichbar" } }; }
  if (!r.ok) {
    let j = null; try { j = await r.json(); } catch (e) {}
    const msg = (j && j.error && (j.error.message || j.error)) || "";
    const code = r.status === 401 ? "auth" : r.status === 402 ? "credit" : r.status === 429 ? "rate" : (/image|vision|modalit/i.test(String(msg)) ? "noimg" : "upstream");
    return { status: 502, body: { code, message: String(msg).slice(0, 300) } };
  }
  // Antwort kommt Stück für Stück (Server-Sent Events)
  const reader = r.body.getReader(); const dec = new TextDecoder();
  let buf = "", text = "", err = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const d = line.slice(5).trim();
        if (d === "[DONE]") continue;
        try {
          const j = JSON.parse(d);
          if (j.error) { err = j.error; continue; }
          const c = j.choices && j.choices[0] && (j.choices[0].delta || j.choices[0].message);
          if (c && c.content) text += Array.isArray(c.content) ? c.content.map(p => p.text || "").join("") : c.content;
        } catch (e) {}
      }
    }
  } catch (e) { return { status: 502, body: { code: "network", message: "Verbindung zur KI abgebrochen" } }; }
  if (!text && err) {
    const msg = String(err.message || err);
    const code = err.code === 429 ? "rate" : err.code === 402 ? "credit" : /image|vision|modalit/i.test(msg) ? "noimg" : "upstream";
    return { status: 502, body: { code, message: msg.slice(0, 300) } };
  }
  if (!text) return { status: 502, body: { code: "upstream", message: "Leere Antwort der KI" } };
  return { status: 200, body: { text } };
}

/* ---------- Statische Dateien der App ---------- */
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"],
  "/sw.js": ["sw.js", "text/javascript; charset=utf-8"],
  "/icon-192.png": ["icon-192.png", "image/png"],
  "/icon-512.png": ["icon-512.png", "image/png"],
  "/icon-maskable-512.png": ["icon-maskable-512.png", "image/png"]
};

/* ---------- Anfragen ---------- */
async function handle(req, res){
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const m = req.method;

  if (STATIC[p] && (m === "GET" || m === "HEAD")) {
    const [file, type] = STATIC[p];
    try {
      const data = await fsp.readFile(path.join(APP_DIR, file));
      const cache = type.startsWith("image/") ? "public, max-age=604800" : "no-cache";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": cache, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
      return res.end(m === "HEAD" ? undefined : data);
    } catch (e) { return send(res, 404, "Nicht gefunden"); }
  }
  if (!p.startsWith("/api/")) return send(res, 404, "Nicht gefunden");

  // Anmeldung
  if (p === "/api/login" && m === "POST") {
    const ip = clientIp(req);
    const mins = lockedFor(ip);
    if (mins) return send(res, 429, { code: "locked", message: `Zu viele Fehlversuche. Bitte in ${mins} Minuten erneut versuchen.` });
    const b = await readJson(req, 10000);
    const user = checkPassword(b.user, b.password);
    if (!user) { noteFail(ip); await new Promise(r => setTimeout(r, 800)); return send(res, 401, { code: "wrong", message: "Name oder Passwort falsch." }); }
    attempts.delete(ip);
    const token = crypto.randomBytes(32).toString("base64url");
    sessions[tokHash(token)] = { user, exp: Date.now() + SESSION_DAYS * 86400000 };
    await saveSessions();
    return send(res, 200, { user }, { "Set-Cookie": sessionCookie(req, token, SESSION_DAYS * 86400) });
  }
  if (p === "/api/logout" && m === "POST") {
    const t = getCookie(req, "rb_session");
    if (t) { delete sessions[tokHash(t)]; await saveSessions(); }
    return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, "", 0) });
  }

  const user = currentUser(req);
  if (!user) return send(res, 401, { code: "login", message: "Bitte anmelden." });

  if (p === "/api/me" && m === "GET") return send(res, 200, { user, ai: AI_READY });

  if (p === "/api/recipes" && m === "GET") return send(res, 200, await listRecipes());

  let mm = p.match(/^\/api\/recipes\/([^/]+)$/);
  if (mm) {
    const id = mm[1]; if (!validId(id)) return send(res, 400, { message: "Ungültige ID" });
    if (m === "PUT") { const b = await readJson(req, 2 * 1024 * 1024); if (!b || typeof b !== "object" || !b.title) return send(res, 400, { message: "Titel fehlt" }); return send(res, 200, await putRecipe(id, b, user)); }
    if (m === "DELETE") { await delFile(path.join(REC_DIR, id + ".json")); await delFile(path.join(IMG_DIR, id + ".img")); return send(res, 200, { ok: true }); }
  }

  mm = p.match(/^\/api\/images\/([^/]+)$/);
  if (mm) {
    const id = mm[1]; if (!validId(id)) return send(res, 400, { message: "Ungültige ID" });
    const f = path.join(IMG_DIR, id + ".img");
    if (m === "GET") {
      try { const buf = await fsp.readFile(f); res.writeHead(200, { "Content-Type": imgType(buf), "Cache-Control": "private, max-age=31536000", "X-Content-Type-Options": "nosniff" }); return res.end(buf); }
      catch (e) { return send(res, 404, "Kein Bild"); }
    }
    if (m === "PUT") { const b = await readJson(req, 25 * 1024 * 1024); const buf = decodeImage(b.data); if (!buf) return send(res, 400, { message: "Ungültiges Bild" }); await putImage(id, buf); return send(res, 200, { ok: true }); }
    if (m === "DELETE") { await delFile(f); return send(res, 200, { ok: true }); }
  }

  if (p === "/api/fetch-page" && m === "POST") {
    const b = await readJson(req, 10000);
    try {
      const r = await safeFetch(String(b.url || ""), "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8");
      if (!r.ok) return send(res, 502, { message: "Seite antwortet mit Fehler " + r.status });
      const buf = await readLimited(r, 8 * 1024 * 1024);
      return send(res, 200, { html: buf.toString("utf8") });
    } catch (e) { return send(res, e.status || 502, { message: e.message || "Seite nicht erreichbar" }); }
  }
  if (p === "/api/fetch-image" && m === "GET") {
    try {
      const r = await safeFetch(String(url.searchParams.get("url") || ""), "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8");
      const type = r.headers.get("content-type") || "";
      if (!r.ok || !type.startsWith("image/")) return send(res, 502, { message: "Kein Bild" });
      const buf = await readLimited(r, 15 * 1024 * 1024);
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      return res.end(buf);
    } catch (e) { return send(res, e.status || 502, { message: e.message || "Bild nicht erreichbar" }); }
  }

  if (p === "/api/ai" && m === "POST") {
    if (!AI_READY) return send(res, 400, { code: "noai", message: "Keine KI eingerichtet." });
    const b = await readJson(req, 40 * 1024 * 1024);
    const out = await aiCall(b.prompt, b.images);
    return send(res, out.status, out.body);
  }

  if (p === "/api/backup" && m === "GET") {
    const recipes = await listRecipes(); const images = {};
    for (const r of recipes) {
      try { const buf = await fsp.readFile(path.join(IMG_DIR, r.id + ".img")); images[r.id] = "data:" + imgType(buf) + ";base64," + buf.toString("base64"); } catch (e) {}
    }
    const name = "rezeptbuch-sicherung-" + new Date().toISOString().slice(0, 10) + ".json";
    return send(res, 200, { app: "rezeptbuch", version: 1, exportedAt: new Date().toISOString(), recipes, images }, { "Content-Disposition": `attachment; filename="${name}"` });
  }
  if (p === "/api/import" && m === "POST") {
    const b = await readJson(req, 400 * 1024 * 1024);
    if (!b || !Array.isArray(b.recipes)) return send(res, 400, { message: "Keine gültige Sicherung" });
    let n = 0;
    for (const r of b.recipes) {
      if (!r || !validId(String(r.id || "")) || !r.title) continue;
      const img = b.images && decodeImage(b.images[r.id]);
      if (img) await putImage(r.id, img);
      await writeAtomic(path.join(REC_DIR, r.id + ".json"), JSON.stringify({ ...r, hasImage: !!(img || r.hasImage) }));
      n++;
    }
    return send(res, 200, { count: n });
  }

  return send(res, 404, { message: "Unbekannte Anfrage" });
}

/* ---------- Start ---------- */
(async () => {
  await fsp.mkdir(REC_DIR, { recursive: true });
  await fsp.mkdir(IMG_DIR, { recursive: true });
  if (!Object.keys(USERS).length) console.warn("WARNUNG: Keine Konten in USERS eingetragen – Anmeldung ist nicht möglich.");
  http.createServer((req, res) => {
    handle(req, res).catch(e => { console.error(e); if (!res.headersSent) send(res, e.status || 500, { message: e.status ? e.message : "Serverfehler" }); else res.end(); });
  }).listen(PORT, () => {
    console.log(`Rezeptbuch läuft auf Port ${PORT}. Konten: ${Object.values(USERS).map(u => u.display).join(", ") || "keine"}. KI: ${AI_READY ? AI_MODEL + " über " + AI_BASE : "nicht eingerichtet"}.`);
  });
})();
