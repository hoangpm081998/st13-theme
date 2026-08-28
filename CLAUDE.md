# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Reference implementation of the **Theme Backend** for the iLauncher OS Android app. This is a **local prototype** — SQLite + local filesystem — meant to be ported to Postgres + Bunny CDN for production. Docs in `SPEC.md` (features, data model, Bunny integration) and `AUTH_SPEC.md` (auth details, security checklist) are the source of truth for the eventual production BE.

## Commands

```bash
npm install
npm start          # node server.js
npm run dev        # node --watch server.js (auto-reload)

# Admin management (CLI only — no HTTP endpoint for this by design):
node cli.js add-admin <email>         # prompts for password (≥10 chars)
node cli.js reset-password <email>    # also revokes all sessions for that admin
node cli.js list-admins
node cli.js remove-admin <email>      # cascades to their sessions
```

There is no lint / test / typecheck script — CommonJS, no build step.

On cold start, if `admin_users` is empty and `ADMIN_INITIAL_PASSWORD` is set in `.env`, `server.js` seeds one admin (`ADMIN_INITIAL_EMAIL`, default `admin@example.com`).

## Architecture

Three files carry all the logic:

- **`server.js`** — single-file Express 5 app. Contains config, schema DDL + best-effort migration, session helpers, middleware, and every route. Sections are separated by `// -------------------- xxx --------------------` banners.
- **`cli.js`** — standalone admin management. Opens the same SQLite file directly; server does not need to be running.
- **`bunny.js`** — Bunny Storage helper. **Not wired into `server.js`.** It exists as a reference the production port will import when replacing the `/files/*` static route.

Data layer (SQLite via `better-sqlite3`, WAL mode) in `data/themes.db`. Three tables — schema is defined inline in `server.js`:
- `themes` — theme metadata + bundle version/hash/size. Soft delete via `deleted_at`.
- `admin_users` — email + bcrypt hash (cost 12).
- `admin_sessions` — `token = raw.HMAC(raw, SESSION_SECRET)`; 7-day TTL; expiry purged hourly.
- `admin_login_attempts` — audit log; 30-day retention (also purged hourly).

Uploads land in `data/uploads/<themeId>/v<version>/{bundle.zip, preview.<ext>}` via `multer` disk storage (50 MB cap). SHA-256 is computed at upload time.

### Auth model

- Cookie session (`theme_admin_session`), `httpOnly`, `sameSite=strict`, `Secure` only in `NODE_ENV=production`.
- `requireAuth` middleware: returns 401 for API/XHR/`/admin/*`; redirects HTML pages to `/login.html`.
- Login is rate-limited (5 / 15 min / IP); all `/admin/*` routes are also rate-limited (100 / min).
- `app.set('trust proxy', 1)` — required for correct `req.ip` behind a reverse proxy/Cloudflare. Keep this if adding one.
- Password change (`/auth/change-password`) revokes every other session for that admin.
- **No admin add/remove endpoint** — intentional. Use `cli.js` on the server.

### Endpoint map

| Route | Auth | Notes |
|---|---|---|
| `GET /manifest` | public | Consumed by Android app. `Cache-Control: max-age=3600`. |
| `POST /auth/login`, `/auth/logout`, `GET /auth/me`, `POST /auth/change-password` | mixed | See middleware. |
| `GET /admin.html` | ✅ | HTML — redirects to login on 401. |
| `GET /admin/themes` (`?trash=true`) | ✅ | JSON — 401 on failure. |
| `POST /admin/upload` | ✅ | multipart: `bundle` (required zip) + 4 optional images (`preview`, `wallpaperPreview`, `iconsPreview`, `widgetsPreview`, each ≤2MB, mapping to one Theme Studio tab in the app). Upsert on `id`; missing preview slots preserve their prior value via COALESCE. |
| `POST /admin/themes/:id/preview?slot=main\|wallpaper\|icons\|widgets` | ✅ | Replace one preview slot. Field name is always `preview`; the slot query param routes it to the right DB column and R2 key. |
| `PATCH /admin/themes/:id` | ✅ | Whitelisted fields only: `status`, `isFree`, `order`, `name`, `minAppVersion`. |
| `DELETE /admin/themes/:id` (`?permanent=true`) | ✅ | Default = soft delete. Permanent also `rm -rf` the upload dir. |
| `POST /admin/themes/:id/restore` | ✅ | Un-soft-delete. |
| `GET /files/*` | public | Static serve of `data/uploads/`. **Delete this route in production** — Bunny CDN serves the files. |

## Non-obvious constraints

- **Android app contract is locked.** The manifest JSON shape (see `themeRow` in `server.js`) and the `/manifest` endpoint path must not change without a coordinated app release. Same for `bundleSha256` semantics (hash of the served zip).
- **Theme `id` must match `/^[a-z0-9_]+$/`** — enforced in the multer destination callback. Reject invalid IDs early, don't loosen this.
- **Rotating `SESSION_SECRET` invalidates every session** (HMAC signatures no longer verify). In dev, absence of `SESSION_SECRET` means a random one is generated per restart — expected.
- **`bunny.js` is production-only scaffolding.** Don't try to run it locally without setting `BUNNY_STORAGE_ZONE` / `BUNNY_STORAGE_KEY` / `BUNNY_PULL_ZONE_URL`. When porting to production, replace the `/files/*` static route with Bunny uploads at write time and switch `themeRow` URLs to `cdnUrl(...)`.
- **Schema migrations are best-effort** — see the `PRAGMA table_info` block that adds `deleted_at` on old DBs. Add new columns the same way rather than expecting a fresh DB.
- **`.env` is loaded from the project root** via `dotenv` with an explicit path — moving `server.js` breaks that.

## Production port checklist (for context, not to do now)

Documented in `README.md` and `SPEC.md`; summary: SQLite→Postgres, filesystem→Bunny (`bunny.js`), keep auth flow and API contract unchanged, add `bundle_path`/`preview_path` columns replacing `preview_ext`, drop `/files/*`, set fixed `SESSION_SECRET` + `NODE_ENV=production`.
