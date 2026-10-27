// Syncthing for your own computers, kept to one written plan: `adisthanam
// sync status` checks this computer's Syncthing against the rules below and
// the plan; `adisthanam sync apply` brings it to the plan through Syncthing's
// own local API; `adisthanam sync quarantine` moves what one device wrongly
// sent into a folder out of it. Nothing here deletes a file, and a plan that
// could lose data or leak this computer's secrets is refused.
//
// The same plan file serves every computer: each finds itself in it by its
// Syncthing device ID. It is personal and lives only on your computers, in
// ~/.config/adisthanam/sync.json (see docs/sync.md). Syncthing runs as you,
// so so does this: no sudo. Linux and Windows.
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export type Plan = {
  /// The GUI user; the password is made once and kept in the password file.
  guiUser?: string;
  devices: Record<
    string,
    {
      id: string;
      /// Where the others dial it: tcp://name.example.com:22000 (its Tailscale name), or "dynamic".
      addresses: string[];
      /// Where it listens. Default: its Tailscale IPv4 (`tailscale ip -4`), TCP and QUIC, port 22000.
      listen?: string[];
    }
  >;
  folders: Record<
    string,
    {
      label: string;
      /// The folder's path on each computer that has it.
      paths: Record<string, string>;
      /// The computers that share it; each shares it with all the others.
      devices: string[];
      /// Extra .stignore lines for this folder, after the shared [ignore].
      ignore?: string[];
      paused?: boolean;
    }
  >;
  /// .stignore lines for every folder.
  ignore?: string[];
  /// Days deleted and replaced files are kept (staggered versioning). Default 30.
  versionDays?: number;
};

const home = homedir();
const expand = (p: string) => resolve(p.startsWith("~/") ? join(home, p.slice(2)) : p === "~" ? home : p);
const inside = (child: string, parent: string) => {
  const r = relative(parent, child);
  return r === "" || (!!r && !r.startsWith("..") && !isAbsolute(r));
};
const DEVICE_ID = /^([A-Z2-7]{7}-){7}[A-Z2-7]{7}$/;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BEGIN = "// BEGIN adisthanam: managed block, change ~/.config/adisthanam/sync.json instead";
const END = "// END adisthanam";
/// Syncthing's own files in a folder; never moved.
const OWN = new Set([".stfolder", ".stignore", ".stversions", ".stfolder.removed-by-syncthing"]);

/// A Syncthing device ID with right check characters (each 14-character
/// chunk ends in a Luhn mod 32 digit), so a typo fails before anything changes.
export function validDeviceId(id: string): boolean {
  if (!DEVICE_ID.test(id)) return false;
  const raw = id.replace(/-/g, "");
  for (let c = 0; c < 4; c++) {
    const chunk = raw.slice(c * 14, c * 14 + 14);
    let factor = 1, sum = 0;
    for (const ch of chunk.slice(0, 13)) {
      let addend = factor * B32.indexOf(ch);
      factor = factor === 2 ? 1 : 2;
      addend = Math.floor(addend / 32) + (addend % 32);
      sum += addend;
    }
    if (B32[(32 - (sum % 32)) % 32] !== chunk[13]) return false;
  }
  return true;
}

/// Where Syncthing keeps its configuration on this computer.
export function defaultSyncthingHome(): string {
  if (process.env.ADISTHANAM_SYNCTHING_HOME) return process.env.ADISTHANAM_SYNCTHING_HOME;
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(home, "AppData/Local"), "Syncthing");
  const state = join(home, ".local/state/syncthing");
  return existsSync(join(state, "config.xml")) ? state : join(home, ".config/syncthing");
}

/// This computer's Tailscale IPv4, for TCP and QUIC on port 22000.
function tailscaleListen(): string[] {
  let ip = "";
  try {
    ip = execFileSync("tailscale", ["ip", "-4"], { encoding: "utf8", timeout: 10_000 }).trim().split("\n")[0];
  } catch {
    // reported below
  }
  if (!/^100\.\d+\.\d+\.\d+$/.test(ip)) {
    throw new Error("Could not read this computer's Tailscale address (tailscale ip -4). Is Tailscale on and signed in?");
  }
  return [`tcp://${ip}:22000`, `quic://${ip}:22000`];
}

/// Places no synced folder may be, or hold: keys, Adisthanam's data and
/// backups, Syncthing's own state.
export function sensitivePaths(syncthingHome: string): string[] {
  return [
    join(home, ".ssh"),
    join(home, ".gnupg"),
    join(home, ".password-store"),
    join(home, ".claude/.credentials.json"),
    join(home, ".local/state/adisthanam"),
    syncthingHome,
    "/etc",
    "/var/lib/adisthanam",
    "/var/backups/adisthanam",
    "/etc/credstore.encrypted",
  ];
}

export type Folder = { id: string; path: string; ignore: string[] };

/// The rules every folder set must keep, whether from the plan or found in
/// Syncthing. Returns what is wrong, in plain words; empty means fine.
export function folderProblems(folders: Folder[], syncthingHome: string): string[] {
  const out: string[] = [];
  for (const f of folders) {
    const p = expand(f.path);
    if (p === home || p === resolve("/")) out.push(`${f.id}: syncs all of ${p}; pick a folder inside it`);
    for (const s of sensitivePaths(syncthingHome)) {
      if (inside(p, s)) out.push(`${f.id}: ${p} is inside ${s}, which must never be synced`);
      else if (inside(s, p) && p !== home) out.push(`${f.id}: ${p} contains ${s}, which must never be synced`);
    }
  }
  for (const a of folders) {
    for (const b of folders) {
      if (a === b) continue;
      const pa = expand(a.path), pb = expand(b.path);
      if (pa === pb) {
        if (a.id < b.id) out.push(`${a.id} and ${b.id} both use ${pa}: each folder needs its own path`);
      } else if (inside(pa, pb)) {
        // Allowed only when the outer folder leaves the inner one out.
        const rel = "/" + relative(pb, pa).split("\\").join("/");
        if (!b.ignore.includes(rel)) out.push(`${a.id} (${pa}) is inside ${b.id}; add "${rel}" to ${b.id}'s ignore list`);
      }
    }
  }
  return out;
}

const LISTEN = /^(tcp|quic):\/\/(\[[0-9a-f:]+\]|[0-9.]+):(\d+)$/;

/// Checks the plan as it applies to [self]; throws with every problem found.
export function checkPlan(plan: Plan, self: string, syncthingHome: string, listen: string[]): void {
  const out: string[] = [];
  if (!plan.devices?.[self]) out.push(`device "${self}" is not in the plan`);
  for (const [name, d] of Object.entries(plan.devices ?? {})) {
    if (!validDeviceId(d.id)) out.push(`device ${name}: "${d.id}" is not a Syncthing device ID`);
    for (const a of d.addresses ?? []) {
      if (a !== "dynamic" && !/^(tcp|quic):\/\/[^/\s]+:\d+$/.test(a)) out.push(`device ${name}: address "${a}" must be tcp://host:port`);
    }
  }
  if (!listen.length) out.push(`${self}: no address to listen on`);
  for (const l of listen) {
    const m = LISTEN.exec(l);
    if (!m || ["0.0.0.0", "[::]"].includes(m[2])) out.push(`${self}: listen "${l}" must be tcp:// or quic:// on one fixed IP address`);
  }
  const folders: Folder[] = [];
  for (const [id, f] of Object.entries(plan.folders ?? {})) {
    for (const d of f.devices) if (!plan.devices[d]) out.push(`folder ${id}: unknown device ${d}`);
    if (!f.devices.includes(self)) continue;
    const path = f.paths?.[self];
    if (!path) {
      out.push(`folder ${id}: no path for ${self}`);
      continue;
    }
    folders.push({ id, path, ignore: [...(plan.ignore ?? []), ...(f.ignore ?? [])] });
  }
  out.push(...folderProblems(folders, syncthingHome));
  if (out.length) throw new Error(`The sync plan has problems:\n  - ${out.join("\n  - ")}`);
}

/// .stignore text: the user's own lines kept, the managed block replaced.
export function ignoreText(existing: string, managed: string[]): string {
  const lines = existing.replace(/\r\n/g, "\n").split("\n");
  const start = lines.indexOf(BEGIN), end = lines.indexOf(END);
  const own = start >= 0 && end > start ? [...lines.slice(0, start), ...lines.slice(end + 1)] : lines;
  const kept = own.join("\n").trim();
  return [BEGIN, ...managed, END, ...(kept ? ["", kept] : [])].join("\n") + "\n";
}

// --- Syncthing's local API ---------------------------------------------------

type Api = { base: string; key: string };

export function connect(syncthingHome: string): Api {
  const file = join(syncthingHome, "config.xml");
  if (!existsSync(file)) throw new Error(`No Syncthing configuration at ${file}. Is Syncthing installed and started once?`);
  const xml = readFileSync(file, "utf8");
  const gui = /<gui\b[^>]*>([\s\S]*?)<\/gui>/.exec(xml)?.[1] ?? "";
  const address = /<address>([^<]+)<\/address>/.exec(gui)?.[1] ?? "";
  const key = /<apikey>([^<]+)<\/apikey>/.exec(gui)?.[1] ?? "";
  const tls = /<gui\b[^>]*\btls="true"/.test(xml);
  if (!/^(127\.0\.0\.1|\[::1\]|localhost):\d+$/.test(address)) {
    throw new Error(`Syncthing's GUI listens on "${address}"; it must be 127.0.0.1 only. Fix it in ${file} first.`);
  }
  if (!key) throw new Error(`Syncthing has no API key in ${file}`);
  return { base: `${tls ? "https" : "http"}://${address}`, key };
}

async function call(api: Api, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(api.base + path, {
    method,
    headers: { "X-API-Key": api.key, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Syncthing ${method} ${path}: ${res.status} ${(await res.text()).trim()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function waitUp(api: Api): Promise<void> {
  await new Promise((r) => setTimeout(r, 1500));
  for (let i = 0; i < 60; i++) {
    try {
      await call(api, "GET", "/rest/system/ping");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("Syncthing did not come back after its restart; see its log");
}

/// This computer's name in the plan, found by its Syncthing device ID.
async function whoAmI(api: Api, plan: Plan): Promise<{ self: string; myID: string }> {
  const { myID } = await call(api, "GET", "/rest/system/status");
  const self = Object.entries(plan.devices ?? {}).find(([, d]) => d.id === myID)?.[0];
  if (!self) throw new Error(`This computer's Syncthing (device ${myID}) is not in the plan; add it to "devices" first.`);
  return { self, myID };
}

const HARDENED = {
  globalAnnounceEnabled: false,
  localAnnounceEnabled: false,
  relaysEnabled: false,
  natEnabled: false,
  crashReportingEnabled: false,
  urAccepted: -1,
  startBrowser: false,
} as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/// The rules Syncthing's live configuration breaks, plan or not.
export function liveProblems(cfg: any, syncthingHome: string): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(HARDENED)) {
    if (k !== "urAccepted" && cfg.options[k] !== v) out.push(`option ${k} is ${cfg.options[k]}, must be ${v}`);
  }
  if (cfg.options.urAccepted > 0) out.push("usage reporting is on");
  for (const l of cfg.options.listenAddresses) {
    if (l === "default" || /:\/\/(0\.0\.0\.0|\[::\]|):/.test(l)) out.push(`listens on all addresses (${l}); use the Tailscale address only`);
  }
  if (!cfg.gui.user || !cfg.gui.password) out.push("the Syncthing GUI has no password: anyone on this computer can use it");
  for (const d of cfg.devices) {
    if (d.autoAcceptFolders) out.push(`device ${d.name}: accepts folders by itself`);
    if (d.introducer) out.push(`device ${d.name}: is an introducer (may add devices on its own)`);
  }
  const ignores = (path: string) => {
    const file = join(expand(path), ".stignore");
    return existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()) : [];
  };
  out.push(...folderProblems(cfg.folders.map((f: any) => ({ id: f.id, path: f.path, ignore: ignores(f.path) })), syncthingHome));
  return out;
}

export type Options = { dry?: boolean; home?: string; passwordFile?: string; quarantineDir?: string };

/// Brings this computer's Syncthing to the plan. Returns what changed (or would, with [dry]).
export async function apply(plan: Plan, opts: Options = {}): Promise<string[]> {
  const stHome = opts.home ?? defaultSyncthingHome();
  const api = connect(stHome);
  const { self, myID } = await whoAmI(api, plan);
  const listen = plan.devices[self].listen ?? tailscaleListen();
  checkPlan(plan, self, stHome, listen);
  const cfg = await call(api, "GET", "/rest/config");
  const changes: string[] = [];
  const act = async (what: string, run: () => Promise<unknown>) => {
    changes.push(what);
    if (!opts.dry) await run();
  };

  const options: Record<string, unknown> = { ...HARDENED, listenAddresses: listen };
  const optDiff = Object.fromEntries(Object.entries(options).filter(([k, v]) => !same(cfg.options[k], v)));
  if (Object.keys(optDiff).length) {
    await act(`options: ${Object.keys(optDiff).join(", ")}`, () => call(api, "PATCH", "/rest/config/options", optDiff));
  }

  if (!cfg.gui.user || !cfg.gui.password) {
    const file = opts.passwordFile ?? join(home, ".local/state/adisthanam/sync-gui-password");
    await act(`GUI: user and password set (password in ${file})`, async () => {
      const password = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
      mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(file, password + "\n", { mode: 0o600 });
      chmodSync(file, 0o600);
      await call(api, "PATCH", "/rest/config/gui", { user: plan.guiUser ?? "admin", password });
      // Syncthing restarts its GUI and API to take a new password.
      await waitUp(api);
    });
  }

  for (const [name, d] of Object.entries(plan.devices)) {
    if (d.id === myID) continue;
    const want = { deviceID: d.id, name, addresses: d.addresses, autoAcceptFolders: false, introducer: false };
    const have = cfg.devices.find((x: any) => x.deviceID === d.id);
    if (!have) {
      const defaults = await call(api, "GET", "/rest/config/defaults/device");
      await act(`device ${name}: added`, () => call(api, "PUT", `/rest/config/devices/${d.id}`, { ...defaults, ...want }));
    } else {
      const diff = Object.fromEntries(Object.entries(want).filter(([k, v]) => !same(have[k], v)));
      if (Object.keys(diff).length) {
        await act(`device ${name}: ${Object.keys(diff).join(", ")}`, () => call(api, "PATCH", `/rest/config/devices/${d.id}`, diff));
      }
    }
  }

  const days = plan.versionDays ?? 30;
  const versioning = { type: "staggered", params: { maxAge: String(days * 86400), cleanInterval: "3600" }, cleanupIntervalS: 3600, fsPath: "", fsType: "basic" };
  for (const [id, f] of Object.entries(plan.folders)) {
    if (!f.devices.includes(self)) continue;
    const path = expand(f.paths[self]);
    const managed = [...(plan.ignore ?? []), ...(f.ignore ?? [])];
    const ignoreFile = join(path, ".stignore");
    const before = existsSync(ignoreFile) ? readFileSync(ignoreFile, "utf8") : "";
    const after = ignoreText(before, managed);
    // Before the folder is added, so its first scan already leaves these out.
    if (before !== after) {
      await act(`folder ${id}: ignore list in ${ignoreFile}`, async () => {
        mkdirSync(path, { recursive: true, mode: 0o700 });
        writeFileSync(ignoreFile, after);
      });
    }
    const want = {
      id,
      label: f.label,
      path,
      type: "sendreceive",
      devices: f.devices.map((n) => plan.devices[n].id).sort().map((deviceID) => ({ deviceID })),
      paused: f.paused ?? false,
      versioning,
    };
    const have = cfg.folders.find((x: any) => x.id === id);
    if (have && expand(have.path) !== path) {
      // A changed path would read as "every file deleted" to the other
      // devices. Removing the folder and adding it again at the new path
      // sends no deletes: the old files stay where they are, untouched.
      await act(`folder ${id}: moved from ${have.path} to ${path} (removed and added again; no files deleted)`, async () => {
        await call(api, "DELETE", `/rest/config/folders/${id}`);
        const defaults = await call(api, "GET", "/rest/config/defaults/folder");
        await call(api, "PUT", `/rest/config/folders/${id}`, { ...defaults, ...want });
      });
    } else if (!have) {
      await act(`folder ${id}: added at ${path}${want.paused ? " (paused)" : ""}`, async () => {
        mkdirSync(path, { recursive: true, mode: 0o700 });
        const defaults = await call(api, "GET", "/rest/config/defaults/folder");
        await call(api, "PUT", `/rest/config/folders/${id}`, { ...defaults, ...want });
      });
    } else {
      const shape = (x: any) => ({
        label: x.label,
        type: x.type,
        devices: x.devices.map((d: any) => d.deviceID).sort(),
        paused: x.paused,
        versioning: [x.versioning?.type, x.versioning?.params?.maxAge],
      });
      const a = shape(have), b = shape(want);
      const diff = Object.keys(b).filter((k) => !same((a as any)[k], (b as any)[k]));
      if (diff.length) {
        await act(`folder ${id}: ${diff.join(", ")}`, () =>
          call(api, "PATCH", `/rest/config/folders/${id}`, Object.fromEntries(diff.map((k) => [k, (want as any)[k]]))),
        );
      }
    }
  }

  if (!opts.dry && changes.length) {
    const r = await call(api, "GET", "/rest/config/restart-required");
    if (r?.requiresRestart) {
      changes.push("Syncthing restarted to use the new settings");
      await call(api, "POST", "/rest/system/restart");
      await waitUp(api);
    }
  }
  return changes;
}

/// Moves out of [folderId] the top-level entries that device [from] put
/// there last, into a dated quarantine folder outside every synced folder.
/// It reads Syncthing's records first (they cannot be read while the folder
/// is paused), then pauses the folder, then moves: nothing is deleted, and
/// the folder stays paused until the plan unpauses it.
export async function quarantine(plan: Plan, folderId: string, from: string, opts: Options = {}): Promise<string[]> {
  const stHome = opts.home ?? defaultSyncthingHome();
  const api = connect(stHome);
  const fromId = plan.devices[from]?.id;
  if (!fromId) throw new Error(`No device "${from}" in the plan`);
  const cfg = await call(api, "GET", "/rest/config");
  const folder = cfg.folders.find((f: any) => f.id === folderId);
  if (!folder) throw new Error(`This computer has no Syncthing folder "${folderId}"`);
  const path = expand(folder.path);
  if (folder.paused) {
    throw new Error(`Folder ${folderId} is paused, so its records cannot be read. It must be running to sort it; nothing was changed.`);
  }
  const short = fromId.slice(0, 7);
  const picked: string[] = [];
  for (const name of readdirSync(path).sort()) {
    if (OWN.has(name)) continue;
    const r = await fetch(`${api.base}/rest/db/file?folder=${encodeURIComponent(folderId)}&file=${encodeURIComponent(name)}`, {
      headers: { "X-API-Key": api.key },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) continue;
    if ((await r.json())?.global?.modifiedBy === short) picked.push(name);
  }
  if (opts.dry || !picked.length) return picked;

  await call(api, "PATCH", `/rest/config/folders/${encodeURIComponent(folderId)}`, { paused: true });
  const day = new Date().toISOString().slice(0, 10);
  const dir = join(opts.quarantineDir ?? join(home, `syncthing-quarantine-${day}`), folderId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of picked) {
    if (existsSync(join(dir, name))) throw new Error(`${join(dir, name)} already exists; moved so far are listed in ${join(dir, "MANIFEST.txt")}`);
    try {
      renameSync(join(path, name), join(dir, name));
    } catch (e) {
      // Never copy-then-delete: a half-done copy could lose data.
      if ((e as NodeJS.ErrnoException).code === "EXDEV") throw new Error(`${path} and ${dir} are on different drives; give --quarantine DIR on the same drive`);
      throw e;
    }
    appendFileSync(join(dir, "MANIFEST.txt"), `${name}\n`);
  }
  return picked;
}

/// What `status` prints, and whether everything is in order.
export async function status(plan: Plan | null, opts: Options = {}): Promise<{ lines: string[]; ok: boolean }> {
  const stHome = opts.home ?? defaultSyncthingHome();
  const api = connect(stHome);
  const [cfg, me, conns, stats, pendingDevices, pendingFolders] = await Promise.all([
    call(api, "GET", "/rest/config"),
    call(api, "GET", "/rest/system/status"),
    call(api, "GET", "/rest/system/connections"),
    call(api, "GET", "/rest/stats/device"),
    call(api, "GET", "/rest/cluster/pending/devices"),
    call(api, "GET", "/rest/cluster/pending/folders"),
  ]);
  const self = plan && Object.entries(plan.devices ?? {}).find(([, d]) => d.id === me.myID)?.[0];
  const lines: string[] = [`This computer: ${self ?? me.myID.slice(0, 7)}`];
  for (const d of cfg.devices) {
    if (d.deviceID === me.myID) continue;
    const c = conns.connections[d.deviceID];
    const seen = stats[d.deviceID]?.lastSeen?.slice(0, 16).replace("T", " ") ?? "never";
    lines.push(`  ${d.name}: ${d.paused ? "paused" : c?.connected ? `connected (${c.address})` : `not connected, last seen ${seen}`}`);
  }
  for (const f of cfg.folders) {
    let state = "paused";
    if (!f.paused) {
      const s = await call(api, "GET", `/rest/db/status?folder=${encodeURIComponent(f.id)}`);
      state = s.state + (s.needFiles ? `, ${s.needFiles} files to fetch` : "") + (s.errors ? `, ${s.errors} errors` : "");
    }
    lines.push(`  folder ${f.id} (${f.path}): ${state}`);
  }
  const problems = liveProblems(cfg, stHome);
  for (const id of Object.keys(pendingDevices ?? {})) problems.push(`unknown device ${id.slice(0, 7)} asks to connect (not accepted)`);
  for (const id of Object.keys(pendingFolders ?? {})) problems.push(`a device offers folder "${id}" (not accepted)`);
  if (plan) {
    if (!self) problems.push(`this computer (${me.myID.slice(0, 7)}) is not in the plan`);
    else {
      for (const f of cfg.folders) {
        if (!plan.folders[f.id]?.devices.includes(self)) problems.push(`folder ${f.id} is not in the plan for ${self}`);
      }
      for (const d of await apply(plan, { ...opts, dry: true })) problems.push(`differs from the plan: ${d}`);
    }
  }
  lines.push(problems.length ? "Problems:" : "No problems found.");
  for (const p of problems) lines.push(`  - ${p}`);
  return { lines, ok: problems.length === 0 };
}

// --- command line ------------------------------------------------------------

function loadPlan(file: string, required: boolean): Plan | null {
  if (!existsSync(file)) {
    if (required) throw new Error(`No sync plan at ${file}. See docs/sync.md for its shape.`);
    return null;
  }
  return JSON.parse(readFileSync(file, "utf8")) as Plan;
}

const USAGE = `adisthanam sync status                          check this computer's Syncthing
adisthanam sync apply [--dry-run]               bring it to the plan
adisthanam sync quarantine FOLDER --from DEVICE [--dry-run]
                                                move what DEVICE wrongly put in FOLDER out of it
Options: --home DIR (Syncthing's configuration folder), --plan FILE,
         --quarantine DIR (default ~/syncthing-quarantine-<date>, on the folder's drive)`;

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    if (!v || v.startsWith("--")) throw new Error(`${name} needs a value`);
    args.splice(i, 2);
    return v;
  };
  try {
    if (process.getuid?.() === 0) throw new Error("Run this as yourself, not with sudo: Syncthing runs as you.");
    const file = flag("--plan") ?? process.env.ADISTHANAM_SYNC_PLAN ?? join(home, ".config/adisthanam/sync.json");
    const homeDir = flag("--home");
    const from = flag("--from");
    const quarantineDir = flag("--quarantine");
    const dry = args.includes("--dry-run");
    const [cmd, folderId] = args.filter((a) => a !== "--dry-run");
    const opts: Options = { dry, home: homeDir, quarantineDir };
    if (cmd === "apply") {
      const changes = await apply(loadPlan(file, true)!, opts);
      console.log(changes.length ? `${dry ? "Would change" : "Changed"}:\n  - ${changes.join("\n  - ")}` : "Already as planned; nothing changed.");
    } else if (cmd === "status") {
      const r = await status(loadPlan(file, false), opts);
      console.log(r.lines.join("\n"));
      process.exitCode = r.ok ? 0 : 1;
    } else if (cmd === "quarantine" && folderId && from) {
      const moved = await quarantine(loadPlan(file, true)!, folderId, from, opts);
      if (!moved.length) console.log(`Nothing in ${folderId} was last changed by ${from}; nothing moved.`);
      else {
        console.log(`${dry ? "Would move" : "Moved"} ${moved.length} entries out of ${folderId}${dry ? "" : " (folder now paused)"}:`);
        for (const m of moved) console.log(`  ${m}`);
      }
    } else {
      console.log(USAGE);
      process.exitCode = 2;
    }
  } catch (e) {
    console.error(`Problem: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
