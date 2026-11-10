// Loads an export of the claude.ai dashboard into this app's database.
//
//   node scripts/import.js export.json [--dry-run]
//
// export.json:
// {
//   "docs":  [ { "path": "requests/abc123", "data": { ... } }, ... ],
//   "files": [ { "id": "<asset id>", "name": "art.pdf", "contentType": "application/pdf",
//                "file": "files/<asset id>.pdf" }, ... ],          // paths relative to export.json
//   "idMap": { "<old claude.ai user id>": "person@company.com", ... }
// }
//
// Files keep their old ids, so every link to them in the records still works.
// idMap swaps old claude.ai user ids for email addresses, which is how this
// app identifies people. It renames documents under members/, accessRequests/
// and visits/, and replaces any text value that is exactly an old id
// (addedBy, updatedBy, assignee ids...).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pool, migrate, docPath } from "../server/db.js";

const file = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!file) {
  console.error("Usage: node scripts/import.js export.json [--dry-run]");
  process.exit(1);
}
const dir = path.dirname(path.resolve(file));
const input = JSON.parse(await readFile(file, "utf8"));
const idMap = Object.fromEntries(
  Object.entries(input.idMap || {}).map(([k, v]) => [k, String(v).trim().toLowerCase()])
);

const swap = (v) => {
  if (typeof v === "string") return Object.hasOwn(idMap, v) ? idMap[v] : v;
  if (Array.isArray(v)) return v.map(swap);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [swap(k), swap(x)]));
  return v;
};
const swapPath = (p) => p.split("/").map((seg, i) => (i % 2 === 1 ? swap(seg) : seg)).join("/");

await migrate();
const client = await pool.connect();
let docs = 0, files = 0;
try {
  await client.query("BEGIN");
  for (const d of input.docs || []) {
    const p = docPath(swapPath(d.path));
    if (!dryRun) {
      await client.query(
        `INSERT INTO docs (path, parent, id, data, updated_by) VALUES ($1, $2, $3, $4, 'import')
         ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = now(), updated_by = 'import'`,
        [p.path, p.parent, p.id, swap(d.data)]
      );
    }
    docs++;
  }
  for (const f of input.files || []) {
    const data = await readFile(path.resolve(dir, f.file));
    if (!dryRun) {
      await client.query(
        `INSERT INTO blobs (id, name, content_type, size_bytes, data, uploaded_by) VALUES ($1, $2, $3, $4, $5, 'import')
         ON CONFLICT (id) DO NOTHING`,
        [f.id, f.name || f.id, f.contentType || "application/octet-stream", data.length, data]
      );
    }
    files++;
  }
  await client.query(dryRun ? "ROLLBACK" : "COMMIT");
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  client.release();
  await pool.end();
}
console.log(`${dryRun ? "Checked" : "Imported"} ${docs} records and ${files} files.`);
