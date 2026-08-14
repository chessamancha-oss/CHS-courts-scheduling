import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const source = await readFile(new URL("../_worker.js", import.meta.url), "utf8");
const worker = (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).default;
// Expected 4xx cases are asserted below; keep the test output readable while the Worker logs them.
console.error = () => {};

class D1Statement {
  constructor(database, sql, parameters = []) {
    this.database = database;
    this.sql = sql;
    this.parameters = parameters;
  }

  bind(...parameters) {
    return new D1Statement(this.database, this.sql, parameters);
  }

  run() {
    return this.database.prepare(this.sql).run(...this.parameters);
  }

  all() {
    return { results: this.database.prepare(this.sql).all(...this.parameters) };
  }

  first() {
    return this.database.prepare(this.sql).get(...this.parameters) || null;
  }
}

class TestD1 {
  constructor() {
    this.database = new DatabaseSync(":memory:");
  }

  prepare(sql) {
    return new D1Statement(this.database, sql);
  }

  batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function easternDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDaysKey(value, days) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days, 12)).toISOString().slice(0, 10);
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

const keyPair = await crypto.subtle.generateKey({
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256"
}, true, ["sign", "verify"]);
const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
publicJwk.kid = "integration-key";
publicJwk.alg = "RS256";
publicJwk.use = "sig";
const teamDomain = "https://integration.cloudflareaccess.com";
const jwtHeader = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: publicJwk.kid }));
const jwtPayload = base64url(JSON.stringify({
  iss: teamDomain,
  aud: ["integration-audience"],
  email: "admin@example.com",
  exp: Math.floor(Date.now() / 1000) + 3600
}));
const jwtSignature = await crypto.subtle.sign(
  { name: "RSASSA-PKCS1-v1_5" },
  keyPair.privateKey,
  new TextEncoder().encode(`${jwtHeader}.${jwtPayload}`)
);
const adminToken = `${jwtHeader}.${jwtPayload}.${Buffer.from(jwtSignature).toString("base64url")}`;

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.href === `${teamDomain}/cdn-cgi/access/certs`) {
    return new Response(JSON.stringify({ keys: [publicJwk] }), { headers: { "Content-Type": "application/json" } });
  }
  return originalFetch(input, init);
};

const env = {
  DB: new TestD1(),
  ASSETS: {
    fetch: async (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname.endsWith(".html")) {
        return new Response(null, { status: 308, headers: { Location: pathname.slice(0, -5) } });
      }
      return new Response(`asset:${pathname}`, { headers: { "Content-Type": "text/plain", "Content-Disposition": "attachment" } });
    }
  },
  ACCESS_TEAM_DOMAIN: teamDomain,
  ACCESS_AUD: "integration-audience",
  ADMIN_EMAILS: "admin@example.com"
};

async function call(path, { method = "GET", client = "browser_client_a", body, admin = false, cookie = "", envOverride = env } = {}) {
  const headers = new Headers({ "X-CHS-Client-Id": client });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (admin) headers.set("CF-Access-Jwt-Assertion", adminToken);
  if (cookie) headers.set("Cookie", cookie);
  const request = new Request(`https://courts.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const response = await worker.fetch(request, envOverride);
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { /* Asset responses are text. */ }
  return { response, data, text };
}

async function createBooking(client, date, court, startMinute, durationMinutes = 30) {
  return call("/api/bookings", {
    method: "POST",
    client,
    body: { name: `Player ${client.slice(-1).toUpperCase()}`, date, court, startMinute, durationMinutes }
  });
}

const today = easternDate();
const target = addDaysKey(today, 10);
const targetWeekday = String(new Date(`${target}T12:00:00Z`).getUTCDay());

const results = [];
function passed(name) { results.push(name); }

let result = await call("/api/health");
assert.equal(result.response.status, 200);
assert.equal(result.data.storage, "d1");
assert.equal(result.data.settings.public_booking_days, "180");
passed("D1 shared storage initializes with configurable 180/365-day windows");

result = await call("/admin.html");
assert.equal(result.response.status, 302);
assert.equal(new URL(result.response.headers.get("location")).pathname, "/admin-login");
passed("Admin Portal is not accessible without a verified Access session");
result = await call("/admin.html", { admin: true });
assert.equal(result.response.status, 200);
assert.equal(result.text, "asset:/admin-page.txt");
assert.equal(result.response.headers.get("content-type"), "text/html; charset=utf-8");
assert.equal(result.response.headers.get("content-disposition"), null);
passed("Allowlisted, signed Access session can open Admin Portal");

result = await call("/admin-login");
assert.equal(result.response.status, 200);
assert.equal(result.text, "asset:/admin-login-page.txt");
assert.equal(result.response.headers.get("content-type"), "text/html; charset=utf-8");
assert.equal(result.response.headers.get("content-disposition"), null);
result = await call("/admin-login.html");
assert.equal(result.response.status, 200);
assert.equal(result.text, "asset:/admin-login-page.txt");
passed("Admin login bypasses Cloudflare HTML canonical redirects and is served inline without a self-loop");

const fallbackEnv = {
  ...env,
  ACCESS_TEAM_DOMAIN: "",
  ACCESS_AUD: "",
  ADMIN_EMAILS: "",
  ADMIN_PASSWORD: "",
  ADMIN_CREDENTIALS: JSON.stringify({
    "admin@example.com": "Correct-Horse-Court-2026",
    "editor@example.com": "Different-Court-Pass-2026"
  }),
  ADMIN_SESSION_SECRET: "integration-session-secret-at-least-32-characters"
};
result = await call("/api/admin-login", { method: "POST", envOverride: fallbackEnv, body: { email: "admin@example.com", password: "wrong-password" } });
assert.equal(result.response.status, 401);
result = await call("/api/admin-login", { method: "POST", envOverride: fallbackEnv, body: { email: "admin@example.com", password: "Correct-Horse-Court-2026" } });
assert.equal(result.response.status, 200);
const fallbackCookie = result.response.headers.get("set-cookie").split(";")[0];
assert.match(fallbackCookie, /^chs_admin_session=/);
result = await call("/admin-api/session", { envOverride: fallbackEnv, cookie: fallbackCookie });
assert.equal(result.response.status, 200);
assert.equal(result.data.email, "admin@example.com");
assert.equal(result.data.authMode, "temporary_password");
result = await call("/admin.html", { envOverride: fallbackEnv, cookie: fallbackCookie });
assert.equal(result.response.status, 200);
assert.equal(result.text, "asset:/admin-page.txt");
result = await call("/api/admin-login", { method: "POST", envOverride: fallbackEnv, body: { email: "editor@example.com", password: "Different-Court-Pass-2026" } });
assert.equal(result.response.status, 200);
const editorCookie = result.response.headers.get("set-cookie").split(";")[0];
passed("Separate pages.dev email/password pairs create signed, HttpOnly admin sessions");

for (let attempt = 1; attempt <= 5; attempt += 1) {
  result = await call("/api/admin-login", { method: "POST", envOverride: fallbackEnv, body: { email: "blocked@example.com", password: "wrong-password" } });
  assert.equal(result.response.status, attempt < 5 ? 401 : 429);
}
result = await call("/api/admin-login", { method: "POST", envOverride: fallbackEnv, body: { email: "blocked@example.com", password: "wrong-password" } });
assert.equal(result.response.status, 429);
assert.equal(result.data.error, "admin_login_rate_limited");
result = await call("/admin-api/housekeeping", { method: "POST", envOverride: fallbackEnv, cookie: editorCookie, body: { action: "clear_archived_storage" } });
assert.equal(result.response.status, 403);
assert.equal(result.data.error, "primary_admin_required");
passed("Admin login throttling and primary-admin-only destructive cleanup guard sensitive operations");

const first = await createBooking("browser_client_a", target, 1, 480, 120);
assert.equal(first.response.status, 201);
const firstId = first.data.booking.id;
result = await call(`/api/schedule?date=${target}`, { client: "browser_client_b" });
assert.equal(result.data.bookings.some((booking) => booking.id === firstId), true);
assert.equal(result.data.bookings.find((booking) => booking.id === firstId).owner, false);
result = await call(`/api/schedule?date=${target}`, { client: "browser_client_b" });
assert.equal(result.data.bookings.some((booking) => booking.id === firstId), true);
passed("Booking persists across reloads and appears to a different browser client");

const noEmailDate = addDaysKey(target, 1);
result = await call("/api/bookings", {
  method: "POST",
  client: "browser_email_ignored",
  body: { name: "Privacy Test", email: "ignored@example.com", date: noEmailDate, court: 6, startMinute: 480, durationMinutes: 30 }
});
assert.equal(result.response.status, 201);
const noEmailRow = await env.DB.prepare("SELECT email FROM bookings WHERE id = ?").bind(result.data.booking.id).first();
assert.equal(noEmailRow.email, null);
assert.equal("email" in result.data.booking, false);
passed("Public booking ignores submitted email data and stores no email");

result = await createBooking("browser_client_a", target, 1, 480, 120);
assert.equal(result.response.status, 200);
assert.equal(result.data.duplicate, true);
assert.equal(result.data.booking.id, firstId);
result = await call(`/api/schedule?date=${target}`, { client: "browser_client_b" });
assert.equal(result.data.bookings.filter((booking) => booking.id === firstId).length, 1);
passed("A retried identical booking request reuses the saved booking instead of creating a duplicate");

const second = await createBooking("browser_client_a", target, 2, 600, 30);
assert.equal(second.response.status, 201);
const secondId = second.data.booking.id;
result = await createBooking("browser_client_a", target, 3, 660, 30);
assert.equal(result.response.status, 409);
assert.equal(result.data.error, "daily_booking_limit");
assert.equal(result.data.message, "You can have up to 2 active bookings per day. Please cancel or complete an existing booking before making another.");
passed("Server enforces 2 active bookings per browser/day with the required message");

result = await createBooking("browser_client_duration", target, 5, 480, 150);
assert.equal(result.response.status, 400);
assert.equal(result.data.error, "invalid_duration");
passed("Server rejects individual bookings longer than 2 hours");

const ownOverlapDate = addDaysKey(target, 9);
result = await createBooking("browser_own_overlap", ownOverlapDate, 5, 540, 60);
assert.equal(result.response.status, 201);
result = await createBooking("browser_own_overlap", ownOverlapDate, 6, 570, 60);
assert.equal(result.response.status, 201);
result = await createBooking("browser_own_overlap", ownOverlapDate, 4, 600, 30);
assert.equal(result.response.status, 409);
assert.equal(result.data.error, "daily_booking_limit");
passed("A player can reserve two courts at overlapping times while the original two-booking daily limit remains enforced");

const canonicalGuardDate = addDaysKey(target, 10);
const canonicalBooking = await createBooking("browser_canonical_a", canonicalGuardDate, 1, 900, 60);
assert.equal(canonicalBooking.response.status, 201);
await env.DB.prepare("DELETE FROM booking_slots WHERE booking_id = ?").bind(canonicalBooking.data.booking.id).run();
result = await createBooking("browser_canonical_b", canonicalGuardDate, 1, 900, 60);
assert.equal(result.response.status, 409);
assert.equal(result.data.error, "booking_conflict");
await call(`/api/bookings/${canonicalBooking.data.booking.id}`, { method: "DELETE", client: "browser_canonical_a" });
passed("Canonical booking rows prevent double-booking even if a slot-index row is missing");

result = await call(`/api/bookings/${firstId}`, { method: "DELETE", client: "browser_client_a" });
assert.equal(result.response.status, 200);
result = await createBooking("browser_client_a", target, 3, 660, 30);
assert.equal(result.response.status, 201);
result = await call(`/api/schedule?date=${target}`, { client: "browser_client_b" });
assert.equal(result.data.bookings.some((booking) => booking.id === firstId), false);
passed("Cancellation immediately frees the daily slot and disappears for other clients");

result = await call(`/api/bookings/${secondId}`, { method: "DELETE", client: "browser_client_a" });
assert.equal(result.response.status, 200);
result = await createBooking("browser_client_a", target, 2, 720, 30);
assert.equal(result.response.status, 201);
passed("A player can rebook immediately after canceling; no cooldown remains");

result = await call("/api/my-bookings", { client: "browser_client_a" });
assert.equal(result.data.bookings.find((booking) => booking.id === firstId).status, "canceled");
result = await call("/api/my-bookings/archive", { method: "POST", client: "browser_client_a" });
assert.equal(result.response.status, 200);
result = await call("/api/my-bookings", { client: "browser_client_a" });
assert.equal(result.data.bookings.find((booking) => booking.id === firstId).archived, true);
result = await call(`/api/my-bookings/${firstId}`, { method: "DELETE", client: "browser_client_a" });
assert.equal(result.response.status, 200);
result = await call("/api/my-bookings/history", { method: "DELETE", client: "browser_client_a" });
assert.equal(result.response.status, 200);
result = await call("/api/my-bookings", { client: "browser_client_a" });
assert.equal(result.data.bookings.every((booking) => booking.status === "active"), true);
assert.equal(result.data.bookings.length, 2);
passed("Players can archive notices and permanently delete history without touching active bookings");

const maintenanceBooking = await createBooking("browser_client_c", target, 4, 720, 60);
assert.equal(maintenanceBooking.response.status, 201);
const maintenanceBookingId = maintenanceBooking.data.booking.id;
result = await call("/admin-api/closures", {
  method: "POST", admin: true,
  body: { title: "Broken net", reason: "Court is unsafe until repaired", startDate: target, endDate: target, start: "11:30", end: "13:30", courts: [4] }
});
assert.equal(result.response.status, 201);
assert.equal(result.data.affectedCount, 1);
assert.equal(result.data.rebookedCount, 1);
result = await call("/api/my-bookings", { client: "browser_client_c" });
const affectedMaintenance = result.data.bookings.find((booking) => booking.id === maintenanceBookingId);
assert.equal(affectedMaintenance.status, "canceled");
assert.equal(affectedMaintenance.affectedByType, "maintenance");
assert.equal(Boolean(affectedMaintenance.replacementBooking), true);
const maintenanceReplacement = result.data.bookings.find((booking) => booking.id === affectedMaintenance.replacementBooking.id);
assert.equal(maintenanceReplacement.status, "active");
assert.equal(maintenanceReplacement.automaticReplacement, true);
result = await createBooking("browser_client_blocked", target, 4, 750, 30);
assert.equal(result.response.status, 409);
assert.equal(result.data.error, "schedule_blocked");
const cOne = await createBooking("browser_client_c", target, 5, 840, 30);
const cTwo = await createBooking("browser_client_c", target, 6, 960, 30);
assert.equal(cOne.response.status, 201);
assert.equal(cTwo.response.status, 409);
assert.equal(cTwo.data.error, "daily_booking_limit");
result = await call(`/api/bookings/${maintenanceReplacement.id}`, { method: "DELETE", client: "browser_client_c" });
assert.equal(result.response.status, 200);
const cTwoAfterReplacementCanceled = await createBooking("browser_client_c", target, 6, 960, 30);
assert.equal(cTwoAfterReplacementCanceled.response.status, 201);
result = await createBooking("browser_client_c", target, 5, 1080, 30);
assert.equal(result.data.error, "daily_booking_limit");
passed("Maintenance blocks the court, records the conflict, and automatically secures a similar replacement when available");

result = await call("/api/maintenance-closures", {
  method: "POST", client: "browser_legacy_status",
  body: { title: "Old timed report", reason: "Should use the new status board", startDate: target, endDate: target, start: "09:00", end: "10:00", courts: [3] }
});
assert.equal(result.response.status, 410);
assert.equal(result.data.error, "court_status_replaced");
result = await call("/api/my-maintenance-closures", { client: "browser_legacy_status" });
assert.equal(result.response.status, 410);
passed("Legacy time-bounded public maintenance routes cannot bypass the down/open status workflow");

const priorityBooking = await createBooking("browser_client_d", target, 1, 780, 60);
assert.equal(priorityBooking.response.status, 201);
const priorityBookingId = priorityBooking.data.booking.id;
result = await call("/admin-api/priority-holds", {
  method: "POST", admin: true,
  body: { label: "CHS Tennis Match", kind: "chs_match", startDate: target, endDate: target, start: "12:30", end: "14:30", courts: [1], weekdays: [targetWeekday] }
});
assert.equal(result.response.status, 201);
assert.equal(result.data.affectedCount, 1);
assert.equal(result.data.rebookedCount, 1);
result = await call("/api/my-bookings", { client: "browser_client_d" });
const affectedPriority = result.data.bookings.find((booking) => booking.id === priorityBookingId);
assert.equal(affectedPriority.status, "canceled");
assert.equal(affectedPriority.affectedByType, "priority");
assert.equal(Boolean(affectedPriority.replacementBooking), true);
result = await call(`/api/schedule?date=${target}`, { client: "browser_client_other" });
assert.equal(result.data.priorityHolds.some((hold) => hold.name === "CHS Tennis Match"), true);
result = await createBooking("browser_client_other", target, 1, 780, 30);
assert.equal(result.data.error, "schedule_blocked");
passed("Priority holds use real labels, block shared time, and automatically compensate conflicts with similar replacements");

result = await call("/admin-api/priority-holds", {
  method: "POST", admin: true,
  body: { label: "CHS Tennis Match", kind: "chs_match", startDate: target, endDate: target, start: "12:30", end: "14:30", courts: [1], weekdays: [targetWeekday] }
});
assert.equal(result.response.status, 200);
assert.equal(result.data.duplicate, true);
passed("Identical active priority-hold retries reuse the existing hold instead of duplicating it");

const allClosureDate = addDaysKey(target, 1);
result = await call("/admin-api/closures", {
  method: "POST", admin: true,
  body: { title: "Facility resurfacing", reason: "All courts are closed", startDate: allClosureDate, endDate: allClosureDate, start: "20:00", end: "21:00", courts: "all" }
});
assert.equal(result.response.status, 201);
result = await call(`/api/schedule?date=${allClosureDate}`, { client: "browser_client_other" });
assert.equal(result.data.closures.length, 6);
passed("Admin can close the entire six-court facility");

result = await call("/admin-api/closures", {
  method: "POST", admin: true,
  body: { title: "Facility resurfacing", reason: "All courts are closed", startDate: allClosureDate, endDate: allClosureDate, start: "20:00", end: "21:00", courts: "all" }
});
assert.equal(result.response.status, 200);
assert.equal(result.data.duplicate, true);
passed("Identical active maintenance retries reuse the existing closure instead of duplicating it");

const noAlternativeDate = addDaysKey(target, 7);
const noAlternativeBooking = await createBooking("browser_client_no_option", noAlternativeDate, 1, 600, 60);
assert.equal(noAlternativeBooking.response.status, 201);
result = await call("/admin-api/closures", {
  method: "POST", admin: true,
  body: { title: "Full-day safety closure", reason: "No courts are available", startDate: noAlternativeDate, endDate: noAlternativeDate, start: "00:00", end: "23:59", courts: "all" }
});
assert.equal(result.response.status, 201);
assert.equal(result.data.rebookedCount, 0);
result = await call("/api/my-bookings", { client: "browser_client_no_option" });
const affectedWithoutReplacement = result.data.bookings.find((booking) => booking.id === noAlternativeBooking.data.booking.id);
assert.equal(affectedWithoutReplacement.status, "canceled");
assert.equal(affectedWithoutReplacement.replacementBooking, null);
passed("When no similar slot exists, the affected record remains available for other-time guidance without a fake replacement");

const multiClosureDate = addDaysKey(target, 2);
result = await call("/admin-api/closures", {
  method: "POST", admin: true,
  body: { title: "Surface inspection", reason: "Courts need inspection", startDate: multiClosureDate, endDate: multiClosureDate, start: "08:00", end: "09:00", courts: [2, 3, 5] }
});
assert.equal(result.response.status, 201);
result = await call(`/api/schedule?date=${multiClosureDate}`, { client: "browser_client_other" });
assert.deepEqual(result.data.closures.map((item) => item.court).sort(), [2, 3, 5]);
passed("Admin can close any selected combination of courts");

result = await createBooking("browser_client_future", addDaysKey(today, 181), 1, 480, 30);
assert.equal(result.response.status, 400);
assert.equal(result.data.error, "outside_booking_window");
assert.equal(result.data.message, "Bookings are only available up to 6 months in advance.");
passed("Public booking is disabled beyond the configured 180-day window");

result = await call("/admin-api/priority-holds", {
  method: "POST", admin: true,
  body: { label: "Too distant", kind: "school_program", startDate: addDaysKey(today, 366), endDate: addDaysKey(today, 366), start: "10:00", end: "11:00", courts: [1], weekdays: ["1"] }
});
assert.equal(result.response.status, 400);
assert.equal(result.data.error, "outside_priority_window");
passed("Admin/priority holds are limited to the configured 1-year window");

const mismatchedWeekday = String((Number(targetWeekday) + 1) % 7);
result = await call("/admin-api/priority-holds", {
  method: "POST", admin: true,
  body: { label: "Impossible weekday", kind: "school_program", startDate: target, endDate: target, start: "18:00", end: "19:00", courts: [6], weekdays: [mismatchedWeekday] }
});
assert.equal(result.response.status, 400);
assert.equal(result.data.error, "weekday_outside_range");
const todayWeekday = String(new Date(`${today}T12:00:00Z`).getUTCDay());
result = await call("/admin-api/priority-holds", {
  method: "POST", admin: true,
  body: { label: "Already ended hold", kind: "school_program", startDate: today, endDate: today, start: "00:00", end: "00:01", courts: [6], weekdays: [todayWeekday] }
});
assert.equal(result.response.status, 400);
assert.equal(result.data.error, "past_schedule_block");
result = await call("/admin-api/closures", {
  method: "POST", admin: true,
  body: { title: "Already ended closure", reason: "Past-time guard", startDate: today, endDate: today, start: "00:00", end: "00:01", courts: [6] }
});
assert.equal(result.response.status, 400);
assert.equal(result.data.error, "past_schedule_block");
passed("Past schedule blocks and weekday/date combinations that can never occur are rejected");

const requestDate = addDaysKey(target, 3);
const immediatePriorityBooking = await createBooking("browser_priority_displaced", requestDate, 6, 540, 60);
assert.equal(immediatePriorityBooking.response.status, 201);
result = await call("/api/priority-requests", {
  method: "POST", client: "browser_public_priority",
  body: { label: "Saturday Clinic", kind: "clinic", organizer: "Coach Test", startDate: requestDate, endDate: requestDate, start: "09:00", end: "10:00", courts: [6], weekdays: [String(new Date(`${requestDate}T12:00:00Z`).getUTCDay())] }
});
assert.equal(result.response.status, 201);
assert.equal(result.data.status, "active");
assert.equal(result.data.affectedCount, 1);
const requestId = result.data.id;
const immediateHoldId = result.data.holdId;
result = await call("/api/my-bookings", { client: "browser_priority_displaced" });
assert.equal(result.data.bookings.find((booking) => booking.id === immediatePriorityBooking.data.booking.id).status, "canceled");
const displacedDailySlot = await env.DB.prepare("SELECT booking_id FROM client_booking_slots WHERE booking_id = ?").bind(immediatePriorityBooking.data.booking.id).first();
assert.equal(displacedDailySlot, null);
result = await call(`/api/schedule?date=${requestDate}`, { client: "browser_client_other" });
assert.equal(result.data.priorityHolds.some((hold) => hold.name === "Saturday Clinic"), true);
result = await call("/api/priority-requests", {
  method: "POST", client: "browser_public_priority",
  body: { label: "Saturday Clinic", kind: "clinic", organizer: "Coach Test", startDate: requestDate, endDate: requestDate, start: "09:00", end: "10:00", courts: [6], weekdays: [String(new Date(`${requestDate}T12:00:00Z`).getUTCDay())] }
});
assert.equal(result.response.status, 200);
assert.equal(result.data.id, requestId);
assert.equal(result.data.duplicate, true);
result = await call(`/admin-api/priority-requests/${requestId}`, { method: "PATCH", admin: true, body: { status: "approved", notes: "Confirmed by school contact" } });
assert.equal(result.response.status, 409);
result = await call(`/admin-api/priority-holds/${immediateHoldId}`, { method: "DELETE", admin: true });
assert.equal(result.response.status, 200);
result = await call(`/api/schedule?date=${requestDate}`, { client: "browser_client_other" });
assert.equal(result.data.priorityHolds.some((hold) => hold.name === "Saturday Clinic"), false);
passed("Public priority submissions activate immediately without approval, deduplicate safely, and remain removable by an administrator");

const recoveryDate = addDaysKey(target, 12);
const recoveryWeekday = String(new Date(`${recoveryDate}T12:00:00Z`).getUTCDay());
const recoveryRequestId = "deadbeef-dead-beef-dead-beefdeadbeef";
await env.DB.prepare(`INSERT INTO priority_requests
  (id, type, activity_kind, program_name, instructor_name, email, listing_url, start_date, end_date, start_time, end_time, court_selection, weekdays, status, submitted_at)
  VALUES (?, 'activity', 'school_program', 'Recovery Program', 'Recovery Coach', 'recovery@example.com', '', ?, ?, '15:00', '16:00', '6', ?, 'pending', ?)`)
  .bind(recoveryRequestId, recoveryDate, recoveryDate, recoveryWeekday, new Date().toISOString()).run();
await env.DB.prepare(`INSERT INTO priority_holds
  (id, source_request_id, label, activity_kind, start_date, end_date, start_time, end_time, courts, weekdays, status, created_by, created_at)
  VALUES ('recovery-source-hold', ?, 'Recovery Program', 'school_program', ?, ?, '15:00', '16:00', '6', ?, 'active', 'admin@example.com', ?)`)
  .bind(recoveryRequestId, recoveryDate, recoveryDate, recoveryWeekday, new Date().toISOString()).run();
result = await call(`/admin-api/priority-requests/${recoveryRequestId}`, { method: "PATCH", admin: true, body: { status: "approved", notes: "Recover prior completed hold creation" } });
assert.equal(result.response.status, 200);
result = await call("/admin-api/priority-holds", { admin: true });
assert.equal(result.data.holds.filter((hold) => hold.source_request_id === recoveryRequestId).length, 1);
passed("Legacy pending priority approvals safely recover if hold creation had already completed");

const collisionDate = addDaysKey(target, 8);
const existingCourtTwo = await createBooking("browser_existing_two", collisionDate, 2, 600, 60);
const existingCourtThree = await createBooking("browser_existing_three", collisionDate, 3, 570, 60);
const bookingToMove = await createBooking("browser_move_safely", collisionDate, 1, 600, 60);
assert.equal(existingCourtTwo.response.status, 201);
assert.equal(existingCourtThree.response.status, 201);
assert.equal(bookingToMove.response.status, 201);
result = await call(`/api/schedule?date=${collisionDate}`, { client: "browser_observer" });
const existingBeforeMove = result.data.bookings
  .filter((booking) => [existingCourtTwo.data.booking.id, existingCourtThree.data.booking.id].includes(booking.id))
  .map(({ id, court, start, duration, status }) => ({ id, court, start, duration, status }))
  .sort((left, right) => left.id.localeCompare(right.id));

result = await call("/admin-api/closures", {
  method: "POST", admin: true,
  body: { title: "Court 1 repair", reason: "Collision safety test", startDate: collisionDate, endDate: collisionDate, start: "10:00", end: "11:00", courts: [1] }
});
assert.equal(result.response.status, 201);
assert.equal(result.data.rebookedCount, 1);
result = await call("/api/my-bookings", { client: "browser_move_safely" });
const movedOriginal = result.data.bookings.find((booking) => booking.id === bookingToMove.data.booking.id);
assert.equal(movedOriginal.replacementBooking.court, 4);
assert.equal(movedOriginal.replacementBooking.start, 10);

result = await call(`/api/schedule?date=${collisionDate}`, { client: "browser_observer" });
const existingAfterMove = result.data.bookings
  .filter((booking) => [existingCourtTwo.data.booking.id, existingCourtThree.data.booking.id].includes(booking.id))
  .map(({ id, court, start, duration, status }) => ({ id, court, start, duration, status }))
  .sort((left, right) => left.id.localeCompare(right.id));
assert.deepEqual(existingAfterMove, existingBeforeMove);
const activeOnCollisionDate = result.data.bookings;
for (let left = 0; left < activeOnCollisionDate.length; left += 1) {
  for (let right = left + 1; right < activeOnCollisionDate.length; right += 1) {
    const a = activeOnCollisionDate[left];
    const b = activeOnCollisionDate[right];
    if (a.court !== b.court) continue;
    assert.equal(a.start < b.start + b.duration && a.start + a.duration > b.start, false);
  }
}
passed("Automatic replacement skips occupied alternatives and leaves every existing booking unchanged");

const chainDate = addDaysKey(target, 11);
const chainOriginal = await createBooking("browser_replacement_chain", chainDate, 1, 600, 60);
assert.equal(chainOriginal.response.status, 201);
result = await call("/admin-api/closures", {
  method: "POST", admin: true,
  body: { title: "Chain repair one", reason: "First replacement-chain test", startDate: chainDate, endDate: chainDate, start: "10:00", end: "11:00", courts: [1] }
});
assert.equal(result.data.rebookedCount, 1);
result = await call("/api/my-bookings", { client: "browser_replacement_chain" });
let chainRoot = result.data.bookings.find((booking) => booking.id === chainOriginal.data.booking.id);
const firstChainReplacementId = chainRoot.replacementBooking.id;
assert.equal(chainRoot.replacementBooking.court, 2);
result = await call("/admin-api/closures", {
  method: "POST", admin: true,
  body: { title: "Chain repair two", reason: "Second replacement-chain test", startDate: chainDate, endDate: chainDate, start: "10:00", end: "11:00", courts: [2] }
});
assert.equal(result.data.rebookedCount, 1);
result = await call("/api/my-bookings", { client: "browser_replacement_chain" });
chainRoot = result.data.bookings.find((booking) => booking.id === chainOriginal.data.booking.id);
const firstChainReplacement = result.data.bookings.find((booking) => booking.id === firstChainReplacementId);
const finalChainReplacement = result.data.bookings.find((booking) => booking.id === chainRoot.replacementBooking.id);
assert.equal(chainRoot.replacementBooking.court, 3);
assert.equal(firstChainReplacement.status, "canceled");
assert.equal(finalChainReplacement.status, "active");
assert.equal(finalChainReplacement.rebookedFromId, chainOriginal.data.booking.id);
passed("Repeated displacement keeps the original notice linked to the latest valid replacement");

const statusDate = addDaysKey(today, 75);
const statusBooking = await createBooking("browser_status_player", statusDate, 2, 1260, 30);
assert.equal(statusBooking.response.status, 201);
result = await call("/api/court-status", {
  method: "POST", client: "browser_status_reporter",
  body: { action: "down", courts: [2, 5], reason: "Standing water covers the court" }
});
assert.equal(result.response.status, 201);
assert.equal(result.data.affectedCount >= 1, true);
result = await call("/api/court-status", { client: "browser_status_observer" });
assert.deepEqual(result.data.courts.filter((item) => item.status === "down").map((item) => item.court), [2, 5]);
result = await call(`/api/schedule?date=${statusDate}`, { client: "browser_status_observer" });
assert.deepEqual(result.data.closures.filter((item) => item.communityStatus).map((item) => item.court), [2, 5]);
result = await createBooking("browser_status_blocked", statusDate, 2, 1290, 30);
assert.equal(result.response.status, 409);
assert.equal(result.data.error, "schedule_blocked");
result = await call("/api/my-bookings", { client: "browser_status_player" });
assert.equal(result.data.bookings.find((item) => item.id === statusBooking.data.booking.id).status, "canceled");
const canceledStatusSlot = await env.DB.prepare("SELECT booking_id FROM client_booking_slots WHERE booking_id = ?").bind(statusBooking.data.booking.id).first();
assert.equal(canceledStatusSlot, null);
passed("A public down report is shared across browsers, blocks future booking, and frees an affected booking slot");

for (let index = 0; index < 3; index += 1) {
  result = await call("/api/court-status", {
    method: "POST", client: `browser_status_repeat_${index}`,
    body: { action: "down", courts: [2], reason: `Community confirmation ${index + 1}` }
  });
  assert.equal(result.response.status, 201);
}
result = await call("/api/court-status", {
  method: "POST", client: "browser_status_reopener",
  body: { action: "open", courts: [2, 5], reason: "Courts are dry" }
});
assert.equal(result.response.status, 201);
result = await call("/api/court-status", { client: "browser_status_observer" });
assert.equal(result.data.courts.every((item) => item.status === "open"), true);
result = await createBooking("browser_status_after_open", statusDate, 2, 1320, 30);
assert.equal(result.response.status, 201);
passed("Community members can report repeatedly and a different browser can reopen courts immediately");

result = await call("/api/court-status", {
  method: "POST", client: "browser_status_facility",
  body: { action: "down", courts: "all", reason: "Facility is temporarily unavailable" }
});
assert.equal(result.response.status, 201);
result = await call("/api/court-status", { client: "browser_status_observer" });
assert.equal(result.data.courts.filter((item) => item.status === "down").length, 6);
result = await createBooking("browser_status_facility_blocked", addDaysKey(statusDate, 1), 6, 600, 30);
assert.equal(result.response.status, 409);
result = await call("/api/court-status", { method: "POST", client: "browser_status_facility_open", body: { action: "open", courts: "all" } });
assert.equal(result.response.status, 201);
const postStatusLiveBooking = await createBooking("browser_status_live_preserve", target, 6, 1380, 30);
assert.equal(postStatusLiveBooking.response.status, 201);
passed("The public can mark the entire facility down or open without approval or an end date");

result = await call("/admin-api/court-status", { method: "POST", admin: true, body: { action: "down", courts: [4], reason: "Admin inspection" } });
assert.equal(result.response.status, 201);
const adminStatusReportId = result.data.eventIds[0];
result = await call("/admin-api/court-status", { admin: true });
assert.equal(result.data.courts.find((item) => item.court === 4).status, "down");
assert.equal(result.data.history.some((item) => item.id === adminStatusReportId), true);
result = await call(`/admin-api/court-status-reports/${adminStatusReportId}`, { method: "DELETE", admin: true });
assert.equal(result.response.status, 200);
result = await call("/admin-api/court-status", { admin: true });
assert.equal(result.data.courts.find((item) => item.court === 4).status, "open");
assert.equal(result.data.history.some((item) => item.id === adminStatusReportId), false);
passed("Admins can override current status and manually delete any individual status report");

await env.DB.prepare("UPDATE court_status_events SET delete_after = '2000-01-01T00:00:00.000Z' WHERE delete_after IS NOT NULL").run();
await env.DB.prepare("UPDATE court_status SET delete_after = '2000-01-01T00:00:00.000Z' WHERE status = 'open'").run();
result = await call("/admin-api/housekeeping", { method: "POST", admin: true, body: { action: "safe_cleanup" } });
assert.equal(result.response.status, 200);
result = await call("/admin-api/court-status", { admin: true });
assert.equal(result.data.history.length, 0);
assert.equal(result.data.courts.every((item) => item.status === "open"), true);
passed("Resolved court-status history and open markers are automatically deleted after their retention deadline");

result = await call("/admin-api/affected", { admin: true });
assert.equal(result.response.status, 200);
assert.equal(result.data.bookings.length >= 2, true);
assert.equal("emailNotificationsActive" in result.data, false);
assert.equal("emailTodo" in result.data, false);
passed("Admin affected-bookings list is shared without unused email-notification fields");

result = await call("/admin-api/debug", { admin: true });
assert.equal(Object.values(result.data.integrity).every((value) => value === 0), true);
passed("Admin diagnostics report healthy court-slot and daily-limit storage indexes");

const yesterday = addDaysKey(today, -1);
await env.DB.prepare(`INSERT INTO priority_holds
  (id, source_request_id, label, activity_kind, start_date, end_date, start_time, end_time, courts, weekdays, status, created_by, created_at)
  VALUES ('expired-test-hold', NULL, 'Past practice', 'chs_practice', ?, ?, '08:00', '09:00', '1', '0,1,2,3,4,5,6', 'active', 'admin@example.com', ?)`)
  .bind(yesterday, yesterday, new Date().toISOString()).run();
await env.DB.prepare(`INSERT INTO maintenance_closures
  (id, title, reason, start_date, end_date, start_time, end_time, courts, status, created_by, created_at)
  VALUES ('expired-test-closure', 'Past repair', 'Completed repair', ?, ?, '08:00', '09:00', '2', 'active', 'admin@example.com', ?)`)
  .bind(yesterday, yesterday, new Date().toISOString()).run();
await env.DB.prepare("INSERT INTO audit_log (entity_type, entity_id, actor_email, action, details, created_at) VALUES ('test','old','admin@example.com','old_action','old','2000-01-01T00:00:00.000Z')").run();

result = await call("/admin-api/housekeeping", { method: "POST", admin: true, body: { action: "safe_cleanup" } });
assert.equal(result.response.status, 200);
assert.equal(result.data.retention.bookingHistoryDays, 90);
result = await call("/admin-api/priority-holds", { admin: true });
assert.equal(result.data.holds.find((item) => item.id === "expired-test-hold").status, "expired");
assert.equal(result.data.holds.some((item) => item.status === "active"), true);
result = await call("/admin-api/closures", { admin: true });
assert.equal(result.data.closures.find((item) => item.id === "expired-test-closure").status, "expired");
assert.equal(result.data.closures.some((item) => item.status === "active"), true);
result = await call("/admin-api/audit", { admin: true });
assert.equal(result.data.audit.some((item) => item.action === "old_action"), false);
passed("Automatic housekeeping expires past calendars and purges old activity while preserving future active blocks");

result = await call("/admin-api/housekeeping", { method: "POST", admin: true, body: { action: "clear_calendar_history" } });
assert.equal(result.response.status, 200);
result = await call("/admin-api/priority-holds", { admin: true });
assert.equal(result.data.holds.some((item) => item.id === "expired-test-hold"), false);
assert.equal(result.data.holds.some((item) => item.status === "active"), true);
result = await call("/admin-api/closures", { admin: true });
assert.equal(result.data.closures.some((item) => item.id === "expired-test-closure"), false);
assert.equal(result.data.closures.some((item) => item.status === "active"), true);
passed("Manual calendar cleanup deletes only expired/removed holds and closures");

result = await call("/admin-api/housekeeping", { method: "POST", admin: true, body: { action: "clear_affected_history" } });
assert.equal(result.response.status, 200);
result = await call("/admin-api/affected", { admin: true });
assert.equal(result.data.bookings.length, 0);
result = await call(`/api/schedule?date=${target}`, { client: "browser_client_a" });
assert.equal(result.data.bookings.length > 0, true);
passed("Manual affected-history reset preserves live shared bookings");

result = await call("/admin-api/housekeeping", { method: "POST", admin: true, body: { action: "clear_recent_activity" } });
assert.equal(result.response.status, 200);
result = await call("/admin-api/audit", { admin: true });
assert.equal(result.data.audit.length, 1);
assert.equal(result.data.audit[0].action, "activity_history_reset");
passed("Recent admin activity can be reset with one transparent reset marker");

const archivedBookingDate = addDaysKey(target, 5);
const archivedBooking = await createBooking("browser_client_archive", archivedBookingDate, 6, 1080, 30);
assert.equal(archivedBooking.response.status, 201);
await call(`/api/bookings/${archivedBooking.data.booking.id}`, { method: "DELETE", client: "browser_client_archive" });
result = await call("/admin-api/housekeeping", { method: "POST", admin: true, body: { action: "clear_archived_storage" } });
assert.equal(result.response.status, 200);
result = await call("/api/my-bookings", { client: "browser_client_archive" });
assert.equal(result.data.bookings.length, 0);
result = await call(`/api/schedule?date=${target}`, { client: "browser_client_a" });
assert.equal(result.data.bookings.length > 0, true);
result = await call("/admin-api/priority-holds", { admin: true });
assert.equal(result.data.holds.some((item) => item.status === "active"), true);
passed("Archived shared storage can be reset without deleting active bookings or future holds");

console.log(`PASS ${results.length}/${results.length} integration checks`);
for (const name of results) console.log(`✓ ${name}`);
