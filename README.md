# CHS Courts

Tennis-only reservation site for the six Chelmsford High School courts.

- `index.html`, `styles.css`, `app.js`: responsive public schedule and booking UI
- `_worker.js`: Cloudflare Pages Worker with shared D1 storage and APIs
- `admin.html`, `admin.css`, `admin.js`: protected Admin Portal dashboard
- `admin-login.html`, `admin-login.js`: temporary server-side email/password login for the free pages.dev address
- `admin-page.txt`, `admin-login-page.txt`: synchronized internal HTML copies used by the Worker to bypass Cloudflare Pages clean-URL redirects
- `tests/worker.integration.mjs`: shared-storage integration suite
- `tests/local-server.mjs`: local browser QA server
- `DEPLOYMENT.md`: Cloudflare custom-domain and Google indexing steps
- `_headers`: forces Admin Portal pages to render inline as HTML instead of downloading

The D1 binding must be named `DB`. Real bookings never fall back to local-only storage. For temporary pages.dev admin access, configure `ADMIN_SESSION_SECRET` plus either the backward-compatible `ADMIN_EMAILS`/`ADMIN_PASSWORD` pair or an encrypted `ADMIN_CREDENTIALS` JSON object for separate per-email passwords.

The public schedule silently refreshes shared bookings, holds, closures, and court status every 10 seconds. The Admin Portal refreshes every 15 seconds, pauses while an admin has unsaved form edits, and both views sync immediately when their tab regains focus or the browser reconnects.

## Data lifecycle

- Active bookings, current court-down statuses, and future maintenance/priority blocks are never cleared by housekeeping.
- When maintenance or priority access displaces a public booking, the Worker tries the same time on another court, then nearby half-hour times within two hours on the same day. Successful replacements are shared bookings and count toward the normal daily limit.
- The public court-status board lets anyone mark one court, several courts, or the whole facility down or open. Reports take effect immediately, require no personal information or approval, and use shared D1 storage.
- A down status has no end date and remains active until someone reports the court open or an administrator overrides it. Resolved status reports and open markers are removed automatically after 24 hours.
- Admin-created maintenance closures remain available for planned, date/time-specific work and are separate from the community status board.
- Public priority submissions use the honor system and become active immediately. Admins retain oversight and can remove any hold.
- Affected players receive an in-site notice and a browser notification when permission is enabled.
- Past or dismissed player notices move into a compact booking history, which the player can permanently delete.
- Ordinary booking history is retained for 90 days; affected bookings, expired calendar records, reviewed requests, and admin activity are retained for 180 days; resolved court-status history is retained for 24 hours.
- The protected Admin Portal can run safe cleanup immediately or permanently clear selected archived categories while preserving live scheduling data and settings.

## Safety guardrails

- Identical booking retries, pending priority requests, maintenance closures, and priority holds reuse their existing shared records instead of creating duplicates. Community court-status reports may be submitted as often as needed.
- Canonical booking-row checks backstop the slot indexes. A browser may reserve two different courts at overlapping times, while the original two-active-bookings-per-day limit remains enforced.
- Automatic replacements avoid reserved slots, priority holds, maintenance closures, and courts currently marked down; repeated displacement keeps the original notice linked to the newest replacement.
- Already-ended blocks and weekday/date ranges that never intersect are rejected before storage.
- Optional local storage and browser notifications cannot turn a successful shared save into a false failure; reminders move to automatic replacement bookings when possible.
- Temporary admin login is throttled after repeated failures. Only the primary administrator can permanently clear history; editors can still run non-destructive safe cleanup.
- Admin diagnostics report missing or stale court-slot and daily-limit indexes.
