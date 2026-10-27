// Where Adisthanam reads its settings and secrets.
//
// Settings (no secrets) come from adisthanam.conf, KEY=value lines. Secrets
// never sit in that file or in the environment: systemd decrypts them from
// /etc/credstore.encrypted into $CREDENTIALS_DIRECTORY, readable only by
// this service, for as long as it runs. Data lives in $STATE_DIRECTORY.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Config = {
  port: number;
  bind: string;
  /// Host names a request may carry, e.g. the Tailscale HTTPS name. Empty
  /// means only the loopback address is accepted.
  hosts: string[];
  name: string;
  state: string;
  tokenKey: string;
  setupCode: string;
};

const KEYS = new Set(["PORT", "BIND", "HOSTS", "NAME"]);

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function parseConf(text: string, file = "adisthanam.conf"): Record<string, string> {
  const out: Record<string, string> = {};
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (!m) fail(`${file}:${i + 1}: expected KEY=value`);
    if (!KEYS.has(m[1])) fail(`${file}:${i + 1}: unknown setting ${m[1]}`);
    out[m[1]] = m[2].trim();
  });
  return out;
}

function credential(name: string, required: boolean): string {
  const dir = process.env.CREDENTIALS_DIRECTORY;
  const file = dir ? join(dir, name) : "";
  if (!file || !existsSync(file)) {
    if (required) fail(`Missing credential ${name}. Start the server through systemd (adisthanam.service).`);
    return "";
  }
  return readFileSync(file, "utf8").trim();
}

export function stateDir(): string {
  const dir = process.env.STATE_DIRECTORY;
  if (!dir) fail("STATE_DIRECTORY is not set. Start the server through systemd (adisthanam.service).");
  return dir;
}

export function loadConfig(): Config {
  const file = process.env.ADISTHANAM_CONF ?? "/etc/adisthanam/adisthanam.conf";
  const conf = existsSync(file) ? parseConf(readFileSync(file, "utf8"), file) : {};
  const port = Number(conf.PORT ?? "8090");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail(`${file}: PORT must be between 1024 and 65535`);
  const bind = conf.BIND ?? "127.0.0.1";
  if (bind !== "127.0.0.1" && bind !== "::1") {
    fail(`${file}: BIND must be 127.0.0.1 or ::1; other devices reach the server through the TLS front (tailscale serve)`);
  }
  const tokenKey = credential("token_key", true);
  if (tokenKey.length < 32) fail("Credential token_key is too short (at least 32 characters)");
  return {
    port,
    bind,
    hosts: (conf.HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
    name: conf.NAME || "Adisthanam",
    state: stateDir(),
    tokenKey,
    setupCode: credential("setup_code", false),
  };
}
