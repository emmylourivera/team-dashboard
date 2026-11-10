# Team Dashboard v3

The creative team's workspace for asset requests, projects, SKUs, vendors, Mockup Studio and print proof checks. Until now it ran as a page hosted on claude.ai. This repository is the same page with its own small server, so IT can host it, connect it to the company sign-in and own the data.

> **Status: scaffold.** It runs, and it has been tested end to end against Postgres with two people signed in at once. Before it goes live, IT needs to do the items in [Going to production](#going-to-production).

## How it fits together

```
 browser ──► company SSO proxy ──► Node server (this repo) ──► Postgres
             (signs people in,      ├─ serves public/index.html   (records + uploaded files)
              adds email header)    ├─ REST + WebSocket API
                                    └─ AI calls ──► Anthropic API (optional)
```

- **`public/index.html`** is the dashboard page as it was on claude.ai, with only its help text changed. It was written against claude.ai's built-in `window.claude.use(...)` features.
- **`public/runtime.js`** supplies those same features from this server, so the page code didn't have to change:

  | Feature | What the page uses it for | Served by |
  |---|---|---|
  | `db` | All shared records, with live updates | `/api/docs`, `/api/collections`, WebSocket `/api/live` |
  | `user` | Who is signed in, roles, names, people search | `/api/me`, `/api/people/*` |
  | `assets` | File uploads | `POST /api/assets`, `GET /_blob/<id>` |
  | `downloads` | Saving mockups to the computer | the browser only |
  | `sample` | Print proof check, carton panel detection | `/api/ai/*` → Anthropic API |

- **`server/`** has the Express app (`index.js`), database access (`db.js`, `schema.sql`), sign-in (`auth.js`), permissions (`rules.js`), AI calls (`ai.js`) and settings (`config.js`).
- **Storage:** Postgres. Records are JSON documents in a `docs` table, keyed by path (`requests/abc`, `requests/abc/chat/m1`). Uploaded files go in a `blobs` table, and people in a `users` table. Live updates use Postgres `LISTEN/NOTIFY`, so you can run more than one server instance.

## Run it locally

With Docker:

```bash
docker compose up --build
```

Then open http://localhost:8080. Everyone is signed in as a test owner (`AUTH_MODE=dev`).

Without Docker (Node 20+ and a Postgres database):

```bash
npm install
```

```bash
DATABASE_URL=postgres://localhost:5432/team_dashboard OWNER_EMAILS=dev@example.com npm run dev
```

```bash
npm test
```

## Going to production

1. **Sign-in.** Put the app behind the company single sign-on proxy: [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/), Google IAP, Cloudflare Access, Azure App Proxy or similar. The proxy must pass the person's email in a header (`AUTH_EMAIL_HEADER`, default `x-forwarded-email`).
   - The server trusts that header, so it **must not be reachable except through the proxy**. Also set `AUTH_PROXY_SECRET`, and have the proxy send it, so requests that skip the proxy are refused.
   - Set `ALLOWED_EMAIL_DOMAINS` to the company domain(s).
   - The proxy must allow WebSocket upgrades on `/api/live`.
   - If you'd rather have the app do OpenID Connect itself, replace `identify()` in `server/auth.js`. Nothing else depends on how people sign in.
2. **People.** Set `OWNER_EMAILS` (whoever owned the claude.ai page, plus a backup) and `EDITOR_EMAILS`. Put outside vendors in `READ_ONLY_EMAILS`.
3. **Database.** Use a managed Postgres (16 or later) with backups turned on. Tables are created on start-up, or with `npm run migrate`.
4. **Files.** Uploads are stored in Postgres, which is simple and gets backed up with everything else. If the total gets large (tens of GB), move `putBlob`/`getBlob` in `server/db.js` to S3, GCS or Azure Blob storage. Nothing else touches files.
5. **AI features (optional).** Set `ANTHROPIC_API_KEY` to turn on the print proof check and Mockup Studio's panel detection. Without a key, both turn off and the page says so.
   - The page sends the artwork being checked to Anthropic's API.
   - Requests use `claude-opus-5-5` (change it with `AI_MODEL`), with server-side refusal fallbacks turned on.
   - This was tested only with an invalid key. Run one proof check on staging with a real key before launch.
6. **Hosting.** Build the `Dockerfile` and run it on whatever IT uses (ECS, Cloud Run, Azure Container Apps, Kubernetes, Render...). Settings are listed in [`.env.example`](.env.example). Use `/healthz` for health checks.
7. **Move the data over.** See below.

## Moving the data from claude.ai

The live data (requests, chat, SKUs, vendors, colors, templates, proofs, renders, members and uploaded files) is still stored with the claude.ai page. To bring it over:

1. Ask Claude, in a session with access to the page, to export its data and files as an `export.json` in the format described at the top of [`scripts/import.js`](scripts/import.js). The export should include an `idMap` from each person's claude.ai user id to their work email. **Keep the export out of git** (`.gitignore` already skips `export/`).
2. Do a trial run first, then the real import:

   ```bash
   DATABASE_URL=... node scripts/import.js export/export.json --dry-run
   ```

   ```bash
   DATABASE_URL=... node scripts/import.js export/export.json
   ```

   Files keep their ids, so links to them in the records keep working. Running the import again overwrites records with the same path.
3. Pause edits on the claude.ai page while you cut over. Otherwise changes made there after the export are lost.

## Permissions

These match what the claude.ai page enforced (`server/rules.js`):

| Data | Read | Write |
|---|---|---|
| `members` | everyone signed in | owners |
| `accessRequests`, `visits` | owners, and each person their own | owners, and each person their own |
| everything else | everyone signed in | everyone not on the read-only list |

**Known gap, carried over from the original:** roles (Vendor, Copywriter...) only change what each person *sees* in the page. The server doesn't limit what data a signed-in person can read. Anyone who can sign in, including a read-only vendor, could read every record through the API. If vendors will get sign-ins, add per-role read rules to `server/rules.js` first, or keep vendors off this app.

## Repository visibility

This repository holds internal workflow code and the company's AI prompts for proof checking. Keep it **private**.
