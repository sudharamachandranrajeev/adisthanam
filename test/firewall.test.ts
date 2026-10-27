// bin/ufw-stale-rules against a real `ufw status numbered` layout.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const script = new URL("../bin/ufw-stale-rules", import.meta.url).pathname;
const run = (input: string, ports: string) =>
  execFileSync("awk", ["-v", `ports=${ports}`, "-f", script], { input, encoding: "utf8" }).trim().split("\n").filter(Boolean);

const STATUS = `Status: active

     To                         Action      From
     --                         ------      ----
[ 1] 53317/udp                  ALLOW IN    Anywhere
[ 2] 53317/tcp                  ALLOW IN    Anywhere
[ 3] 198.51.100.1 53/udp        ALLOW IN    203.0.113.0/24             # allow-docker-dns
[ 4] 22/tcp                     ALLOW IN    198.51.100.0/22
[ 5] 8090/tcp                   ALLOW IN    198.51.100.0/22
[ 6] 443/tcp on tailscale0      ALLOW IN    Anywhere                   # Adisthanam HTTPS (Tailscale only)
[ 7] 22/tcp on tailscale0       ALLOW IN    Anywhere                   # SSH (Tailscale only)
[ 8] 53317/udp (v6)             ALLOW IN    Anywhere (v6)
[ 9] 443/tcp (v6) on tailscale0 ALLOW IN    Anywhere (v6)              # Adisthanam HTTPS (Tailscale only)
[10] 8090/tcp (v6)              ALLOW IN    Anywhere (v6)
[11] 22/tcp                     DENY IN     Anywhere
`;

test("removes managed ports outside Tailscale, highest number first", () => {
  const out = run(STATUS, "8090 443 22");
  assert.deepEqual(out.filter((l) => l.startsWith("delete")), ["delete 10", "delete 5", "delete 4"]);
});

test("reports other programs' rules without removing them", () => {
  const out = run(STATUS, "8090 443 22");
  assert.deepEqual(out.filter((l) => l.startsWith("warn")), [
    "warn 53317/udp|Anywhere",
    "warn 53317/tcp|Anywhere",
    "warn 198.51.100.1 53/udp|203.0.113.0/24",
    "warn 53317/udp (v6)|Anywhere (v6)",
  ]);
});

test("leaves SSH rules alone when SSH is not managed", () => {
  const out = run(STATUS, "8090 443");
  assert.ok(!out.includes("delete 4"));
  assert.ok(out.includes("warn 22/tcp|198.51.100.0/22"));
});
