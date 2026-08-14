import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const index = await readFile(new URL("../index.html", import.meta.url), "utf8");
const publicClient = await readFile(new URL("../app.js", import.meta.url), "utf8");
const loginClient = await readFile(new URL("../admin-login.js", import.meta.url), "utf8");
const worker = await readFile(new URL("../_worker.js", import.meta.url), "utf8");
const headers = await readFile(new URL("../_headers", import.meta.url), "utf8");
const adminSource = await readFile(new URL("../admin.html", import.meta.url), "utf8");
const adminAsset = await readFile(new URL("../admin-page.txt", import.meta.url), "utf8");
const loginSource = await readFile(new URL("../admin-login.html", import.meta.url), "utf8");
const loginAsset = await readFile(new URL("../admin-login-page.txt", import.meta.url), "utf8");

assert.match(index, /href="\/admin-login"/);
assert.doesNotMatch(index, /bookerEmail|priorityEmail|Contact email|Optional email/i);
assert.doesNotMatch(publicClient, /bookerEmail|priorityEmail|chs-booker-email|invalid_email/);
assert.match(loginClient, /credentials: "same-origin"/);
assert.match(loginClient, /responseType\.includes\("application\/json"\)/);
assert.match(loginClient, /window\.location\.replace\("\/admin"\)/);
assert.match(worker, /"\/admin-login-page\.txt"/);
assert.match(worker, /"\/admin-page\.txt"/);
assert.doesNotMatch(worker, /serveAsset\(request, env, "\/admin-login\.html"/);
assert.equal(loginAsset, loginSource);
assert.equal(adminAsset, adminSource);
assert.match(worker, /headers\.delete\("Content-Disposition"\)/);
assert.match(worker, /"text\/html; charset=utf-8"/);
assert.match(headers, /Content-Disposition: inline/);

console.log("PASS admin routes use synchronized non-HTML assets and cannot enter a Pages clean-URL redirect loop");
