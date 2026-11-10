import http from "node:http";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { WebSocketServer } from "ws";

import { config } from "./config.js";
import * as db from "./db.js";
import { identify, requireUser } from "./auth.js";
import { assertRead, assertWrite, canRead } from "./rules.js";
import { aiLimits, sampleJson, MAX_IMAGES } from "./ai.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const newId = () => randomBytes(12).toString("base64url");
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "same-origin");
  res.set("X-Frame-Options", "SAMEORIGIN");
  next();
});

// Health check for load balancers. No sign-in needed, reveals nothing.
app.get("/healthz", wrap(async (req, res) => {
  await db.pool.query("SELECT 1");
  res.json({ ok: true });
}));

app.use(requireUser);
app.use(express.json({ limit: "5mb" }));

// ---------- who am I ----------
app.get("/api/me", (req, res) => {
  const u = req.user;
  res.json({ id: u.id, name: u.name, email: u.email, isOwner: u.isOwner, isEditor: u.isEditor, canWrite: u.canWrite });
});
app.post("/api/people/profiles", wrap(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 500) : [];
  res.json(ids.length ? await db.profiles(ids) : {});
}));
app.get("/api/people/search", wrap(async (req, res) => {
  res.json(await db.searchUsers(req.query.q));
}));

// ---------- documents ----------
// GET    /api/docs/<doc path>          read one
// PUT    /api/docs/<doc path>          create or replace
// PATCH  /api/docs/<doc path>          merge fields into an existing document
// DELETE /api/docs/<doc path>          delete (and its sub-collections)
// GET    /api/collections/<col path>   list (?orderBy=&dir=asc|desc&limit=)
// POST   /api/collections/<col path>   add with a new id
const plain = (v) => v && typeof v === "object" && !Array.isArray(v);

app.get("/api/docs/*path", wrap(async (req, res) => {
  const p = db.docPath(req.params.path.join("/"));
  assertRead(req.user, p.parts);
  const row = await db.getDoc(p.path);
  res.json(row ? { exists: true, id: row.id, data: row.data } : { exists: false, id: p.id });
}));
app.put("/api/docs/*path", wrap(async (req, res) => {
  const p = db.docPath(req.params.path.join("/"));
  assertWrite(req.user, p.parts);
  if (!plain(req.body)) throw db.httpError(400, "body_must_be_an_object");
  await db.setDoc(p, req.body, req.user.id);
  res.json({ id: p.id });
}));
app.patch("/api/docs/*path", wrap(async (req, res) => {
  const p = db.docPath(req.params.path.join("/"));
  assertWrite(req.user, p.parts);
  if (!plain(req.body)) throw db.httpError(400, "body_must_be_an_object");
  await db.updateDoc(p, req.body, req.user.id);
  res.json({ id: p.id });
}));
app.delete("/api/docs/*path", wrap(async (req, res) => {
  const p = db.docPath(req.params.path.join("/"));
  assertWrite(req.user, p.parts);
  await db.deleteDoc(p);
  res.json({ ok: true });
}));
app.get("/api/collections/*path", wrap(async (req, res) => {
  const c = db.collectionPath(req.params.path.join("/"));
  assertRead(req.user, c.parts);
  res.json(await db.listDocs(c.path, req.query));
}));
app.post("/api/collections/*path", wrap(async (req, res) => {
  const c = db.collectionPath(req.params.path.join("/"));
  const id = newId();
  const p = db.docPath(c.path + "/" + id);
  assertWrite(req.user, p.parts);
  if (!plain(req.body)) throw db.httpError(400, "body_must_be_an_object");
  await db.setDoc(p, req.body, req.user.id);
  res.json({ id });
}));

// ---------- files ----------
app.post(
  "/api/assets",
  express.raw({ type: () => true, limit: config.maxUploadBytes }),
  wrap(async (req, res) => {
    if (!req.user.canWrite) throw db.httpError(403, "permission_denied");
    const data = req.body;
    if (!Buffer.isBuffer(data) || !data.length) throw db.httpError(400, "empty_file");
    let name = "file";
    try {
      name = decodeURIComponent(String(req.get("x-filename") || "file")).slice(0, 255);
    } catch {}
    const contentType = String(req.get("content-type") || "application/octet-stream").slice(0, 120);
    const id = newId();
    await db.putBlob({ id, name, contentType, data, userId: req.user.id });
    res.json({ id, name, contentType, sizeBytes: data.length, url: "/_blob/" + id });
  })
);

// Only these types are shown in the browser; everything else downloads,
// so an uploaded HTML or SVG file can't run script on this site.
const INLINE = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "application/pdf", "video/mp4", "text/plain"]);
app.get("/_blob/:id", wrap(async (req, res) => {
  const b = await db.getBlob(req.params.id);
  if (!b) return res.status(404).end();
  const type = b.content_type.split(";")[0].trim().toLowerCase();
  const inline = INLINE.has(type);
  res.set("Content-Type", inline ? b.content_type : "application/octet-stream");
  res.set("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(b.name)}`);
  res.set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  res.set("Cache-Control", "private, max-age=31536000, immutable");
  res.send(b.data);
}));

// ---------- AI ----------
const aiUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: MAX_IMAGES } });
app.get("/api/ai/limits", (req, res) => res.json(aiLimits()));
app.post("/api/ai/json", aiUpload.array("images", MAX_IMAGES), wrap(async (req, res) => {
  const controller = new AbortController();
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });
  try {
    const result = await sampleJson({
      prompt: String(req.body.prompt || ""),
      tier: req.body.tier === "complex" ? "complex" : "default",
      images: req.files || [],
      signal: controller.signal,
    });
    res.json({ result });
  } catch (e) {
    if (e.code && e.status) return res.status(e.status).json({ code: e.code });
    throw e;
  }
}));

// ---------- the page ----------
app.use(express.static(path.join(root, "public"), { index: "index.html", maxAge: "5m" }));

app.use((err, req, res, next) => {
  if (err.status && err.code) return res.status(err.status).json({ code: err.code });
  if (err.type === "entity.too.large" || err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ code: "too_large" });
  console.error(err);
  res.status(500).json({ code: "server_error" });
});

// ---------- live updates over a WebSocket ----------
// Client -> server: {t:"sub", sid, kind:"col"|"doc", path, orderBy?, dir?, limit?}
//                   {t:"unsub", sid}
// Server -> client: {t:"snap", sid, docs:[{id,data}]}
//                   {t:"doc",  sid, exists, id, data}
//                   {t:"err",  sid, code}
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const sockets = new Set();

server.on("upgrade", (req, socket, head) => {
  if (new URL(req.url, "http://x").pathname !== "/api/live") return socket.destroy();
  const user = identify(req.headers);
  if (!user) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.user = user;
    ws.subs = new Map();
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    ws.on("message", (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.t === "unsub") return ws.subs.delete(m.sid);
      if (m.t !== "sub" || typeof m.sid !== "string" || ws.subs.size > 200) return;
      try {
        const sub =
          m.kind === "doc"
            ? { kind: "doc", ...db.docPath(m.path) }
            : { kind: "col", ...db.collectionPath(m.path), orderBy: m.orderBy, dir: m.dir, limit: m.limit };
        if (!canRead(ws.user, sub.parts)) throw db.httpError(403, "permission_denied");
        ws.subs.set(m.sid, sub);
        push(ws, m.sid, sub);
      } catch (e) {
        send(ws, { t: "err", sid: m.sid, code: e.code || "bad_request" });
      }
    });
  });
});

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
async function push(ws, sid, sub) {
  try {
    if (sub.kind === "doc") {
      const row = await db.getDoc(sub.path);
      send(ws, { t: "doc", sid, exists: !!row, id: sub.id, data: row ? row.data : null });
    } else {
      const docs = await db.listDocs(sub.path, sub);
      send(ws, { t: "snap", sid, docs });
    }
  } catch (e) {
    send(ws, { t: "err", sid, code: e.code || "server_error" });
  }
}

// Batch change notices so a burst of writes sends one update per listener.
const pending = new Set();
let flushTimer = null;
function changed({ parent, path: p }) {
  pending.add(parent + "\n" + p);
  flushTimer ||= setTimeout(flush, 50);
}
function flush() {
  flushTimer = null;
  const items = [...pending].map((s) => s.split("\n"));
  pending.clear();
  for (const ws of sockets) {
    for (const [sid, sub] of ws.subs) {
      const hit = items.some(([parent, p]) =>
        sub.kind === "doc" ? p === sub.path || sub.path.startsWith(p + "/") : parent === sub.path || sub.path.startsWith(p + "/")
      );
      if (hit) push(ws, sid, sub);
    }
  }
}

// Keep idle connections open through proxies that drop quiet sockets.
setInterval(() => { for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.ping(); }, 30000).unref();

await db.migrate();
await db.onChange(changed);
server.listen(config.port, () => {
  console.log(`Team Dashboard listening on :${config.port} (auth: ${config.authMode}, AI: ${aiLimits() ? "on" : "off"})`);
});
