// Database jobs that run outside the server: backups, checks and imports.
// The server user runs these (adisthanam-backup.service, or through
// bin/adisthanam); none of them needs network access or credentials.
//
//   node src/db.ts backup              verified copy into $STATE_DIRECTORY/outbox
//   node src/db.ts verify FILE         integrity check and row counts of a copy
//   node src/db.ts copy FROM TO        consistent copy of a live database (import, restore)
//   node src/db.ts users               number of accounts (0 means setup is still open)
//   node src/db.ts status              accounts, devices, changes, size, check
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fail, stateDir } from "./config.ts";

const TABLES = ["users", "devices", "changes"] as const;

const check = (db: DatabaseSync) => (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/// Opens a live database the way the server does (WAL), for reading.
function openLive(file: string): DatabaseSync {
  if (!existsSync(file)) fail(`No database at ${file}`);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

/// A consistent copy through SQLite, so changes still in the write-ahead log
/// are included. Refuses to copy a database that fails its check.
export function copy(from: string, to: string): void {
  if (existsSync(to)) fail(`${to} already exists; not overwriting it`);
  const db = openLive(from);
  try {
    const result = check(db);
    if (result !== "ok") fail(`${from} fails its integrity check (${result}); not copying it`);
    db.prepare("VACUUM INTO ?").run(to);
  } finally {
    db.close();
  }
}

/// Checks a copy without touching it: opened from a scratch copy, so a WAL
/// or journal next to the original is never created or changed.
export function verify(file: string): Record<string, number | string> {
  if (!existsSync(file)) fail(`No such file: ${file}`);
  const dir = mkdtempSync(join(tmpdir(), "adisthanam-verify-"));
  try {
    const scratch = join(dir, "copy.db");
    copyFileSync(file, scratch);
    let db: DatabaseSync;
    let result: string;
    try {
      db = new DatabaseSync(scratch, { readOnly: true });
      result = check(db);
    } catch (e) {
      fail(`${file} is not a readable SQLite database (${(e as Error).message})`);
    }
    try {
      if (result !== "ok") fail(`${file} fails its integrity check (${result})`);
      const out: Record<string, number | string> = { check: result };
      for (const t of TABLES) {
        try {
          out[t] = count(db, t);
        } catch {
          fail(`${file} is not a Brahma sync database (no ${t} table)`);
        }
      }
      return out;
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function backup(): void {
  process.umask(0o077);
  const outbox = join(stateDir(), "outbox");
  mkdirSync(outbox, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = join(outbox, `brahma-${stamp}.db`);
  copy(join(stateDir(), "brahma.db"), file);
  const counts = verify(file);
  console.log(`Backed up to ${file} (${TABLES.map((t) => `${t} ${counts[t]}`).join(", ")})`);
}

function status(): void {
  const file = join(stateDir(), "brahma.db");
  const db = openLive(file);
  try {
    console.log(`Accounts: ${count(db, "users")}, devices: ${count(db, "devices")}, changes: ${count(db, "changes")}`);
    console.log(`Database: ${(statSync(file).size / 1e6).toFixed(1)} MB, check: ${check(db)}`);
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const [cmd, a, b] = process.argv.slice(2);
  switch (cmd) {
    case "backup":
      backup();
      break;
    case "verify": {
      const counts = verify(a ?? fail("Name the backup file to verify."));
      console.log(Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(", "));
      break;
    }
    case "copy":
      copy(a ?? fail("copy needs FROM and TO"), b ?? fail("copy needs FROM and TO"));
      console.log(`Copied ${a} to ${b}`);
      break;
    case "users": {
      const db = openLive(join(stateDir(), "brahma.db"));
      console.log(count(db, "users"));
      db.close();
      break;
    }
    case "status":
      status();
      break;
    default:
      console.log("Usage: node src/db.ts backup | verify FILE | copy FROM TO | users | status");
      process.exit(cmd ? 1 : 0);
  }
}
