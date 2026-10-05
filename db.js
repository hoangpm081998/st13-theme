/**
 * Postgres pool. Reference implementation for production BE.
 *
 * Not wired into server.js yet (server.js still uses SQLite).
 * Migration path: swap `require('better-sqlite3')` → `require('./db')`,
 * rewrite queries from `.prepare().run()` sync API → `pool.query()` async.
 *
 * Usage:
 *   const { pool, query } = require('./db');
 *   const { rows } = await query('SELECT * FROM themes WHERE id = $1', [id]);
 */

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. See .env.example.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Self-hosted without TLS → false. Managed provider → true.
  // rejectUnauthorized: false accepts self-signed certs (common on managed dev instances).
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  // Pool tuning — small, releases idle fast so a low `rolconnlimit`
  // on shared/self-hosted DBs doesn't starve concurrent tools (cli.js, scripts).
  max: 3,
  idleTimeoutMillis: 5_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  // Don't crash on transient network drops — the pool will reconnect.
  console.error('[pg] pool error:', err.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Schema DDL — matches SPEC.md section 3. Run once on startup (idempotent via IF NOT EXISTS).
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS themes (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    is_free         BOOLEAN NOT NULL DEFAULT false,
    order_index     INTEGER NOT NULL DEFAULT 999,
    bundle_version  INTEGER NOT NULL,
    bundle_sha256   TEXT NOT NULL,
    bundle_size     BIGINT NOT NULL,
    bundle_path     TEXT NOT NULL,
    preview_path    TEXT,
    wallpaper_preview_path TEXT,
    icons_preview_path     TEXT,
    widgets_preview_path   TEXT,
    price_bundle_coins  INTEGER NOT NULL DEFAULT 0,
    price_icons_coins   INTEGER NOT NULL DEFAULT 0,
    price_widgets_coins INTEGER NOT NULL DEFAULT 0,
    min_app_version TEXT NOT NULL DEFAULT '0.0.1',
    status          TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'published', 'unpublished')),
    description     TEXT,
    deleted_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_themes_status_order
    ON themes(status, order_index) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_themes_deleted_at
    ON themes(deleted_at);

  CREATE TABLE IF NOT EXISTS admin_users (
    email         TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    token       TEXT PRIMARY KEY,
    email       TEXT NOT NULL REFERENCES admin_users(email) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL,
    ip          TEXT,
    user_agent  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires
    ON admin_sessions(expires_at);

  CREATE TABLE IF NOT EXISTS admin_login_attempts (
    id       BIGSERIAL PRIMARY KEY,
    email    TEXT NOT NULL,
    ip       TEXT NOT NULL,
    success  BOOLEAN NOT NULL,
    at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_at
    ON admin_login_attempts(ip, at);
  CREATE INDEX IF NOT EXISTS idx_login_attempts_email_at
    ON admin_login_attempts(email, at);

  CREATE TABLE IF NOT EXISTS admin_audit_log (
    id       BIGSERIAL PRIMARY KEY,
    actor    TEXT NOT NULL,
    action   TEXT NOT NULL,
    target   TEXT,
    metadata JSONB,
    ip       TEXT,
    ua       TEXT,
    at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_audit_actor_at ON admin_audit_log(actor, at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_target_at ON admin_audit_log(target, at DESC);

  CREATE TABLE IF NOT EXISTS user_coin_state (
    device_id             TEXT PRIMARY KEY,
    -- Column-level default is a safety net only; the real seed comes from
    -- coin_config.initial_coin_grant via server.js:getOrCreateState() → INSERT
    -- passes the admin-configured value explicitly. Leave at 0 so anyone
    -- inserting directly (migration script, hotfix SQL) surfaces as "no bonus"
    -- rather than silently minting coins.
    balance               INTEGER NOT NULL DEFAULT 0,
    unlocked_theme_ids    TEXT[] NOT NULL DEFAULT '{}',
    streak_day            INTEGER NOT NULL DEFAULT 0,
    last_checkin_date     DATE,
    watch_ads_today       INTEGER NOT NULL DEFAULT 0,
    watch_ads_today_date  DATE,
    notif_bonus_claimed   BOOLEAN NOT NULL DEFAULT false,
    fsi_bonus_claimed     BOOLEAN NOT NULL DEFAULT false,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- Singleton row (id = 1). Admin edits these via the Coin Config tab and the
  -- BE reads them into an in-memory cache on startup + after every UPDATE.
  -- Each coin API response piggy-backs the current config so the client stays
  -- in sync without polling.
  CREATE TABLE IF NOT EXISTS coin_config (
    id                      SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    daily_checkin_rewards   INTEGER[] NOT NULL DEFAULT ARRAY[3, 5, 7, 10, 15, 20, 30]::INTEGER[],
    watch_ad_reward_amount  INTEGER   NOT NULL DEFAULT 3,
    watch_ad_daily_cap      INTEGER   NOT NULL DEFAULT 5,
    notif_bonus_amount      INTEGER   NOT NULL DEFAULT 3,
    fsi_bonus_amount        INTEGER   NOT NULL DEFAULT 3,
    initial_coin_grant      INTEGER   NOT NULL DEFAULT 3,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by              TEXT
  );

  INSERT INTO coin_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
`;

// Best-effort migrations for older DBs — Postgres 9.6+ supports `ADD COLUMN IF NOT EXISTS`.
const MIGRATIONS_SQL = `
  ALTER TABLE themes ADD COLUMN IF NOT EXISTS wallpaper_preview_path TEXT;
  ALTER TABLE themes ADD COLUMN IF NOT EXISTS icons_preview_path     TEXT;
  ALTER TABLE themes ADD COLUMN IF NOT EXISTS widgets_preview_path   TEXT;
  ALTER TABLE themes ADD COLUMN IF NOT EXISTS price_coins            INTEGER NOT NULL DEFAULT 0;
  -- Per-part pricing: bundle / icons / widgets each priced independently.
  -- Legacy price_coins is kept for one release as a fallback the app can
  -- read if the 3 new columns are absent from an older manifest response.
  ALTER TABLE themes ADD COLUMN IF NOT EXISTS price_bundle_coins   INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE themes ADD COLUMN IF NOT EXISTS price_icons_coins    INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE themes ADD COLUMN IF NOT EXISTS price_widgets_coins  INTEGER NOT NULL DEFAULT 0;
  -- One-shot backfill for rows that predate the split: if all 3 new columns
  -- are still 0 but legacy price_coins > 0, mirror the old single price into
  -- every part so nothing suddenly turns free after the migration.
  UPDATE themes
    SET price_bundle_coins  = price_coins,
        price_icons_coins   = price_coins,
        price_widgets_coins = price_coins
    WHERE price_coins > 0
      AND price_bundle_coins = 0
      AND price_icons_coins = 0
      AND price_widgets_coins = 0;
  -- Onboarding bonus: every new device_id INSERT auto-receives 10 free coins
  -- (COIN_ONBOARDING_BONUS in server.js — keep in sync).
  -- Update column default so future INSERTs (via getOrCreateState) get 10, not 0/5.
  -- Existing rows are NOT retroactively bumped by this — only new devices going forward.
  ALTER TABLE user_coin_state ALTER COLUMN balance SET DEFAULT 10;
  -- One-shot bonus khi user bật USE_FULL_SCREEN_INTENT (Android 14+). Mirror notif_bonus.
  ALTER TABLE user_coin_state ADD COLUMN IF NOT EXISTS fsi_bonus_claimed BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE coin_config     ADD COLUMN IF NOT EXISTS fsi_bonus_amount  INTEGER NOT NULL DEFAULT 3;
`;

async function ensureSchema() {
  await pool.query(SCHEMA_SQL);
  await pool.query(MIGRATIONS_SQL);
}

module.exports = { pool, query, withTransaction, ensureSchema };
