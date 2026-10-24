const COURT_COUNT = 6;
const SLOT_HEIGHT = 58;
const MAX_BOOKING_MINUTES = 120;
const MAX_ACTIVE_BOOKINGS_PER_DAY = 2;
const DEFAULT_PUBLIC_BOOKING_DAYS = 180;
const DEFAULT_PRIORITY_BOOKING_DAYS = 365;
const LIVE_SYNC_INTERVAL_MS = 10000;
const CLIENT_ID_KEY = "chs-anonymous-client-id-v1";
const REMINDERS_KEY = "chs-booking-reminders-v2";
const AFFECTED_NOTICES_SEEN_KEY = "chs-affected-notices-seen-v1";
const CHELMSFORD_LATITUDE = 42.5998;
const CHELMSFORD_LONGITUDE = -71.3673;

const $ = (id) => document.getElementById(id);
const scheduleGrid = $("scheduleGrid");
const scheduleScroll = $("scheduleScroll");
const dateDisplay = $("dateDisplay");
const datePicker = $("datePicker");
const selectedDateLabel = $("selectedDateLabel");
const dateKicker = $("dateKicker");
const previousDayButton = $("previousDay");
const nextDayButton = $("nextDay");
const bookingDialog = $("bookingDialog");
const bookingForm = $("bookingForm");
const confirmBookingButton = $("confirmBookingButton");
const courtSelect = $("courtSelect");
const startTime = $("startTime");
const durationSelect = $("durationSelect");
const nameInput = $("bookerName");
const agreement = $("agreement");
const reminderOptIn = $("reminderOptIn");
const availabilityMessage = $("availabilityMessage");
const toast = $("toast");
const myBookingsPanel = $("myBookingsPanel");
const myBookingsList = $("myBookingsList");
const bookingHistoryPanel = $("bookingHistoryPanel");
const bookingHistoryList = $("bookingHistoryList");
const bookingHistoryCount = $("bookingHistoryCount");
const resetNoticesButton = $("resetNoticesButton");
const deleteHistoryButton = $("deleteHistoryButton");
const enablePingsButton = $("enablePingsButton");
const weatherAdvisory = $("weatherAdvisory");
const weatherIcon = $("weatherIcon");
const weatherTitle = $("weatherTitle");
const weatherMessage = $("weatherMessage");
const weatherMeta = $("weatherMeta");
const bookingWeatherAdvisory = $("bookingWeatherAdvisory");
const priorityDialog = $("priorityDialog");
const priorityForm = $("priorityForm");
const maintenanceDialog = $("maintenanceDialog");
const maintenanceForm = $("maintenanceForm");
const courtStatusPanel = $("courtStatusPanel");
const courtStatusList = $("courtStatusList");
const courtStatusCount = $("courtStatusCount");

let selectedDate = startOfDay(new Date());
let bookings = [];
let priorityHolds = [];
let closures = [];
let myBookings = [];
let courtStatus = Array.from({ length: COURT_COUNT }, (_, index) => ({ court: index + 1, status: "open", reason: "" }));
let settings = {
  public_booking_days: String(DEFAULT_PUBLIC_BOOKING_DAYS),
  priority_booking_days: String(DEFAULT_PRIORITY_BOOKING_DAYS)
};
let sharedServiceAvailable = false;
let scheduleRequest = 0;
let myBookingsRequest = 0;
let weatherCache = null;
let weatherRequest = null;
let pollTimer = null;
let refreshInFlight = null;
const pendingCancellations = new Set();
const clientId = getOrCreateClientId();

function safeStorageGet(key, fallback = "") {
  try { return localStorage.getItem(key) ?? fallback; } catch (_) { return fallback; }
}

function safeStorageSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch (_) { return false; }
}

function clientIdCookie() {
  try {
    const match = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("chs_client_id="));
    return match ? decodeURIComponent(match.slice("chs_client_id=".length)) : "";
  } catch (_) { return ""; }
}

function persistClientId(value) {
  safeStorageSet(CLIENT_ID_KEY, value);
  const secure = location.protocol === "https:" ? "; Secure" : "";
  try { document.cookie = `chs_client_id=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`; } catch (_) { /* Memory-only identity is the final fallback. */ }
}

function getOrCreateClientId() {
  let value = safeStorageGet(CLIENT_ID_KEY) || clientIdCookie();
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(value)) {
    value = `browser_${crypto.randomUUID().replace(/-/g, "")}`;
  }
  persistClientId(value);
  return value;
}

function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return startOfDay(copy);
}

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateKey(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(year, month - 1, day);
}

function daysFromToday(days) {
  return addDays(new Date(), Number(days));
}

function publicWindowEnd() {
  return daysFromToday(Number(settings.public_booking_days) || DEFAULT_PUBLIC_BOOKING_DAYS);
}

function visibleWindowEnd() {
  return daysFromToday(Number(settings.priority_booking_days) || DEFAULT_PRIORITY_BOOKING_DAYS);
}

function isOutsidePublicWindow(date = selectedDate) {
  return date < startOfDay(new Date()) || date > publicWindowEnd();
}

function clampVisibleDate(date) {
  const today = startOfDay(new Date());
  if (date < today) return today;
  if (date > visibleWindowEnd()) return visibleWindowEnd();
  return date;
}

function formatDate(date, options = { weekday: "long", month: "long", day: "numeric" }) {
  return new Intl.DateTimeFormat("en-US", options).format(date);
}

function formatTime(decimalHour) {
  const totalMinutes = Math.round(decimalHour * 60) % 1440;
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function overlaps(startA, durationA, startB, durationB) {
  return startA < startB + durationB && startA + durationA > startB;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");
  headers.set("X-CHS-Client-Id", clientId);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  let response;
  try {
    response = await fetch(path, { ...options, cache: "no-store", headers });
  } catch (_) {
    throw Object.assign(new Error("The shared booking service could not be reached."), { code: "service_unavailable" });
  }
  let data = {};
  try { data = await response.json(); } catch (_) { /* A non-JSON response is treated as unavailable. */ }
  if (!response.ok) {
    const error = new Error(data.message || "The shared booking request could not be completed.");
    error.code = data.error || "request_failed";
    error.status = response.status;
    throw error;
  }
  return data;
}

function setServiceStatus(available, message = "") {
  sharedServiceAvailable = available;
  const status = $("serviceStatus");
  status.className = `service-status ${available ? "connected" : "unavailable"}`;
  status.querySelector("span:last-child").textContent = message || (available
    ? "Live updates connected. Booking and court changes refresh automatically."
    : "Shared booking service unavailable. No booking will be saved until the connection returns.");
}

async function loadSettings() {
  try {
    const data = await api("/api/settings");
    settings = { ...settings, ...(data.settings || {}) };
    setServiceStatus(true);
  } catch (error) {
    console.warn("Shared settings unavailable", error);
    setServiceStatus(false);
  }
  updateDateLimits();
}

async function loadSchedule() {
  const requestNumber = ++scheduleRequest;
  const requestedDate = dateKey(selectedDate);
  try {
    const data = await api(`/api/schedule?date=${encodeURIComponent(requestedDate)}`);
    if (requestNumber !== scheduleRequest || requestedDate !== dateKey(selectedDate)) return;
    bookings = Array.isArray(data.bookings) ? data.bookings : [];
    priorityHolds = Array.isArray(data.priorityHolds) ? data.priorityHolds : [];
    closures = Array.isArray(data.closures) ? data.closures : [];
    settings = { ...settings, ...(data.settings || {}) };
    setServiceStatus(true);
    updateDateLimits();
  } catch (error) {
    if (requestNumber !== scheduleRequest) return;
    console.warn("Shared schedule unavailable", error);
    setServiceStatus(false);
  }
  renderSchedule();
}

async function loadMyBookings() {
  const requestNumber = ++myBookingsRequest;
  try {
    const data = await api("/api/my-bookings");
    if (requestNumber !== myBookingsRequest) return;
    myBookings = Array.isArray(data.bookings) ? data.bookings : [];
    renderMyBookings();
    notifyAffectedChanges();
  } catch (error) {
    if (requestNumber !== myBookingsRequest) return;
    console.warn("Your shared bookings could not be loaded", error);
    // Keep the last known shared state visible during a temporary connection problem.
  }
}

async function loadCourtStatus() {
  try {
    const data = await api("/api/court-status");
    courtStatus = Array.isArray(data.courts) ? data.courts : courtStatus;
    renderCourtStatus();
  } catch (error) {
    console.warn("Court status could not be loaded", error);
    renderCourtStatus();
  }
}

async function refreshSharedData() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = Promise.all([loadSchedule(), loadMyBookings(), loadCourtStatus()])
    .then(() => {
      if (bookingDialog.open) updateAvailabilityMessage();
    })
    .finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

function updateDateLimits() {
  const today = startOfDay(new Date());
  datePicker.min = dateKey(today);
  datePicker.max = dateKey(visibleWindowEnd());
  ["priorityStartDate", "priorityEndDate"].forEach((id) => {
    $(id).min = dateKey(today);
    $(id).max = dateKey(visibleWindowEnd());
  });
  previousDayButton.disabled = selectedDate <= today;
  nextDayButton.disabled = selectedDate >= visibleWindowEnd();
  $("windowMessage").hidden = !isOutsidePublicWindow();
}

function populateStartTimes() {
  startTime.innerHTML = "";
  for (let minute = 0; minute < 1440; minute += 30) {
    const option = document.createElement("option");
    option.value = String(minute);
    option.textContent = formatTime(minute / 60);
    startTime.appendChild(option);
  }
}

function renderDateHeading() {
  const today = startOfDay(new Date());
  const tomorrow = addDays(today, 1);
  dateKicker.textContent = selectedDate.getTime() === today.getTime() ? "Today" : selectedDate.getTime() === tomorrow.getTime() ? "Tomorrow" : "Selected date";
  selectedDateLabel.textContent = formatDate(selectedDate);
  datePicker.value = dateKey(selectedDate);
  updateDateLimits();
}

function scheduleItems() {
  return [
    ...bookings.map((item) => ({ ...item, blockType: item.owner ? "yours" : "reserved" })),
    ...priorityHolds.map((item) => ({ ...item, blockType: "priority" })),
    ...closures.map((item) => ({ ...item, blockType: "maintenance" }))
  ];
}

function conflictDetails(court, start, duration) {
  const proposedStart = Math.round(start * 60);
  const proposedEnd = Math.round((start + duration) * 60);
  const proposedDate = dateKey(selectedDate);

  const conflicts = scheduleItems().filter((item) => {
    const existingStart = Math.round(item.start * 60);
    const existingEnd = Math.round((item.start + item.duration) * 60);

    return !bookingsDoNotConflict(
      proposedStart,
      proposedEnd,
      existingStart,
      existingEnd,
      court,
      item.court,
      proposedDate,
      item.date
    );
  });

  return conflicts.find((item) => item.blockType === "maintenance")
    || conflicts.find((item) => item.blockType === "priority")
    || conflicts[0]
    || null;
}

function buildBookingBlock(item) {
  const block = document.createElement("div");
  block.className = `booking-block ${item.blockType === "yours" ? "yours" : ""} ${item.blockType === "priority" ? "priority-block" : ""} ${item.blockType === "maintenance" ? "maintenance-block" : ""}`.trim();
  block.style.left = `calc(86px + (100% - 86px) / 6 * ${item.court - 1})`;
  block.style.width = "calc((100% - 86px) / 6)";
  block.style.top = `${70 + item.start * SLOT_HEIGHT}px`;
  block.style.height = `${Math.max(28, item.duration * SLOT_HEIGHT)}px`;

  const title = document.createElement("strong");
  title.textContent = item.blockType === "maintenance" ? item.name : item.name || "Reserved";
  const details = document.createElement("span");
  const prefix = item.blockType === "priority" ? "Priority · " : item.blockType === "maintenance" ? "Closed · " : "";
  details.textContent = `${prefix}${formatTime(item.start)}–${formatTime(item.start + item.duration)}`;
  block.append(title, details);
  block.title = item.blockType === "maintenance" && item.reason ? `${item.name}: ${item.reason}` : `${title.textContent}, ${details.textContent}`;

  if (item.blockType === "yours") {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cancel-booking";
    cancel.setAttribute("aria-label", "Cancel this booking");
    cancel.textContent = "×";
    cancel.addEventListener("click", (event) => {
      event.stopPropagation();
      cancelBooking(item.id);
    });
    block.appendChild(cancel);
  }
  return block;
}

function renderSchedule() {
  renderDateHeading();
  scheduleGrid.innerHTML = "";

  const corner = document.createElement("div");
  corner.className = "corner-cell";
  corner.textContent = "Time";
  scheduleGrid.appendChild(corner);
  for (let court = 1; court <= COURT_COUNT; court += 1) {
    const header = document.createElement("div");
    header.className = "court-header";
    header.innerHTML = `<strong>Court ${court}</strong>`;
    scheduleGrid.appendChild(header);
  }

  const now = new Date();
  const today = dateKey(now) === dateKey(selectedDate);
  const outsideWindow = isOutsidePublicWindow();
  for (let hour = 0; hour < 24; hour += 1) {
    const timeCell = document.createElement("div");
    timeCell.className = "time-cell";
    timeCell.textContent = formatTime(hour);
    scheduleGrid.appendChild(timeCell);
    for (let court = 1; court <= COURT_COUNT; court += 1) {
      const slot = document.createElement("button");
      slot.type = "button";
      slot.className = "slot";
      const fullyPast = today && hour + 1 <= now.getHours() + now.getMinutes() / 60;
      if (fullyPast) slot.classList.add("past-slot");
      if (outsideWindow) slot.classList.add("outside-window-slot");
      slot.setAttribute("aria-label", `Book Court ${court} around ${formatTime(hour)}`);
      slot.addEventListener("click", (event) => {
        const rect = slot.getBoundingClientRect();
        const keyboardActivation = event.detail === 0;
        const minute = hour * 60 + (!keyboardActivation && event.clientY - rect.top >= rect.height / 2 ? 30 : 0);
        openBookingDialog(court, minute);
      });
      scheduleGrid.appendChild(slot);
    }
  }

  scheduleItems().forEach((item) => scheduleGrid.appendChild(buildBookingBlock(item)));

  if (today) {
    const currentHour = now.getHours() + now.getMinutes() / 60;
    const line = document.createElement("div");
    line.className = "now-line";
    line.style.top = `${70 + currentHour * SLOT_HEIGHT}px`;
    line.innerHTML = '<span class="now-label">Now</span>';
    scheduleGrid.appendChild(line);
    const occupiedCourts = new Set(scheduleItems().filter((item) => overlaps(currentHour, 0.01, item.start, item.duration)).map((item) => item.court));
    $("availableNowCount").textContent = `${COURT_COUNT - occupiedCourts.size} of ${COURT_COUNT} courts`;
  }
  $("scheduleBookButton").disabled = outsideWindow || !sharedServiceAvailable;
}

function readReminders() {
  try { return JSON.parse(safeStorageGet(REMINDERS_KEY, "{}")) || {}; } catch (_) { return {}; }
}

function writeReminders(value) {
  safeStorageSet(REMINDERS_KEY, JSON.stringify(value));
}

function isCurrentBookingNotice(booking) {
  return booking.status !== "active" && booking.affectedByType && !booking.archived && booking.date >= dateKey(new Date());
}

function buildMyBookingCard(booking, history = false) {
    const card = document.createElement("article");
    const affected = Boolean(booking.affectedByType);
    card.className = `your-booking-card${affected ? " affected-booking-card" : ""}${booking.automaticReplacement ? " replacement-booking-card" : ""}`;
    const info = document.createElement("div");
    info.className = "your-booking-info";
    const heading = document.createElement("strong");
    heading.textContent = booking.status === "active" ? `${booking.automaticReplacement ? "Automatic replacement · " : ""}Court ${booking.court}` : affected ? "Booking canceled / affected" : booking.status === "completed" ? "Completed booking" : "Canceled booking";
    const details = document.createElement("span");
    details.textContent = `${formatDate(parseDateKey(booking.date), { month: "short", day: "numeric", year: "numeric" })} · Court ${booking.court} · ${formatTime(booking.start)}–${formatTime(booking.start + booking.duration)}${booking.cancellationReason ? ` · ${booking.cancellationReason}` : ""}`;
    info.append(heading, details);
    if (affected) {
      const replacementNote = document.createElement("span");
      replacementNote.className = `rebooking-note${booking.replacementBooking ? " rebooking-success" : ""}`;
      replacementNote.textContent = booking.replacementBooking
        ? `Replacement secured: Court ${booking.replacementBooking.court}, ${formatTime(booking.replacementBooking.start)}–${formatTime(booking.replacementBooking.start + booking.replacementBooking.duration)}. You can keep it, cancel it, or view other times.`
        : "No similar same-day opening was available. You can choose another court or time from the calendar.";
      info.appendChild(replacementNote);
    }
    card.appendChild(info);
    if (booking.status === "active") {
      const actions = document.createElement("div");
      actions.className = "your-booking-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "card-cancel-button";
      cancel.textContent = "Cancel booking";
      cancel.addEventListener("click", () => cancelBooking(booking.id));
      actions.appendChild(cancel);
      card.appendChild(actions);
    } else if (history) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "history-delete-one";
      remove.textContent = "Delete forever";
      remove.addEventListener("click", () => deleteBookingHistory(booking.id));
      card.appendChild(remove);
    } else if (affected) {
      const alternatives = document.createElement("button");
      alternatives.type = "button";
      alternatives.className = "alternative-booking-button";
      alternatives.textContent = "View other times";
      alternatives.addEventListener("click", () => viewOtherTimes(booking));
      card.appendChild(alternatives);
    }
    return card;
}

function viewOtherTimes(booking) {
  selectedDate = clampVisibleDate(parseDateKey(booking.replacementBooking?.date || booking.date));
  renderSchedule();
  loadSchedule();
  renderWeatherAdvisory();
  $("schedule").scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => scheduleScroll.scrollTo({ top: Math.max(0, (booking.start - 2) * SLOT_HEIGHT), behavior: "smooth" }), 300);
}

function notifyAffectedChanges() {
  let seen = {};
  try { seen = JSON.parse(safeStorageGet(AFFECTED_NOTICES_SEEN_KEY, "{}")) || {}; } catch (_) { seen = {}; }
  const now = Date.now();
  const seenCutoff = now - 365 * 24 * 60 * 60 * 1000;
  for (const [id, timestamp] of Object.entries(seen)) {
    if (!Number.isFinite(Number(timestamp)) || Number(timestamp) < seenCutoff) delete seen[id];
  }
  const fresh = myBookings.filter((booking) => booking.status !== "active" && booking.affectedByType && !booking.archived && !seen[booking.id]);
  const reminders = readReminders();
  let remindersChanged = false;
  for (const booking of fresh) {
    const replacement = booking.replacementBooking;
    if (replacement && reminders[booking.id]?.enabled && !reminders[replacement.id]) {
      reminders[replacement.id] = { ...reminders[booking.id], notified: false };
      remindersChanged = true;
    }
    if (reminders[booking.id]) {
      delete reminders[booking.id];
      remindersChanged = true;
    }
    const body = replacement
      ? `Your original Court ${booking.court} booking was affected. A replacement is reserved on Court ${replacement.court} at ${formatTime(replacement.start)}.`
      : `Your Court ${booking.court} booking was affected. No similar same-day opening was available; view other times on the calendar.`;
    if ("Notification" in window && Notification.permission === "granted") {
      try { new Notification(replacement ? "CHS Courts — booking moved" : "CHS Courts — booking affected", { body }); } catch (_) { /* In-site notice remains authoritative. */ }
    }
    seen[booking.id] = now;
  }
  const activeBookingIds = new Set(myBookings.filter((booking) => booking.status === "active").map((booking) => booking.id));
  for (const id of Object.keys(reminders)) {
    if (!activeBookingIds.has(id)) {
      delete reminders[id];
      remindersChanged = true;
    }
  }
  if (remindersChanged) writeReminders(reminders);
  safeStorageSet(AFFECTED_NOTICES_SEEN_KEY, JSON.stringify(seen));
  if (!fresh.length) return;
  const first = fresh[0];
  showToast(first.replacementBooking ? "A similar court time was reserved automatically. Check your booking notice for details." : "No similar time was open. Use “View other times” to choose another option.", first.replacementBooking ? "Booking moved automatically" : "Booking needs a new time");
}

function renderMyBookings() {
  const current = myBookings.filter((booking) => booking.status === "active" || isCurrentBookingNotice(booking));
  const history = myBookings.filter((booking) => booking.status !== "active" && !isCurrentBookingNotice(booking));
  myBookingsPanel.hidden = current.length === 0;
  resetNoticesButton.hidden = !current.some((booking) => booking.status !== "active");
  myBookingsList.replaceChildren(...current.map((booking) => buildMyBookingCard(booking)));
  bookingHistoryPanel.hidden = history.length === 0;
  bookingHistoryCount.textContent = `${history.length} ${history.length === 1 ? "record" : "records"}`;
  bookingHistoryList.replaceChildren(...history.map((booking) => buildMyBookingCard(booking, true)));
  if (!history.length) bookingHistoryPanel.open = false;
  updatePingButton();
}

function formatStatusUpdated(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function renderCourtStatus() {
  const down = courtStatus.filter((item) => item.status === "down").length;
  courtStatusPanel.dataset.hasClosures = down ? "true" : "false";
  courtStatusCount.textContent = down ? `${down} ${down === 1 ? "court" : "courts"} down` : "All courts open";
  const cards = courtStatus.map((item) => {
    const card = document.createElement("article");
    card.className = `court-status-card ${item.status === "down" ? "down" : "open"}`;
    const marker = document.createElement("span");
    marker.className = "court-status-marker";
    marker.setAttribute("aria-hidden", "true");
    const copy = document.createElement("div");
    const heading = document.createElement("strong");
    heading.textContent = `Court ${item.court}`;
    const status = document.createElement("span");
    status.textContent = item.status === "down" ? "Unavailable" : "Open";
    copy.append(heading, status);
    if (item.status === "down" && item.reason) {
      const reason = document.createElement("small");
      reason.textContent = item.reason;
      copy.appendChild(reason);
    }
    const updated = formatStatusUpdated(item.updatedAt);
    if (updated) {
      const time = document.createElement("time");
      time.dateTime = item.updatedAt;
      time.textContent = updated;
      copy.appendChild(time);
    }
    card.append(marker, copy);
    return card;
  });
  courtStatusList.replaceChildren(...cards);
}

function syncCourtStatusAction() {
  const action = maintenanceForm.querySelector('input[name="courtStatusAction"]:checked')?.value || "down";
  const reason = $("maintenanceReason");
  const isDown = action === "down";
  reason.required = isDown;
  reason.placeholder = isDown ? "Broken net, standing water, cracked surface…" : "Optional note";
  $("maintenanceReasonLabel").textContent = isDown ? "Why are the courts unavailable?" : "Status note (optional)";
  $("saveCourtStatusButton").innerHTML = `${isDown ? "Mark courts down" : "Mark courts open"} <span>→</span>`;
}

function openMaintenanceDialog(action = "down") {
  maintenanceForm.reset();
  const selectedAction = maintenanceForm.querySelector(`input[name="courtStatusAction"][value="${action}"]`);
  if (selectedAction) selectedAction.checked = true;
  $("maintenanceError").textContent = "";
  $("saveCourtStatusButton").disabled = false;
  syncCourtStatusAction();
  maintenanceDialog.showModal();
}

async function submitCourtStatus(event) {
  event.preventDefault();
  const action = maintenanceForm.querySelector('input[name="courtStatusAction"]:checked')?.value || "down";
  const checkedCourts = Array.from(document.querySelectorAll("#maintenanceCourts input:checked")).map((input) => input.value);
  const payload = {
    action,
    courts: checkedCourts.includes("all") ? "all" : checkedCourts.map(Number),
    reason: $("maintenanceReason").value.trim()
  };
  const error = $("maintenanceError");
  error.textContent = "";
  if (!checkedCourts.length) {
    error.textContent = "Select at least one court.";
    return;
  }
  if (action === "down" && payload.reason.length < 3) {
    error.textContent = "Briefly explain why the courts are unavailable.";
    return;
  }
  const submit = $("saveCourtStatusButton");
  submit.disabled = true;
  submit.textContent = action === "down" ? "Updating shared status…" : "Reopening courts…";
  try {
    const data = await api("/api/court-status", { method: "POST", body: JSON.stringify(payload) });
    const count = data.courts?.length || checkedCourts.length;
    const replacementCopy = data.rebookedCount ? ` ${data.rebookedCount} affected booking(s) received a similar-time replacement.` : "";
    showToast(action === "down" ? `${count} ${count === 1 ? "court is" : "courts are"} unavailable.${replacementCopy}` : `${count} ${count === 1 ? "court is" : "courts are"} open for booking again.`, action === "down" ? "Court status updated" : "Courts reopened");
    maintenanceDialog.close();
    await refreshSharedData();
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    submit.disabled = false;
    syncCourtStatusAction();
  }
}

async function archiveBookingNotices() {
  try {
    await api("/api/my-bookings/archive", { method: "POST" });
    showToast("Notices moved to booking history.", "Calendar area reset");
    await loadMyBookings();
  } catch (error) {
    showToast(error.message, "Could not reset notices");
  }
}

async function deleteBookingHistory(id = "") {
  const message = id ? "Permanently delete this booking-history record?" : "Permanently delete all of your booking history? Active bookings will stay in place.";
  if (!window.confirm(message)) return;
  try {
    await api(id ? `/api/my-bookings/${encodeURIComponent(id)}` : "/api/my-bookings/history", { method: "DELETE" });
    const reminders = readReminders();
    if (id) delete reminders[id];
    else {
      for (const booking of myBookings.filter((item) => item.status !== "active")) delete reminders[booking.id];
    }
    writeReminders(reminders);
    showToast(id ? "The history record was permanently deleted." : "Your booking history was permanently deleted.", "History deleted");
    await loadMyBookings();
  } catch (error) {
    showToast(error.message, "Could not delete history");
  }
}

async function cancelBooking(id) {
  if (pendingCancellations.has(id)) return;
  const booking = myBookings.find((item) => item.id === id) || bookings.find((item) => item.id === id);
  if (!booking) return;
  pendingCancellations.add(id);
  try {
    await api(`/api/bookings/${encodeURIComponent(id)}`, { method: "DELETE" });
    const reminders = readReminders();
    delete reminders[id];
    writeReminders(reminders);
    showToast(`Court ${booking.court} was released for everyone.`, "Booking canceled");
    await refreshSharedData();
  } catch (error) {
    showToast(error.message, "Could not cancel");
  } finally {
    pendingCancellations.delete(id);
  }
}

function activeBookingsOnSelectedDay() {
  return myBookings.filter((booking) => booking.status === "active" && booking.date === dateKey(selectedDate));
}

function validateSelection() {
  const startMinute = Number(startTime.value);
  const durationMinutes = Number(durationSelect.value);
  const court = Number(courtSelect.value);
  const start = startMinute / 60;
  const duration = durationMinutes / 60;
  const selectedStart = new Date(selectedDate);
  selectedStart.setHours(Math.floor(startMinute / 60), startMinute % 60, 0, 0);

  if (!sharedServiceAvailable) return { valid: false, message: "Shared booking service unavailable. No booking will be saved until it reconnects." };
  if (isOutsidePublicWindow()) return { valid: false, message: "Bookings are only available up to 6 months in advance." };
  if (!Number.isInteger(durationMinutes) || durationMinutes < 30 || durationMinutes > MAX_BOOKING_MINUTES) return { valid: false, message: "Each booking can be up to 2 hours." };
  if (startMinute + durationMinutes > 1440) return { valid: false, message: "This booking would run past midnight. Choose an earlier time or shorter stay." };
  if (selectedStart <= new Date()) return { valid: false, message: "That start time has already passed. Choose a later time." };
  const proposedBooking = {
    date: dateKey(selectedDate),
    clientId,
    status: "active"
  };

  const personalBookings = myBookings.map((booking) => ({
    date: booking.date,
    clientId,
    status: booking.status
  }));

  if (!isUnderDailyLimit(proposedBooking, personalBookings)) {
    return { valid: false, message: "You can have up to 2 active bookings per day. Please cancel or complete an existing booking before making another." };
  }
  const conflict = conflictDetails(court, start, duration);
  if (conflict?.blockType === "maintenance") return { valid: false, message: `Court ${court} is closed: ${conflict.name}.` };
  if (conflict?.blockType === "priority") return { valid: false, message: `Court ${court} is held for ${conflict.name}.` };
  if (conflict) return { valid: false, message: `Court ${court} is already reserved during part of that time.` };
  return { valid: true, message: `Court ${court} is open from ${formatTime(start)} to ${formatTime(start + duration)}.` };
}

function updateAvailabilityMessage() {
  const result = validateSelection();
  confirmBookingButton.disabled = !result.valid;

  availabilityMessage.className =
    `availability-message ${result.valid ? "available" : "unavailable"}`;

  availabilityMessage.textContent =
    `${result.valid ? "✓" : "!"} ${result.message}`;
  const duration = Number(durationSelect.value);
  $("summaryDuration").textContent = duration === 30 ? "30 minutes" : duration === 60 ? "1 hour" : duration === 90 ? "1½ hours" : "2 hours";
  renderBookingWeather();
}

function nextUsefulStartMinute() {
  if (dateKey(selectedDate) !== dateKey(new Date())) return 8 * 60;
  const now = new Date();
  return Math.min(1410, Math.ceil((now.getHours() * 60 + now.getMinutes() + 1) / 30) * 30);
}

function openBookingDialog(court = 1, minute = null) {
  bookingForm.reset();
  nameInput.value = safeStorageGet("chs-booker-name");
  reminderOptIn.checked = true;
  courtSelect.value = String(court);
  startTime.value = String(minute ?? nextUsefulStartMinute());
  durationSelect.value = "120";
  agreement.checked = false;
  $("nameError").textContent = "";
  $("agreementError").textContent = "";
  $("summaryDate").textContent = formatDate(selectedDate);
  updateAvailabilityMessage();
  bookingDialog.showModal();
  setTimeout(() => (nameInput.value ? courtSelect.focus() : nameInput.focus()), 50);
}

async function submitBooking(event) {
  event.preventDefault();
  const name = nameInput.value.trim();
  $("nameError").textContent = name.length >= 2 ? "" : "Please enter your name.";
  $("agreementError").textContent = agreement.checked ? "" : "Please agree to the cancellation rule.";
  const selection = validateSelection();
  updateAvailabilityMessage();
  if (name.length < 2 || !agreement.checked || !selection.valid) return;

  const submitButton = bookingForm.querySelector('[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = "Saving to shared schedule…";
  try {
    const data = await api("/api/bookings", {
      method: "POST",
      body: JSON.stringify({
        name,
        date: dateKey(selectedDate),
        court: Number(courtSelect.value),
        startMinute: Number(startTime.value),
        durationMinutes: Number(durationSelect.value)
      })
    });
    safeStorageSet("chs-booker-name", name);
    if (reminderOptIn.checked && data.booking?.id) {
      const reminders = readReminders();
      reminders[data.booking.id] = { enabled: true, notified: false };
      writeReminders(reminders);
      if ("Notification" in window && Notification.permission === "default") requestNotificationPermission();
    }
    bookingDialog.close();
    showToast(`Court ${data.booking.court} · ${formatTime(data.booking.start)}–${formatTime(data.booking.start + data.booking.duration)}`, data.duplicate ? "Booking was already saved" : "Booking saved for everyone");
    await refreshSharedData();
  } catch (error) {
    availabilityMessage.className = "availability-message unavailable";
    availabilityMessage.textContent = `! ${error.message}`;
    if (error.code === "service_unavailable" || error.code === "database_not_configured") setServiceStatus(false);
    await loadSchedule();
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = 'Confirm booking <span>→</span>';
  }
}

function weatherWithinForecastRange(date) {
  const days = Math.round((startOfDay(date) - startOfDay(new Date())) / 86400000);
  return days >= 0 && days <= 15;
}

function analyzeWeather(date, range = null) {
  if (!weatherCache) return null;
  const key = dateKey(date);
  const points = weatherCache.time.map((time, index) => ({
    time,
    hour: Number(time.slice(11, 13)),
    code: weatherCache.weatherCode[index],
    probability: weatherCache.precipitationProbability[index] ?? 0,
    apparent: weatherCache.apparentTemperature[index]
  })).filter((point) => point.time.startsWith(key) && (range ? point.hour >= Math.floor(range.start) && point.hour < Math.ceil(range.end) : point.hour >= 6 && point.hour <= 22));
  if (!points.length) return null;
  const maxProbability = Math.max(...points.map((point) => point.probability));
  const maxApparent = Math.round(Math.max(...points.map((point) => point.apparent)));
  const storm = points.some((point) => point.code >= 95);
  const snowOrIce = points.some((point) => [56, 57, 66, 67].includes(point.code) || (point.code >= 71 && point.code <= 77) || [85, 86].includes(point.code));
  const rain = maxProbability >= 60 || points.some((point) => (point.code >= 51 && point.code <= 65) || (point.code >= 80 && point.code <= 82));
  if (storm) return { type: "storm", icon: "⚡", title: "Court time is not advised", message: "Thunderstorms are possible. Leave the courts immediately if thunder is heard. Booking remains available.", meta: `${maxProbability}% precipitation` };
  if (snowOrIce) return { type: "snow", icon: "❄", title: "Slippery courts may make play unsafe", message: "Snow, sleet, or freezing precipitation is possible. Check the surface before playing. Booking remains available.", meta: `${maxProbability}% precipitation` };
  if (rain) return { type: "rain", icon: "☂", title: "Booking this time may be unadvisable", message: "Rain is possible and wet courts can be slippery. Check conditions before playing. Booking remains available.", meta: `${maxProbability}% precipitation` };
  if (maxApparent >= 90) return { type: "heat", icon: "☀", title: "Heat precautions recommended", message: "Bring water, take frequent rest breaks, and stop if anyone feels unwell. Booking remains available.", meta: `Feels up to ${maxApparent}°F` };
  return { type: "good", icon: "✓", title: "No major weather concern in the forecast", message: "Conditions can still change, so check the court surface when you arrive.", meta: `Feels up to ${maxApparent}°F · ${maxProbability}% rain` };
}

function setWeatherBanner(advisory) {
  weatherAdvisory.className = `weather-advisory ${advisory.type}`;
  weatherIcon.textContent = advisory.icon;
  weatherTitle.textContent = advisory.title;
  weatherMessage.textContent = advisory.message;
  weatherMeta.textContent = advisory.meta;
}

async function loadWeather() {
  if (weatherCache || weatherRequest) return weatherRequest;
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: CHELMSFORD_LATITUDE,
    longitude: CHELMSFORD_LONGITUDE,
    hourly: "apparent_temperature,precipitation_probability,weather_code",
    temperature_unit: "fahrenheit",
    timezone: "America/New_York",
    forecast_days: "16"
  });
  weatherRequest = fetch(url).then((response) => {
    if (!response.ok) throw new Error(`Weather request failed: ${response.status}`);
    return response.json();
  }).then((data) => {
    weatherCache = {
      time: data.hourly.time,
      apparentTemperature: data.hourly.apparent_temperature,
      precipitationProbability: data.hourly.precipitation_probability,
      weatherCode: data.hourly.weather_code
    };
    return weatherCache;
  }).finally(() => { weatherRequest = null; });
  return weatherRequest;
}

async function renderWeatherAdvisory() {
  if (!weatherWithinForecastRange(selectedDate)) {
    setWeatherBanner({ type: "unavailable", icon: "○", title: "Forecast not available this far ahead", message: "A detailed advisory will appear within the 16-day forecast window. Booking remains available.", meta: "Open-Meteo" });
    renderBookingWeather();
    return;
  }
  if (weatherCache) {
    setWeatherBanner(analyzeWeather(selectedDate));
    renderBookingWeather();
    return;
  }
  setWeatherBanner({ type: "loading", icon: "◌", title: "Checking court weather…", message: "Loading the latest Chelmsford forecast.", meta: "Open-Meteo" });
  try {
    await loadWeather();
    if (weatherWithinForecastRange(selectedDate)) setWeatherBanner(analyzeWeather(selectedDate));
    renderBookingWeather();
  } catch (error) {
    console.warn("Weather unavailable", error);
    setWeatherBanner({ type: "unavailable", icon: "!", title: "Weather forecast unavailable", message: "Check a local forecast and the court surface before playing. Booking remains available.", meta: "Try again later" });
  }
}

function renderBookingWeather() {
  if (!bookingDialog.open || !weatherWithinForecastRange(selectedDate) || !weatherCache) {
    bookingWeatherAdvisory.hidden = true;
    return;
  }
  const start = Number(startTime.value) / 60;
  const end = start + Number(durationSelect.value) / 60;
  const advisory = analyzeWeather(selectedDate, { start, end });
  if (!advisory || advisory.type === "good") {
    bookingWeatherAdvisory.hidden = true;
    return;
  }
  bookingWeatherAdvisory.hidden = false;
  $("bookingWeatherTitle").textContent = `${advisory.icon} ${advisory.title}`;
  $("bookingWeatherMessage").textContent = advisory.message;
}

function openPriorityDialog(type) {
  priorityForm.reset();
  const school = type === "school";
  $("priorityRequestType").value = "activity";
  $("priorityDialogTitle").textContent = school ? "CHS schedule hold" : "Activities hold";
  $("priorityActivityKind").value = school ? "chs_practice" : "clinic";
  $("priorityProgramName").value = school ? "CHS Tennis Practice" : "";
  $("priorityStartTime").value = school ? "14:00" : "15:00";
  $("priorityEndTime").value = "17:00";
  $("priorityCourt").value = school ? "all" : "1";
  const proposedStart = addDays(new Date(), 7);
  $("priorityStartDate").value = dateKey(proposedStart);
  $("priorityEndDate").value = dateKey(addDays(proposedStart, 28));
  $("priorityError").textContent = "";
  $("priorityAccuracy").checked = false;
  priorityDialog.showModal();
}

async function submitPriorityRequest(event) {
  event.preventDefault();
  const payload = {
    label: $("priorityProgramName").value.trim(),
    kind: $("priorityActivityKind").value,
    organizer: $("priorityInstructorName").value.trim(),
    listingUrl: $("priorityListingUrl").value.trim(),
    startDate: $("priorityStartDate").value,
    endDate: $("priorityEndDate").value,
    start: $("priorityStartTime").value,
    end: $("priorityEndTime").value,
    courts: $("priorityCourt").value,
    weekdays: Array.from(document.querySelectorAll(".priority-days input:checked")).map((input) => input.value)
  };
  const error = $("priorityError");
  if (!$("priorityAccuracy").checked) {
    error.textContent = "Please confirm that the activity and dates are accurate.";
    return;
  }
  const submitButton = priorityForm.querySelector('[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = "Activating shared priority booking…";
  try {
    const data = await api("/api/priority-requests", { method: "POST", body: JSON.stringify(payload) });
    priorityDialog.close();
    const replacementCopy = data.rebookedCount ? ` ${data.rebookedCount} affected booking(s) received a similar-time replacement.` : "";
    showToast(`The selected court time is blocked on the shared calendar now.${replacementCopy}`, data.duplicate ? "Priority booking already active" : "Priority booking active");
    await refreshSharedData();
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = 'Submit request <span>→</span>';
  }
}

function showToast(message, title = "Saved") {
  toast.querySelector("strong").textContent = title;
  $("toastMessage").textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 5200);
}

function changeDay(delta) {
  selectedDate = clampVisibleDate(addDays(selectedDate, delta));
  bookings = [];
  priorityHolds = [];
  closures = [];
  renderSchedule();
  loadSchedule();
  renderWeatherAdvisory();
  scheduleScroll.scrollTop = 0;
}

function jumpToNow() {
  selectedDate = startOfDay(new Date());
  renderSchedule();
  loadSchedule();
  renderWeatherAdvisory();
  const now = new Date();
  scheduleScroll.scrollLeft = 0;
  scheduleScroll.scrollTo({ top: Math.max(0, 70 + (now.getHours() - 2) * SLOT_HEIGHT), behavior: "smooth" });
}

async function requestNotificationPermission() {
  if (!("Notification" in window)) {
    showToast("This browser does not support reminders.", "Browser reminder unavailable");
    return;
  }
  let permission = "default";
  try { permission = await Notification.requestPermission(); } catch (_) {
    showToast("Browser reminder permission could not be requested. Your shared booking is still saved.", "Reminders unchanged");
    return;
  }
  updatePingButton();
  showToast(permission === "granted" ? "Browser reminders are enabled while this site is open." : "Reminder permission was not enabled.", permission === "granted" ? "Reminders enabled" : "Reminders unchanged");
}

function updatePingButton() {
  if (!("Notification" in window)) {
    enablePingsButton.disabled = true;
    enablePingsButton.textContent = "Reminders unsupported";
  } else if (Notification.permission === "granted") {
    enablePingsButton.disabled = true;
    enablePingsButton.textContent = "✓ Browser reminders enabled";
  } else {
    enablePingsButton.disabled = false;
    enablePingsButton.textContent = "🔔 Enable browser reminder";
  }
}

function checkReminders() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const reminders = readReminders();
  let changed = false;
  const now = new Date();
  for (const booking of myBookings.filter((item) => item.status === "active")) {
    const reminder = reminders[booking.id];
    if (!reminder?.enabled || reminder.notified) continue;
    const starts = parseDateKey(booking.date);
    starts.setHours(Math.floor(booking.start), Math.round((booking.start % 1) * 60), 0, 0);
    const minutesUntil = (starts - now) / 60000;
    if (minutesUntil >= 0 && minutesUntil <= 15) {
      try {
        new Notification("CHS Courts — court time soon", { body: `Court ${booking.court} starts at ${formatTime(booking.start)}. Still coming? Cancel the booking if plans changed.` });
        reminder.notified = true;
        changed = true;
      } catch (_) { /* Try again on a later reminder check; the booking remains unaffected. */ }
    }
  }
  if (changed) writeReminders(reminders);
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.visibilityState === "visible") {
      refreshSharedData();
      checkReminders();
    }
  }, LIVE_SYNC_INTERVAL_MS);
}

populateStartTimes();
nameInput.value = safeStorageGet("chs-booker-name");
renderSchedule();
updatePingButton();

previousDayButton.addEventListener("click", () => changeDay(-1));
nextDayButton.addEventListener("click", () => changeDay(1));
dateDisplay.addEventListener("click", () => datePicker.showPicker ? datePicker.showPicker() : datePicker.click());
datePicker.addEventListener("change", () => {
  if (!datePicker.value) return;
  selectedDate = clampVisibleDate(parseDateKey(datePicker.value));
  bookings = [];
  priorityHolds = [];
  closures = [];
  renderSchedule();
  loadSchedule();
  renderWeatherAdvisory();
});
$("jumpNowButton").addEventListener("click", jumpToNow);
["headerBookButton", "heroBookButton", "scheduleBookButton"].forEach((id) => {
  $(id).addEventListener("click", () => {
    $("schedule").scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => openBookingDialog(), 300);
  });
});
$("closeDialog").addEventListener("click", () => bookingDialog.close());
$("cancelDialog").addEventListener("click", () => bookingDialog.close());
$("toastClose").addEventListener("click", () => toast.classList.remove("show"));
enablePingsButton.addEventListener("click", requestNotificationPermission);
resetNoticesButton.addEventListener("click", archiveBookingNotices);
deleteHistoryButton.addEventListener("click", () => deleteBookingHistory());
[courtSelect, startTime, durationSelect].forEach((element) => element.addEventListener("change", updateAvailabilityMessage));
bookingForm.addEventListener("submit", submitBooking);
$("programRequestButton").addEventListener("click", () => openPriorityDialog("activity"));
$("schoolRequestButton").addEventListener("click", () => openPriorityDialog("school"));
$("closePriorityDialog").addEventListener("click", () => priorityDialog.close());
$("cancelPriorityDialog").addEventListener("click", () => priorityDialog.close());
priorityForm.addEventListener("submit", submitPriorityRequest);
$("reportIssueButton").addEventListener("click", () => openMaintenanceDialog("down"));
$("statusPanelReportButton").addEventListener("click", () => openMaintenanceDialog("down"));
$("closeMaintenanceDialog").addEventListener("click", () => maintenanceDialog.close());
$("cancelMaintenanceDialog").addEventListener("click", () => maintenanceDialog.close());
maintenanceForm.addEventListener("submit", submitCourtStatus);
maintenanceForm.querySelectorAll('input[name="courtStatusAction"]').forEach((input) => input.addEventListener("change", syncCourtStatusAction));
$("maintenanceCourts").addEventListener("change", (event) => {
  const fieldset = $("maintenanceCourts");
  if (event.target.value === "all" && event.target.checked) {
    fieldset.querySelectorAll('input:not([value="all"])').forEach((input) => { input.checked = false; });
  } else if (event.target.checked) {
    fieldset.querySelector('input[value="all"]').checked = false;
  }
});
[bookingDialog, priorityDialog, maintenanceDialog].forEach((modal) => modal.addEventListener("click", (event) => {
  const bounds = modal.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) modal.close();
}));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshSharedData();
});
window.addEventListener("focus", () => refreshSharedData());
window.addEventListener("online", () => refreshSharedData());

(async function initialize() {
  await loadSettings();
  await refreshSharedData();
  renderWeatherAdvisory();
  startPolling();
  setTimeout(() => {
    const now = new Date();
    scheduleScroll.scrollTop = Math.max(0, 70 + (now.getHours() - 2) * SLOT_HEIGHT);
  }, 100);
})();
