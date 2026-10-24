import http from "node:http";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const root = new URL("../", import.meta.url);
const workerSource = await readFile(new URL("../_worker.js", import.meta.url), "utf8");
const worker = (await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString("base64")}`)).default;

class Statement {
  constructor(database, sql, parameters = []) { this.database = database; this.sql = sql; this.parameters = parameters; }
  bind(...parameters) { return new Statement(this.database, this.sql, parameters); }
  run() { return this.database.prepare(this.sql).run(...this.parameters); }
  all() { return { results: this.database.prepare(this.sql).all(...this.parameters) }; }
  first() { return this.database.prepare(this.sql).get(...this.parameters) || null; }
}

class D1 {
  constructor() { this.database = new DatabaseSync(":memory:"); }
  prepare(sql) { return new Statement(this.database, sql); }
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

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/booking-logic.js", ["booking-logic.js", "text/javascript; charset=utf-8"]],
  ["/admin.css", ["admin.css", "text/css; charset=utf-8"]],
  ["/admin.js", ["admin.js", "text/javascript; charset=utf-8"]],
  ["/admin-page.txt", ["admin-page.txt", "text/plain; charset=utf-8"]],
  ["/admin-login-page.txt", ["admin-login-page.txt", "text/plain; charset=utf-8"]],
  ["/admin-login.js", ["admin-login.js", "text/javascript; charset=utf-8"]],
  ["/robots.txt", ["robots.txt", "text/plain; charset=utf-8"]],
  ["/sitemap.xml", ["sitemap.xml", "application/xml; charset=utf-8"]]
]);

const env = {
  DB: new D1(),
  ADMIN_CREDENTIALS: JSON.stringify({
    "admin@example.com": "Local-Court-Admin-2026",
    "editor@example.com": "Local-Court-Editor-2026"
  }),
  ADMIN_SESSION_SECRET: "local-integration-session-secret-32-characters",
  ASSETS: {
    fetch: async (request) => {
      const pathname = new URL(request.url).pathname;
      const asset = assets.get(pathname);
      if (!asset) return new Response("Not found", { status: 404 });
      return new Response(await readFile(new URL(asset[0], root)), { headers: { "Content-Type": asset[1] } });
    }
  }
};

const server = http.createServer(async (incoming, outgoing) => {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const request = new Request(`http://127.0.0.1:4173${incoming.url}`, {
    method: incoming.method,
    headers: incoming.headers,
    body: ["GET", "HEAD"].includes(incoming.method) ? undefined : body
  });
  const response = await worker.fetch(request, env);
  outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(4173, "127.0.0.1", () => console.log("CHS Courts test server: http://127.0.0.1:4173"));
