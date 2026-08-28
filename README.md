# theme-be-local

Reference implementation của **Theme Backend** cho iLauncher OS Android app.

**Trạng thái:** Local prototype dùng SQLite + local filesystem. Production BE cần port sang Postgres + Bunny CDN (xem `SPEC.md` + `AUTH_SPEC.md`).

---

## Chạy local trong 30 giây

```bash
cp .env.example .env
# sửa ADMIN_INITIAL_PASSWORD, SESSION_SECRET trong .env

npm install
npm start
```

Mở browser:
- **Login:** http://localhost:8787/login.html (dùng credential trong `.env`)
- **Admin:** http://localhost:8787/admin.html (auto redirect nếu chưa login)
- **Manifest (public):** http://localhost:8787/manifest

Android app config `THEME_BE_URL` trong `app/build.gradle.kts`:
- Emulator: `http://10.0.2.2:8787`
- Device thật cùng LAN: `http://<Mac-LAN-IP>:8787` (lấy IP bằng `ipconfig getifaddr en0`)

---

## Cấu trúc

```
theme-be-local/
├── server.js              # Express server + auth + endpoints (~350 lòng)
├── cli.js                 # CLI: add-admin, reset-password, list-admins, remove-admin
├── .env.example           # Template env — copy sang .env, sửa giá trị
├── package.json
├── public/
│   ├── admin.html         # Admin UI (list + upload + inline edit)
│   └── login.html         # Login page
├── data/                  # gitignored
│   ├── themes.db          # SQLite: themes + admin_users + admin_sessions
│   └── uploads/           # Bundle zip + preview file (production: Bunny)
├── SPEC.md                # Feature spec + Bunny integration cho BE dev
├── AUTH_SPEC.md           # Chi tiết auth + security cho BE dev
└── README.md              # File này
```

---

## Admin management

Không có endpoint HTTP để add admin (security) — chỉ CLI trên server.

```bash
node cli.js add-admin designer@example.com       # prompt password
node cli.js list-admins
node cli.js reset-password designer@example.com  # force logout
node cli.js remove-admin ex-designer@example.com # xoá + cascade sessions
```

---

## API endpoints

| Method | Path | Auth | Mục đích |
|---|---|---|---|
| GET | `/manifest` | ❌ public | App Android fetch |
| POST | `/auth/login` | ❌ | Email + password → set cookie |
| POST | `/auth/logout` | any | Clear cookie |
| GET | `/auth/me` | any | Current admin email |
| POST | `/auth/change-password` | ✅ | Đổi password + revoke other sessions |
| GET | `/admin.html` | ✅ | Admin UI (redirect login nếu chưa auth) |
| GET | `/admin/themes` | ✅ | List all themes (?trash=true xem recycle bin) |
| POST | `/admin/upload` | ✅ | Upload theme (multipart: bundle + preview + metadata) |
| PATCH | `/admin/themes/:id` | ✅ | Edit fields (status, isFree, order, name) |
| DELETE | `/admin/themes/:id` | ✅ | Soft delete (add ?permanent=true để xoá vĩnh viễn) |
| POST | `/admin/themes/:id/restore` | ✅ | Un-soft-delete |

Chi tiết request/response: `SPEC.md` section 5.

---

## Chuyển sang production

Xem 3 doc theo thứ tự:

1. **`SPEC.md`** — Overview, data model, feature list, Bunny integration
2. **`AUTH_SPEC.md`** — Auth details, security checklist, incident response
3. Source code trong repo này — reference impl

**Delta chính:**

| Local | Production |
|---|---|
| SQLite | Postgres (managed: Supabase/Neon/Railway) |
| Local filesystem `data/uploads/` | Bunny Storage (upload qua HTTP PUT) |
| Serve file qua `/files/*` static | Serve qua Bunny CDN (`<pull-zone>.b-cdn.net`) — xoá route `/files/*` |
| `NODE_ENV=development` | `NODE_ENV=production` (cookie `Secure` flag) |
| HTTP | HTTPS (host provider tự lo TLS) |
| `SESSION_SECRET` random mỗi restart | Fixed trong env, generate bằng `openssl rand -hex 32` |
| Seed admin qua env | Dùng CLI trên server production |

Không cần đổi:
- Auth flow (bcrypt + cookie session + rate limit)
- API contract (Android app đã lock)
- Zip validation logic
- Schema `themes` table (thêm cột `bundle_path`, `preview_path` thay `preview_ext`)

---

## Test quick

```bash
# Login + list themes
curl -c cookies.txt -X POST http://localhost:8787/auth/login \
  -H "content-type: application/json" \
  -d '{"email":"admin@example.com","password":"admin123456"}'

curl -b cookies.txt http://localhost:8787/admin/themes

# Upload theme (zip có sẵn dragon_ball.zip)
curl -b cookies.txt -X POST http://localhost:8787/admin/upload \
  -F "id=test_theme" -F "name=Test" -F "isFree=false" \
  -F "bundle=@/path/to/theme.zip"

# Manifest public
curl http://localhost:8787/manifest
```
