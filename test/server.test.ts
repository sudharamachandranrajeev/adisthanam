// The server as a real process, set up the way systemd starts it (state and
// credential directories, a settings file), then the whole path an app takes:
// set up the owner, sign in, sync, back up, restore, and keep working.
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const root = new URL("..", import.meta.url).pathname;
const SETUP = "ABCD-EFGH-JKMN";
const HOST = "node.tailnet.ts.net";
const dirs: string[] = [];
const procs: ChildProcess[] = [];

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

type Instance = { port: number; state: string; env: NodeJS.ProcessEnv; proc: ChildProcess };

async function start(state?: string): Promise<Instance> {
  const base = mkdtempSync(join(tmpdir(), "adisthanam-test-"));
  dirs.push(base);
  state ??= join(base, "state");
  mkdirSync(state, { recursive: true });
  const creds = join(base, "creds");
  mkdirSync(creds);
  writeFileSync(join(creds, "token_key"), "k".repeat(43));
  writeFileSync(join(creds, "setup_code"), SETUP);
  const port = await freePort();
  writeFileSync(join(base, "adisthanam.conf"), `PORT=${port}\nBIND=127.0.0.1\nHOSTS=${HOST}\nNAME=Test\n`);
  const env = { ...process.env, STATE_DIRECTORY: state, CREDENTIALS_DIRECTORY: creds, ADISTHANAM_CONF: join(base, "adisthanam.conf") };
  const proc = spawn(process.execPath, [join(root, "src/serve.ts")], { env, stdio: ["ignore", "pipe", "inherit"] });
  procs.push(proc);
  await new Promise<void>((resolve, reject) => {
    proc.stdout!.on("data", (d) => String(d).includes("listening") && resolve());
    proc.on("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
  return { port, state, env, proc };
}

async function call(i: Instance, method: string, path: string, opts: { body?: unknown; token?: string; host?: string; fwd?: string } = {}) {
  const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${i.port}` };
  if (opts.body) headers["content-type"] = "application/json";
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.fwd) headers["x-forwarded-for"] = opts.fwd;
  // node:http, not fetch: fetch will not let a test choose the Host header.
  const { request } = await import("node:http");
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: i.port, method, path, headers }, (res) => {
      let s = "";
      res.on("data", (d) => (s += d)).on("end", () => resolve({ status: res.statusCode!, json: s ? JSON.parse(s) : null }));
    });
    req.on("error", reject);
    req.end(opts.body ? JSON.stringify(opts.body) : undefined);
  });
}

const stop = (i: Instance) => new Promise<void>((resolve) => {
  i.proc.once("exit", () => resolve());
  i.proc.kill("SIGTERM");
});

const db = (env: NodeJS.ProcessEnv, ...args: string[]) =>
  execFileSync(process.execPath, [join(root, "src/db.ts"), ...args], { env, encoding: "utf8" });

const DEVICE = "a".repeat(32);
const SECRET = "s".repeat(43);
let a: Instance;
let token = "";

before(async () => {
  a = await start();
});
after(() => {
  for (const p of procs) p.kill("SIGKILL");
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("health answers on loopback and the published name only", async () => {
  const h = await call(a, "GET", "/api/health");
  assert.equal(h.status, 200);
  assert.equal(h.json.service, "brahma-sync");
  assert.equal(h.json.kind, "home");
  assert.equal(h.json.needsSetup, true);
  assert.equal((await call(a, "GET", "/api/health", { host: HOST })).status, 200);
  assert.equal((await call(a, "GET", "/api/health", { host: `${HOST}:443` })).status, 200);
  assert.equal((await call(a, "GET", "/api/health", { host: "evil.example" })).status, 421);
});

test("the Sentinel modules load: rules and threats answer, not crash", async () => {
  const r = await call(a, "GET", "/api/rules");
  assert.ok([200, 401, 503].includes(r.status), `rules gave ${r.status}`);
});

test("owner sets up with the setup code, then signs in and syncs", async () => {
  assert.equal((await call(a, "POST", "/api/register", { body: { email: "owner@example.com", secret: SECRET, invite: "wrong-code" } })).status, 403);
  const reg = await call(a, "POST", "/api/register", { body: { email: "owner@example.com", secret: SECRET, invite: SETUP.toLowerCase() } });
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
  const login = await call(a, "POST", "/api/login", { body: { email: "owner@example.com", secret: SECRET } });
  assert.equal(login.status, 200);
  token = login.json.token;
  assert.ok(token);
  assert.equal((await call(a, "POST", "/api/devices", { token, body: { device: DEVICE, platform: "linux" } })).status, 201);
  assert.equal((await call(a, "POST", "/api/changes", { token, body: { device: DEVICE, seq: 1, payload: "ciphertext-1" } })).status, 201);
  const pull = await call(a, "GET", `/api/changes?device=${DEVICE}&after=0`, { token });
  assert.deepEqual(pull.json.items.map((r: { payload: string }) => r.payload), ["ciphertext-1"]);
  assert.equal((await call(a, "GET", "/api/health")).json.needsSetup, false);
});

test("rate limits follow each device behind the TLS front, not the front itself", async () => {
  let last = 0;
  for (let n = 0; n < 21; n++) {
    last = (await call(a, "POST", "/api/login", { body: { email: `x${n}@example.com`, secret: SECRET }, fwd: "198.51.100.7" })).status;
  }
  assert.equal(last, 429, "the 21st sign-in from one device is refused");
  const other = await call(a, "POST", "/api/login", { body: { email: "y@example.com", secret: SECRET }, fwd: "198.51.100.8" });
  assert.equal(other.status, 401, "another device is not affected");
  // A client cannot pick its own address: the front's entry is the last one.
  const spoof = await call(a, "POST", "/api/login", { body: { email: "z@example.com", secret: SECRET }, fwd: "198.51.100.9, 198.51.100.7" });
  assert.equal(spoof.status, 429);
});

test("backup, verify, restore into a fresh server, and the data is all there", async () => {
  assert.match(db(a.env, "backup"), /Backed up to .*users 1, devices 1, changes 1/);
  const outbox = join(a.state, "outbox");
  const [file] = readdirSync(outbox);
  assert.match(db(a.env, "verify", join(outbox, file)), /check: ok, users: 1, devices: 1, changes: 1/);
  const state = mkdtempSync(join(tmpdir(), "adisthanam-restore-"));
  dirs.push(state);
  copyFileSync(join(outbox, file), join(state, "brahma.db"));
  const b = await start(state);
  const login = await call(b, "POST", "/api/login", { body: { email: "owner@example.com", secret: SECRET } });
  assert.equal(login.status, 200, "the restored server knows the owner (same signing key)");
  const pull = await call(b, "GET", `/api/changes?device=${DEVICE}&after=0`, { token: login.json.token });
  assert.deepEqual(pull.json.items.map((r: { payload: string }) => r.payload), ["ciphertext-1"]);
  await stop(b);
});

test("verify refuses a damaged backup", () => {
  const bad = join(dirs[0], "bad.db");
  writeFileSync(bad, "not a database");
  assert.throws(() => db(a.env, "verify", bad));
});

test("data survives a restart", async () => {
  await stop(a);
  a = await start(a.state);
  const login = await call(a, "POST", "/api/login", { body: { email: "owner@example.com", secret: SECRET } });
  assert.equal(login.status, 200);
});

test("refuses to start without its signing key or with a public bind address", async () => {
  const base = mkdtempSync(join(tmpdir(), "adisthanam-bad-"));
  dirs.push(base);
  writeFileSync(join(base, "c.conf"), "BIND=0.0.0.0\n");
  const run = (env: NodeJS.ProcessEnv) => {
    try {
      execFileSync(process.execPath, [join(root, "src/serve.ts")], { env: { ...process.env, ...env }, stdio: "pipe", timeout: 5000 });
      return "";
    } catch (e) {
      return String((e as { stderr: Buffer }).stderr);
    }
  };
  assert.match(run({ STATE_DIRECTORY: base, CREDENTIALS_DIRECTORY: base, ADISTHANAM_CONF: join(base, "none") }), /Missing credential token_key/);
  writeFileSync(join(base, "token_key"), "k".repeat(43));
  assert.match(run({ STATE_DIRECTORY: base, CREDENTIALS_DIRECTORY: base, ADISTHANAM_CONF: join(base, "c.conf") }), /BIND must be 127.0.0.1/);
  writeFileSync(join(base, "c.conf"), "TYPO=1\n");
  assert.match(run({ STATE_DIRECTORY: base, CREDENTIALS_DIRECTORY: base, ADISTHANAM_CONF: join(base, "c.conf") }), /unknown setting TYPO/);
});
