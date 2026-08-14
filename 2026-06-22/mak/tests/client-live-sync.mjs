import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const publicClient = await readFile(new URL("../app.js", import.meta.url), "utf8");
const adminClient = await readFile(new URL("../admin.js", import.meta.url), "utf8");

assert.match(publicClient, /LIVE_SYNC_INTERVAL_MS = 10000/);
assert.match(publicClient, /cache: "no-store"/);
assert.match(publicClient, /document\.visibilityState === "visible"/);
assert.match(publicClient, /window\.addEventListener\("focus"/);
assert.match(publicClient, /window\.addEventListener\("online"/);
assert.match(publicClient, /if \(refreshInFlight\) return refreshInFlight/);

assert.match(adminClient, /ADMIN_LIVE_SYNC_INTERVAL_MS = 15000/);
assert.match(adminClient, /cache: "no-store"/);
assert.match(adminClient, /adminCanLiveSync/);
assert.match(adminClient, /management-form\[data-dirty="true"\]/);
assert.match(adminClient, /window\.addEventListener\("focus"/);
assert.match(adminClient, /window\.addEventListener\("online"/);

console.log("PASS live-sync client guardrails");
