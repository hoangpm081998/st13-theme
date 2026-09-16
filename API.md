# Theme Backend — API Reference

Tài liệu API cho **Client team** (iLauncher OS Android app, package `com.ilauncher.oslauncher`).

- **Version:** v1
- **Last updated:** 2026-08-26
- **Contact:** [tên/email của BE owner]

---

## 1. Tổng quan

Backend cung cấp:

1. **Manifest endpoint** (`GET /manifest`) — list theme available để app render trong `IconThemeActivity`
2. **CDN URLs** — bundle `.zip` + preview image serve trực tiếp từ Cloudflare R2, không qua BE

**Client CHỈ dùng:**
- `GET /manifest` để fetch danh sách theme
- `GET <bundleUrl>` để tải bundle khi user Apply theme (URL lấy từ manifest, trỏ CDN)
- `GET <previewUrl>` để load ảnh preview (URL lấy từ manifest, trỏ CDN)
- (Optional) `GET /health` để monitor uptime

Các endpoint `/admin/*` và `/auth/*` là **cho designer**, client KHÔNG dùng — xem Appendix A.

---

## 2. Base URL

| Environment | Base URL | Chú thích |
|---|---|---|
| **Local dev (Android Emulator)** | `http://10.0.2.2:8787` | Emulator special IP → host machine |
| **Local dev (device cùng LAN)** | `http://<Mac-LAN-IP>:8787` | Lấy IP Mac: `ipconfig getifaddr en0` |
| **Staging** | *(TBD — BE sẽ cấp)* | HTTPS |
| **Production** | *(TBD — BE sẽ cấp)* | HTTPS bắt buộc |

Config trong app: `THEME_BE_URL` (`app/build.gradle.kts`).

**Production:** cần HTTPS. HTTP chỉ chấp nhận trong dev local. Android 9+ block cleartext traffic mặc định — client cần cấu hình `network_security_config.xml` cho phép domain BE trong debug builds.

---

## 3. Endpoints

### 3.1 `GET /manifest`

Fetch danh sách theme đang publish. Client gọi mỗi khi mở `IconThemeActivity`.

**Auth:** không cần (public).

**Request:**
```http
GET /manifest HTTP/1.1
Host: <base-url>
Accept: application/json
```

**Response 200:**
```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: public, max-age=3600
```
```json
{
  "version": 1787735396379,
  "themes": [
    {
      "id": "dragon_ball",
      "name": "Dragon Ball",
      "isFree": false,
      "order": 3,
      "previewUrl": "https://pub-8d557592318143ec8b5fbfbbfa13480d.r2.dev/themes/dragon_ball/v3/preview.webp",
      "wallpaperPreviewUrl": "https://pub-8d557592318143ec8b5fbfbbfa13480d.r2.dev/themes/dragon_ball/v3/wallpaperPreview.webp",
      "iconsPreviewUrl": "https://pub-8d557592318143ec8b5fbfbbfa13480d.r2.dev/themes/dragon_ball/v3/iconsPreview.webp",
      "widgetsPreviewUrl": "https://pub-8d557592318143ec8b5fbfbbfa13480d.r2.dev/themes/dragon_ball/v3/widgetsPreview.webp",
      "priceBundleCoins": 5,
      "priceIconsCoins": 3,
      "priceWidgetsCoins": 2,
      "priceCoins": 5,
      "bundleUrl": "https://pub-8d557592318143ec8b5fbfbbfa13480d.r2.dev/themes/dragon_ball/v3/bundle.zip",
      "bundleVersion": 3,
      "bundleSha256": "5496052f6e18c94f0c191a61e9159bdb1b88cc8df9a58b9ada00e38163ecdf28",
      "bundleSize": 1190451,
      "minAppVersion": "0.0.1"
    }
  ]
}
```

**Field spec:**

| Field | Type | Nullable | Ý nghĩa |
|---|---|---|---|
| `version` | `long` (unix millis) | no | Timestamp response. Dùng detect manifest đổi (nếu != version cache trước → refetch bundle mới nếu cần) |
| `themes[]` | `array` | no | Danh sách theme (có thể empty) |
| `themes[].id` | `string` | no | Slug định danh, regex `^[a-z0-9_]+$`. Dùng làm key cache/analytics/unlock |
| `themes[].name` | `string` | no | Tên hiển thị (có thể chứa Unicode + space) |
| `themes[].isFree` | `boolean` | no | `true` = free, `false` = phải xem rewarded ad để unlock |
| `themes[].order` | `int` | no | Thứ tự hiển thị. Server đã sort ASC. `0` = ưu tiên nhất, `999` = default |
| `themes[].previewUrl` | `string` | **yes** | Absolute HTTPS URL preview chính (Themes tab). `null` nếu chưa upload |
| `themes[].wallpaperPreviewUrl` | `string` | **yes** | Absolute HTTPS URL preview cho Wallpaper tab. `null` = theme không xuất hiện ở tab Wallpaper khi chưa download |
| `themes[].iconsPreviewUrl` | `string` | **yes** | Absolute HTTPS URL preview cho Icons tab. `null` = theme không xuất hiện ở tab Icons khi chưa download |
| `themes[].widgetsPreviewUrl` | `string` | **yes** | Absolute HTTPS URL preview cho Widgets tab. `null` = theme không xuất hiện ở tab Widgets khi chưa download |
| `themes[].priceBundleCoins` | `int` | no | Coin cost để apply **full bundle** (tab Themes). `0` = free. |
| `themes[].priceIconsCoins` | `int` | no | Coin cost để apply **chỉ icon pack** (tab Icons). `0` = free. |
| `themes[].priceWidgetsCoins` | `int` | no | Coin cost để apply **chỉ widget skin** (tab Widgets). `0` = free. Wallpaper KHÔNG có giá coin — luôn free. |
| `themes[].priceCoins` | `int` | no | **Legacy** — giá cũ dùng chung cho cả 3 part. App version mới đọc 3 field ở trên; field này còn để 1 release cho app cũ fallback, sau đó BE có thể xoá. |
| `themes[].bundleUrl` | `string` | no | Absolute HTTPS URL tải bundle `.zip` |
| `themes[].bundleVersion` | `int` | no | Version bundle, tự bump khi re-upload. Client dùng để so với cache local → biết cần re-download hay không |
| `themes[].bundleSha256` | `string` | no | SHA-256 hex lowercase, 64 chars. Client **PHẢI** verify khi tải xong |
| `themes[].bundleSize` | `long` | no | Kích thước bundle bytes. Client so sánh khi tải để pre-allocate hoặc verify |
| `themes[].minAppVersion` | `string` | no | SemVer tối thiểu app phải hỗ trợ theme này (ví dụ `"1.2.0"`). Client filter theme nếu app version < minAppVersion |

**Contract locked:** app parser dùng `ignoreUnknownKeys = true` nên BE có thể **thêm** field mới không phá app cũ. **KHÔNG được đổi tên hoặc kiểu** của field đã có.

**Sort order:** server đã sort `ORDER BY order ASC, created_at ASC`. Client render theo thứ tự trả về, **không sort lại**.

**Cache:** response có `Cache-Control: public, max-age=3600` (1 giờ). Client nên tôn trọng — dùng OkHttp cache hoặc Retrofit cache. Nếu cần bypass (user pull-to-refresh), thêm query `?_=timestamp`.

**Response 5xx (rare):**
```json
{ "error": "internal error" }
```
Client retry với exponential backoff (1s, 2s, 4s, max 3 lần), sau đó fallback dùng cache local.

---

### 3.2 Tải bundle từ CDN

Không phải endpoint BE — client GET trực tiếp `bundleUrl` từ manifest tới **Cloudflare R2 CDN**.

**Request:**
```http
GET /themes/dragon_ball/v3/bundle.zip HTTP/1.1
Host: pub-8d557592318143ec8b5fbfbbfa13480d.r2.dev
```

**Response 200:**
```
HTTP/1.1 200 OK
Content-Type: application/zip
Content-Length: 1190451
Cache-Control: public, max-age=31536000, immutable
ETag: "..."
CF-Cache-Status: HIT
```
Body: bytes zip.

**Requirements — client PHẢI:**

1. **Verify SHA-256** sau khi tải xong:
   ```kotlin
   val expected = manifestTheme.bundleSha256
   val actual = MessageDigest.getInstance("SHA-256")
       .digest(bundleBytes)
       .joinToString("") { "%02x".format(it) }
   if (actual != expected) throw IntegrityException("SHA-256 mismatch")
   ```
   Nếu mismatch → **KHÔNG cache**, **KHÔNG apply**, refetch manifest (có thể URL cũ đã stale).

2. **Verify size** khớp `bundleSize`. Nếu không khớp → coi như MITM/corrupt, discard.

3. **Cache bundle theo `bundleVersion`** trong `id`. Ví dụ path local:
   ```
   /data/data/com.ilauncher.oslauncher/theme_cache/<id>/v<n>/bundle.zip
   ```
   Nếu manifest trả `bundleVersion=3` và cache local là v2 → tải v3 mới, xoá v2 sau khi apply xong.

4. **Retry** 3 lần với backoff exponential nếu network fail hoặc HTTP 5xx từ CDN. HTTP 404 → manifest stale → refetch manifest.

5. **Zip extraction safety** — parse zip với thư viện standard, reject entry có path chứa `..` hoặc absolute path (zip-slip). Server đã validate zip trước khi upload nhưng client vẫn nên defense-in-depth.

**URL pattern:** `<R2_PUBLIC_BASE>/themes/<id>/v<n>/bundle.zip` — **immutable** (URL không đổi với cùng version). Client cache aggressive OK.

---

### 3.3 Tải preview image

Tương tự — GET trực tiếp `previewUrl` từ manifest.

Content-Type: `image/webp` / `image/png` / `image/jpg` tùy designer upload.

Dùng cho grid theme trong `IconThemeActivity`. Load bằng thư viện image loader (Coil / Glide / Fresco) — chúng auto-cache theo URL.

---

### 3.4 `GET /health` (optional)

Endpoint monitoring — không dùng runtime, chỉ nếu client muốn ping check BE.

**Response 200:**
```json
{ "ok": true, "ts": 1787736967089 }
```

**Response 503:** BE có vấn đề (DB down, etc.)
```json
{ "ok": false }
```

---

## 4. Error responses (unified)

Mọi error trả về JSON:
```json
{ "error": "<message>" }
```

| HTTP code | Ý nghĩa | Client behavior |
|---|---|---|
| `400` | Request malformed | Bug client — không retry, log |
| `401` | Unauthorized (không xảy ra với `/manifest`) | Chỉ áp dụng cho admin endpoints |
| `404` | Bundle không tồn tại trên CDN | Manifest stale → refetch manifest |
| `429` | Rate limit vượt | Backoff, retry sau `Retry-After` seconds (header có) |
| `5xx` | Server error | Retry 3 lần backoff exponential, fallback cache local |

**Rate limit trên `/manifest`:** không có (public, cache 1 giờ giảm tải). Nhưng nên tôn trọng `Cache-Control` để không hammer.

---

## 5. Versioning & compatibility

### 5.1 Manifest version

- `manifest.version` = timestamp millis mỗi lần response.
- **Không** phải semver. Không dùng để so sánh "version app support".
- Dùng detect manifest có đổi:
  - App poll manifest mỗi lần vào `IconThemeActivity`.
  - Nếu `manifest.version` = version lần trước → không thay đổi gì, skip re-download.
  - Nếu khác → so sánh từng theme, tìm theme có `bundleVersion` tăng → refetch bundle.

### 5.2 App version gate

- `minAppVersion` per theme (ví dụ `"1.2.0"`).
- Client parse app version hiện tại (từ `BuildConfig.VERSION_NAME`), so sánh SemVer.
- Nếu `appVersion < minAppVersion` → **ẩn theme** trong UI (hoặc hiện với disabled state + tooltip "Cần cập nhật app").

### 5.3 Bundle version

- `bundleVersion` tăng monotone khi designer re-upload cùng `id`.
- URL chứa version → immutable, không invalidate CDN.
- Server giữ **N=3 version** gần nhất trên CDN. Nếu app có cache manifest cũ trỏ về version <= current-3, request URL đó = 404 → refetch manifest.

---

## 6. Contract stability guarantee

Field trong response `/manifest.themes[]` đã **lock**:
- `id`, `name`, `isFree`, `order`, `previewUrl`, `bundleUrl`, `bundleVersion`, `bundleSha256`, `bundleSize`, `minAppVersion`

BE cam kết:
- **KHÔNG đổi tên field**
- **KHÔNG đổi kiểu** (`isFree` luôn `boolean`, `bundleSize` luôn `number`, etc.)
- **KHÔNG remove field**
- **KHÔNG thay đổi ngữ nghĩa**

BE có thể:
- **Thêm** field mới (`themes[].extraField: "..."`) — client phải dùng parser `ignoreUnknownKeys = true` (Kotlin Serialization / Moshi default OK)
- **Thêm** top-level field cạnh `themes` (`extra: {...}`) — không phá gì

Nếu cần breaking change → mở endpoint mới `/v2/manifest` + duy trì `/manifest` song song ≥6 tháng.

---

## 7. Security notes

- **HTTPS bắt buộc** trong production. HTTP dev local OK.
- **Bundle SHA-256 verify** là bắt buộc — chống MITM + chống file corrupt.
- **Không có API key** — manifest public. OK vì:
  - Không có nội dung nhạy cảm
  - Theme unlock qua rewarded ad, không phải paywall
- **CDN URL public** — anyone có URL đều tải được. Nếu client rip bundle share cho user khác → user đó bypass rewarded ad. Chấp nhận rủi ro này (revenue model không phụ thuộc bundle secret, mà là ad impression tại thời điểm apply).

---

## 8. Testing checklist cho Client

Trước khi ship version mới của app:

- [ ] Fetch `/manifest` — parse JSON không lỗi
- [ ] Tất cả field trong response được map đúng type
- [ ] Verify SHA-256 sau khi tải bundle (test với bundle valid + intentional corrupt)
- [ ] Bundle size check
- [ ] `minAppVersion` gating hoạt động (test với theme có minAppVersion cao hơn app version)
- [ ] Cache bundle theo `<id>/v<n>` path
- [ ] Detect version bump — refetch bundle mới, xoá version cũ khỏi cache
- [ ] Handle `previewUrl = null` gracefully
- [ ] Handle empty `themes: []` (BE chưa có theme nào)
- [ ] Handle 5xx → retry với backoff
- [ ] Handle 404 bundle URL → refetch manifest
- [ ] Zip extraction reject path `..` (defense in depth)
- [ ] Test với network chậm/mất kết nối giữa chừng — resume-friendly
- [ ] Test manifest cache: 2 lần mở activity liên tiếp → không hammer BE

---

## 9. Sample code (Kotlin)

### 9.1 Fetch manifest (Retrofit + Kotlin Serialization)

```kotlin
@Serializable
data class Manifest(
    val version: Long,
    val themes: List<RemoteTheme>
)

@Serializable
data class RemoteTheme(
    val id: String,
    val name: String,
    val isFree: Boolean,
    val order: Int,
    val previewUrl: String? = null,
    val bundleUrl: String,
    val bundleVersion: Int,
    val bundleSha256: String,
    val bundleSize: Long,
    val minAppVersion: String,
)

interface ThemeBeApi {
    @GET("/manifest")
    suspend fun getManifest(): Manifest
}
```

### 9.2 Download + verify bundle

```kotlin
suspend fun downloadBundle(theme: RemoteTheme, cacheDir: File): File {
    val target = File(cacheDir, "${theme.id}/v${theme.bundleVersion}/bundle.zip")
    if (target.exists() && target.length() == theme.bundleSize) {
        val cachedSha = target.sha256Hex()
        if (cachedSha == theme.bundleSha256) return target   // cache hit
    }

    target.parentFile?.mkdirs()
    val response = httpClient.newCall(Request.Builder().url(theme.bundleUrl).build()).execute()
    if (!response.isSuccessful) throw IOException("HTTP ${response.code}")

    val bytes = response.body!!.bytes()
    if (bytes.size.toLong() != theme.bundleSize) {
        throw IntegrityException("size mismatch: got ${bytes.size} expected ${theme.bundleSize}")
    }

    val actualSha = MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { "%02x".format(it) }
    if (actualSha != theme.bundleSha256) {
        throw IntegrityException("SHA-256 mismatch")
    }

    target.writeBytes(bytes)
    return target
}
```

### 9.3 Version bump detection

```kotlin
suspend fun syncTheme(remote: RemoteTheme) {
    val cached = themeDao.get(remote.id)
    if (cached != null && cached.bundleVersion >= remote.bundleVersion) {
        return  // cache still valid
    }
    // Version bumped — download new
    val bundle = downloadBundle(remote, cacheDir)
    // Delete old version if exists
    cached?.let {
        File(cacheDir, "${it.id}/v${it.bundleVersion}").deleteRecursively()
    }
    themeDao.upsert(remote.toEntity())
}
```

---

## Appendix A — Endpoints NOT for Client

Các endpoint dưới đây là **cho designer/admin**, client tuyệt đối không dùng:

| Endpoint | Mục đích |
|---|---|
| `GET /login.html`, `GET /admin.html` | Admin UI web |
| `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/change-password` | Session management |
| `GET /admin/themes`, `POST /admin/upload`, `PATCH /admin/themes/:id`, `DELETE /admin/themes/:id`, `POST /admin/themes/:id/restore`, `POST /admin/themes/:id/preview` | Theme CRUD |

Tất cả admin endpoints yêu cầu session cookie `theme_admin_session`, protected bằng rate limit (100 req/phút/IP).

---

## Appendix B — Common issues

### Manifest trả cache cũ sau khi designer upload theme mới
Client nên tôn trọng `Cache-Control: max-age=3600`. Nếu cần force refresh:
- Thêm query `?_=<random>` vào URL
- Hoặc dùng OkHttp `.cacheControl(CacheControl.FORCE_NETWORK)`

### `bundleUrl` trả 404
1. Manifest cache local đã stale (bundle version cũ đã bị BE retention purge).
2. Solution: refetch `/manifest`, dùng URL mới.

### SHA-256 mismatch liên tục
1. Kiểm tra bundle download có bị proxy modify không (corporate proxy, dev proxy).
2. Kiểm tra `bundleSize` — nếu size khác cũng là dấu hiệu.
3. Report cho BE — có thể designer upload zip bị corrupt.

### `previewUrl = null`
Theme chưa upload preview image. Client hiển thị placeholder default hoặc fallback UI.

### `network_security_config` block dev URL
Android 9+ block cleartext HTTP. Thêm `res/xml/network_security_config.xml`:
```xml
<network-security-config>
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="true">10.0.2.2</domain>
    <domain includeSubdomains="true">192.168.1.0</domain> <!-- LAN range -->
  </domain-config>
</network-security-config>
```
Rồi trong `AndroidManifest.xml`: `<application android:networkSecurityConfig="@xml/network_security_config">`.

**Production dùng HTTPS — không cần config này.**

---

## Appendix C — Changelog

| Date | Change |
|---|---|
| 2026-08-26 | v1 initial release. Endpoint `/manifest`, R2 CDN, contract locked. |

---

## Liên hệ

- **BE issues:** [tên/kênh Slack]
- **API contract change proposal:** mở PR / ticket
- **On-call:** [tên/pager]
