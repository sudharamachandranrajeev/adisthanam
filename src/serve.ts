// The Adisthanam server: the Brahma sync protocol (vendor/brahma, pinned in
// brahma.lock) on Node's built-in SQLite, listening on loopback only. Other
// devices reach it through the TLS front (tailscale serve), never directly.
//
// Run by systemd (adisthanam.service), which supplies $STATE_DIRECTORY and
// the decrypted credentials; see src/config.ts.
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { handle, type Env } from "../vendor/brahma/server/src/app.ts";
import { asD1, openDatabase } from "../vendor/brahma/server/src/sqlite.ts";
import { loadConfig } from "./config.ts";

export const VERSION = "0.1.0";
const MAX_BODY = 3_000_000;

const cfg = loadConfig();
const db = openDatabase(join(cfg.state, "brahma.db"));
const stamp = join(cfg.state, "last-backup");

const env: Env = {
  DB: asD1(db),
  TOKEN_KEY: cfg.tokenKey,
  SETUP_CODE: cfg.setupCode || undefined,
  KIND: "home",
  NAME: cfg.name,
  // Written by the backup job (bin/collect-backups) after each verified backup.
  lastBackup: () => (existsSync(stamp) ? readFileSync(stamp, "utf8").trim() || null : null),
};

const loopback = (a: string | undefined) => a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
const local = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`, `[::1]:${cfg.port}`]);

/// The address rate limits are keyed on. The TLS front connects from
/// loopback and appends the device's tailnet address to X-Forwarded-For; the
/// last entry is the one it added, so a client cannot choose its own.
function clientAddress(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  const fwd = req.headers["x-forwarded-for"];
  if (loopback(peer) && typeof fwd === "string" && fwd.trim()) {
    return fwd.split(",").at(-1)!.trim();
  }
  return peer;
}

/// Only the names this server is published under: refuses DNS-rebinding
/// pages and anything that reached the port by another route.
function hostAllowed(host: string | undefined): boolean {
  const h = (host ?? "").toLowerCase();
  return local.has(h) || cfg.hosts.includes(h) || cfg.hosts.includes(h.replace(/:443$/, ""));
}

const server = createServer(async (req, res) => {
  if (!hostAllowed(req.headers.host)) {
    res.writeHead(421, { "content-type": "application/json" }).end('{"message":"Unknown host"}');
    req.resume();
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) {
      res.writeHead(413, { "content-type": "application/json" }).end('{"message":"Too large"}');
      req.destroy();
      return;
    }
    chunks.push(c as Buffer);
  }
  const method = req.method ?? "GET";
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    // The client address comes from clientAddress(), never from this header.
    if (k !== "cf-connecting-ip" && typeof v === "string") headers.set(k, v);
  }
  try {
    const out = await handle(
      new Request(`http://${cfg.bind}:${cfg.port}${req.url ?? "/"}`, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" || !chunks.length ? undefined : Buffer.concat(chunks),
      }),
      env,
      clientAddress(req),
    );
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(400).end();
  }
});
server.headersTimeout = 10_000;
server.requestTimeout = 60_000;
server.listen(cfg.port, cfg.bind, () => {
  console.log(`Adisthanam ${VERSION} listening on ${cfg.bind}:${cfg.port} (data in ${cfg.state})`);
});

const stop = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  server.closeAllConnections();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
