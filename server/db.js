import pg from "pg";
import { readFile } from "node:fs/promises";
import { config } from "./config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export async function migrate() {
  const sql = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
  await pool.query(sql);
}

// ---------- paths ----------
// A document path has an even number of segments ("requests/abc"),
// a collection path an odd number ("requests", "requests/abc/chat").
const SEG = /^[^/\s]{1,200}$/;

export function splitPath(path) {
  const parts = String(path || "").split("/").filter((p) => p !== "");
  if (!parts.length || !parts.every((p) => SEG.test(p) && p !== "." && p !== "..")) {
    throw httpError(400, "bad_path");
  }
  return parts;
}
export function docPath(path) {
  const parts = splitPath(path);
  if (parts.length % 2 !== 0) throw httpError(400, "not_a_document_path");
  return { path: parts.join("/"), parent: parts.slice(0, -1).join("/"), id: parts.at(-1), parts };
}
export function collectionPath(path) {
  const parts = splitPath(path);
  if (parts.length % 2 !== 1) throw httpError(400, "not_a_collection_path");
  return { path: parts.join("/"), parts };
}

export function httpError(status, code) {
  const e = new Error(code);
  e.status = status;
  e.code = code;
  return e;
}

// ---------- documents ----------
export async function getDoc(path) {
  const { rows } = await pool.query("SELECT id, data FROM docs WHERE path = $1", [path]);
  return rows[0] || null;
}

export async function listDocs(parent, { orderBy, dir, limit } = {}) {
  const params = [parent];
  let sql = "SELECT id, data FROM docs WHERE parent = $1";
  if (orderBy) {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(orderBy)) throw httpError(400, "bad_order_field");
    params.push(orderBy);
    sql += ` ORDER BY data->>$${params.length} ${dir === "desc" ? "DESC" : "ASC"} NULLS LAST, id`;
  } else {
    sql += " ORDER BY created_at, id";
  }
  if (limit) {
    params.push(Math.min(Math.max(1, Number(limit) || 1), 5000));
    sql += ` LIMIT $${params.length}`;
  }
  const { rows } = await pool.query(sql, params);
  return rows;
}

export async function setDoc(p, data, userId) {
  await pool.query(
    `INSERT INTO docs (path, parent, id, data, updated_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [p.path, p.parent, p.id, data, userId]
  );
  await notify(p.parent, p.path);
}

// Shallow merge, like the claude.ai store's update(): top-level fields in the
// patch replace the stored ones. Fails if the document doesn't exist.
export async function updateDoc(p, patch, userId) {
  const { rowCount } = await pool.query(
    "UPDATE docs SET data = data || $2::jsonb, updated_at = now(), updated_by = $3 WHERE path = $1",
    [p.path, patch, userId]
  );
  if (!rowCount) throw httpError(404, "not_found");
  await notify(p.parent, p.path);
}

export async function deleteDoc(p) {
  // Deleting a document also deletes its sub-collections (chat, comments...).
  await pool.query("DELETE FROM docs WHERE path = $1 OR path LIKE $2", [p.path, likePrefix(p.path) + "/%"]);
  await notify(p.parent, p.path);
}

function likePrefix(s) {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

// ---------- change notifications ----------
// Postgres LISTEN/NOTIFY, so live updates reach every server instance.
const CHANNEL = "docs_changed";
async function notify(parent, path) {
  await pool.query("SELECT pg_notify($1, $2)", [CHANNEL, JSON.stringify({ parent, path })]);
}

export async function onChange(handler) {
  let client;
  const connect = async () => {
    client = new pg.Client({ connectionString: config.databaseUrl });
    client.on("notification", (m) => {
      try {
        handler(JSON.parse(m.payload));
      } catch {}
    });
    client.on("error", () => {
      setTimeout(() => connect().catch(() => {}), 2000);
    });
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
  };
  await connect();
}

// ---------- files ----------
export async function putBlob({ id, name, contentType, data, userId }) {
  await pool.query(
    "INSERT INTO blobs (id, name, content_type, size_bytes, data, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, name, contentType, data.length, data, userId]
  );
}
export async function getBlob(id) {
  const { rows } = await pool.query("SELECT name, content_type, size_bytes, data FROM blobs WHERE id = $1", [id]);
  return rows[0] || null;
}

// ---------- people ----------
export async function touchUser({ id, email, name }) {
  await pool.query(
    `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET last_seen = now(),
       name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE users.name END`,
    [id, email, name || ""]
  );
}
export async function profiles(ids) {
  const { rows } = await pool.query("SELECT id, name, avatar FROM users WHERE id = ANY($1)", [ids]);
  const out = {};
  for (const r of rows) out[r.id] = { name: r.name || r.id, avatar: r.avatar || null };
  return out;
}
export async function searchUsers(q) {
  const like = "%" + likePrefix(String(q || "").trim()) + "%";
  const { rows } = await pool.query(
    "SELECT id, name, avatar FROM users WHERE name ILIKE $1 OR email ILIKE $1 ORDER BY name LIMIT 20",
    [like]
  );
  return rows.map((r) => ({ id: r.id, name: r.name || r.id, avatar: r.avatar || null }));
}
