const adminState = {
  session: null,
  bookings: [],
  affected: [],
  requests: [],
  holds: [],
  closures: [],
  courtStatus: [],
  courtStatusHistory: [],
  settings: {},
  audit: [],
  debug: null
};
const ADMIN_LIVE_SYNC_INTERVAL_MS = 15000;
let adminRefreshPromise = null;
let adminPollTimer = null;

const $ = (id) => document.getElementById(id);

function escapeHtml(value = "") {
  const node = document.createElement("div");
  node.textContent = String(value);
  return node.innerHTML;
}

function dateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(`${value}T12:00:00`));
}

function formatDateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatTime(value) {
  if (!value) return "—";
  const [hour, minute] = value.split(":").map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
}

function courtsLabel(value) {
  return value === "all" ? "All 6 courts" : `Court${String(value).includes(",") ? "s" : ""} ${String(value).split(",").join(", ")}`;
}

function kindLabel(value) {
  return ({
    chs_practice: "CHS Tennis Practice",
    chs_match: "CHS Tennis Match",
    clinic: "Clinic",
    tournament: "Tournament",
    school_program: "School Program",
    other: "Other"
  })[value] || value || "Priority activity";
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");
  if (options.body) headers.set("Content-Type", "application/json");
  let response;
  try { response = await fetch(path, { ...options, cache: "no-store", headers }); } catch (_) { throw Object.assign(new Error("The admin service could not be reached."), { status: 503 }); }
  let data = {};
  try { data = await response.json(); } catch (_) { /* handled below */ }
  if (!response.ok) {
    const error = new Error(data.message || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = data.error;
    if (response.status === 401) window.location.replace("/admin-login");
    throw error;
  }
  return data;
}

function showAlert(title, message) {
  $("adminAlertTitle").textContent = title;
  $("adminAlertMessage").textContent = message;
  $("adminAlert").hidden = false;
}

function hideAlert() {
  $("adminAlert").hidden = true;
}

function showToast(title, message) {
  $("adminToastTitle").textContent = title;
  $("adminToastMessage").textContent = message;
  $("adminToast").classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => $("adminToast").classList.remove("show"), 5200);
}

function renderSession() {
  if (!adminState.session) return;
  $("adminEmail").textContent = adminState.session.email;
  const role = adminState.session.role === "admin" ? "Primary administrator" : "Authorized editor";
  $("adminRole").textContent = `${role} · ${adminState.session.authMode === "temporary_password" ? "temporary password login" : "Cloudflare Access"}`;
  if (adminState.session.logoutUrl) {
    $("logoutLink").href = adminState.session.logoutUrl;
    $("logoutLink").hidden = false;
  }
  const primary = adminState.session.role === "admin";
  document.querySelectorAll("[data-cleanup-action]").forEach((button) => {
    if (button.dataset.cleanupAction === "safe_cleanup") return;
    button.disabled = !primary;
    button.title = primary ? "" : "Only the primary administrator can permanently clear stored history.";
  });
}

function renderStats() {
  $("activeBookingsStat").textContent = adminState.bookings.filter((item) => item.status === "active").length;
  $("pendingRequestsStat").textContent = adminState.requests.length;
  $("activeClosuresStat").textContent = adminState.closures.filter((item) => item.status === "active").length;
  $("courtsDownStat").textContent = adminState.courtStatus.filter((item) => item.status === "down").length;
  $("affectedBookingsStat").textContent = adminState.affected.length;
}

function renderBookings() {
  const list = $("bookingList");
  if (!adminState.bookings.length) {
    list.innerHTML = '<p class="admin-empty">No bookings in this date range.</p>';
    return;
  }
  list.innerHTML = adminState.bookings.map((booking) => `
    <article class="data-row ${escapeHtml(booking.status)}">
      <div>
        <strong>${escapeHtml(booking.name)} · Court ${escapeHtml(booking.court)}</strong>
        <span>${escapeHtml(formatDate(booking.booking_date))} · ${escapeHtml(formatTime(booking.start_time))}–${escapeHtml(formatTime(booking.end_time))}</span>
        <small>${escapeHtml(booking.status)}${booking.cancellation_reason ? ` · ${escapeHtml(booking.cancellation_reason)}` : ""}</small>
      </div>
      ${booking.status === "active" ? `<button class="small-danger" type="button" data-cancel-booking="${escapeHtml(booking.id)}">Admin cancel</button>` : ""}
    </article>
  `).join("");
  list.querySelectorAll("[data-cancel-booking]").forEach((button) => button.addEventListener("click", () => cancelBookingAsAdmin(button.dataset.cancelBooking)));
}

async function cancelBookingAsAdmin(id) {
  const reason = window.prompt("Reason shown to the affected player (required):", "Rare scheduling exception");
  if (!reason || reason.trim().length < 3) return;
  try {
    await api(`/admin-api/bookings/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ reason: reason.trim() }) });
    showToast("Booking canceled", "The court slot and the player's daily booking slot were released.");
    await loadAdminData();
  } catch (error) {
    showToast("Could not cancel booking", error.message);
  }
}

function renderAffected() {
  const list = $("affectedList");
  if (!adminState.affected.length) {
    list.innerHTML = '<p class="admin-empty">No affected bookings in the last 90 days.</p>';
    return;
  }
  list.innerHTML = adminState.affected.map((booking) => `
    <article class="data-row affected">
      <div>
        <strong>${escapeHtml(booking.name)} · Court ${escapeHtml(booking.court)}</strong>
        <span>${escapeHtml(formatDate(booking.booking_date))} · ${escapeHtml(formatTime(booking.start_time))}–${escapeHtml(formatTime(booking.end_time))}</span>
        <small>${escapeHtml(booking.cancellation_reason || "Affected by schedule change")}</small>
        ${booking.replacement_booking_id && booking.replacement_status === "active" ? `<small><strong>Automatic replacement:</strong> Court ${escapeHtml(booking.replacement_court)} · ${escapeHtml(formatDate(booking.replacement_date))} · ${escapeHtml(formatTime(booking.replacement_start_time))}–${escapeHtml(formatTime(booking.replacement_end_time))}</small>` : "<small>No similar same-day opening was available; the player can choose another time from the public calendar.</small>"}
      </div>
      <span class="status-pill canceled">Canceled</span>
    </article>
  `).join("");
}

function renderRequests() {
  const list = $("requestList");
  if (!adminState.requests.length) {
    list.innerHTML = '<p class="admin-empty">No priority requests yet.</p>';
    return;
  }
  list.innerHTML = adminState.requests.map((request) => `
    <article class="request-card ${escapeHtml(request.status)}" data-request-id="${escapeHtml(request.id)}">
      <div>
        <div class="request-meta"><span class="request-type">${escapeHtml(kindLabel(request.activity_kind))}</span><span>${escapeHtml(request.status)}</span><span>Submitted ${escapeHtml(formatDateTime(request.submitted_at))}</span></div>
        <h3>${escapeHtml(request.program_name)}</h3>
        <p><strong>Organizer:</strong> ${escapeHtml(request.instructor_name)}</p>
        <p><strong>Requested:</strong> ${escapeHtml(formatDate(request.start_date))}–${escapeHtml(formatDate(request.end_date))}, ${escapeHtml(formatTime(request.start_time))}–${escapeHtml(formatTime(request.end_time))}</p>
        <p><strong>Coverage:</strong> ${escapeHtml(courtsLabel(request.court_selection))} · weekdays ${escapeHtml(request.weekdays)}</p>
        ${request.listing_url ? `<p><a href="${escapeHtml(request.listing_url)}" target="_blank" rel="noreferrer">Open organizer-provided listing ↗</a></p>` : "<p>No public listing provided.</p>"}
        ${request.reviewer_email ? `<p class="reviewed-by">Reviewed by ${escapeHtml(request.reviewer_email)} on ${escapeHtml(formatDateTime(request.reviewed_at))} · ${escapeHtml(request.reviewer_notes || "")}</p>` : ""}
      </div>
      ${request.status === "pending" ? `<div class="request-review"><label><span class="visually-hidden">Review notes</span><textarea data-review-notes placeholder="Record why this is approved or rejected…"></textarea></label><div class="review-actions"><button class="approve-button" type="button" data-review-action="approved">Approve & create hold</button><button class="reject-button" type="button" data-review-action="rejected">Reject request</button></div></div>` : `<span class="status-pill ${escapeHtml(request.status)}">${escapeHtml(request.status)}</span>`}
    </article>
  `).join("");
  list.querySelectorAll("[data-review-action]").forEach((button) => button.addEventListener("click", () => reviewRequest(button)));
}

async function reviewRequest(button) {
  const card = button.closest("[data-request-id]");
  const notes = card.querySelector("[data-review-notes]").value.trim();
  if (notes.length < 3) {
    showToast("Add review notes", "Briefly record why the request is being approved or rejected.");
    return;
  }
  card.querySelectorAll("button").forEach((item) => { item.disabled = true; });
  try {
    const data = await api(`/admin-api/priority-requests/${encodeURIComponent(card.dataset.requestId)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: button.dataset.reviewAction, notes })
    });
    const replacementCopy = data.rebookedCount ? ` ${data.rebookedCount} received an automatic similar-time replacement.` : "";
    showToast(button.dataset.reviewAction === "approved" ? "Priority hold created" : "Request rejected", data.affectedCount ? `${data.affectedCount} conflicting booking(s) were moved to the affected list.${replacementCopy}` : "The decision was recorded in the audit trail.");
    await loadAdminData();
  } catch (error) {
    showToast("Could not save decision", error.message);
  } finally {
    card.querySelectorAll("button").forEach((item) => { item.disabled = false; });
  }
}

function renderCourtStatusAdmin() {
  const currentList = $("adminCurrentStatusList");
  currentList.innerHTML = adminState.courtStatus.map((item) => `
    <article class="admin-status-card ${escapeHtml(item.status)}">
      <div><strong>Court ${escapeHtml(item.court)}</strong><span>${item.status === "down" ? "Unavailable" : "Open"}</span>${item.reason ? `<small>${escapeHtml(item.reason)}</small>` : ""}${item.updatedAt ? `<time datetime="${escapeHtml(item.updatedAt)}">${escapeHtml(formatDateTime(item.updatedAt))}</time>` : ""}</div>
      <button type="button" data-status-court="${escapeHtml(item.court)}" data-status-action="${item.status === "down" ? "open" : "down"}">${item.status === "down" ? "Mark open" : "Mark down"}</button>
    </article>
  `).join("");
  currentList.querySelectorAll("[data-status-court]").forEach((button) => button.addEventListener("click", () => quickCourtStatus(button)));

  const historyList = $("courtStatusHistoryList");
  if (!adminState.courtStatusHistory.length) {
    historyList.innerHTML = '<p class="admin-empty">No recent court status reports.</p>';
    return;
  }
  historyList.innerHTML = adminState.courtStatusHistory.map((item) => `
    <article class="status-history-row ${escapeHtml(item.action)}">
      <div><strong>Court ${escapeHtml(item.court)} marked ${item.action === "down" ? "down" : "open"}</strong><span>${escapeHtml(item.reason)}</span><small>${item.source_type === "public" ? "Public report" : "Admin update"} · ${escapeHtml(formatDateTime(item.created_at))}</small></div>
      <button type="button" data-delete-status-report="${escapeHtml(item.id)}">Delete report</button>
    </article>
  `).join("");
  historyList.querySelectorAll("[data-delete-status-report]").forEach((button) => button.addEventListener("click", () => deleteCourtStatusReport(button.dataset.deleteStatusReport)));
}

async function setCourtStatus(payload, successTitle = "Court status updated") {
  const data = await api("/admin-api/court-status", { method: "POST", body: JSON.stringify(payload) });
  const affectedCopy = data.affectedCount ? ` ${data.affectedCount} booking(s) were affected${data.rebookedCount ? ` and ${data.rebookedCount} received a similar-time replacement` : ""}.` : "";
  showToast(successTitle, `The shared calendar updated immediately.${affectedCopy}`);
  await loadAdminData();
}

async function quickCourtStatus(button) {
  const action = button.dataset.statusAction;
  button.disabled = true;
  try {
    await setCourtStatus({ action, courts: [Number(button.dataset.statusCourt)], reason: action === "down" ? "Admin marked unavailable" : "Admin marked open" }, action === "down" ? "Court marked down" : "Court marked open");
  } catch (error) {
    showToast("Could not update court status", error.message);
  } finally {
    button.disabled = false;
  }
}

async function deleteCourtStatusReport(id) {
  if (!window.confirm("Delete this status report? If it is the current report, the court will return to its previous unresolved status or open.")) return;
  try {
    await api(`/admin-api/court-status-reports/${encodeURIComponent(id)}`, { method: "DELETE" });
    showToast("Status report deleted", "The current court status was recalculated from the remaining reports.");
    await loadAdminData();
  } catch (error) {
    showToast("Could not delete status report", error.message);
  }
}

function renderClosures() {
  const list = $("closureList");
  if (!adminState.closures.length) {
    list.innerHTML = '<p class="admin-empty">No maintenance closures.</p>';
    return;
  }
  list.innerHTML = adminState.closures.map((item) => `
    <article class="compact-card ${escapeHtml(item.status)}">
      <strong>${escapeHtml(item.title)}</strong>
      <span>${escapeHtml(formatDate(item.start_date))}–${escapeHtml(formatDate(item.end_date))} · ${escapeHtml(formatTime(item.start_time))}–${escapeHtml(formatTime(item.end_time))}</span>
      <small>${escapeHtml(courtsLabel(item.courts))} · ${escapeHtml(item.reason)} · ${escapeHtml(item.status)}</small>
      <small>${item.source_type === "public" ? `Public report${item.creator_name ? ` · ${escapeHtml(item.creator_name)}` : ""}` : `Admin-created · ${escapeHtml(item.created_by || "administrator")}`}</small>
      ${item.status === "active" ? `<button type="button" data-remove-closure="${escapeHtml(item.id)}">Remove closure</button>` : ""}
    </article>
  `).join("");
  list.querySelectorAll("[data-remove-closure]").forEach((button) => button.addEventListener("click", () => removeItem("closures", button.dataset.removeClosure)));
}

function renderHolds() {
  const list = $("holdList");
  if (!adminState.holds.length) {
    list.innerHTML = '<p class="admin-empty">No priority holds.</p>';
    return;
  }
  list.innerHTML = adminState.holds.map((item) => `
    <article class="compact-card ${escapeHtml(item.status)}">
      <strong>${escapeHtml(item.label)}</strong>
      <span>${escapeHtml(formatDate(item.start_date))}–${escapeHtml(formatDate(item.end_date))} · ${escapeHtml(formatTime(item.start_time))}–${escapeHtml(formatTime(item.end_time))}</span>
      <small>${escapeHtml(kindLabel(item.activity_kind))} · ${escapeHtml(courtsLabel(item.courts))} · weekdays ${escapeHtml(item.weekdays)} · ${escapeHtml(item.status)}</small>
      <small>${item.source_type === "public" ? "Public honor-system submission" : `Admin-created · ${escapeHtml(item.created_by || "administrator")}`}</small>
      ${item.status === "active" ? `<button type="button" data-remove-hold="${escapeHtml(item.id)}">Remove hold</button>` : ""}
    </article>
  `).join("");
  list.querySelectorAll("[data-remove-hold]").forEach((button) => button.addEventListener("click", () => removeItem("priority-holds", button.dataset.removeHold)));
}

async function removeItem(endpoint, id) {
  try {
    await api(`/admin-api/${endpoint}/${encodeURIComponent(id)}`, { method: "DELETE" });
    showToast("Schedule block removed", "Previously affected bookings remain canceled and visible in the affected list.");
    await loadAdminData();
  } catch (error) {
    showToast("Could not remove schedule block", error.message);
  }
}

function renderSettings() {
  $("publicBookingDays").value = adminState.settings.public_booking_days || "180";
  $("priorityBookingDays").value = adminState.settings.priority_booking_days || "365";
  const max = dateInputValue(addDays(new Date(), Number(adminState.settings.priority_booking_days || 365)));
  ["closureStartDate", "closureEndDate", "holdStartDate", "holdEndDate"].forEach((id) => {
    $(id).min = dateInputValue(new Date());
    $(id).max = max;
  });
}

function renderDebug() {
  if (!adminState.debug) return;
  const counts = adminState.debug.counts || {};
  const integrity = adminState.debug.integrity || {};
  const integrityIssues = Object.values(integrity).reduce((total, value) => total + Number(value || 0), 0);
  $("debugBox").innerHTML = `
    <strong>Database: ${escapeHtml(adminState.debug.database)}</strong>
    <span>Booking rows: ${escapeHtml(counts.bookings || 0)}</span>
    <span>Priority requests: ${escapeHtml(counts.priority_requests || 0)}</span>
    <span>Priority holds: ${escapeHtml(counts.priority_holds || 0)}</span>
    <span>Maintenance closures: ${escapeHtml(counts.maintenance_closures || 0)}</span>
    <span>Current court statuses: ${escapeHtml(counts.court_status || 0)}</span>
    <span>Court status reports: ${escapeHtml(counts.court_status_events || 0)}</span>
    <span>Reserved court slots: ${escapeHtml(counts.booking_slots || 0)}</span>
    <span>Daily-limit slots: ${escapeHtml(counts.client_booking_slots || 0)}</span>
    <span>Admin activity rows: ${escapeHtml(counts.audit_log || 0)}</span>
    <span>Active login-throttle records: ${escapeHtml(counts.admin_login_attempts || 0)}</span>
    <span>Storage integrity: ${integrityIssues ? `${escapeHtml(integrityIssues)} issue(s) detected` : "healthy"}</span>
  `;
}

async function runCleanup(button) {
  const action = button.dataset.cleanupAction;
  const descriptions = {
    clear_affected_history: "Permanently delete all non-active affected-booking records?",
    clear_calendar_history: "Permanently delete expired and removed maintenance/priority calendar records?",
    clear_recent_activity: "Permanently clear the recent admin activity list? One reset marker will remain for transparency.",
    clear_archived_storage: "Permanently delete all archived shared data? Active bookings, future schedule blocks, pending requests, and settings will stay intact."
  };
  if (descriptions[action] && !window.confirm(descriptions[action])) return;
  const buttons = document.querySelectorAll("[data-cleanup-action]");
  buttons.forEach((item) => { item.disabled = true; });
  try {
    await api("/admin-api/housekeeping", { method: "POST", body: JSON.stringify({ action }) });
    showToast(action === "safe_cleanup" ? "Safe cleanup complete" : "Archived data cleared", "Active bookings and future scheduling data were preserved.");
    await loadAdminData();
  } catch (error) {
    showToast("Cleanup could not be completed", error.message);
  } finally {
    buttons.forEach((item) => { item.disabled = false; });
    renderSession();
  }
}

function renderAudit() {
  const list = $("auditList");
  if (!adminState.audit.length) {
    list.innerHTML = '<p class="admin-empty">No admin actions recorded yet.</p>';
    return;
  }
  list.innerHTML = adminState.audit.map((item) => `
    <article class="audit-item"><strong>${escapeHtml(item.actor_email)}</strong><span>${escapeHtml(String(item.action).replaceAll("_", " "))}${item.details ? ` · ${escapeHtml(item.details)}` : ""}</span><time datetime="${escapeHtml(item.created_at)}">${escapeHtml(formatDateTime(item.created_at))}</time></article>
  `).join("");
}

async function loadAdminDataOnce() {
  hideAlert();
  const from = $("bookingFrom").value;
  const to = $("bookingTo").value;
  try {
    const [session, bookings, affected, requests, holds, closures, courtStatusData, settings, audit, debug] = await Promise.all([
      api("/admin-api/session"),
      api(`/admin-api/bookings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
      api("/admin-api/affected"),
      api("/admin-api/priority-requests"),
      api("/admin-api/priority-holds"),
      api("/admin-api/closures"),
      api("/admin-api/court-status"),
      api("/admin-api/settings"),
      api("/admin-api/audit"),
      api("/admin-api/debug")
    ]);
    Object.assign(adminState, {
      session,
      bookings: bookings.bookings || [],
      affected: affected.bookings || [],
      requests: requests.requests || [],
      holds: holds.holds || [],
      closures: closures.closures || [],
      courtStatus: courtStatusData.courts || [],
      courtStatusHistory: courtStatusData.history || [],
      settings: settings.settings || {},
      audit: audit.audit || [],
      debug
    });
    renderSession();
    renderBookings();
    renderAffected();
    renderRequests();
    renderCourtStatusAdmin();
    renderClosures();
    renderHolds();
    renderSettings();
    renderDebug();
    renderAudit();
    renderStats();
  } catch (error) {
    showAlert(error.status === 503 ? "Shared database setup required" : "Secure Admin Portal access failed", error.message);
  }
}

async function loadAdminData() {
  if (adminRefreshPromise) return adminRefreshPromise;
  adminRefreshPromise = loadAdminDataOnce().finally(() => { adminRefreshPromise = null; });
  return adminRefreshPromise;
}

function adminCanLiveSync() {
  if (document.visibilityState !== "visible") return false;
  if (document.querySelector('.management-form[data-dirty="true"]')) return false;
  const active = document.activeElement;
  return !active || !active.matches("input, textarea, select");
}

function startAdminPolling() {
  clearInterval(adminPollTimer);
  adminPollTimer = setInterval(() => {
    if (adminCanLiveSync()) loadAdminData();
  }, ADMIN_LIVE_SYNC_INTERVAL_MS);
}

function selectedValues(fieldsetId) {
  const values = Array.from(document.querySelectorAll(`#${fieldsetId} input:checked`)).map((input) => input.value);
  if (values.includes("all")) return "all";
  return values;
}

function wireAllToggle(fieldsetId) {
  const fieldset = $(fieldsetId);
  fieldset.addEventListener("change", (event) => {
    if (event.target.value === "all" && event.target.checked) {
      fieldset.querySelectorAll('input:not([value="all"])').forEach((input) => { input.checked = false; });
    } else if (event.target.checked) {
      const all = fieldset.querySelector('input[value="all"]');
      if (all) all.checked = false;
    }
  });
}

$("courtStatusForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const action = $("adminCourtStatusAction").value;
  const reason = $("adminCourtStatusReason").value.trim();
  const courts = selectedValues("adminStatusCourts");
  const error = $("courtStatusError");
  error.textContent = "";
  if (!courts.length) {
    error.textContent = "Select at least one court.";
    return;
  }
  if (action === "down" && reason.length < 3) {
    error.textContent = "Briefly explain why the courts are unavailable.";
    return;
  }
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    await setCourtStatus({ action, courts, reason }, action === "down" ? "Courts marked down" : "Courts marked open");
    form.reset();
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    button.disabled = false;
  }
});

$("closureForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = {
    title: $("closureTitle").value.trim(),
    reason: $("closureReason").value.trim(),
    startDate: $("closureStartDate").value,
    endDate: $("closureEndDate").value,
    start: $("closureStartTime").value,
    end: $("closureEndTime").value,
    courts: selectedValues("closureCourts")
  };
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const data = await api("/admin-api/closures", { method: "POST", body: JSON.stringify(payload) });
    $("closureError").textContent = "";
    form.reset();
    $("closureStartDate").value = dateInputValue(new Date());
    $("closureEndDate").value = dateInputValue(new Date());
    $("closureStartTime").value = "00:00";
    $("closureEndTime").value = "23:59";
    const resultCopy = data.duplicate ? "That identical active closure already existed, so no duplicate was created." : !data.affectedCount ? "No player bookings were affected." : `${data.affectedCount} conflicting booking(s) were moved to the affected list.${data.rebookedCount ? ` ${data.rebookedCount} received an automatic similar-time replacement.` : " No similar-time replacement was available; affected players will see other-booking guidance."}`;
    showToast(data.duplicate ? "Closure already scheduled" : "Maintenance closure created", resultCopy);
    await loadAdminData();
  } catch (error) {
    $("closureError").textContent = error.message;
  } finally { button.disabled = false; }
});

$("holdForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = {
    label: $("holdLabel").value.trim(),
    kind: $("holdKind").value,
    startDate: $("holdStartDate").value,
    endDate: $("holdEndDate").value,
    start: $("holdStartTime").value,
    end: $("holdEndTime").value,
    courts: selectedValues("holdCourts"),
    weekdays: selectedValues("holdWeekdays")
  };
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const data = await api("/admin-api/priority-holds", { method: "POST", body: JSON.stringify(payload) });
    $("holdError").textContent = "";
    const resultCopy = data.duplicate ? "That identical active hold already existed, so no duplicate was created." : !data.affectedCount ? "No player bookings were affected." : `${data.affectedCount} conflicting booking(s) were moved to the affected list.${data.rebookedCount ? ` ${data.rebookedCount} received an automatic similar-time replacement.` : " No similar-time replacement was available; affected players will see other-booking guidance."}`;
    showToast(data.duplicate ? "Priority hold already scheduled" : "Priority hold created", resultCopy);
    await loadAdminData();
    form.dataset.dirty = "false";
  } catch (error) {
    $("holdError").textContent = error.message;
  } finally { button.disabled = false; }
});

$("settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = {
    public_booking_days: Number($("publicBookingDays").value),
    priority_booking_days: Number($("priorityBookingDays").value),
    reason: $("settingsReason").value.trim()
  };
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    await api("/admin-api/settings", { method: "PATCH", body: JSON.stringify(payload) });
    $("settingsError").textContent = "";
    $("settingsReason").value = "";
    showToast("Booking windows saved", "The public calendar now uses the shared configuration.");
    await loadAdminData();
    form.dataset.dirty = "false";
  } catch (error) {
    $("settingsError").textContent = error.message;
  } finally { button.disabled = false; }
});

const today = new Date();
$("bookingFrom").value = dateInputValue(today);
$("bookingTo").value = dateInputValue(addDays(today, 30));
$("closureStartDate").value = dateInputValue(today);
$("closureEndDate").value = dateInputValue(today);
$("holdStartDate").value = dateInputValue(addDays(today, 7));
$("holdEndDate").value = dateInputValue(addDays(today, 35));
wireAllToggle("closureCourts");
wireAllToggle("holdCourts");
wireAllToggle("adminStatusCourts");
document.querySelectorAll(".management-form").forEach((form) => {
  form.dataset.dirty = "false";
  const markDirty = () => { form.dataset.dirty = "true"; };
  form.addEventListener("input", markDirty);
  form.addEventListener("change", markDirty);
  form.addEventListener("reset", () => setTimeout(() => { form.dataset.dirty = "false"; }, 0));
});
$("refreshAdmin").addEventListener("click", loadAdminData);
document.querySelectorAll("[data-cleanup-action]").forEach((button) => button.addEventListener("click", () => runCleanup(button)));
$("adminToastClose").addEventListener("click", () => $("adminToast").classList.remove("show"));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") loadAdminData();
});
window.addEventListener("focus", () => loadAdminData());
window.addEventListener("online", () => loadAdminData());
loadAdminData();
startAdminPolling();
