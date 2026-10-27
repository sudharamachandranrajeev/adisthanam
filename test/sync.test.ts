// adisthanam sync: the rules on their own, then apply, status and quarantine
// against two real, throwaway Syncthing instances that sync to each other on
// loopback (their own homes and ports, no discovery servers they can reach),
// never the one on this computer.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { apply, checkPlan, findRepos, folderProblems, ignoreText, quarantine, quarantineStrays, status, validDeviceId, type Plan } from "../src/sync.ts";

// Anything that forgets its own Syncthing home fails here instead of
// reaching the real one on this computer.
process.env.ADISTHANAM_SYNCTHING_HOME = join(tmpdir(), "adisthanam-sync-test-no-such-syncthing");

const home = homedir();
const ST = join(home, ".local/state/syncthing");
// A real device ID (Syncthing's documentation example) and the same with one typo.
const PEER = "P56IOI7-MZJNU2Y-IQGDREY-DM2MGTI-MGL3BXN-PQ6W5BM-TBBZ4TJ-XZWICQ2";
const TYPO = "P56IOI7-MZJNU2Y-IQGDREY-DM2MGTI-MGL3BXN-PQ6W5BM-TBBZ4TJ-XZWICQ3";
const L = ["tcp://192.0.2.10:22000"];

test("each folder needs its own path, and nesting needs the outer one to leave it out", () => {
  const f = (id: string, path: string, ignore: string[] = []) => ({ id, path, ignore });
  assert.match(folderProblems([f("a", "/srv/x"), f("b", "/srv/x")], ST).join(), /both use \/srv\/x/);
  assert.match(folderProblems([f("outer", "/srv/x"), f("inner", "/srv/x/y")], ST).join(), /inside outer; add "\/y"/);
  assert.deepEqual(folderProblems([f("outer", "/srv/x", ["/y"]), f("inner", "/srv/x/y")], ST), []);
  assert.deepEqual(folderProblems([f("a", "/srv/x"), f("b", "/srv/xy")], ST), [], "a shared prefix is not nesting");
});

test("secrets, Adisthanam's data and Syncthing's own state are never synced", () => {
  const one = (path: string) => folderProblems([{ id: "f", path, ignore: [] }], ST).join();
  assert.match(one("~"), /syncs all of/);
  assert.match(one("~/.ssh"), /never be synced/);
  assert.match(one("~/.gnupg/x"), /never be synced/);
  assert.match(one("~/.claude"), /contains .*credentials\.json/);
  assert.match(one(ST), /never be synced/);
  assert.match(one("/var/lib/adisthanam"), /never be synced/);
  assert.match(one("/var/lib"), /contains \/var\/lib\/adisthanam/);
  assert.equal(one("~/.claude/projects"), "");
  assert.equal(one("~/Work"), "");
});

test("a plan is checked for the computer it runs on, before anything changes", () => {
  const plan = (p: Partial<Plan>): Plan => ({ devices: { me: { id: PEER, addresses: ["dynamic"] } }, folders: {}, ...p });
  assert.doesNotThrow(() => checkPlan(plan({}), "me", ST, L));
  assert.throws(() => checkPlan(plan({}), "someone", ST, L), /not in the plan/);
  assert.throws(() => checkPlan(plan({}), "me", ST, ["default"]), /one fixed IP/);
  assert.throws(() => checkPlan(plan({}), "me", ST, ["tcp://0.0.0.0:22000"]), /one fixed IP/);
  assert.throws(() => checkPlan(plan({ devices: { me: { id: "nope", addresses: [] } } }), "me", ST, L), /not a Syncthing device ID/);
  assert.equal(validDeviceId(PEER), true);
  assert.throws(() => checkPlan(plan({ devices: { me: { id: TYPO, addresses: [] } } }), "me", ST, L), /not a Syncthing device ID/);
  const ssh = { f: { label: "F", paths: { me: "~/.ssh" }, devices: ["me"] } };
  assert.throws(() => checkPlan(plan({ folders: ssh }), "me", ST, L), /never be synced/);
  assert.throws(() => checkPlan(plan({ folders: { f: { label: "F", paths: { other: "~/x" }, devices: ["me"] } } }), "me", ST, L), /no path for me/);
  // A folder this computer does not share is not its concern.
  const two = { me: { id: PEER, addresses: [] }, other: { id: PEER, addresses: [] } };
  const elsewhere = { f: { label: "F", paths: { other: "C:\\Users\\x\\Work" }, devices: ["other"] } };
  assert.doesNotThrow(() => checkPlan(plan({ devices: two, folders: elsewhere }), "me", ST, L));
});

test("the managed ignore block is replaced; your own lines stay", () => {
  const first = ignoreText("my-own-file\r\n", ["(?d)build", ".git"]);
  assert.match(first, /^\/\/ BEGIN adisthanam[^\n]*\n\(\?d\)build\n\.git\n\/\/ END adisthanam\n\nmy-own-file\n$/);
  const again = ignoreText(first, ["node_modules"]);
  assert.match(again, /node_modules/);
  assert.doesNotMatch(again, /\.git/);
  assert.match(again, /my-own-file/);
  assert.equal(ignoreText(again, ["node_modules"]), again);
});

test("without its own Syncthing home a test cannot reach the real one", async () => {
  await assert.rejects(status(null), /No Syncthing configuration at .*no-such-syncthing/);
});

// --- two real Syncthings ---------------------------------------------------------

const have = (() => {
  try {
    execFileSync("syncthing", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const skip = have ? false : "syncthing is not installed";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

type Node = { name: string; home: string; gui: number; listen: number; id: string; key: string; proc: ChildProcess };
let base = "";
const nodes: Node[] = [];
const env = () => ({ ...process.env, STNODEFAULTFOLDER: "1", STNOUPGRADE: "1", STNOBROWSER: "1" });

async function startNode(name: string): Promise<Node> {
  const home = join(base, name);
  const gui = await freePort(), listen = await freePort();
  execFileSync("syncthing", ["generate", `--home=${home}`, "--no-port-probing"], { env: env(), stdio: "ignore" });
  // Out of the box, but unable to reach the internet: discovery pointed at a
  // closed local port, no relay listener, no LAN broadcast or UPnP.
  let xml = readFileSync(join(home, "config.xml"), "utf8");
  xml = xml
    .replace(/(<gui\b[^>]*>\s*<address>)[^<]*/, `$1127.0.0.1:${gui}`)
    .replace(/<listenAddress>[^<]*<\/listenAddress>/g, "")
    .replace("<options>", `<options><listenAddress>tcp://127.0.0.1:${listen}</listenAddress>`)
    .replace(/<globalAnnounceServer>[^<]*<\/globalAnnounceServer>/g, "")
    .replace("<options>", "<options><globalAnnounceServer>http://127.0.0.1:9</globalAnnounceServer>")
    .replace(/<localAnnounceEnabled>true</, "<localAnnounceEnabled>false<")
    .replace(/<natEnabled>true</, "<natEnabled>false<");
  writeFileSync(join(home, "config.xml"), xml);
  const key = /<apikey>([^<]+)<\/apikey>/.exec(xml)![1];
  const proc = spawn("syncthing", ["serve", `--home=${home}`, "--no-browser"], { env: env(), stdio: "ignore", detached: true });
  let id = "";
  for (let i = 0; i < 80 && !id; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${gui}/rest/system/status`, { headers: { "X-API-Key": key } });
      if (r.ok) id = (await r.json()).myID;
    } catch {
      // not up yet
    }
    if (!id) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(id, `test Syncthing ${name} did not start`);
  assert.equal(validDeviceId(id), true, "a generated ID passes the check");
  const n = { name, home, gui, listen, id, key, proc };
  nodes.push(n);
  return n;
}

const rest = async (n: Node, path: string) =>
  (await fetch(`http://127.0.0.1:${n.gui}${path}`, { headers: { "X-API-Key": n.key } })).json();

async function until(what: string, check: () => unknown, seconds = 60) {
  for (let i = 0; i < seconds * 4; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.fail(`timed out waiting for ${what}`);
}

let a: Node, b: Node;
before(async () => {
  if (skip) return;
  base = mkdtempSync(join(tmpdir(), "adisthanam-sync-"));
  a = await startNode("a");
  b = await startNode("b");
});

after(() => {
  for (const n of nodes) {
    try {
      process.kill(-n.proc.pid!, "SIGTERM");
    } catch {
      // already gone
    }
  }
  if (base) rmSync(base, { recursive: true, force: true });
});

const planFor = (folders: Plan["folders"]): Plan => ({
  guiUser: "admin",
  devices: {
    a: { id: a.id, addresses: [`tcp://127.0.0.1:${a.listen}`], listen: [`tcp://127.0.0.1:${a.listen}`] },
    b: { id: b.id, addresses: [`tcp://127.0.0.1:${b.listen}`], listen: [`tcp://127.0.0.1:${b.listen}`] },
  },
  folders,
  ignore: ["(?d)build", ".git", "/API keys"],
});
const opt = (n: Node) => ({ home: n.home, passwordFile: join(base, `${n.name}-gui-password`) });

test("apply hardens Syncthing, finds itself in the plan, and a second run changes nothing", { skip }, async () => {
  const before = await status(null, { home: a.home });
  assert.equal(before.ok, false);
  assert.match(before.lines.join("\n"), /no password/);

  const outer = join(base, "a-outer");
  mkdirSync(outer, { recursive: true });
  writeFileSync(join(outer, ".stignore"), "my-own-pattern\n");
  const plan = planFor({
    alpha: { label: "Alpha", paths: { a: outer }, devices: ["a"], ignore: ["/inner"] },
    beta: { label: "Beta", paths: { a: join(outer, "inner") }, devices: ["a"], paused: true },
  });
  const changes = await apply(plan, opt(a));
  assert.ok(changes.some((c) => c.startsWith("options:")));
  assert.ok(changes.some((c) => c.startsWith("GUI:")));
  assert.ok(changes.includes("device b: added"));
  assert.ok(changes.some((c) => c.startsWith("folder beta: added") && c.endsWith("(paused)")));

  assert.equal(statSync(opt(a).passwordFile).mode & 0o777, 0o600);
  const cfg = await rest(a, "/rest/config");
  assert.equal(cfg.options.globalAnnounceEnabled, false);
  assert.equal(cfg.options.relaysEnabled, false);
  assert.equal(cfg.options.crashReportingEnabled, false);
  assert.deepEqual(cfg.options.listenAddresses, [`tcp://127.0.0.1:${a.listen}`]);
  assert.match(cfg.gui.password, /^\$2[aby]\$/, "the GUI password is stored as a bcrypt hash");
  const peer = cfg.devices.find((d: any) => d.deviceID === b.id);
  assert.deepEqual([peer.autoAcceptFolders, peer.introducer], [false, false]);
  const alpha = cfg.folders.find((f: any) => f.id === "alpha");
  assert.deepEqual([alpha.versioning.type, alpha.versioning.params.maxAge], ["staggered", String(30 * 86400)]);
  assert.equal(cfg.folders.find((f: any) => f.id === "beta").paused, true);
  const ignore = readFileSync(join(outer, ".stignore"), "utf8");
  assert.match(ignore, /\/inner/);
  assert.match(ignore, /my-own-pattern/);

  assert.deepEqual(await apply(plan, opt(a)), []);
  const after = await status(plan, { home: a.home });
  assert.equal(after.ok, true, after.lines.join("\n"));
  assert.match(after.lines[0], /This computer: a/);
});

test("a folder at the wrong path is moved without deleting a file", { skip }, async () => {
  const wrong = join(base, "wrong"), right = join(base, "right");
  mkdirSync(wrong, { recursive: true });
  writeFileSync(join(wrong, "keep-me.txt"), "still here");
  const plan = planFor({ moved: { label: "Moved", paths: { a: wrong }, devices: ["a"] } });
  await apply(plan, opt(a));

  plan.folders.moved.paths.a = right;
  const dry = await apply(plan, { ...opt(a), dry: true });
  assert.ok(dry.some((c) => c.includes("moved from") && c.includes("no files deleted")));
  const changes = await apply(plan, opt(a));
  assert.ok(changes.some((c) => c.startsWith("folder moved: moved from")));
  assert.equal(readFileSync(join(wrong, "keep-me.txt"), "utf8"), "still here");
  assert.ok(existsSync(join(right, ".stignore")));
  assert.deepEqual(await apply(plan, opt(a)), []);
});

test("one plan on two computers: they sync, and quarantine moves only what the other one sent", { skip }, async () => {
  const da = join(base, "shared-a"), db = join(base, "shared-b");
  const plan = planFor({ shared: { label: "Shared", paths: { a: da, b: db }, devices: ["a", "b"] } });
  await apply(plan, opt(a));
  await apply(plan, opt(b));
  assert.match((await status(plan, { home: b.home })).lines[0], /This computer: b/);

  writeFileSync(join(db, "from-b.txt"), "b wrote this");
  mkdirSync(join(db, "b-dir"));
  writeFileSync(join(db, "b-dir", "x.txt"), "x");
  writeFileSync(join(da, "mine.txt"), "a wrote this");
  writeFileSync(join(da, "API keys"), "never leaves a");
  await until("b's files on a", () => existsSync(join(da, "from-b.txt")) && existsSync(join(da, "b-dir/x.txt")));
  await until("a's file on b", () => existsSync(join(db, "mine.txt")));
  await until("a to index mine.txt", async () => (await rest(a, "/rest/db/file?folder=shared&file=mine.txt"))?.global?.modifiedBy);
  assert.equal(existsSync(join(db, "API keys")), false, "ignored files are not sent");

  const q = join(base, "quarantine");
  const dry = await quarantine(plan, "shared", "b", { home: a.home, dry: true, quarantineDir: q });
  assert.deepEqual(dry, ["b-dir", "from-b.txt"]);
  assert.equal(existsSync(q), false, "a dry run moves nothing");

  const moved = await quarantine(plan, "shared", "b", { home: a.home, quarantineDir: q });
  assert.deepEqual(moved, ["b-dir", "from-b.txt"]);
  assert.equal(readFileSync(join(q, "shared", "from-b.txt"), "utf8"), "b wrote this");
  assert.equal(readFileSync(join(q, "shared", "MANIFEST.txt"), "utf8"), "b-dir\nfrom-b.txt\n");
  assert.ok(existsSync(join(da, "mine.txt")) && existsSync(join(da, ".stignore")), "a's own files stay");
  assert.equal((await rest(a, "/rest/config/folders/shared")).paused, true);

  // Paused, so b loses nothing.
  await new Promise((r) => setTimeout(r, 3000));
  assert.ok(existsSync(join(db, "from-b.txt")) && existsSync(join(db, "b-dir/x.txt")));
  await assert.rejects(quarantine(plan, "shared", "b", { home: a.home, quarantineDir: q }), /paused/);

  // A second folder on the same path: moving would delete through it, so quarantine refuses.
  const key = { "X-API-Key": a.key, "content-type": "application/json" };
  const defaults = await rest(a, "/rest/config/defaults/folder");
  await fetch(`http://127.0.0.1:${a.gui}/rest/config/folders/twin`, { method: "PUT", headers: key, body: JSON.stringify({ ...defaults, id: "twin", path: da }) });
  await assert.rejects(quarantine(plan, "shared", "b", { home: a.home, quarantineDir: q }), /shares files with folder twin/);
  await fetch(`http://127.0.0.1:${a.gui}/rest/config/folders/twin`, { method: "DELETE", headers: key });
});

test("Git repositories are left to Git: listed or found, never synced", { skip }, async () => {
  const w = join(base, "work-repos");
  mkdirSync(join(w, "app", ".git"), { recursive: true });
  mkdirSync(join(w, "spikes", "feat-x"), { recursive: true });
  writeFileSync(join(w, "spikes", "feat-x", ".git"), "gitdir: elsewhere\n");
  mkdirSync(join(w, "app", "sub", ".git"), { recursive: true });
  mkdirSync(join(w, "notes"), { recursive: true });
  assert.deepEqual(findRepos(w), ["/app", "/spikes/feat-x"], "worktrees count; nothing inside a repository is searched");

  const plan = planFor({ w: { label: "W", paths: { a: w }, devices: ["a"], repos: ["/only-elsewhere"] } });
  await apply(plan, opt(a));
  const ignore = readFileSync(join(w, ".stignore"), "utf8");
  for (const r of ["/app", "/spikes/feat-x", "/only-elsewhere"]) assert.ok(ignore.split("\n").includes(r), r);
  assert.ok(!ignore.includes("/notes"));
  const s = (await status(plan, { home: a.home })).lines.join("\n");
  assert.match(s, /Git repository \/app is not in the plan's repos/);
  assert.match(s, /Git repository \/app has no remote/);
  plan.folders.w.repos = ["/app", "/only-elsewhere", "/spikes/feat-x"];
  assert.deepEqual(await apply(plan, opt(a)), [], "same lines, nothing to change");
  assert.doesNotMatch((await status(plan, { home: a.home })).lines.join("\n"), /not in the plan's repos/);
});

test("strays are ignored first, then moved out without a delete reaching the other side", { skip }, async () => {
  const da = join(base, "st-a"), db = join(base, "st-b");
  const plan = planFor({ s: { label: "S", paths: { a: da, b: db }, devices: ["a", "b"] } });
  await apply(plan, opt(a));
  await apply(plan, opt(b));
  writeFileSync(join(db, "Not Mine"), "b's stray");
  mkdirSync(join(db, "keep"));
  writeFileSync(join(db, "keep", "k.txt"), "k");
  await until("b's files on a", () => existsSync(join(da, "Not Mine")) && existsSync(join(da, "keep/k.txt")));

  plan.folders.s.strays = ["Not Mine"];
  const q = join(base, "q-strays");
  await assert.rejects(quarantineStrays(plan, "s", { home: a.home, quarantineDir: q }), /does not ignore these yet/);
  await apply(plan, opt(a));
  await until("a to load the ignore", async () => (await rest(a, "/rest/db/ignores?folder=s")).ignore?.includes("/Not Mine"));
  assert.deepEqual(await quarantineStrays(plan, "s", { home: a.home, quarantineDir: q }), ["Not Mine"]);
  assert.equal(readFileSync(join(q, "s", "Not Mine"), "utf8"), "b's stray");
  assert.equal((await rest(a, "/rest/config/folders/s")).paused, false, "unpaused again");
  await new Promise((r) => setTimeout(r, 5000));
  assert.ok(existsSync(join(db, "Not Mine")), "b's copy is untouched: no delete was sent");
  assert.ok(existsSync(join(da, "keep/k.txt")), "the rest keeps syncing");
});

test("apply refuses a bad plan, and a computer missing from it, before touching Syncthing", { skip }, async () => {
  const plan = planFor({ x: { label: "X", paths: { a: join(home, ".ssh") }, devices: ["a"] } });
  await assert.rejects(apply(plan, opt(a)), /never be synced/);
  const stranger = planFor({});
  delete (stranger.devices as any).a;
  await assert.rejects(apply(stranger, opt(a)), /is not in the plan/);
});
