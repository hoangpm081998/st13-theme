/**
 * Theme Backend — production wiring.
 *
 * Postgres (metadata + auth) + Cloudflare R2 (file storage) + Express.
 * See SPEC.md and AUTH_SPEC.md.
 */

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcrypt');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const AdmZip = require('adm-zip');

require('dotenv').config?.({ path: path.join(__dirname, '.env') });

const { pool, query, ensureSchema } = require('./db');
const r2 = require('./r2');

// Dummy bcrypt hash used as constant-time filler when the email doesn't exist,
// so login latency is the same whether the account exists or not.
const DUMMY_BCRYPT_HASH = '$2b$12$Sh6NxLkpjrflSbTYCEuh3.KDvfKN7ZFTNhIRkfP0IB4OMCbGvSN0G';

// Reject zip bombs / path traversal / non-zip uploads early.
function assertSafeZip(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4B) {
    throw new Error('not a valid zip (magic bytes mismatch)');
  }
  let zip;
  try { zip = new AdmZip(buffer); } catch { throw new Error('cannot parse zip'); }
  const entries = zip.getEntries();
  if (!entries.length) throw new Error('empty zip');
  if (entries.length > 5000) throw new Error('too many entries in zip');
  let totalUncompressed = 0;
  for (const e of entries) {
    const name = e.entryName;
    if (name.includes('..') || name.startsWith('/') || name.startsWith('\\') || /^[a-zA-Z]:/.test(name)) {
      throw new Error('illegal path in zip: ' + name);
    }
    const size = e.header.size;
    totalUncompressed += size;
    if (size > 100 * 1024 * 1024) throw new Error('zip entry too large: ' + name);
  }
  if (totalUncompressed > 500 * 1024 * 1024) throw new Error('zip uncompressed size too large');
}

// Convention-based extractor: pull the 4 preview slots out of a theme bundle zip.
// Admin uploads ONE zip and the previews are read from these root-level filenames:
//   preview.<ext>            → main (Themes tab card)
//   preview_wallpaper.<ext>  → Wallpaper tab card
//   preview_icons.<ext>      → Icons tab card
//   preview_widgets.<ext>    → Widgets tab card
// Any file not found is left null → theme won't appear in that tab.
// Extension is matched case-insensitively against webp/png/jpg/jpeg/gif.
function extractPreviewsFromZip(buffer) {
  const patterns = {
    main:      /^preview\.(webp|png|jpe?g|gif)$/i,
    wallpaper: /^preview_wallpaper\.(webp|png|jpe?g|gif)$/i,
    icons:     /^preview_icons\.(webp|png|jpe?g|gif)$/i,
    widgets:   /^preview_widgets\.(webp|png|jpe?g|gif)$/i,
  };
  const out = { main: null, wallpaper: null, icons: null, widgets: null };
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries()
    .filter((e) => !e.isDirectory)
    .filter((e) => !e.entryName.startsWith('__MACOSX/') && !e.entryName.endsWith('.DS_Store'));

  // Detect single-folder wrapping (e.g. `dragon_ball/theme.json`) so the extractor
  // still finds previews when admin zipped the parent folder instead of its contents.
  // Rule: locate `theme.json` — anything at the same directory level counts as "root".
  const themeJsonEntry = entries.find((e) => e.entryName === 'theme.json' || e.entryName.endsWith('/theme.json'));
  const rootPrefix = themeJsonEntry
    ? themeJsonEntry.entryName.slice(0, themeJsonEntry.entryName.lastIndexOf('/') + 1)
    : '';

  for (const entry of entries) {
    if (rootPrefix && !entry.entryName.startsWith(rootPrefix)) continue;
    const relative = entry.entryName.slice(rootPrefix.length);
    // Skip anything inside a subfolder (e.g. icons/foo.webp) — previews must live
    // at the theme root, same level as theme.json.
    if (relative.includes('/') || relative.includes('\\')) continue;
    for (const [slot, pattern] of Object.entries(patterns)) {
      if (out[slot]) continue;
      const match = relative.match(pattern);
      if (!match) continue;
      const ext = match[1].toLowerCase() === 'jpg' ? 'jpeg' : match[1].toLowerCase();
      const data = entry.getData();
      if (data.length > 2 * 1024 * 1024) continue;   // Skip oversized (>2MB) previews silently.
      out[slot] = { buffer: data, ext, mime: `image/${ext}` };
    }
  }
  return out;
}

// Strip control chars + limit length. Name can still contain unicode, spaces, punctuation.
function sanitizeName(s) {
  const cleaned = String(s || '').replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (cleaned.length === 0) throw new Error('name is empty');
  if (cleaned.length > 200) throw new Error('name too long (max 200 chars)');
  return cleaned;
}

// -------------------- config --------------------

const PORT = parseInt(process.env.PORT || '8787', 10);
const ROOT = __dirname;

const SESSION_SECRET = process.env.SESSION_SECRET
  || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_DAYS = 7;
const SESSION_COOKIE = 'theme_admin_session';
const BCRYPT_COST = 12;

const SEED_ADMIN_EMAIL = process.env.ADMIN_INITIAL_EMAIL || null;
const SEED_ADMIN_PASSWORD = process.env.ADMIN_INITIAL_PASSWORD || null;

// -------------------- session helpers --------------------

function signToken(raw) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(raw).digest('hex');
}

async function createSession(email, req) {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = `${raw}.${signToken(raw)}`;
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await query(
    `INSERT INTO admin_sessions (token, email, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [token, email, expiresAt, req.ip, (req.get('user-agent') || '').slice(0, 500)],
  );
  await query('UPDATE admin_users SET last_login_at = NOW() WHERE email = $1', [email]);
  return { token, expiresAt };
}

async function verifyAndTouchSession(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [raw, sig] = token.split('.', 2);
  if (signToken(raw) !== sig) return null;
  const { rows } = await query(
    'SELECT email, expires_at FROM admin_sessions WHERE token = $1',
    [token],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.expires_at.getTime() < Date.now()) {
    await query('DELETE FROM admin_sessions WHERE token = $1', [token]);
    return null;
  }
  return row;
}

async function destroySession(token) {
  await query('DELETE FROM admin_sessions WHERE token = $1', [token]);
}

// -------------------- middleware --------------------

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: false }));

// Security headers via helmet. CSP allows R2 public URL for preview img in admin UI.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'https://*.r2.dev', 'https://*.r2.cloudflarestorage.com', 'data:'],
      scriptSrc: ["'self'", "'unsafe-inline'"],   // admin.html/login.html có inline script
      scriptSrcAttr: ["'unsafe-inline'"],         // cho phép onclick=... trên các nút static (Upload/Refresh/Logout)
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  strictTransportSecurity: process.env.NODE_ENV === 'production'
    ? { maxAge: 31536000, includeSubDomains: true }
    : false,
}));

app.use(express.json({ limit: '100kb' }));  // JSON body cap — upload dùng multipart, không cần lớn
app.use(cookieParser());

// Login rate limit: throttle per IP…
const loginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts from this IP. Try again in 15 minutes.' },
});

// …and per email (chống distributed brute force qua nhiều IP)
const loginEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const email = req.body && typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    return email || '__no_email__';   // static fallback — không dùng IP để tránh IPv6 warning
  },
  message: { error: 'Too many login attempts for this account.' },
});

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

async function requireAuth(req, res, next) {
  try {
    const token = req.cookies[SESSION_COOKIE];
    const session = await verifyAndTouchSession(token);
    if (!session) {
      const isApiCall = req.originalUrl.startsWith('/admin/')
        || req.headers.accept?.includes('application/json')
        || req.headers['x-requested-with'] === 'XMLHttpRequest';
      if (isApiCall) return res.status(401).json({ error: 'unauthorized' });
      return res.redirect('/login.html');
    }
    req.adminEmail = session.email;
    next();
  } catch (err) {
    console.error('[requireAuth]', err);
    res.status(500).json({ error: 'internal error' });
  }
}

app.use('/login.html', express.static(path.join(ROOT, 'public/login.html')));

app.get('/admin.html', requireAuth, (req, res) => {
  res.sendFile(path.join(ROOT, 'public/admin.html'));
});
app.get('/', (req, res) => res.redirect('/admin.html'));

// Minimal health check — no auth, returns 200 if the server is up and can talk to DB.
app.get('/health', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({ ok: true, ts: Date.now() });
  } catch {
    res.status(503).json({ ok: false });
  }
});

// -------------------- auth endpoints --------------------

app.post('/auth/login', express.json(), loginIpLimiter, loginEmailLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ error: 'email + password required' });
    if (email.length > 254 || password.length > 200) {
      return res.status(400).json({ error: 'input too long' });
    }

    const { rows } = await query('SELECT password_hash FROM admin_users WHERE email = $1', [email]);
    const row = rows[0];
    // Always run bcrypt.compare (async) whether email exists or not — constant-time.
    const hashToCheck = row ? row.password_hash : DUMMY_BCRYPT_HASH;
    const cmp = await bcrypt.compare(password, hashToCheck);
    const valid = !!row && cmp;

    await query(
      'INSERT INTO admin_login_attempts (email, ip, success) VALUES ($1, $2, $3)',
      [email, req.ip, valid],
    );

    if (!valid) return res.status(401).json({ error: 'invalid credentials' });

    const { token, expiresAt } = await createSession(email, req);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: expiresAt.getTime() - Date.now(),
      path: '/',
      priority: 'high',
    });
    res.json({ ok: true, email });
  } catch (err) {
    console.error('[login]', err);
    res.status(500).json({ error: 'login failed' });
  }
});

app.post('/auth/logout', async (req, res) => {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await destroySession(token);
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

app.get('/auth/me', async (req, res) => {
  const session = await verifyAndTouchSession(req.cookies[SESSION_COOKIE]);
  if (!session) return res.status(401).json({ error: 'unauthorized' });
  res.json({ email: session.email });
});

app.post('/auth/change-password', requireAuth, async (req, res) => {
  try {
    const current = String(req.body?.current || '');
    const newPassword = String(req.body?.next || '');
    if (!current || !newPassword || newPassword.length < 10 || newPassword.length > 200) {
      return res.status(400).json({ error: 'current + new password (10-200 chars) required' });
    }
    const { rows } = await query('SELECT password_hash FROM admin_users WHERE email = $1', [req.adminEmail]);
    if (!(await bcrypt.compare(current, rows[0].password_hash))) {
      return res.status(401).json({ error: 'current password incorrect' });
    }
    const hash = await bcrypt.hash(newPassword, BCRYPT_COST);
    await query('UPDATE admin_users SET password_hash = $1 WHERE email = $2', [hash, req.adminEmail]);
    await query(
      'DELETE FROM admin_sessions WHERE email = $1 AND token <> $2',
      [req.adminEmail, req.cookies[SESSION_COOKIE]],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[change-password]', err);
    res.status(500).json({ error: 'password change failed' });
  }
});

// -------------------- audit log --------------------

// Fire-and-forget insert to admin_audit_log after a successful admin action.
function audit(action) {
  return (req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 400 && req.adminEmail) {
        const target = req.params?.id || req.body?.id || null;
        const ua = (req.get('user-agent') || '').slice(0, 300);
        query(
          `INSERT INTO admin_audit_log (actor, action, target, ip, ua) VALUES ($1, $2, $3, $4, $5)`,
          [req.adminEmail, action, target, req.ip, ua],
        ).catch((e) => console.warn('[audit]', action, e.message));
      }
    });
    next();
  };
}

// -------------------- theme endpoints --------------------

// Upload lives in memory — SHA-256 + PUT to R2 happen inline, nothing hits local disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 5, fields: 20 },
});

function themeRow(row) {
  return {
    id: row.id,
    name: row.name,
    previewUrl: row.preview_path ? r2.publicUrl(row.preview_path) : null,
    wallpaperPreviewUrl: row.wallpaper_preview_path ? r2.publicUrl(row.wallpaper_preview_path) : null,
    iconsPreviewUrl: row.icons_preview_path ? r2.publicUrl(row.icons_preview_path) : null,
    widgetsPreviewUrl: row.widgets_preview_path ? r2.publicUrl(row.widgets_preview_path) : null,
    priceCoins: Number(row.price_coins) || 0,
    bundleUrl: r2.publicUrl(row.bundle_path),
    bundleVersion: row.bundle_version,
    bundleSha256: row.bundle_sha256,
    bundleSize: Number(row.bundle_size),
    minAppVersion: row.min_app_version,
  };
}

// One preview slot corresponds to a Theme Studio tab in the Android app.
// The main slot is what the Themes tab shows; the others (wallpaper/icons/widgets)
// are what the slice tabs show for remote-only themes.
const PREVIEW_SLOTS = {
  main:      { field: 'preview',           column: 'preview_path',           file: 'preview' },
  wallpaper: { field: 'wallpaperPreview',  column: 'wallpaper_preview_path', file: 'wallpaperPreview' },
  icons:     { field: 'iconsPreview',      column: 'icons_preview_path',     file: 'iconsPreview' },
  widgets:   { field: 'widgetsPreview',    column: 'widgets_preview_path',   file: 'widgetsPreview' },
};

// Public — used by the Android app.
app.get('/manifest', async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM themes
       WHERE status = 'published' AND deleted_at IS NULL
       ORDER BY order_index ASC, created_at ASC`,
    );
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ version: Date.now(), themes: rows.map(themeRow) });
  } catch (err) {
    console.error('[manifest]', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.use('/admin', adminLimiter, requireAuth);

app.get('/admin/themes', async (req, res) => {
  try {
    const includeTrash = req.query.trash === 'true';
    const sql = includeTrash
      ? `SELECT * FROM themes WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`
      : `SELECT * FROM themes WHERE deleted_at IS NULL ORDER BY created_at DESC`;
    const { rows } = await query(sql);
    // Return snake_case DB rows + full R2 URLs (paths alone are R2 keys, not resolvable from server origin).
    res.json(rows.map((r) => ({
      ...r,
      bundle_size: Number(r.bundle_size),
      preview_url:           r.preview_path           ? r2.publicUrl(r.preview_path)           : null,
      wallpaper_preview_url: r.wallpaper_preview_path ? r2.publicUrl(r.wallpaper_preview_path) : null,
      icons_preview_url:     r.icons_preview_path     ? r2.publicUrl(r.icons_preview_path)     : null,
      widgets_preview_url:   r.widgets_preview_path   ? r2.publicUrl(r.widgets_preview_path)   : null,
      bundle_url:            r2.publicUrl(r.bundle_path),
    })));
  } catch (err) {
    console.error('[list themes]', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post(
  '/admin/upload',
  audit('upload'),
  upload.fields([
    { name: 'bundle', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { id, isFree, order, minAppVersion, status, priceCoins } = req.body;
      const bundle = req.files?.bundle?.[0];
      if (!id || !req.body.name || !bundle) {
        return res.status(400).json({ error: 'id, name, bundle are required' });
      }
      if (!/^[a-z0-9_]+$/.test(id) || id.length > 64) {
        return res.status(400).json({ error: 'id must match ^[a-z0-9_]+$ (max 64 chars)' });
      }

      let name;
      try { name = sanitizeName(req.body.name); }
      catch (e) { return res.status(400).json({ error: e.message }); }

      // Reject non-zip / zip-slip / zip-bomb before touching R2.
      try { assertSafeZip(bundle.buffer); }
      catch (e) { return res.status(400).json({ error: 'bundle rejected: ' + e.message }); }

      // Extract the 4 preview slots from the zip by convention filename. Whatever
      // is missing stays null → the theme won't show up in that tab in the app.
      const zipPreviews = extractPreviewsFromZip(bundle.buffer);
      const previewFiles = {};
      for (const slot of Object.keys(PREVIEW_SLOTS)) {
        if (zipPreviews[slot]) previewFiles[slot] = zipPreviews[slot];
      }

      const priceCoinsInt = Math.max(0, Math.min(1000, parseInt(priceCoins || '0', 10) || 0));

      // Auto-bump bundle_version.
      const { rows: existingRows } = await query(
        'SELECT bundle_version FROM themes WHERE id = $1',
        [id],
      );
      const newVersion = existingRows[0] ? existingRows[0].bundle_version + 1 : 1;

      const sha256 = crypto.createHash('sha256').update(bundle.buffer).digest('hex');
      const size = bundle.buffer.length;
      const bundleKey = `themes/${id}/v${newVersion}/bundle.zip`;

      // R2 keys for each extracted preview, keyed by the zip's own extension.
      const previewKeys = {};   // { main: 'themes/id/v1/preview.png', ... }
      for (const [slot, file] of Object.entries(previewFiles)) {
        const meta = PREVIEW_SLOTS[slot];
        previewKeys[slot] = `themes/${id}/v${newVersion}/${meta.file}.${file.ext}`;
      }

      // R2 uploads FIRST (order-of-operations: no DB row pointing at missing object).
      await r2.uploadObject(bundleKey, bundle.buffer, 'application/zip');
      for (const [slot, file] of Object.entries(previewFiles)) {
        await r2.uploadObject(previewKeys[slot], file.buffer, file.mime);
      }

      // Then upsert metadata. COALESCE keeps existing preview_path if this upload
      // did not include that slot — so uploading a new bundle without re-uploading
      // slice previews preserves them.
      await query(
        `INSERT INTO themes (
           id, name, is_free, order_index, bundle_version, bundle_sha256, bundle_size,
           bundle_path, preview_path, wallpaper_preview_path, icons_preview_path, widgets_preview_path,
           price_coins, min_app_version, status, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           is_free = EXCLUDED.is_free,
           order_index = EXCLUDED.order_index,
           bundle_version = EXCLUDED.bundle_version,
           bundle_sha256 = EXCLUDED.bundle_sha256,
           bundle_size = EXCLUDED.bundle_size,
           bundle_path = EXCLUDED.bundle_path,
           preview_path           = COALESCE(EXCLUDED.preview_path,           themes.preview_path),
           wallpaper_preview_path = COALESCE(EXCLUDED.wallpaper_preview_path, themes.wallpaper_preview_path),
           icons_preview_path     = COALESCE(EXCLUDED.icons_preview_path,     themes.icons_preview_path),
           widgets_preview_path   = COALESCE(EXCLUDED.widgets_preview_path,   themes.widgets_preview_path),
           price_coins            = EXCLUDED.price_coins,
           min_app_version = EXCLUDED.min_app_version,
           status = EXCLUDED.status,
           deleted_at = NULL,
           updated_at = NOW()`,
        [
          id,
          name,
          isFree === 'true' || isFree === true || isFree === '1',
          parseInt(order || '999', 10),
          newVersion,
          sha256,
          size,
          bundleKey,
          previewKeys.main       || null,
          previewKeys.wallpaper  || null,
          previewKeys.icons      || null,
          previewKeys.widgets    || null,
          priceCoinsInt,
          minAppVersion || '0.0.1',
          status || 'published',
        ],
      );

      // Retention: keep last 3 versions on R2 (fire-and-forget errors).
      r2.purgeOldVersions(id, newVersion, 3).catch((e) => {
        console.warn('[retention]', id, e.message);
      });

      res.json({
        ok: true,
        id,
        bundleVersion: newVersion,
        bundleSha256: sha256,
        bundleSize: size,
        bundlePath: bundleKey,
      });
    } catch (err) {
      console.error('[upload]', err);
      res.status(500).json({ error: 'upload failed' });
    }
  },
);

// Replace one preview slot (main | wallpaper | icons | widgets).
// The admin form and multer field name is `preview` in every case — the slot
// query parameter tells us which DB column + R2 key to write.
app.post(
  '/admin/themes/:id/preview',
  audit('replace-preview'),
  upload.single('preview'),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!/^[a-z0-9_]+$/.test(id)) return res.status(400).json({ error: 'invalid id' });
      const slot = String(req.query.slot || 'main');
      const slotMeta = PREVIEW_SLOTS[slot];
      if (!slotMeta) {
        return res.status(400).json({ error: `invalid slot: ${slot} (main|wallpaper|icons|widgets)` });
      }
      const preview = req.file;
      if (!preview) return res.status(400).json({ error: 'preview file required' });
      if (!preview.mimetype || !preview.mimetype.startsWith('image/')) {
        return res.status(400).json({ error: 'preview must be an image' });
      }
      if (preview.buffer.length > 2 * 1024 * 1024) {
        return res.status(400).json({ error: 'preview too large (max 2MB)' });
      }

      const { rows } = await query(
        `SELECT bundle_version, ${slotMeta.column} AS old_path FROM themes WHERE id = $1`,
        [id],
      );
      const existing = rows[0];
      if (!existing) return res.status(404).json({ error: 'not found' });

      const version = existing.bundle_version;
      const rawExt = path.extname(preview.originalname).slice(1).toLowerCase();
      const ext = ['webp', 'png', 'jpg', 'jpeg', 'gif'].includes(rawExt) ? rawExt : 'png';
      const newKey = `themes/${id}/v${version}/${slotMeta.file}.${ext}`;
      const mime = preview.mimetype || `image/${ext}`;

      await r2.uploadObject(newKey, preview.buffer, mime);

      if (existing.old_path && existing.old_path !== newKey) {
        r2.deleteObject(existing.old_path).catch(() => {});
      }

      await query(
        `UPDATE themes SET ${slotMeta.column} = $1, updated_at = NOW() WHERE id = $2`,
        [newKey, id],
      );

      res.json({ ok: true, slot, previewUrl: r2.publicUrl(newKey), previewPath: newKey });
    } catch (err) {
      console.error('[preview replace]', err);
      res.status(500).json({ error: 'preview replace failed' });
    }
  },
);

app.patch('/admin/themes/:id', audit('patch'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^[a-z0-9_]+$/.test(id)) return res.status(400).json({ error: 'invalid id' });
    const map = {
      status: 'status',
      isFree: 'is_free',
      order: 'order_index',
      name: 'name',
      minAppVersion: 'min_app_version',
      priceCoins: 'price_coins',
    };
    const allowedStatus = new Set(['published', 'draft', 'unpublished']);
    const updates = [];
    const params = [];
    for (const [k, v] of Object.entries(req.body || {})) {
      const col = map[k];
      if (!col) continue;
      let value;
      if (col === 'is_free') value = (v === true || v === 'true' || v === 1);
      else if (col === 'order_index') {
        value = parseInt(v, 10);
        if (!Number.isFinite(value) || value < 0 || value > 100000) {
          return res.status(400).json({ error: 'order must be 0..100000' });
        }
      }
      else if (col === 'status') {
        if (!allowedStatus.has(v)) return res.status(400).json({ error: 'invalid status' });
        value = v;
      }
      else if (col === 'name') {
        try { value = sanitizeName(v); }
        catch (e) { return res.status(400).json({ error: e.message }); }
      }
      else if (col === 'min_app_version') {
        if (typeof v !== 'string' || v.length > 20 || !/^[0-9.]+$/.test(v)) {
          return res.status(400).json({ error: 'invalid minAppVersion' });
        }
        value = v;
      }
      else if (col === 'price_coins') {
        value = parseInt(v, 10);
        if (!Number.isFinite(value) || value < 0 || value > 1000) {
          return res.status(400).json({ error: 'priceCoins must be 0..1000' });
        }
      }
      else value = v;
      params.push(value);
      updates.push(`${col} = $${params.length}`);
    }
    if (updates.length === 0) return res.status(400).json({ error: 'no valid fields' });
    params.push(id);
    const result = await query(
      `UPDATE themes SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`,
      params,
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[patch]', err);
    res.status(500).json({ error: 'patch failed' });
  }
});

app.delete('/admin/themes/:id', audit('delete'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^[a-z0-9_]+$/.test(id)) return res.status(400).json({ error: 'invalid id' });
    const permanent = req.query.permanent === 'true';
    const { rows } = await query('SELECT 1 FROM themes WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'not found' });

    if (permanent) {
      const objects = await r2.listObjects(`themes/${id}/`);
      await Promise.all(objects.map((o) => r2.deleteObject(o.key)));
      await query('DELETE FROM themes WHERE id = $1', [id]);
    } else {
      await query('UPDATE themes SET deleted_at = NOW() WHERE id = $1', [id]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[delete]', err);
    res.status(500).json({ error: 'delete failed' });
  }
});

app.post('/admin/themes/:id/restore', audit('restore'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^[a-z0-9_]+$/.test(id)) return res.status(400).json({ error: 'invalid id' });
    const result = await query(
      'UPDATE themes SET deleted_at = NULL, updated_at = NOW() WHERE id = $1',
      [id],
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[restore]', err);
    res.status(500).json({ error: 'restore failed' });
  }
});

// -------------------- coin config admin --------------------

app.get('/admin/coin-config', (_req, res) => {
  res.json({
    dailyCheckinRewards: coinCfg.dailyCheckinRewards,
    watchAdRewardAmount: coinCfg.watchAdRewardAmount,
    watchAdDailyCap:     coinCfg.watchAdDailyCap,
    notifBonusAmount:    coinCfg.notifBonusAmount,
    initialCoinGrant:    coinCfg.initialCoinGrant,
    updatedAt:           coinCfg.updatedAt,
    updatedBy:           coinCfg.updatedBy,
  });
});

app.put('/admin/coin-config', audit('coin-config-update'), async (req, res) => {
  try {
    const b = req.body || {};

    // Validate each field. Any bad input rejects the whole PUT — partial edits
    // would leave the config in a mixed old/new state that's confusing to reason about.
    const errs = [];

    let rewards = b.dailyCheckinRewards;
    if (!Array.isArray(rewards) || rewards.length < 1 || rewards.length > 30) {
      errs.push('dailyCheckinRewards must be an array of 1..30 ints');
    } else {
      rewards = rewards.map((x) => parseInt(x, 10));
      if (rewards.some((n) => !Number.isFinite(n) || n < 0 || n > 10000)) {
        errs.push('dailyCheckinRewards entries must be integers 0..10000');
      }
    }

    const validateInt = (name, min, max) => {
      const n = parseInt(b[name], 10);
      if (!Number.isFinite(n) || n < min || n > max) {
        errs.push(`${name} must be an integer ${min}..${max}`);
        return null;
      }
      return n;
    };
    const watchAdRewardAmount = validateInt('watchAdRewardAmount', 0, 10000);
    const watchAdDailyCap     = validateInt('watchAdDailyCap',     0, 100);
    const notifBonusAmount    = validateInt('notifBonusAmount',    0, 100000);
    const initialCoinGrant    = validateInt('initialCoinGrant',    0, 100000);

    if (errs.length) return res.status(400).json({ error: 'invalid config', details: errs });

    await query(
      `UPDATE coin_config
       SET daily_checkin_rewards  = $1,
           watch_ad_reward_amount = $2,
           watch_ad_daily_cap     = $3,
           notif_bonus_amount     = $4,
           initial_coin_grant     = $5,
           updated_at             = NOW(),
           updated_by             = $6
       WHERE id = 1`,
      [rewards, watchAdRewardAmount, watchAdDailyCap, notifBonusAmount, initialCoinGrant, req.adminEmail],
    );
    await loadCoinConfig();   // reload in-memory cache so getters return the new values immediately
    res.json({
      ok: true,
      dailyCheckinRewards: coinCfg.dailyCheckinRewards,
      watchAdRewardAmount: coinCfg.watchAdRewardAmount,
      watchAdDailyCap:     coinCfg.watchAdDailyCap,
      notifBonusAmount:    coinCfg.notifBonusAmount,
      initialCoinGrant:    coinCfg.initialCoinGrant,
      updatedAt:           coinCfg.updatedAt,
      updatedBy:           coinCfg.updatedBy,
    });
  } catch (err) {
    console.error('[coin-config PUT]', err);
    res.status(500).json({ error: 'coin config update failed' });
  }
});

// -------------------- coin economy endpoints --------------------

// Anti-DoS on public coin endpoints — per-IP, generous but non-zero.
const coinLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

// Coin-economy knobs are admin-tunable via the "Coin Config" tab in admin.html.
// Persisted in the `coin_config` table (singleton row id=1); an in-memory cache
// [coinCfg] mirrors it and reloads on every successful PUT. Every /coin/* response
// piggy-backs this config so the client stays in sync without a separate call.
//
// Cache seeds from DB on startup. If the DB read fails (fresh install, network),
// we fall back to the same defaults that used to be hardcoded here so behaviour
// is unchanged. See loadCoinConfig() + PUT /admin/coin-config below.
const COIN_CFG_DEFAULTS = Object.freeze({
  dailyCheckinRewards: [3, 5, 7, 10, 15, 20, 30],
  watchAdRewardAmount: 3,
  watchAdDailyCap: 5,
  notifBonusAmount: 10,
  initialCoinGrant: 10,
});
let coinCfg = { ...COIN_CFG_DEFAULTS, updatedAt: null, updatedBy: null };

async function loadCoinConfig() {
  try {
    const { rows } = await query(
      `SELECT daily_checkin_rewards, watch_ad_reward_amount, watch_ad_daily_cap,
              notif_bonus_amount, initial_coin_grant, updated_at, updated_by
       FROM coin_config WHERE id = 1`,
    );
    if (rows[0]) {
      const r = rows[0];
      coinCfg = {
        dailyCheckinRewards: r.daily_checkin_rewards || COIN_CFG_DEFAULTS.dailyCheckinRewards,
        watchAdRewardAmount: r.watch_ad_reward_amount,
        watchAdDailyCap:     r.watch_ad_daily_cap,
        notifBonusAmount:    r.notif_bonus_amount,
        initialCoinGrant:    r.initial_coin_grant,
        updatedAt:           r.updated_at,
        updatedBy:           r.updated_by,
      };
    }
  } catch (err) {
    console.warn('[coin-config] load failed, keeping defaults:', err.message);
  }
}
function coinDailyCheckinRewards() { return coinCfg.dailyCheckinRewards; }
function coinCycleLength()         { return coinCfg.dailyCheckinRewards.length; }
function coinWatchAdsCap()         { return coinCfg.watchAdDailyCap; }
function coinWatchAdRewardAmount() { return coinCfg.watchAdRewardAmount; }
function coinNotifBonusAmount()    { return coinCfg.notifBonusAmount; }
function coinOnboardingBonus()     { return coinCfg.initialCoinGrant; }

function isValidDeviceId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(id);
}

// Local (server host) date as YYYY-MM-DD — matches Android device-local midnight semantics
// closely enough for our anti-cheat needs since server + client should be in the same country
// timezone for this app. If deployed globally, switch to per-user tz sent from client.
function todayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function isoDaysDiff(a, b) {
  // a, b: 'YYYY-MM-DD'. Returns b - a in whole days.
  const da = new Date(a + 'T00:00:00Z');
  const db = new Date(b + 'T00:00:00Z');
  return Math.round((db.getTime() - da.getTime()) / (24 * 60 * 60 * 1000));
}

// Read a single row with DATE columns cast to `YYYY-MM-DD` strings so JS date-parsing
// timezone ambiguities (server tz vs Postgres tz vs `pg` library behaviour) cannot cause
// off-by-one comparisons in the checkin/watch-ad logic. Always use this instead of `SELECT *`.
const STATE_SELECT_COLS = `
  device_id,
  balance,
  unlocked_theme_ids,
  streak_day,
  to_char(last_checkin_date, 'YYYY-MM-DD') AS last_checkin_date,
  watch_ads_today,
  to_char(watch_ads_today_date, 'YYYY-MM-DD') AS watch_ads_today_date,
  notif_bonus_claimed
`;

async function readState(deviceId) {
  const { rows } = await query(
    `SELECT ${STATE_SELECT_COLS} FROM user_coin_state WHERE device_id = $1`,
    [deviceId],
  );
  return rows[0] || null;
}

async function getOrCreateState(deviceId) {
  await query(
    `INSERT INTO user_coin_state (device_id) VALUES ($1)
     ON CONFLICT (device_id) DO NOTHING`,
    [deviceId],
  );
  return readState(deviceId);
}

// Continuous streak (never resets at Day 7). `dayInCycle` (1..7) drives the UI grid,
// while `nextClaimDay` and `streakDay` are the raw running counters so we can display
// "Streak: N days" and repeat the reward pattern across cycles.
function rewardForStreakDay(streakDay) {
  const rewards = coinDailyCheckinRewards();
  const len = rewards.length;
  const idx = ((streakDay - 1) % len + len) % len;
  return rewards[idx];
}

function stateToPayload(row) {
  const today = todayIso();
  // `last_checkin_date` / `watch_ads_today_date` already come in as 'YYYY-MM-DD' strings
  // (or null) via [readState]; no JS Date parsing here — that's what caused the bug.
  const lastCheckin = row.last_checkin_date || null;
  const watchDate = row.watch_ads_today_date || null;
  const usedTodayEffective = watchDate === today ? row.watch_ads_today : 0;
  const nextClaimDay = (() => {
    if (!lastCheckin) return 1;
    if (lastCheckin === today) return row.streak_day;
    const gap = isoDaysDiff(lastCheckin, today);
    if (gap === 1) return row.streak_day + 1;   // Continuous, never resets
    return 1;                                    // Missed day → reset to 1
  })();
  const dayInCycle = ((nextClaimDay - 1) % coinCycleLength()) + 1;
  const canClaimToday = lastCheckin !== today;
  return {
    balance: row.balance,
    unlockedThemeIds: row.unlocked_theme_ids || [],
    streakDay: row.streak_day,
    lastCheckinDate: lastCheckin,
    watchAdsToday: usedTodayEffective,
    watchAdsTodayDate: usedTodayEffective > 0 ? watchDate : null,
    notifBonusClaimed: !!row.notif_bonus_claimed,
    dailyCheckin: {
      canClaimToday,
      nextClaimDay,
      dayInCycle,
      todayReward: canClaimToday ? rewardForStreakDay(nextClaimDay) : 0,
    },
    watchAdsCap: coinWatchAdsCap(),
  };
}

app.use('/coin', coinLimiter);

app.get('/coin/state', async (req, res) => {
  try {
    const deviceId = String(req.query.device_id || '');
    if (!isValidDeviceId(deviceId)) return res.status(400).json({ error: 'invalid device_id' });
    const state = await getOrCreateState(deviceId);
    res.json(stateToPayload(state));
  } catch (err) {
    console.error('[coin/state]', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Seed initial state on a brand-new device (never seen before). Ignored if the row
// already exists — protects against clients trying to overwrite a real balance
// by claiming they had it locally.
app.post('/coin/init', express.json(), async (req, res) => {
  try {
    const deviceId = String(req.body?.device_id || '');
    if (!isValidDeviceId(deviceId)) return res.status(400).json({ error: 'invalid device_id' });
    const seed = req.body?.seed || {};
    // Onboarding bonus floor: even if the local upgrade seed was 0/1/2, the user still
    // gets at least the admin-configured `initial_coin_grant` on first state.
    const rawSeed = Math.max(0, Math.min(1_000_000, parseInt(seed.balance || 0, 10) || 0));
    const seedBalance = Math.max(rawSeed, coinOnboardingBonus());
    const seedUnlocked = Array.isArray(seed.unlockedThemeIds)
      ? seed.unlockedThemeIds.filter((s) => typeof s === 'string' && s.length <= 64).slice(0, 500)
      : [];
    // Insert only if not exists — anti-cheat.
    await query(
      `INSERT INTO user_coin_state (device_id, balance, unlocked_theme_ids)
       VALUES ($1, $2, $3)
       ON CONFLICT (device_id) DO NOTHING`,
      [deviceId, seedBalance, seedUnlocked],
    );
    const fresh = await readState(deviceId);
    res.json(stateToPayload(fresh));
  } catch (err) {
    console.error('[coin/init]', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/coin/spend', express.json(), async (req, res) => {
  try {
    const deviceId = String(req.body?.device_id || '');
    const themeId = String(req.body?.theme_id || '');
    const clientCost = parseInt(req.body?.cost || 0, 10) || 0;
    if (!isValidDeviceId(deviceId)) return res.status(400).json({ error: 'invalid device_id' });
    if (!themeId || themeId.length > 64) return res.status(400).json({ error: 'invalid theme_id' });
    if (clientCost < 0 || clientCost > 1000) return res.status(400).json({ error: 'invalid cost' });

    // Server-authoritative price. Look up the theme's ACTUAL published price;
    // ignore whatever the client sent as `cost` (which is display-only). Prevents
    // a hacked client from claiming a paid theme is free by sending cost=0, and
    // prevents the race where the app's manifest sync hasn't populated priceCoins
    // yet at the moment the user tapped Apply.
    const themeRow = await query(
      `SELECT price_coins
       FROM themes
       WHERE id = $1 AND deleted_at IS NULL AND status = 'published'`,
      [themeId],
    );
    // If the theme is not published on the server (e.g. a locally-bundled free
    // theme like `attack_on_titan` shipped in the APK), fall back to clientCost
    // capped at 1000 — such themes are typically free (0) anyway.
    const serverPrice = themeRow.rowCount > 0
      ? Math.max(0, Number(themeRow.rows[0].price_coins) || 0)
      : Math.min(clientCost, 1000);

    const state = await getOrCreateState(deviceId);
    const unlocked = state.unlocked_theme_ids || [];
    if (unlocked.includes(themeId)) {
      // Idempotent — already unlocked, don't charge again.
      return res.json({ ok: true, alreadyUnlocked: true, chargedCost: 0, ...stateToPayload(state) });
    }
    if (state.balance < serverPrice) {
      return res.status(400).json({
        error: 'insufficient balance',
        chargedCost: serverPrice,
        ...stateToPayload(state),
      });
    }
    await query(
      `UPDATE user_coin_state
       SET balance = balance - $2,
           unlocked_theme_ids = array_append(unlocked_theme_ids, $3),
           updated_at = NOW()
       WHERE device_id = $1`,
      [deviceId, serverPrice, themeId],
    );
    const fresh = await readState(deviceId);
    res.json({ ok: true, chargedCost: serverPrice, ...stateToPayload(fresh) });
  } catch (err) {
    console.error('[coin/spend]', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/coin/checkin', express.json(), async (req, res) => {
  try {
    const deviceId = String(req.body?.device_id || '');
    if (!isValidDeviceId(deviceId)) return res.status(400).json({ error: 'invalid device_id' });
    const prev = await getOrCreateState(deviceId);
    const today = todayIso();
    const lastCheckin = prev.last_checkin_date;
    if (lastCheckin === today) {
      return res.json({ ok: false, alreadyClaimed: true, awarded: 0, ...stateToPayload(prev) });
    }
    const nextDay = (() => {
      if (!lastCheckin) return 1;
      const gap = isoDaysDiff(lastCheckin, today);
      if (gap === 1) return prev.streak_day + 1;   // Continuous — no cap at 7
      return 1;                                     // Missed a day → reset streak
    })();
    const reward = rewardForStreakDay(nextDay);
    // Atomic guard against races and clock-tampering: the WHERE clause only allows
    // the update when the stored last_checkin_date is NULL or strictly less than
    // today (as Postgres knows it). If someone else claimed first, rowCount = 0.
    const updated = await query(
      `UPDATE user_coin_state
       SET balance = balance + $2,
           streak_day = $3,
           last_checkin_date = CURRENT_DATE,
           updated_at = NOW()
       WHERE device_id = $1
         AND (last_checkin_date IS NULL OR last_checkin_date < CURRENT_DATE)`,
      [deviceId, reward, nextDay],
    );
    if (updated.rowCount === 0) {
      const fresh = await readState(deviceId);
      return res.json({ ok: false, alreadyClaimed: true, awarded: 0, ...stateToPayload(fresh) });
    }
    const fresh = await readState(deviceId);
    res.json({ ok: true, awarded: reward, ...stateToPayload(fresh) });
  } catch (err) {
    console.error('[coin/checkin]', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/coin/watch-ad', express.json(), async (req, res) => {
  try {
    const deviceId = String(req.body?.device_id || '');
    if (!isValidDeviceId(deviceId)) return res.status(400).json({ error: 'invalid device_id' });
    const prev = await getOrCreateState(deviceId);
    const today = todayIso();
    const watchDate = prev.watch_ads_today_date;
    const used = watchDate === today ? prev.watch_ads_today : 0;
    const cap = coinWatchAdsCap();
    const reward = coinWatchAdRewardAmount();
    if (used >= cap) {
      return res.json({ ok: false, full: true, awarded: 0, ...stateToPayload(prev) });
    }
    // Atomic: reset counter if the stored date < today, then increment. Concurrent
    // requests still cap correctly because we run the check inside the UPDATE.
    const updated = await query(
      `UPDATE user_coin_state
       SET balance = balance + $3,
           watch_ads_today = CASE
             WHEN watch_ads_today_date = CURRENT_DATE THEN watch_ads_today + 1
             ELSE 1
           END,
           watch_ads_today_date = CURRENT_DATE,
           updated_at = NOW()
       WHERE device_id = $1
         AND (watch_ads_today_date IS NULL
              OR watch_ads_today_date < CURRENT_DATE
              OR watch_ads_today < $2)`,
      [deviceId, cap, reward],
    );
    if (updated.rowCount === 0) {
      const fresh = await readState(deviceId);
      return res.json({ ok: false, full: true, awarded: 0, ...stateToPayload(fresh) });
    }
    const fresh = await readState(deviceId);
    res.json({ ok: true, awarded: reward, ...stateToPayload(fresh) });
  } catch (err) {
    console.error('[coin/watch-ad]', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/coin/notif-bonus', express.json(), async (req, res) => {
  try {
    const deviceId = String(req.body?.device_id || '');
    if (!isValidDeviceId(deviceId)) return res.status(400).json({ error: 'invalid device_id' });
    const state = await getOrCreateState(deviceId);
    if (state.notif_bonus_claimed) return res.json({ ok: false, alreadyClaimed: true, awarded: 0, ...stateToPayload(state) });
    const bonus = coinNotifBonusAmount();
    const updated = await query(
      `UPDATE user_coin_state
       SET balance = balance + $2,
           notif_bonus_claimed = true,
           updated_at = NOW()
       WHERE device_id = $1
         AND notif_bonus_claimed = false`,
      [deviceId, bonus],
    );
    if (updated.rowCount === 0) {
      const fresh = await readState(deviceId);
      return res.json({ ok: false, alreadyClaimed: true, awarded: 0, ...stateToPayload(fresh) });
    }
    const fresh = await readState(deviceId);
    res.json({ ok: true, awarded: bonus, ...stateToPayload(fresh) });
  } catch (err) {
    console.error('[coin/notif-bonus]', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// -------------------- startup --------------------

async function seedInitialAdmin() {
  if (!SEED_ADMIN_EMAIL || !SEED_ADMIN_PASSWORD) return;
  if (SEED_ADMIN_PASSWORD.length < 10) {
    console.warn(`[warn] ADMIN_INITIAL_PASSWORD is only ${SEED_ADMIN_PASSWORD.length} chars — OK for dev, NOT for production. Change via /auth/change-password or CLI.`);
  }
  if (/^(dev-|change-me|change-this)/i.test(process.env.SESSION_SECRET || '')) {
    console.warn('[warn] SESSION_SECRET looks like a placeholder. Rotate: openssl rand -hex 32');
  }
  const { rows } = await query('SELECT 1 FROM admin_users WHERE email = $1', [SEED_ADMIN_EMAIL]);
  if (rows.length) {
    console.log(`[seed] admin ${SEED_ADMIN_EMAIL} already exists`);
    return;
  }
  const hash = bcrypt.hashSync(SEED_ADMIN_PASSWORD, BCRYPT_COST);
  await query(
    'INSERT INTO admin_users (email, password_hash) VALUES ($1, $2)',
    [SEED_ADMIN_EMAIL, hash],
  );
  console.log(`[seed] created admin: ${SEED_ADMIN_EMAIL}`);
}

// Housekeeping: purge expired sessions + old login attempts hourly.
setInterval(async () => {
  try {
    await query('DELETE FROM admin_sessions WHERE expires_at < NOW()');
    await query(`DELETE FROM admin_login_attempts WHERE at < NOW() - INTERVAL '30 days'`);
  } catch (err) {
    console.warn('[housekeep]', err.message);
  }
}, 60 * 60 * 1000);

(async () => {
  try {
    await ensureSchema();
    console.log('[db] schema ready');
    await seedInitialAdmin();
    // Load coin_config into memory ONCE at startup. Every PUT /admin/coin-config
    // reloads it, so no per-request DB hit for the 5 knobs.
    await loadCoinConfig();
    app.listen(PORT, () => {
      console.log(`theme-be   http://localhost:${PORT}`);
      console.log(`login      http://localhost:${PORT}/login.html`);
      console.log(`admin      http://localhost:${PORT}/admin.html (auth required)`);
      console.log(`manifest   http://localhost:${PORT}/manifest (public)`);
    });
  } catch (err) {
    console.error('[startup]', err.message);
    process.exit(1);
  }
})();
