let cachedAccessKeys = null;
let cachedAccessKeysAt = 0;
let lastHousekeepingAt = 0;

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const DEFAULT_SETTINGS = {
  public_booking_days: "180",
  priority_booking_days: "365"
};
const MAX_ACTIVE_BOOKINGS_PER_DAY = 2;
const MAX_BOOKING_MINUTES = 120;
const COURT_COUNT = 6;
const ADMIN_COOKIE = "chs_admin_session";
const ADMIN_SESSION_SECONDS = 8 * 60 * 60;
const HOUSEKEEPING_INTERVAL_MS = 60 * 60 * 1000;
const BOOKING_HISTORY_RETENTION_DAYS = 90;
const AFFECTED_BOOKING_RETENTION_DAYS = 180;
const ADMIN_CALENDAR_HISTORY_RETENTION_DAYS = 180;
const REVIEWED_REQUEST_RETENTION_DAYS = 180;
const AUDIT_LOG_RETENTION_DAYS = 180;
const MAX_AUTO_REBOOK_OFFSET_MINUTES = 120;
const ADMIN_LOGIN_WINDOW_SECONDS = 10 * 60;
const ADMIN_LOGIN_LOCK_SECONDS = 15 * 60;
const ADMIN_LOGIN_MAX_FAILURES = 5;
const PUBLIC_MAINTENANCE_MAX_DAYS = 7;
const PUBLIC_MAINTENANCE_MAX_HOURS = 12;
const PUBLIC_MAINTENANCE_FUTURE_DAYS = 30;
const PUBLIC_PRIORITY_MAX_ACTIVE = 6;
const PUBLIC_PRIORITY_MAX_DAYS = 90;
const COURT_STATUS_OPEN_RETENTION_HOURS = 24;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function httpError(message, status = 400, code = "request_failed") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function methodNotAllowed() {
  return json({ error: "method_not_allowed", message: "That request method is not supported." }, 405);
}

async function readJson(request) {
  const body = await request.text();
  if (body.length > 30000) throw httpError("Request body is too large.", 413, "body_too_large");
  try { return JSON.parse(body); } catch (_) { throw httpError("Request body must be valid JSON.", 400, "invalid_json"); }
}

function normalizeTeamDomain(value = "") {
  const trimmed = value.trim().replace(/\/$/, "");
  if (!trimmed) return "";
  return trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`;
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJwtJson(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

function encodeBase64Url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function adminCredentialMap(env) {
  const raw = String(env.ADMIN_CREDENTIALS || "").trim();
  if (!raw) return {};
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { return {}; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const credentials = {};
  for (const [email, password] of Object.entries(parsed)) {
    const normalizedEmail = String(email).trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) && String(password).length >= 12) credentials[normalizedEmail] = String(password);
  }
  return credentials;
}

function allowedAdminEmails(env) {
  const configured = String(env.ADMIN_EMAILS || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
  return [...new Set([...configured, ...Object.keys(adminCredentialMap(env))])];
}

function cookieValue(request, name) {
  const cookie = String(request.headers.get("cookie") || "");
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return "";
}

async function adminSessionKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function createAdminSession(email, secret) {
  const payload = encodeBase64Url(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + ADMIN_SESSION_SECONDS }));
  const signature = await crypto.subtle.sign("HMAC", await adminSessionKey(secret), new TextEncoder().encode(payload));
  return `${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

async function verifyAdminSession(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) throw httpError("Admin sign-in is required.", 401, "admin_login_required");
  const verified = await crypto.subtle.verify(
    "HMAC",
    await adminSessionKey(secret),
    decodeBase64Url(parts[1]),
    new TextEncoder().encode(parts[0])
  );
  let payload;
  try { payload = decodeJwtJson(parts[0]); } catch (_) { payload = null; }
  if (!verified || !payload || !Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw httpError("The Admin Portal session has expired. Sign in again.", 401, "admin_login_required");
  }
  return payload;
}

async function secureTextEqual(left, right) {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(left))),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(right)))
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function getAccessKeys(teamDomain) {
  if (cachedAccessKeys && Date.now() - cachedAccessKeysAt < 3600000) return cachedAccessKeys;
  const response = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw httpError("Could not load Cloudflare Access signing keys.", 503, "access_keys_unavailable");
  const data = await response.json();
  cachedAccessKeys = data.keys || [];
  cachedAccessKeysAt = Date.now();
  return cachedAccessKeys;
}

async function verifyAdmin(request, env) {
  const teamDomain = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN);
  const audience = String(env.ACCESS_AUD || "").trim();
  const allowedEmails = allowedAdminEmails(env);
  const sessionSecret = String(env.ADMIN_SESSION_SECRET || "");
  const credentialCount = Object.keys(adminCredentialMap(env)).length;
  const passwordConfigured = (credentialCount > 0 || String(env.ADMIN_PASSWORD || "").length >= 12) && sessionSecret.length >= 32 && allowedEmails.length;

  const token = request.headers.get("cf-access-jwt-assertion");
  if (token && teamDomain && audience && allowedEmails.length) {
    const parts = token.split(".");
    if (parts.length !== 3) throw httpError("Invalid Access session.", 401, "invalid_access_token");
    const header = decodeJwtJson(parts[0]);
    const payload = decodeJwtJson(parts[1]);
    if (header.alg !== "RS256" || !header.kid) throw httpError("Unsupported Access token.", 401, "invalid_access_token");

    const keys = await getAccessKeys(teamDomain);
    const jwk = keys.find((key) => key.kid === header.kid);
    if (!jwk) throw httpError("Access signing key was not found.", 401, "invalid_access_token");
    const publicKey = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const verified = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      publicKey,
      decodeBase64Url(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    const now = Math.floor(Date.now() / 1000);
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!verified || payload.iss !== teamDomain || !audiences.includes(audience) || !Number.isFinite(payload.exp) || payload.exp <= now || (payload.nbf && payload.nbf > now)) {
      throw httpError("The Cloudflare Access session could not be verified.", 401, "invalid_access_token");
    }
    const email = String(payload.email || "").toLowerCase();
    if (!allowedEmails.includes(email)) throw httpError("This email is not on the Admin Portal allowlist.", 403, "admin_not_allowed");
    return { email, role: allowedEmails.indexOf(email) === 0 ? "admin" : "editor", teamDomain, authMode: "cloudflare_access", logoutUrl: `${teamDomain}/cdn-cgi/access/logout` };
  }

  if (passwordConfigured) {
    const payload = await verifyAdminSession(cookieValue(request, ADMIN_COOKIE), sessionSecret);
    const email = String(payload.email || "").toLowerCase();
    if (!allowedEmails.includes(email)) throw httpError("This email is no longer on the Admin Portal allowlist.", 403, "admin_not_allowed");
    return { email, role: allowedEmails.indexOf(email) === 0 ? "admin" : "editor", teamDomain: "", authMode: "temporary_password", logoutUrl: "/api/admin-logout" };
  }

  if (teamDomain && audience && allowedEmails.length) throw httpError("A verified Cloudflare Access session is required.", 401, "admin_login_required");
  throw httpError("Admin access is not configured. For pages.dev, set ADMIN_SESSION_SECRET plus either ADMIN_CREDENTIALS or ADMIN_EMAILS and ADMIN_PASSWORD.", 403, "admin_not_configured");
}

async function adminLoginAttemptKey(request, email) {
  const forwarded = String(request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${forwarded}|${email}`));
  return encodeBase64Url(new Uint8Array(digest));
}

async function assertAdminLoginAllowed(env, attemptKey, nowSeconds) {
  const attempt = await env.DB.prepare("SELECT * FROM admin_login_attempts WHERE attempt_key = ?").bind(attemptKey).first();
  if (!attempt) return;
  if (Number(attempt.locked_until) > nowSeconds) {
    throw httpError("Too many sign-in attempts. Wait 15 minutes and try again.", 429, "admin_login_rate_limited");
  }
  if (nowSeconds - Number(attempt.first_failed_at) > ADMIN_LOGIN_WINDOW_SECONDS) {
    await env.DB.prepare("DELETE FROM admin_login_attempts WHERE attempt_key = ?").bind(attemptKey).run();
  }
}

async function recordAdminLoginFailure(env, attemptKey, nowSeconds) {
  const attempt = await env.DB.prepare("SELECT * FROM admin_login_attempts WHERE attempt_key = ?").bind(attemptKey).first();
  const withinWindow = attempt && nowSeconds - Number(attempt.first_failed_at) <= ADMIN_LOGIN_WINDOW_SECONDS;
  const failures = withinWindow ? Number(attempt.failures) + 1 : 1;
  const firstFailedAt = withinWindow ? Number(attempt.first_failed_at) : nowSeconds;
  const lockedUntil = failures >= ADMIN_LOGIN_MAX_FAILURES ? nowSeconds + ADMIN_LOGIN_LOCK_SECONDS : 0;
  await env.DB.prepare(`INSERT INTO admin_login_attempts (attempt_key, failures, first_failed_at, locked_until) VALUES (?, ?, ?, ?)
    ON CONFLICT(attempt_key) DO UPDATE SET failures=excluded.failures, first_failed_at=excluded.first_failed_at, locked_until=excluded.locked_until`)
    .bind(attemptKey, failures, firstFailedAt, lockedUntil).run();
  if (lockedUntil) throw httpError("Too many sign-in attempts. Wait 15 minutes and try again.", 429, "admin_login_rate_limited");
}

async function handleAdminLogin(request, env) {
  if (request.method !== "POST") return methodNotAllowed();
  await ensureDatabase(env);
  const emails = allowedAdminEmails(env);
  const configuredPassword = String(env.ADMIN_PASSWORD || "");
  const credentials = adminCredentialMap(env);
  const sessionSecret = String(env.ADMIN_SESSION_SECRET || "");
  if (!emails.length || (!Object.keys(credentials).length && configuredPassword.length < 12) || sessionSecret.length < 32) {
    throw httpError("Temporary Admin Portal login is not configured. Set ADMIN_SESSION_SECRET plus either ADMIN_CREDENTIALS or ADMIN_EMAILS and ADMIN_PASSWORD in Production variables and secrets, then redeploy.", 503, "admin_not_configured");
  }
  const data = await readJson(request);
  const email = String(data.email || "").trim().toLowerCase();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const attemptKey = await adminLoginAttemptKey(request, email);
  await assertAdminLoginAllowed(env, attemptKey, nowSeconds);
  const expectedPassword = credentials[email] || configuredPassword;
  const passwordMatches = Boolean(expectedPassword) && await secureTextEqual(data.password || "", expectedPassword);
  if (!emails.includes(email) || !passwordMatches) {
    await recordAdminLoginFailure(env, attemptKey, nowSeconds);
    throw httpError("The email or password is incorrect.", 401, "invalid_admin_login");
  }
  await env.DB.prepare("DELETE FROM admin_login_attempts WHERE attempt_key = ?").bind(attemptKey).run();
  const session = await createAdminSession(email, sessionSecret);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      ...JSON_HEADERS,
      "Set-Cookie": `${ADMIN_COOKIE}=${session}; Path=/; Max-Age=${ADMIN_SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`
    }
  });
}

function adminLogout() {
  return new Response(null, {
    status: 303,
    headers: {
      "Location": "/",
      "Set-Cookie": `${ADMIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`
    }
  });
}

async function safeMigration(env, sql) {
  try { await env.DB.prepare(sql).run(); } catch (_) { /* Existing installations may already have this column. */ }
}

async function ensureDatabase(env) {
  if (!env.DB) throw httpError("Shared booking storage is not connected. Bind a D1 database as DB.", 503, "database_not_configured");
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      booking_date TEXT NOT NULL,
      court INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL,
      name TEXT NOT NULL,
      email TEXT,
      client_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      canceled_at TEXT,
      cancellation_reason TEXT,
      affected_by_type TEXT,
      affected_by_id TEXT,
      user_archived_at TEXT,
      replacement_booking_id TEXT,
      rebooked_from_id TEXT,
      auto_rebooked INTEGER NOT NULL DEFAULT 0
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS booking_slots (
      booking_date TEXT NOT NULL,
      court INTEGER NOT NULL,
      slot_minute INTEGER NOT NULL,
      booking_id TEXT NOT NULL,
      PRIMARY KEY (booking_date, court, slot_minute)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS client_booking_slots (
      client_id TEXT NOT NULL,
      booking_date TEXT NOT NULL,
      position INTEGER NOT NULL,
      booking_id TEXT NOT NULL,
      PRIMARY KEY (client_id, booking_date, position)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS priority_requests (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      activity_kind TEXT NOT NULL DEFAULT 'clinic',
      program_name TEXT NOT NULL,
      instructor_name TEXT NOT NULL,
      email TEXT NOT NULL,
      listing_url TEXT NOT NULL DEFAULT '',
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      court_selection TEXT NOT NULL DEFAULT 'all',
      weekdays TEXT NOT NULL DEFAULT '1,2,3,4,5',
      status TEXT NOT NULL DEFAULT 'pending',
      submitted_at TEXT NOT NULL,
      reviewed_at TEXT,
      reviewer_email TEXT,
      reviewer_notes TEXT,
      creator_client_id TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS priority_holds (
      id TEXT PRIMARY KEY,
      source_request_id TEXT,
      label TEXT NOT NULL,
      activity_kind TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      courts TEXT NOT NULL,
      weekdays TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      removed_by TEXT,
      removed_at TEXT,
      source_type TEXT NOT NULL DEFAULT 'admin',
      creator_client_id TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS maintenance_closures (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      reason TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      courts TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      removed_by TEXT,
      removed_at TEXT,
      source_type TEXT NOT NULL DEFAULT 'admin',
      creator_client_id TEXT,
      creator_name TEXT,
      creator_email TEXT,
      removal_code_hash TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS court_status (
      court INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      source_event_id TEXT,
      source_type TEXT NOT NULL DEFAULT 'public',
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      delete_after TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS court_status_events (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      court INTEGER NOT NULL,
      action TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL DEFAULT 'public',
      creator_client_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      delete_after TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS site_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      reviewer_email TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT,
      entity_id TEXT,
      actor_email TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS admin_login_attempts (
      attempt_key TEXT PRIMARY KEY,
      failures INTEGER NOT NULL,
      first_failed_at INTEGER NOT NULL,
      locked_until INTEGER NOT NULL DEFAULT 0
    )`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_bookings_date_status ON bookings (booking_date, status)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_bookings_client_date ON bookings (client_id, booking_date, status)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_priority_holds_dates ON priority_holds (start_date, end_date, status)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_closures_dates ON maintenance_closures (start_date, end_date, status)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_court_status_events_group ON court_status_events (group_id)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_court_status_events_created ON court_status_events (created_at)")
  ]);
  await safeMigration(env, "ALTER TABLE priority_requests ADD COLUMN activity_kind TEXT NOT NULL DEFAULT 'clinic'");
  await safeMigration(env, "ALTER TABLE priority_requests ADD COLUMN court_selection TEXT NOT NULL DEFAULT 'all'");
  await safeMigration(env, "ALTER TABLE priority_requests ADD COLUMN weekdays TEXT NOT NULL DEFAULT '1,2,3,4,5'");
  await safeMigration(env, "ALTER TABLE priority_requests ADD COLUMN creator_client_id TEXT");
  await safeMigration(env, "ALTER TABLE priority_holds ADD COLUMN source_type TEXT NOT NULL DEFAULT 'admin'");
  await safeMigration(env, "ALTER TABLE priority_holds ADD COLUMN creator_client_id TEXT");
  await safeMigration(env, "ALTER TABLE maintenance_closures ADD COLUMN source_type TEXT NOT NULL DEFAULT 'admin'");
  await safeMigration(env, "ALTER TABLE maintenance_closures ADD COLUMN creator_client_id TEXT");
  await safeMigration(env, "ALTER TABLE maintenance_closures ADD COLUMN creator_name TEXT");
  await safeMigration(env, "ALTER TABLE maintenance_closures ADD COLUMN creator_email TEXT");
  await safeMigration(env, "ALTER TABLE maintenance_closures ADD COLUMN removal_code_hash TEXT");
  await safeMigration(env, "ALTER TABLE audit_log ADD COLUMN entity_type TEXT");
  await safeMigration(env, "ALTER TABLE audit_log ADD COLUMN entity_id TEXT");
  await safeMigration(env, "ALTER TABLE bookings ADD COLUMN user_archived_at TEXT");
  await safeMigration(env, "ALTER TABLE bookings ADD COLUMN replacement_booking_id TEXT");
  await safeMigration(env, "ALTER TABLE bookings ADD COLUMN rebooked_from_id TEXT");
  await safeMigration(env, "ALTER TABLE bookings ADD COLUMN auto_rebooked INTEGER NOT NULL DEFAULT 0");
  await safeMigration(env, "UPDATE bookings SET email = NULL WHERE email IS NOT NULL");
  await safeMigration(env, "UPDATE priority_requests SET email = '' WHERE email <> ''");
  await safeMigration(env, "UPDATE maintenance_closures SET creator_email = NULL WHERE creator_email IS NOT NULL");
}

function easternParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
    minute: Number(values.hour) * 60 + Number(values.minute)
  };
}

function addDaysKey(value, days) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12));
  return date.toISOString().slice(0, 10);
}

function daysBetween(startDate, endDate) {
  const start = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(`${endDate}T12:00:00Z`);
  return Math.round((end - start) / 86400000);
}

async function hashText(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function publicActor(clientId) {
  return `public:${clientId.slice(-12)}`;
}

function retentionPolicy() {
  return {
    bookingHistoryDays: BOOKING_HISTORY_RETENTION_DAYS,
    affectedBookingDays: AFFECTED_BOOKING_RETENTION_DAYS,
    calendarHistoryDays: ADMIN_CALENDAR_HISTORY_RETENTION_DAYS,
    reviewedRequestDays: REVIEWED_REQUEST_RETENTION_DAYS,
    auditLogDays: AUDIT_LOG_RETENTION_DAYS,
    reopenedCourtStatusHours: COURT_STATUS_OPEN_RETENTION_HOURS
  };
}

async function performHousekeeping(env, { force = false } = {}) {
  const currentMs = Date.now();
  if (!force && currentMs - lastHousekeepingAt < HOUSEKEEPING_INTERVAL_MS) {
    return { ran: false, retention: retentionPolicy() };
  }
  const now = easternParts();
  const completedCutoff = addDaysKey(now.date, -BOOKING_HISTORY_RETENTION_DAYS);
  const affectedCutoff = addDaysKey(now.date, -AFFECTED_BOOKING_RETENTION_DAYS);
  const calendarCutoff = addDaysKey(now.date, -ADMIN_CALENDAR_HISTORY_RETENTION_DAYS);
  const reviewedCutoff = new Date(currentMs - REVIEWED_REQUEST_RETENTION_DAYS * 86400000).toISOString();
  const auditCutoff = new Date(currentMs - AUDIT_LOG_RETENTION_DAYS * 86400000).toISOString();
  const isoNow = new Date(currentMs).toISOString();

  await env.DB.batch([
    env.DB.prepare(`UPDATE bookings SET status = 'completed'
      WHERE status = 'active' AND (booking_date < ? OR (booking_date = ? AND end_time <= ?))`).bind(now.date, now.date, now.time),
    env.DB.prepare(`UPDATE priority_holds SET status = 'expired', removed_at = COALESCE(removed_at, ?), removed_by = COALESCE(removed_by, 'automatic_housekeeping')
      WHERE status = 'active' AND (end_date < ? OR (end_date = ? AND end_time <= ?))`).bind(isoNow, now.date, now.date, now.time),
    env.DB.prepare(`UPDATE maintenance_closures SET status = 'expired', removed_at = COALESCE(removed_at, ?), removed_by = COALESCE(removed_by, 'automatic_housekeeping')
      WHERE status = 'active' AND (end_date < ? OR (end_date = ? AND end_time <= ?))`).bind(isoNow, now.date, now.date, now.time),
    env.DB.prepare("DELETE FROM booking_slots WHERE booking_id IN (SELECT id FROM bookings WHERE status <> 'active')"),
    env.DB.prepare("DELETE FROM client_booking_slots WHERE booking_id IN (SELECT id FROM bookings WHERE status <> 'active')"),
    env.DB.prepare(`DELETE FROM bookings WHERE status <> 'active' AND affected_by_type IS NULL AND booking_date < ?`).bind(completedCutoff),
    env.DB.prepare(`DELETE FROM bookings WHERE status <> 'active' AND affected_by_type IS NOT NULL AND booking_date < ?`).bind(affectedCutoff),
    env.DB.prepare("DELETE FROM priority_holds WHERE status <> 'active' AND end_date < ?").bind(calendarCutoff),
    env.DB.prepare("DELETE FROM maintenance_closures WHERE status <> 'active' AND end_date < ?").bind(calendarCutoff),
    env.DB.prepare("DELETE FROM court_status_events WHERE delete_after IS NOT NULL AND delete_after <= ?").bind(isoNow),
    env.DB.prepare("DELETE FROM court_status WHERE status = 'open' AND delete_after IS NOT NULL AND delete_after <= ?").bind(isoNow),
    env.DB.prepare("DELETE FROM priority_requests WHERE status <> 'pending' AND reviewed_at IS NOT NULL AND reviewed_at < ?").bind(reviewedCutoff),
    env.DB.prepare("DELETE FROM audit_log WHERE created_at < ?").bind(auditCutoff),
    env.DB.prepare("DELETE FROM admin_login_attempts WHERE locked_until < ? AND first_failed_at < ?").bind(Math.floor(currentMs / 1000), Math.floor(currentMs / 1000) - ADMIN_LOGIN_WINDOW_SECONDS),
    env.DB.prepare("DELETE FROM booking_slots WHERE booking_id NOT IN (SELECT id FROM bookings)"),
    env.DB.prepare("DELETE FROM client_booking_slots WHERE booking_id NOT IN (SELECT id FROM bookings)")
  ]);
  lastHousekeepingAt = currentMs;
  return { ran: true, completedAt: isoNow, retention: retentionPolicy() };
}

function dayOfWeek(value) {
  return String(new Date(`${value}T12:00:00Z`).getUTCDay());
}

function timeToMinutes(value) {
  const [hours, minutes] = String(value).split(":").map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(value) {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function decimalHour(value) {
  return timeToMinutes(value) / 60;
}

function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function isTimeKey(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
}

function validClientId(request) {
  const value = String(request.headers.get("x-chs-client-id") || "").trim();
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(value)) throw httpError("A valid anonymous browser ID is required.", 400, "invalid_client_id");
  return value;
}

function normalizeCourts(value) {
  if (value === "all" || (Array.isArray(value) && value.includes("all"))) return "all";
  const courts = (Array.isArray(value) ? value : String(value || "").split(","))
    .map(Number).filter((court) => Number.isInteger(court) && court >= 1 && court <= COURT_COUNT);
  const unique = [...new Set(courts)].sort((a, b) => a - b);
  if (!unique.length) throw httpError("Select at least one valid court.", 400, "invalid_courts");
  return unique.join(",");
}

function selectionIncludes(selection, court) {
  return selection === "all" || String(selection).split(",").includes(String(court));
}

function expandCourts(selection) {
  return selection === "all" ? [1, 2, 3, 4, 5, 6] : String(selection).split(",").map(Number).filter(Boolean);
}

function normalizeWeekdays(value) {
  const days = (Array.isArray(value) ? value : String(value || "").split(",")).map(String).filter((day) => /^[0-6]$/.test(day));
  const unique = [...new Set(days)].sort();
  if (!unique.length) throw httpError("Select at least one repeating weekday.", 400, "invalid_weekdays");
  return unique.join(",");
}

function dateRangeContainsWeekday(startDate, endDate, weekdays) {
  const allowed = new Set(String(weekdays).split(","));
  for (let date = startDate; date <= endDate; date = addDaysKey(date, 1)) {
    if (allowed.has(dayOfWeek(date))) return true;
  }
  return false;
}

function maskedName(name) {
  const parts = String(name || "Player").trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] || "Player";
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

async function getSettings(env) {
  await ensureDatabase(env);
  const result = await env.DB.prepare("SELECT key, value FROM site_settings").all();
  return { ...DEFAULT_SETTINGS, ...Object.fromEntries((result.results || []).map((row) => [row.key, row.value])) };
}

async function getPriorityRows(env, date) {
  const result = await env.DB.prepare(`SELECT * FROM priority_holds
    WHERE status = 'active' AND start_date <= ? AND end_date >= ? ORDER BY start_time, label`).bind(date, date).all();
  const weekday = dayOfWeek(date);
  return (result.results || []).filter((row) => String(row.weekdays).split(",").includes(weekday));
}

async function getClosureRows(env, date) {
  const result = await env.DB.prepare(`SELECT * FROM maintenance_closures
    WHERE status = 'active' AND start_date <= ? AND end_date >= ? ORDER BY start_time, title`).bind(date, date).all();
  return result.results || [];
}

async function getCourtStatusRows(env) {
  const result = await env.DB.prepare("SELECT * FROM court_status WHERE status = 'down' ORDER BY court").all();
  return result.results || [];
}

async function getCourtStatusPayload(env, { includeHistory = false } = {}) {
  await performHousekeeping(env);
  const rows = await env.DB.prepare("SELECT * FROM court_status ORDER BY court").all();
  const byCourt = new Map((rows.results || []).map((row) => [Number(row.court), row]));
  const courts = Array.from({ length: COURT_COUNT }, (_, index) => {
    const court = index + 1;
    const row = byCourt.get(court);
    return {
      court,
      status: row?.status === "down" ? "down" : "open",
      reason: row?.reason || "",
      reportId: row?.source_event_id || null,
      sourceType: row?.source_type || "",
      updatedAt: row?.updated_at || null
    };
  });
  if (!includeHistory) return { courts };
  const history = await env.DB.prepare("SELECT * FROM court_status_events ORDER BY created_at DESC LIMIT 300").all();
  return { courts, history: history.results || [] };
}

async function applyCourtStatus(env, data, actor, { sourceType = "public", clientId = null } = {}) {
  const action = String(data.action || "").trim().toLowerCase();
  if (!['down', 'open'].includes(action)) throw httpError("Choose whether the selected courts are down or open.", 400, "invalid_court_status");
  const courts = normalizeCourts(data.courts || data.court || []);
  let reason = String(data.reason || "").trim();
  if (action === "down" && (reason.length < 3 || reason.length > 300)) throw httpError("Briefly explain why the court is unavailable.", 400, "status_reason_required");
  if (action === "open" && reason.length > 300) throw httpError("Keep the status note under 300 characters.", 400, "invalid_status_reason");
  if (!reason) reason = action === "open" ? "Reported open" : "Reported unavailable";
  const expandedCourts = expandCourts(courts);
  const groupId = crypto.randomUUID();
  const now = new Date().toISOString();
  const deleteAfter = action === "open" ? new Date(Date.now() + COURT_STATUS_OPEN_RETENTION_HOURS * 60 * 60 * 1000).toISOString() : null;
  const statements = [];
  const eventIds = [];
  for (const court of expandedCourts) {
    const eventId = crypto.randomUUID();
    eventIds.push(eventId);
    if (action === "open") {
      statements.push(env.DB.prepare("UPDATE court_status_events SET delete_after = COALESCE(delete_after, ?) WHERE court = ? AND delete_after IS NULL")
        .bind(deleteAfter, court));
    }
    statements.push(env.DB.prepare(`INSERT INTO court_status_events
      (id, group_id, court, action, reason, source_type, creator_client_id, created_by, created_at, delete_after)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(eventId, groupId, court, action, reason, sourceType, clientId, actor, now, deleteAfter));
    statements.push(env.DB.prepare(`INSERT INTO court_status
      (court, status, reason, source_event_id, source_type, updated_by, updated_at, delete_after)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(court) DO UPDATE SET status=excluded.status, reason=excluded.reason, source_event_id=excluded.source_event_id,
        source_type=excluded.source_type, updated_by=excluded.updated_by, updated_at=excluded.updated_at, delete_after=excluded.delete_after`)
      .bind(court, action, reason, eventId, sourceType, actor, now, deleteAfter));
  }
  await env.DB.batch(statements);
  let result = { affected: [], replacements: [] };
  if (action === "down") {
    const settings = await getSettings(env);
    const today = easternParts().date;
    result = await cancelAffectedBookings(env, {
      id: groupId,
      title: `Court status: ${reason}`,
      start_date: today,
      end_date: addDaysKey(today, Number(settings.priority_booking_days)),
      start_time: "00:00",
      end_time: "24:00",
      courts
    }, "maintenance");
  }
  await addAudit(env, actor, action === "down" ? "courts_reported_down" : "courts_reported_open", `${courts === "all" ? "All courts" : `Courts ${courts}`}; ${reason}; affected bookings: ${result.affected.length}; automatic replacements: ${result.replacements.length}`, "court_status", groupId);
  return { ok: true, groupId, eventIds, courts: expandedCourts, status: action, affectedCount: result.affected.length, rebookedCount: result.replacements.length };
}

async function handlePublicCourtStatus(request, env) {
  await ensureDatabase(env);
  if (request.method === "GET") return json(await getCourtStatusPayload(env));
  if (request.method !== "POST") return methodNotAllowed();
  const clientId = validClientId(request);
  const result = await applyCourtStatus(env, await readJson(request), publicActor(clientId), { sourceType: "public", clientId });
  return json(result, 201);
}

async function deleteCourtStatusEvent(env, id, actor) {
  const event = await env.DB.prepare("SELECT * FROM court_status_events WHERE id = ?").bind(id).first();
  if (!event) throw httpError("Court status report not found.", 404, "status_report_not_found");
  const current = await env.DB.prepare("SELECT * FROM court_status WHERE court = ?").bind(event.court).first();
  const statements = [];
  if (current?.source_event_id === id) {
    const previousDown = await env.DB.prepare(`SELECT * FROM court_status_events
      WHERE court = ? AND id <> ? AND action = 'down' AND delete_after IS NULL ORDER BY created_at DESC LIMIT 1`)
      .bind(event.court, id).first();
    if (previousDown) {
      statements.push(env.DB.prepare(`UPDATE court_status SET status = 'down', reason = ?, source_event_id = ?, source_type = ?, updated_by = ?, updated_at = ?, delete_after = NULL WHERE court = ?`)
        .bind(previousDown.reason, previousDown.id, previousDown.source_type, previousDown.created_by, previousDown.created_at, event.court));
    } else {
      const now = new Date().toISOString();
      const deleteAfter = new Date(Date.now() + COURT_STATUS_OPEN_RETENTION_HOURS * 60 * 60 * 1000).toISOString();
      statements.push(env.DB.prepare(`UPDATE court_status SET status = 'open', reason = 'Status report removed by admin', source_event_id = NULL,
        source_type = 'admin', updated_by = ?, updated_at = ?, delete_after = ? WHERE court = ?`).bind(actor, now, deleteAfter, event.court));
    }
  }
  statements.push(env.DB.prepare("DELETE FROM court_status_events WHERE id = ?").bind(id));
  await env.DB.batch(statements);
  await addAudit(env, actor, "court_status_report_deleted", `Court ${event.court} ${event.action} report removed.`, "court_status", id);
  return { ok: true };
}

async function getSchedule(env, date, clientId) {
  await performHousekeeping(env);
  const [bookingResult, priorityRows, closureRows, statusRows, settings] = await Promise.all([
    env.DB.prepare("SELECT * FROM bookings WHERE booking_date = ? AND status = 'active' ORDER BY court, start_time").bind(date).all(),
    getPriorityRows(env, date),
    getClosureRows(env, date),
    getCourtStatusRows(env),
    getSettings(env)
  ]);
  const bookings = (bookingResult.results || []).map((row) => ({
    id: row.id,
    date: row.booking_date,
    court: row.court,
    start: decimalHour(row.start_time),
    duration: row.duration_minutes / 60,
    name: row.client_id === clientId ? row.name : maskedName(row.name),
    owner: row.client_id === clientId,
    status: row.status
  }));
  const priorityHolds = [];
  for (const row of priorityRows) {
    for (const court of expandCourts(row.courts)) {
      priorityHolds.push({
        id: `${row.id}-${court}`,
        sourceId: row.id,
        date,
        court,
        start: decimalHour(row.start_time),
        duration: (timeToMinutes(row.end_time) - timeToMinutes(row.start_time)) / 60,
        name: row.label,
        priority: true,
        kind: row.activity_kind
      });
    }
  }
  const closures = [];
  for (const row of closureRows) {
    for (const court of expandCourts(row.courts)) {
      closures.push({
        id: `${row.id}-${court}`,
        sourceId: row.id,
        date,
        court,
        start: decimalHour(row.start_time),
        duration: (timeToMinutes(row.end_time) - timeToMinutes(row.start_time)) / 60,
        name: row.title,
        reason: row.reason,
        maintenance: true,
        owner: row.source_type === "public" && row.creator_client_id === clientId,
        sourceType: row.source_type || "admin"
      });
    }
  }
  for (const row of statusRows) {
    closures.push({
      id: `court-status-${row.court}`,
      sourceId: row.source_event_id,
      date,
      court: Number(row.court),
      start: 0,
      duration: 24,
      name: `Court ${row.court} unavailable`,
      reason: row.reason,
      maintenance: true,
      communityStatus: true,
      sourceType: row.source_type || "public"
    });
  }
  return { bookings, priorityHolds, closures, courtStatus: statusRows, settings, serverTime: new Date().toISOString() };
}

async function releaseExpiredClientBookings(env, clientId, date) {
  const now = easternParts();
  if (date !== now.date) return;
  const result = await env.DB.prepare("SELECT id FROM bookings WHERE client_id = ? AND booking_date = ? AND status = 'active' AND end_time <= ?")
    .bind(clientId, date, now.time).all();
  const rows = result.results || [];
  if (!rows.length) return;
  const statements = [];
  for (const row of rows) {
    statements.push(env.DB.prepare("UPDATE bookings SET status = 'completed' WHERE id = ? AND status = 'active'").bind(row.id));
    statements.push(env.DB.prepare("DELETE FROM booking_slots WHERE booking_id = ?").bind(row.id));
    statements.push(env.DB.prepare("DELETE FROM client_booking_slots WHERE booking_id = ?").bind(row.id));
  }
  await env.DB.batch(statements);
}

async function bookingBlockedBySchedule(env, date, court, startTime, endTime) {
  const [priorityRows, closureRows, statusRow] = await Promise.all([
    getPriorityRows(env, date),
    getClosureRows(env, date),
    env.DB.prepare("SELECT * FROM court_status WHERE court = ? AND status = 'down'").bind(court).first()
  ]);
  if (statusRow) return `Court ${court} is currently unavailable: ${statusRow.reason}.`;
  const timeOverlap = (row) => row.start_time < endTime && row.end_time > startTime;
  const closure = closureRows.find((row) => selectionIncludes(row.courts, court) && timeOverlap(row));
  if (closure) return `Court ${court} is closed for maintenance: ${closure.title}.`;
  const priority = priorityRows.find((row) => selectionIncludes(row.courts, court) && timeOverlap(row));
  if (priority) return `Court ${court} is held for ${priority.label}.`;
  return null;
}

function validateBookingPayload(data, settings) {
  const name = String(data.name || "").trim();
  const date = String(data.date || "");
  const court = Number(data.court);
  const startMinute = Number(data.startMinute);
  const durationMinutes = Number(data.durationMinutes);
  if (name.length < 2 || name.length > 80) throw httpError("Enter a valid name.", 400, "invalid_name");
  if (!isDateKey(date)) throw httpError("Choose a valid booking date.", 400, "invalid_date");
  if (!Number.isInteger(court) || court < 1 || court > COURT_COUNT) throw httpError("Choose a valid court.", 400, "invalid_court");
  if (!Number.isInteger(startMinute) || startMinute < 0 || startMinute >= 1440 || startMinute % 30 !== 0) throw httpError("Choose a valid half-hour start time.", 400, "invalid_start");
  if (![30, 60, 90, 120].includes(durationMinutes) || durationMinutes > MAX_BOOKING_MINUTES || startMinute + durationMinutes > 1440) {
    throw httpError("Each booking can be up to 2 hours and cannot pass midnight.", 400, "invalid_duration");
  }
  const now = easternParts();
  const windowEnd = addDaysKey(now.date, Number(settings.public_booking_days));
  if (date < now.date) throw httpError("That booking date has passed.", 400, "past_date");
  if (date > windowEnd) throw httpError("Bookings are only available up to 6 months in advance.", 400, "outside_booking_window");
  if (date === now.date && startMinute <= now.minute) throw httpError("That start time has already passed.", 400, "past_time");
  return { name, date, court, startMinute, durationMinutes, endMinute: startMinute + durationMinutes };
}

async function createBooking(request, env) {
  if (request.method !== "POST") return methodNotAllowed();
  await ensureDatabase(env);
  const clientId = validClientId(request);
  const settings = await getSettings(env);
  const booking = validateBookingPayload(await readJson(request), settings);
  await releaseExpiredClientBookings(env, clientId, booking.date);

  const startTime = minutesToTime(booking.startMinute);
  const endTime = minutesToTime(booking.endMinute);
  const existingExactBooking = await env.DB.prepare(`SELECT * FROM bookings WHERE client_id = ? AND booking_date = ? AND court = ?
    AND start_time = ? AND end_time = ? AND status = 'active' LIMIT 1`)
    .bind(clientId, booking.date, booking.court, startTime, endTime).first();
  if (existingExactBooking) {
    return json({ ok: true, duplicate: true, booking: {
      id: existingExactBooking.id, date: existingExactBooking.booking_date, court: existingExactBooking.court,
      start: decimalHour(existingExactBooking.start_time), duration: existingExactBooking.duration_minutes / 60,
      name: existingExactBooking.name, owner: true
    } });
  }

  const currentSlotsResult = await env.DB.prepare("SELECT position FROM client_booking_slots WHERE client_id = ? AND booking_date = ? ORDER BY position")
    .bind(clientId, booking.date).all();
  const usedPositions = new Set((currentSlotsResult.results || []).map((row) => Number(row.position)));
  const position = [1, 2].find((candidate) => !usedPositions.has(candidate));
  if (!position) {
    throw httpError("You can have up to 2 active bookings per day. Please cancel or complete an existing booking before making another.", 409, "daily_booking_limit");
  }

  const canonicalCourtConflict = await env.DB.prepare(`SELECT id FROM bookings WHERE booking_date = ? AND court = ? AND status = 'active'
    AND start_time < ? AND end_time > ? LIMIT 1`).bind(booking.date, booking.court, endTime, startTime).first();
  if (canonicalCourtConflict) throw httpError("That court is already reserved during part of that time.", 409, "booking_conflict");
  const scheduleBlock = await bookingBlockedBySchedule(env, booking.date, booking.court, startTime, endTime);
  if (scheduleBlock) throw httpError(scheduleBlock, 409, "schedule_blocked");

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const statements = [
    env.DB.prepare(`INSERT INTO bookings
      (id, booking_date, court, start_time, end_time, duration_minutes, name, email, client_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
      .bind(id, booking.date, booking.court, startTime, endTime, booking.durationMinutes, booking.name, null, clientId, now),
    env.DB.prepare("INSERT INTO client_booking_slots (client_id, booking_date, position, booking_id) VALUES (?, ?, ?, ?)")
      .bind(clientId, booking.date, position, id)
  ];
  for (let minute = booking.startMinute; minute < booking.endMinute; minute += 30) {
    statements.push(env.DB.prepare("INSERT INTO booking_slots (booking_date, court, slot_minute, booking_id) VALUES (?, ?, ?, ?)")
      .bind(booking.date, booking.court, minute, id));
  }
  try {
    await env.DB.batch(statements);
  } catch (_) {
    throw httpError("That court time was just taken or your daily booking limit was reached. Refresh and choose another time.", 409, "booking_conflict");
  }
  return json({ ok: true, booking: { id, date: booking.date, court: booking.court, start: booking.startMinute / 60, duration: booking.durationMinutes / 60, name: booking.name, owner: true } }, 201);
}

async function cancelBooking(request, env, id) {
  if (request.method !== "DELETE") return methodNotAllowed();
  await ensureDatabase(env);
  const clientId = validClientId(request);
  const row = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(id).first();
  if (!row || row.client_id !== clientId) throw httpError("Booking not found.", 404, "booking_not_found");
  if (row.status !== "active") throw httpError("This booking is no longer active.", 409, "booking_not_active");
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE bookings SET status = 'canceled', canceled_at = ?, cancellation_reason = 'Canceled by player' WHERE id = ? AND status = 'active'").bind(now, id),
    env.DB.prepare("DELETE FROM booking_slots WHERE booking_id = ?").bind(id),
    env.DB.prepare("DELETE FROM client_booking_slots WHERE booking_id = ?").bind(id)
  ]);
  return json({ ok: true });
}

async function getMyBookings(request, env) {
  if (request.method !== "GET") return methodNotAllowed();
  await ensureDatabase(env);
  const clientId = validClientId(request);
  const now = easternParts();
  await performHousekeeping(env);
  const cutoff = addDaysKey(now.date, -AFFECTED_BOOKING_RETENTION_DAYS);
  const result = await env.DB.prepare(`SELECT b.*, r.booking_date AS replacement_date, r.court AS replacement_court,
    r.start_time AS replacement_start_time, r.end_time AS replacement_end_time, r.status AS replacement_status
    FROM bookings b LEFT JOIN bookings r ON r.id = b.replacement_booking_id
    WHERE b.client_id = ? AND (b.status = 'active' OR b.booking_date >= ?)
    ORDER BY b.booking_date DESC, b.start_time DESC`).bind(clientId, cutoff).all();
  const bookings = (result.results || []).map((row) => ({
    id: row.id,
    date: row.booking_date,
    court: row.court,
    start: decimalHour(row.start_time),
    duration: row.duration_minutes / 60,
    name: row.name,
    owner: true,
    status: row.status,
    cancellationReason: row.cancellation_reason || "",
    affectedByType: row.affected_by_type || "",
    archived: Boolean(row.user_archived_at),
    rebookedFromId: row.rebooked_from_id || "",
    automaticReplacement: Boolean(row.auto_rebooked),
    replacementBooking: row.replacement_booking_id && row.replacement_status === "active" ? {
      id: row.replacement_booking_id,
      date: row.replacement_date,
      court: row.replacement_court,
      start: decimalHour(row.replacement_start_time),
      duration: (timeToMinutes(row.replacement_end_time) - timeToMinutes(row.replacement_start_time)) / 60
    } : null
  }));
  return json({ bookings, retentionDays: AFFECTED_BOOKING_RETENTION_DAYS });
}

async function archiveMyBookingNotices(request, env) {
  if (request.method !== "POST") return methodNotAllowed();
  await ensureDatabase(env);
  const clientId = validClientId(request);
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE bookings SET user_archived_at = ? WHERE client_id = ? AND status <> 'active' AND user_archived_at IS NULL")
    .bind(now, clientId).run();
  return json({ ok: true });
}

async function deleteMyBookingHistory(request, env, id = "") {
  if (request.method !== "DELETE") return methodNotAllowed();
  await ensureDatabase(env);
  const clientId = validClientId(request);
  if (id) {
    const row = await env.DB.prepare("SELECT id FROM bookings WHERE id = ? AND client_id = ? AND status <> 'active'").bind(id, clientId).first();
    if (!row) throw httpError("Booking-history record not found or still active.", 404, "history_not_found");
    await env.DB.prepare("DELETE FROM bookings WHERE id = ? AND client_id = ? AND status <> 'active'").bind(id, clientId).run();
  } else {
    await env.DB.prepare("DELETE FROM bookings WHERE client_id = ? AND status <> 'active'").bind(clientId).run();
  }
  return json({ ok: true });
}

function automaticRebookingCandidates(booking) {
  const originalStart = timeToMinutes(booking.start_time);
  const offsets = [0];
  for (let offset = 30; offset <= MAX_AUTO_REBOOK_OFFSET_MINUTES; offset += 30) offsets.push(-offset, offset);
  const courts = Array.from({ length: COURT_COUNT }, (_, index) => index + 1)
    .sort((left, right) => Math.abs(left - booking.court) - Math.abs(right - booking.court));
  const candidates = [];
  for (const offset of offsets) {
    const startMinute = originalStart + offset;
    if (startMinute < 0 || startMinute + booking.duration_minutes > 1440) continue;
    for (const court of courts) candidates.push({ court, startMinute, endMinute: startMinute + booking.duration_minutes });
  }
  return candidates;
}

async function tryAutomaticRebooking(env, booking) {
  const now = easternParts();
  for (const candidate of automaticRebookingCandidates(booking)) {
    if (booking.booking_date === now.date && candidate.startMinute <= now.minute) continue;
    const startTime = minutesToTime(candidate.startMinute);
    const endTime = minutesToTime(candidate.endMinute);
    if (await bookingBlockedBySchedule(env, booking.booking_date, candidate.court, startTime, endTime)) continue;

    const [courtConflict, canonicalCourtConflict, playerSlots] = await Promise.all([
      env.DB.prepare(`SELECT booking_id FROM booking_slots WHERE booking_date = ? AND court = ? AND slot_minute >= ? AND slot_minute < ? LIMIT 1`)
        .bind(booking.booking_date, candidate.court, candidate.startMinute, candidate.endMinute).first(),
      env.DB.prepare(`SELECT id FROM bookings WHERE booking_date = ? AND court = ? AND status = 'active' AND start_time < ? AND end_time > ? LIMIT 1`)
        .bind(booking.booking_date, candidate.court, endTime, startTime).first(),
      env.DB.prepare("SELECT position FROM client_booking_slots WHERE client_id = ? AND booking_date = ? ORDER BY position")
        .bind(booking.client_id, booking.booking_date).all()
    ]);
    if (courtConflict || canonicalCourtConflict) continue;
    const usedPositions = new Set((playerSlots.results || []).map((row) => Number(row.position)));
    const position = [1, 2].find((value) => !usedPositions.has(value));
    if (!position) return null;

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const lineageRootId = booking.rebooked_from_id || booking.id;
    const statements = [
      env.DB.prepare(`INSERT INTO bookings
        (id, booking_date, court, start_time, end_time, duration_minutes, name, email, client_id, status, created_at, rebooked_from_id, auto_rebooked)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 1)`)
        .bind(id, booking.booking_date, candidate.court, startTime, endTime, booking.duration_minutes, booking.name, null, booking.client_id, createdAt, lineageRootId),
      env.DB.prepare("INSERT INTO client_booking_slots (client_id, booking_date, position, booking_id) VALUES (?, ?, ?, ?)")
        .bind(booking.client_id, booking.booking_date, position, id),
      env.DB.prepare(`UPDATE bookings SET replacement_booking_id = ?, cancellation_reason = cancellation_reason || ? WHERE id = ?`)
        .bind(id, ` · Automatically rebooked to Court ${candidate.court}, ${startTime}–${endTime}`, booking.id)
    ];
    if (lineageRootId !== booking.id) {
      statements.push(env.DB.prepare("UPDATE bookings SET replacement_booking_id = ? WHERE id = ?").bind(id, lineageRootId));
    }
    for (let minute = candidate.startMinute; minute < candidate.endMinute; minute += 30) {
      statements.push(env.DB.prepare("INSERT INTO booking_slots (booking_date, court, slot_minute, booking_id) VALUES (?, ?, ?, ?)")
        .bind(booking.booking_date, candidate.court, minute, id));
    }
    try {
      await env.DB.batch(statements);
      return { id, date: booking.booking_date, court: candidate.court, startTime, endTime };
    } catch (_) {
      // A simultaneous booking may win a candidate; continue to the next closest option.
    }
  }
  return null;
}

async function cancelAffectedBookings(env, block, affectedType) {
  const result = await env.DB.prepare(`SELECT * FROM bookings WHERE status = 'active' AND booking_date >= ? AND booking_date <= ?
    AND start_time < ? AND end_time > ? ORDER BY booking_date, start_time`)
    .bind(block.start_date, block.end_date, block.end_time, block.start_time).all();
  const weekdays = block.weekdays ? new Set(String(block.weekdays).split(",")) : null;
  const affected = (result.results || []).filter((booking) => {
    const dayMatches = !weekdays || weekdays.has(dayOfWeek(booking.booking_date));
    return dayMatches && selectionIncludes(block.courts, booking.court);
  });
  if (!affected.length) return { affected: [], replacements: [] };
  const now = new Date().toISOString();
  const reasonPrefix = affectedType === "maintenance" ? "Maintenance" : affectedType === "priority" ? "Priority access" : "Admin action";
  const reason = `${reasonPrefix}: ${block.label || block.title || block.reason || "Court unavailable"}`;
  const statements = [];
  for (const booking of affected) {
    statements.push(env.DB.prepare(`UPDATE bookings SET status = 'canceled', canceled_at = ?, cancellation_reason = ?, affected_by_type = ?, affected_by_id = ?
      WHERE id = ? AND status = 'active'`).bind(now, reason, affectedType, block.id, booking.id));
    statements.push(env.DB.prepare("DELETE FROM booking_slots WHERE booking_id = ?").bind(booking.id));
    statements.push(env.DB.prepare("DELETE FROM client_booking_slots WHERE booking_id = ?").bind(booking.id));
  }
  await env.DB.batch(statements);
  const replacements = [];
  for (const booking of affected) {
    try {
      const replacement = await tryAutomaticRebooking(env, booking);
      if (replacement) replacements.push({ originalId: booking.id, ...replacement });
    } catch (error) {
      console.error("Automatic rebooking failed after the original booking was safely marked affected.", error);
    }
  }
  return { affected, replacements };
}

function validatePriorityData(data, priorityDays, { requestMode = false, publicMode = false } = {}) {
  const label = String(data.label || data.programName || "").trim();
  const kind = String(data.kind || data.type || "school_program").trim();
  const startDate = String(data.startDate || "");
  const endDate = String(data.endDate || "");
  const startTime = String(data.start || data.startTime || "");
  const endTime = String(data.end || data.endTime || "");
  if (label.length < 2 || label.length > 120) throw httpError("Enter a clear activity label.", 400, "invalid_label");
  if (!["chs_practice", "chs_match", "clinic", "tournament", "school_program", "other"].includes(kind)) throw httpError("Choose a valid priority activity type.", 400, "invalid_kind");
  if (!isDateKey(startDate) || !isDateKey(endDate) || endDate < startDate) throw httpError("Choose a valid priority date range.", 400, "invalid_dates");
  if (!isTimeKey(startTime) || !isTimeKey(endTime) || endTime <= startTime) throw httpError("Choose valid priority times.", 400, "invalid_times");
  const now = easternParts();
  if (startDate < now.date || endDate > addDaysKey(now.date, Number(priorityDays))) throw httpError("Priority holds can be scheduled up to 1 year in advance.", 400, "outside_priority_window");
  if (publicMode && daysBetween(startDate, endDate) + 1 > PUBLIC_PRIORITY_MAX_DAYS) {
    throw httpError(`Public priority bookings can cover up to ${PUBLIC_PRIORITY_MAX_DAYS} days per request.`, 400, "public_priority_too_long");
  }
  if (endDate === now.date && endTime <= now.time) throw httpError("That priority hold has already ended. Choose a future end time.", 400, "past_schedule_block");
  const courts = normalizeCourts(data.courts || data.court || "all");
  const weekdays = normalizeWeekdays(data.weekdays);
  if (!dateRangeContainsWeekday(startDate, endDate, weekdays)) throw httpError("The selected weekday does not occur inside this date range.", 400, "weekday_outside_range");
  const organizer = String(data.organizer || data.instructorName || "").trim();
  const listingUrl = String(data.listingUrl || "").trim();
  if (requestMode) {
    if (organizer.length < 2) throw httpError("Enter an organizer name.", 400, "invalid_organizer");
    if (listingUrl) {
      let url;
      try { url = new URL(listingUrl); } catch (_) { throw httpError("The public listing URL is invalid.", 400, "invalid_url"); }
      if (url.protocol !== "https:") throw httpError("The public listing must use HTTPS.", 400, "invalid_url");
    }
  }
  return { label, kind, startDate, endDate, startTime, endTime, courts, weekdays, organizer, listingUrl };
}

function validateClosureData(data, priorityDays, { publicMode = false } = {}) {
  const title = String(data.title || "Maintenance closure").trim();
  const reason = String(data.reason || "").trim();
  const startDate = String(data.startDate || "");
  const endDate = String(data.endDate || "");
  const startTime = String(data.start || data.startTime || "");
  const endTime = String(data.end || data.endTime || "");
  if (title.length < 2 || title.length > 120 || reason.length < 3 || reason.length > 500) throw httpError("Enter a clear maintenance title and reason.", 400, "invalid_closure");
  if (!isDateKey(startDate) || !isDateKey(endDate) || endDate < startDate) throw httpError("Choose a valid closure date range.", 400, "invalid_dates");
  if (!isTimeKey(startTime) || !isTimeKey(endTime) || endTime <= startTime) throw httpError("Choose valid closure times.", 400, "invalid_times");
  const now = easternParts();
  if (startDate < now.date || endDate > addDaysKey(now.date, Number(priorityDays))) throw httpError("Maintenance closures can be scheduled up to 1 year in advance.", 400, "outside_priority_window");
  if (endDate === now.date && endTime <= now.time) throw httpError("That maintenance closure has already ended. Choose a future end time.", 400, "past_schedule_block");
  const courts = normalizeCourts(data.courts || "all");
  if (publicMode) {
    if (startDate > addDaysKey(now.date, PUBLIC_MAINTENANCE_FUTURE_DAYS)) throw httpError(`Public maintenance reports can start up to ${PUBLIC_MAINTENANCE_FUTURE_DAYS} days ahead.`, 400, "public_closure_too_far");
    if (daysBetween(startDate, endDate) + 1 > PUBLIC_MAINTENANCE_MAX_DAYS) throw httpError(`Public maintenance reports can cover up to ${PUBLIC_MAINTENANCE_MAX_DAYS} days.`, 400, "public_closure_too_long");
    if (timeToMinutes(endTime) - timeToMinutes(startTime) > PUBLIC_MAINTENANCE_MAX_HOURS * 60) throw httpError(`Public maintenance reports can cover up to ${PUBLIC_MAINTENANCE_MAX_HOURS} hours per day.`, 400, "public_closure_too_long");
  }
  return { title, reason, startDate, endDate, startTime, endTime, courts };
}

async function submitPriorityRequest(request, env) {
  if (request.method !== "POST") return methodNotAllowed();
  await ensureDatabase(env);
  const clientId = validClientId(request);
  const settings = await getSettings(env);
  const data = validatePriorityData(await readJson(request), settings.priority_booking_days, { requestMode: true, publicMode: true });
  const actor = publicActor(clientId);
  let existing = await env.DB.prepare(`SELECT id FROM priority_requests WHERE status IN ('pending','active') AND creator_client_id = ? AND activity_kind = ? AND program_name = ?
    AND instructor_name = ? AND listing_url = ? AND start_date = ? AND end_date = ? AND start_time = ? AND end_time = ?
    AND court_selection = ? AND weekdays = ? LIMIT 1`)
    .bind(clientId, data.kind, data.label, data.organizer, data.listingUrl, data.startDate, data.endDate, data.startTime, data.endTime, data.courts, data.weekdays).first();
  const wasDuplicate = Boolean(existing);
  const id = existing?.id || crypto.randomUUID();
  const now = new Date().toISOString();
  if (!existing) {
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM priority_holds WHERE status = 'active' AND source_type = 'public' AND creator_client_id = ?")
      .bind(clientId).first();
    if (Number(count?.count || 0) >= PUBLIC_PRIORITY_MAX_ACTIVE) throw httpError(`You can have up to ${PUBLIC_PRIORITY_MAX_ACTIVE} active priority bookings at a time.`, 409, "public_priority_limit");
    await env.DB.prepare(`INSERT INTO priority_requests
      (id, type, activity_kind, program_name, instructor_name, email, listing_url, start_date, end_date, start_time, end_time, court_selection, weekdays, status, submitted_at, creator_client_id)
      VALUES (?, 'activity', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .bind(id, data.kind, data.label, data.organizer, "", data.listingUrl, data.startDate, data.endDate, data.startTime, data.endTime, data.courts, data.weekdays, now, clientId).run();
    existing = { id };
  }
  const existingSourceHold = await env.DB.prepare("SELECT id FROM priority_holds WHERE source_request_id = ? AND status = 'active' LIMIT 1").bind(id).first();
  const created = existingSourceHold ? { id: existingSourceHold.id, affectedCount: 0, rebookedCount: 0, duplicate: true } : await createPriorityHold(env, data, actor, id, {
    sourceType: "public",
    clientId
  });
  await env.DB.prepare("UPDATE priority_requests SET status = 'active', reviewed_at = ?, reviewer_email = 'honor-system', reviewer_notes = 'Activated immediately under the public honor system.' WHERE id = ?")
    .bind(now, id).run();
  return json({ ok: true, id, holdId: created.id, status: "active", affectedCount: created.affectedCount, rebookedCount: created.rebookedCount, duplicate: wasDuplicate || created.duplicate }, wasDuplicate || created.duplicate ? 200 : 201);
}

async function addAudit(env, actor, action, details, entityType = null, entityId = null) {
  await env.DB.prepare("INSERT INTO audit_log (entity_type, entity_id, actor_email, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(entityType, entityId, actor, action, details || "", new Date().toISOString()).run();
}

async function createPriorityHold(env, data, actor, sourceRequestId = null, { sourceType = "admin", clientId = null } = {}) {
  const settings = await getSettings(env);
  const hold = validatePriorityData(data, settings.priority_booking_days);
  const duplicate = await env.DB.prepare(`SELECT id FROM priority_holds WHERE status = 'active' AND label = ? AND activity_kind = ?
    AND start_date = ? AND end_date = ? AND start_time = ? AND end_time = ? AND courts = ? AND weekdays = ? LIMIT 1`)
    .bind(hold.label, hold.kind, hold.startDate, hold.endDate, hold.startTime, hold.endTime, hold.courts, hold.weekdays).first();
  if (duplicate) return { id: duplicate.id, affectedCount: 0, rebookedCount: 0, duplicate: true };
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const row = {
    id, label: hold.label, activity_kind: hold.kind, start_date: hold.startDate, end_date: hold.endDate,
    start_time: hold.startTime, end_time: hold.endTime, courts: hold.courts, weekdays: hold.weekdays
  };
  await env.DB.prepare(`INSERT INTO priority_holds
    (id, source_request_id, label, activity_kind, start_date, end_date, start_time, end_time, courts, weekdays, status, created_by, created_at, source_type, creator_client_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
    .bind(id, sourceRequestId, hold.label, hold.kind, hold.startDate, hold.endDate, hold.startTime, hold.endTime, hold.courts, hold.weekdays, actor, now, sourceType, clientId).run();
  const result = await cancelAffectedBookings(env, row, "priority");
  await addAudit(env, actor, sourceType === "public" ? "priority_hold_created_by_public" : "priority_hold_created", `${hold.label}; affected bookings: ${result.affected.length}; automatic replacements: ${result.replacements.length}`, "priority_hold", id);
  return { id, affectedCount: result.affected.length, rebookedCount: result.replacements.length };
}

async function createClosure(env, data, actor, { sourceType = "admin", clientId = null, creatorName = "", removalCodeHash = "" } = {}) {
  const settings = await getSettings(env);
  const closure = validateClosureData(data, settings.priority_booking_days, { publicMode: sourceType === "public" });
  const duplicate = await env.DB.prepare(`SELECT id FROM maintenance_closures WHERE status = 'active' AND title = ? AND reason = ?
    AND start_date = ? AND end_date = ? AND start_time = ? AND end_time = ? AND courts = ? AND source_type = ?
    AND COALESCE(creator_client_id, '') = ? LIMIT 1`)
    .bind(closure.title, closure.reason, closure.startDate, closure.endDate, closure.startTime, closure.endTime, closure.courts, sourceType, clientId || "").first();
  if (duplicate) return { id: duplicate.id, affectedCount: 0, rebookedCount: 0, duplicate: true };
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const row = {
    id, title: closure.title, reason: closure.reason, start_date: closure.startDate, end_date: closure.endDate,
    start_time: closure.startTime, end_time: closure.endTime, courts: closure.courts
  };
  await env.DB.prepare(`INSERT INTO maintenance_closures
    (id, title, reason, start_date, end_date, start_time, end_time, courts, status, created_by, created_at, source_type, creator_client_id, creator_name, creator_email, removal_code_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, closure.title, closure.reason, closure.startDate, closure.endDate, closure.startTime, closure.endTime, closure.courts, actor, now, sourceType, clientId, creatorName || null, null, removalCodeHash || null).run();
  const result = await cancelAffectedBookings(env, row, "maintenance");
  await addAudit(env, actor, sourceType === "public" ? "maintenance_closure_reported_by_public" : "maintenance_closure_created", `${closure.title}; affected bookings: ${result.affected.length}; automatic replacements: ${result.replacements.length}`, "maintenance", id);
  return { id, affectedCount: result.affected.length, rebookedCount: result.replacements.length };
}

async function getMyMaintenanceClosures(request, env) {
  if (request.method !== "GET") return methodNotAllowed();
  await ensureDatabase(env);
  await performHousekeeping(env);
  const clientId = validClientId(request);
  const result = await env.DB.prepare(`SELECT id, title, reason, start_date, end_date, start_time, end_time, courts, status, created_at
    FROM maintenance_closures WHERE source_type = 'public' AND creator_client_id = ?
    ORDER BY created_at DESC LIMIT 50`).bind(clientId).all();
  return json({ closures: result.results || [] });
}

async function createPublicMaintenanceClosure(request, env) {
  if (request.method !== "POST") return methodNotAllowed();
  await ensureDatabase(env);
  const clientId = validClientId(request);
  const data = await readJson(request);
  const creatorName = String(data.name || "").trim();
  if (creatorName.length > 80) throw httpError("Name must be 80 characters or fewer.", 400, "invalid_name");
  const settings = await getSettings(env);
  const closure = validateClosureData(data, settings.priority_booking_days, { publicMode: true });
  const duplicate = await env.DB.prepare(`SELECT id FROM maintenance_closures WHERE status = 'active' AND source_type = 'public' AND creator_client_id = ?
    AND title = ? AND reason = ? AND start_date = ? AND end_date = ? AND start_time = ? AND end_time = ? AND courts = ? LIMIT 1`)
    .bind(clientId, closure.title, closure.reason, closure.startDate, closure.endDate, closure.startTime, closure.endTime, closure.courts).first();
  if (duplicate) return json({ ok: true, id: duplicate.id, affectedCount: 0, rebookedCount: 0, duplicate: true, removalCode: null });
  const removalCode = crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
  const created = await createClosure(env, data, publicActor(clientId), {
    sourceType: "public",
    clientId,
    creatorName,
    removalCodeHash: await hashText(removalCode)
  });
  return json({ ok: true, ...created, removalCode: created.duplicate ? null : removalCode }, created.duplicate ? 200 : 201);
}

async function removePublicMaintenanceClosure(request, env, id) {
  if (request.method !== "DELETE") return methodNotAllowed();
  await ensureDatabase(env);
  const clientId = validClientId(request);
  const row = await env.DB.prepare("SELECT * FROM maintenance_closures WHERE id = ? AND source_type = 'public'").bind(id).first();
  if (!row) throw httpError("Maintenance report not found.", 404, "closure_not_found");
  if (row.status !== "active") throw httpError("This maintenance report is no longer active.", 409, "closure_not_active");
  let authorized = row.creator_client_id === clientId;
  if (!authorized) {
    const data = await readJson(request);
    const code = String(data.code || "").trim().toUpperCase();
    authorized = Boolean(code && row.removal_code_hash && await secureTextEqual(await hashText(code), row.removal_code_hash));
  }
  if (!authorized) throw httpError("That confirmation code does not match this maintenance report.", 403, "closure_removal_not_allowed");
  const now = new Date().toISOString();
  const actor = row.creator_client_id === clientId ? publicActor(clientId) : "public:confirmation-code";
  await env.DB.prepare("UPDATE maintenance_closures SET status = 'removed', removed_by = ?, removed_at = ? WHERE id = ? AND status = 'active'")
    .bind(actor, now, id).run();
  await addAudit(env, actor, "maintenance_closure_removed_by_public", "Public maintenance report removed by its creator or confirmation code.", "maintenance", id);
  return json({ ok: true });
}

async function adminCancelBooking(env, id, reason, adminEmail) {
  const row = await env.DB.prepare("SELECT * FROM bookings WHERE id = ? AND status = 'active'").bind(id).first();
  if (!row) throw httpError("Active booking not found.", 404, "booking_not_found");
  const now = new Date().toISOString();
  const message = `Admin action: ${String(reason || "Rare exception").trim()}`;
  await env.DB.batch([
    env.DB.prepare(`UPDATE bookings SET status = 'canceled', canceled_at = ?, cancellation_reason = ?, affected_by_type = 'admin', affected_by_id = 'admin'
      WHERE id = ? AND status = 'active'`).bind(now, message, id),
    env.DB.prepare("DELETE FROM booking_slots WHERE booking_id = ?").bind(id),
    env.DB.prepare("DELETE FROM client_booking_slots WHERE booking_id = ?").bind(id)
  ]);
  await addAudit(env, adminEmail, "booking_canceled_by_admin", message, "booking", id);
}

async function runAdminCleanup(env, action, adminEmail) {
  const validActions = new Set(["safe_cleanup", "clear_affected_history", "clear_calendar_history", "clear_recent_activity", "clear_archived_storage"]);
  if (!validActions.has(action)) throw httpError("Choose a valid cleanup action.", 400, "invalid_cleanup_action");
  const automatic = await performHousekeeping(env, { force: true });

  if (action === "clear_affected_history") {
    await env.DB.prepare("DELETE FROM bookings WHERE status <> 'active' AND affected_by_type IS NOT NULL").run();
    await addAudit(env, adminEmail, "affected_history_cleared", "Archived affected-booking records were permanently deleted; active bookings were preserved.", "housekeeping", "affected");
  } else if (action === "clear_calendar_history") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM priority_holds WHERE status <> 'active'"),
      env.DB.prepare("DELETE FROM maintenance_closures WHERE status <> 'active'")
    ]);
    await addAudit(env, adminEmail, "expired_calendar_history_cleared", "Expired and removed holds/closures were deleted; active schedule blocks were preserved.", "housekeeping", "calendar");
  } else if (action === "clear_recent_activity") {
    await env.DB.prepare("DELETE FROM audit_log").run();
    await addAudit(env, adminEmail, "activity_history_reset", "Earlier admin activity was permanently cleared.", "housekeeping", "audit");
  } else if (action === "clear_archived_storage") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM bookings WHERE status <> 'active'"),
      env.DB.prepare("DELETE FROM priority_requests WHERE status <> 'pending'"),
      env.DB.prepare("DELETE FROM priority_holds WHERE status <> 'active'"),
      env.DB.prepare("DELETE FROM maintenance_closures WHERE status <> 'active'"),
      env.DB.prepare("DELETE FROM booking_slots WHERE booking_id NOT IN (SELECT id FROM bookings)"),
      env.DB.prepare("DELETE FROM client_booking_slots WHERE booking_id NOT IN (SELECT id FROM bookings)")
    ]);
    await addAudit(env, adminEmail, "archived_shared_storage_cleared", "All archived rows were deleted; active bookings, future holds/closures, pending requests, and settings were preserved.", "housekeeping", "archive");
  } else {
    await addAudit(env, adminEmail, "safe_cleanup_run", "Automatic retention and expiration cleanup was run manually.", "housekeeping", "automatic");
  }
  return { ok: true, action, automatic, retention: retentionPolicy() };
}

async function handleAdmin(request, env, url) {
  const admin = await verifyAdmin(request, env);
  await ensureDatabase(env);
  await performHousekeeping(env);

  if (url.pathname === "/admin-api/session") {
    if (request.method !== "GET") return methodNotAllowed();
    return json({ email: admin.email, role: admin.role, authMode: admin.authMode, logoutUrl: admin.logoutUrl });
  }
  if (url.pathname === "/admin-api/court-status") {
    if (request.method === "GET") return json(await getCourtStatusPayload(env, { includeHistory: true }));
    if (request.method !== "POST") return methodNotAllowed();
    return json(await applyCourtStatus(env, await readJson(request), admin.email, { sourceType: "admin" }), 201);
  }
  const statusReportMatch = url.pathname.match(/^\/admin-api\/court-status-reports\/([a-f0-9-]+)$/i);
  if (statusReportMatch) {
    if (request.method !== "DELETE") return methodNotAllowed();
    return json(await deleteCourtStatusEvent(env, statusReportMatch[1], admin.email));
  }
  if (url.pathname === "/admin-api/bookings") {
    if (request.method !== "GET") return methodNotAllowed();
    const from = isDateKey(url.searchParams.get("from")) ? url.searchParams.get("from") : easternParts().date;
    const to = isDateKey(url.searchParams.get("to")) ? url.searchParams.get("to") : addDaysKey(from, 30);
    const result = await env.DB.prepare("SELECT * FROM bookings WHERE booking_date >= ? AND booking_date <= ? ORDER BY booking_date, start_time, court").bind(from, to).all();
    return json({ bookings: result.results || [] });
  }
  if (url.pathname === "/admin-api/affected") {
    if (request.method !== "GET") return methodNotAllowed();
    const cutoff = addDaysKey(easternParts().date, -90);
    const result = await env.DB.prepare(`SELECT b.*, r.booking_date AS replacement_date, r.court AS replacement_court,
      r.start_time AS replacement_start_time, r.end_time AS replacement_end_time, r.status AS replacement_status
      FROM bookings b LEFT JOIN bookings r ON r.id = b.replacement_booking_id
      WHERE b.booking_date >= ? AND b.affected_by_type IN ('maintenance','priority','admin')
      ORDER BY b.canceled_at DESC LIMIT 300`).bind(cutoff).all();
    return json({ bookings: result.results || [] });
  }
  const adminBookingMatch = url.pathname.match(/^\/admin-api\/bookings\/([a-f0-9-]+)$/i);
  if (adminBookingMatch) {
    if (request.method !== "PATCH") return methodNotAllowed();
    const data = await readJson(request);
    if (String(data.reason || "").trim().length < 3) throw httpError("Provide a reason for the admin cancellation.", 400, "reason_required");
    await adminCancelBooking(env, adminBookingMatch[1], data.reason, admin.email);
    return json({ ok: true });
  }
  if (url.pathname === "/admin-api/priority-requests") {
    if (request.method !== "GET") return methodNotAllowed();
    const result = await env.DB.prepare("SELECT * FROM priority_requests ORDER BY submitted_at DESC LIMIT 300").all();
    return json({ requests: result.results || [] });
  }
  const requestMatch = url.pathname.match(/^\/admin-api\/priority-requests\/([a-f0-9-]+)$/i);
  if (requestMatch) {
    if (request.method !== "PATCH") return methodNotAllowed();
    const data = await readJson(request);
    const row = await env.DB.prepare("SELECT * FROM priority_requests WHERE id = ?").bind(requestMatch[1]).first();
    if (!row) throw httpError("Priority request not found.", 404, "request_not_found");
    if (row.status !== "pending") throw httpError("This priority request has already been reviewed.", 409, "request_already_reviewed");
    if (!["approved", "rejected"].includes(data.status) || String(data.notes || "").trim().length < 3) throw httpError("Choose approve or reject and add notes.", 400, "invalid_review");
    let affectedCount = 0;
    let rebookedCount = 0;
    if (data.status === "approved") {
      const existingSourceHold = await env.DB.prepare("SELECT id FROM priority_holds WHERE source_request_id = ? AND status = 'active' LIMIT 1").bind(row.id).first();
      const created = existingSourceHold ? { id: existingSourceHold.id, affectedCount: 0, rebookedCount: 0, duplicate: true } : await createPriorityHold(env, {
          label: row.program_name, kind: row.activity_kind, startDate: row.start_date, endDate: row.end_date,
          start: row.start_time, end: row.end_time, courts: row.court_selection, weekdays: row.weekdays
        }, admin.email, row.id);
      affectedCount = created.affectedCount;
      rebookedCount = created.rebookedCount;
    }
    const now = new Date().toISOString();
    await env.DB.prepare("UPDATE priority_requests SET status = ?, reviewed_at = ?, reviewer_email = ?, reviewer_notes = ? WHERE id = ?")
      .bind(data.status, now, admin.email, String(data.notes).trim(), row.id).run();
    await addAudit(env, admin.email, `priority_request_${data.status}`, String(data.notes).trim(), "priority_request", row.id);
    return json({ ok: true, affectedCount, rebookedCount });
  }
  if (url.pathname === "/admin-api/priority-holds") {
    if (request.method === "GET") {
      const result = await env.DB.prepare("SELECT * FROM priority_holds ORDER BY start_date DESC, start_time DESC LIMIT 300").all();
      return json({ holds: result.results || [] });
    }
    if (request.method === "POST") {
      const created = await createPriorityHold(env, await readJson(request), admin.email);
      return json({ ok: true, ...created }, created.duplicate ? 200 : 201);
    }
    return methodNotAllowed();
  }
  const holdMatch = url.pathname.match(/^\/admin-api\/priority-holds\/([a-f0-9-]+)$/i);
  if (holdMatch) {
    if (request.method !== "DELETE") return methodNotAllowed();
    const now = new Date().toISOString();
    await env.DB.prepare("UPDATE priority_holds SET status = 'removed', removed_by = ?, removed_at = ? WHERE id = ? AND status = 'active'")
      .bind(admin.email, now, holdMatch[1]).run();
    await addAudit(env, admin.email, "priority_hold_removed", "Hold removed; previously affected bookings remain canceled.", "priority_hold", holdMatch[1]);
    return json({ ok: true });
  }
  if (url.pathname === "/admin-api/closures") {
    if (request.method === "GET") {
      const result = await env.DB.prepare("SELECT * FROM maintenance_closures ORDER BY start_date DESC, start_time DESC LIMIT 300").all();
      return json({ closures: result.results || [] });
    }
    if (request.method === "POST") {
      const created = await createClosure(env, await readJson(request), admin.email);
      return json({ ok: true, ...created }, created.duplicate ? 200 : 201);
    }
    return methodNotAllowed();
  }
  const closureMatch = url.pathname.match(/^\/admin-api\/closures\/([a-f0-9-]+)$/i);
  if (closureMatch) {
    if (request.method !== "DELETE") return methodNotAllowed();
    const now = new Date().toISOString();
    await env.DB.prepare("UPDATE maintenance_closures SET status = 'removed', removed_by = ?, removed_at = ? WHERE id = ? AND status = 'active'")
      .bind(admin.email, now, closureMatch[1]).run();
    await addAudit(env, admin.email, "maintenance_closure_removed", "Closure removed; previously affected bookings remain canceled.", "maintenance", closureMatch[1]);
    return json({ ok: true });
  }
  if (url.pathname === "/admin-api/settings") {
    if (request.method === "GET") return json({ settings: await getSettings(env) });
    if (request.method !== "PATCH") return methodNotAllowed();
    const data = await readJson(request);
    const publicDays = Number(data.public_booking_days);
    const priorityDays = Number(data.priority_booking_days);
    const reason = String(data.reason || "").trim();
    if (!Number.isInteger(publicDays) || publicDays < 30 || publicDays > 365) throw httpError("Public booking window must be between 30 and 365 days.", 400, "invalid_setting");
    if (!Number.isInteger(priorityDays) || priorityDays < publicDays || priorityDays > 365) throw httpError("Priority window must be at least the public window and no more than 365 days.", 400, "invalid_setting");
    if (reason.length < 3) throw httpError("Provide a reason for the settings change.", 400, "reason_required");
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO site_settings (key,value,updated_at,reviewer_email) VALUES ('public_booking_days',?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,reviewer_email=excluded.reviewer_email`).bind(String(publicDays), now, admin.email),
      env.DB.prepare(`INSERT INTO site_settings (key,value,updated_at,reviewer_email) VALUES ('priority_booking_days',?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,reviewer_email=excluded.reviewer_email`).bind(String(priorityDays), now, admin.email)
    ]);
    await addAudit(env, admin.email, "booking_windows_updated", `${publicDays} public / ${priorityDays} priority days; ${reason}`, "settings", "booking_windows");
    return json({ ok: true });
  }
  if (url.pathname === "/admin-api/housekeeping") {
    if (request.method === "GET") return json({ retention: retentionPolicy(), lastAutomaticCheck: lastHousekeepingAt ? new Date(lastHousekeepingAt).toISOString() : null });
    if (request.method !== "POST") return methodNotAllowed();
    const data = await readJson(request);
    const action = String(data.action || "");
    if (action !== "safe_cleanup" && admin.role !== "admin") throw httpError("Only the primary administrator can permanently clear stored history.", 403, "primary_admin_required");
    return json(await runAdminCleanup(env, action, admin.email));
  }
  if (url.pathname === "/admin-api/audit") {
    if (request.method !== "GET") return methodNotAllowed();
    const result = await env.DB.prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200").all();
    return json({ audit: result.results || [] });
  }
  if (url.pathname === "/admin-api/debug") {
    if (request.method !== "GET") return methodNotAllowed();
    const tables = ["bookings", "booking_slots", "client_booking_slots", "priority_requests", "priority_holds", "maintenance_closures", "court_status", "court_status_events", "audit_log", "admin_login_attempts"];
    const counts = {};
    for (const table of tables) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first();
      counts[table] = Number(row?.count || 0);
    }
    const [missingCourtSlots, missingClientSlots, staleCourtSlots, staleClientSlots] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS count FROM bookings b WHERE b.status = 'active' AND NOT EXISTS (SELECT 1 FROM booking_slots s WHERE s.booking_id = b.id)").first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM bookings b WHERE b.status = 'active' AND NOT EXISTS (SELECT 1 FROM client_booking_slots s WHERE s.booking_id = b.id)").first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM booking_slots s WHERE NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = s.booking_id AND b.status = 'active')").first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM client_booking_slots s WHERE NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = s.booking_id AND b.status = 'active')").first()
    ]);
    const integrity = {
      missingCourtSlots: Number(missingCourtSlots?.count || 0),
      missingClientSlots: Number(missingClientSlots?.count || 0),
      staleCourtSlots: Number(staleCourtSlots?.count || 0),
      staleClientSlots: Number(staleClientSlots?.count || 0)
    };
    return json({ database: "connected", counts, integrity, settings: await getSettings(env), retention: retentionPolicy() });
  }
  return json({ error: "not_found", message: "Admin endpoint not found." }, 404);
}

async function serveAsset(request, env, pathOverride = null, contentType = null) {
  const assetRequest = pathOverride ? new Request(new URL(pathOverride, request.url).toString(), request) : request;
  const response = await env.ASSETS.fetch(assetRequest);
  const headers = new Headers(response.headers);
  headers.delete("Content-Disposition");
  if (contentType) {
    headers.set("Content-Type", contentType);
    headers.set("Cache-Control", "no-store");
  }
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Content-Security-Policy", "default-src 'self'; connect-src 'self' https://api.open-meteo.com; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/health") {
        await ensureDatabase(env);
        return json({ ok: true, storage: "d1", settings: await getSettings(env) });
      }
      if (url.pathname === "/api/settings") {
        await ensureDatabase(env);
        return json({ settings: await getSettings(env), active: true });
      }
      if (url.pathname === "/api/schedule") {
        if (request.method !== "GET") return methodNotAllowed();
        await ensureDatabase(env);
        const date = url.searchParams.get("date") || "";
        if (!isDateKey(date)) throw httpError("Provide a valid schedule date.", 400, "invalid_date");
        const clientId = validClientId(request);
        return json(await getSchedule(env, date, clientId));
      }
      if (url.pathname === "/api/my-bookings") return await getMyBookings(request, env);
      if (url.pathname === "/api/my-bookings/archive") return await archiveMyBookingNotices(request, env);
      if (url.pathname === "/api/my-bookings/history") return await deleteMyBookingHistory(request, env);
      const historyMatch = url.pathname.match(/^\/api\/my-bookings\/([a-f0-9-]+)$/i);
      if (historyMatch) return await deleteMyBookingHistory(request, env, historyMatch[1]);
      if (url.pathname === "/api/bookings") return await createBooking(request, env);
      const bookingMatch = url.pathname.match(/^\/api\/bookings\/([a-f0-9-]+)$/i);
      if (bookingMatch) return await cancelBooking(request, env, bookingMatch[1]);
      if (url.pathname === "/api/court-status") return await handlePublicCourtStatus(request, env);
      if (url.pathname === "/api/my-maintenance-closures" || url.pathname === "/api/maintenance-closures" || /^\/api\/maintenance-closures\/[a-f0-9-]+$/i.test(url.pathname)) {
        return json({ error: "court_status_replaced", message: "Use the shared court-status report to mark courts down or open." }, 410);
      }
      if (url.pathname === "/api/priority-requests") return await submitPriorityRequest(request, env);
      if (url.pathname === "/api/admin-login") return await handleAdminLogin(request, env);
      if (url.pathname === "/api/admin-logout") return adminLogout();
      if (url.pathname === "/admin-login" || url.pathname === "/admin-login.html") {
        return await serveAsset(request, env, "/admin-login-page.txt", "text/html; charset=utf-8");
      }
      if (url.pathname === "/admin" || url.pathname === "/admin.html") {
        try {
          await verifyAdmin(request, env);
        } catch (error) {
          if (["admin_login_required", "admin_not_configured"].includes(error.code)) {
            return Response.redirect(new URL("/admin-login", request.url).toString(), 302);
          }
          throw error;
        }
        return await serveAsset(request, env, "/admin-page.txt", "text/html; charset=utf-8");
      }
      if (url.pathname.startsWith("/admin-api/")) return await handleAdmin(request, env, url);
      return await serveAsset(request, env);
    } catch (error) {
      console.error(error);
      return json({ error: error.code || "request_failed", message: error.message || "The request could not be completed." }, error.status || 500);
    }
  }
};
