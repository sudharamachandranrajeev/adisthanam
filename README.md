<h1 align="center">
  <br>
  <a href="https://github.com/sudharamachandranrajeev/adisthanam"><img src="branding/adisthanam-512.png" alt="Adisthanam" width="140"></a>
  <br>
  Adisthanam
  <br>
</h1>

<h4 align="center">The foundation under every Brahma app: your own login and encrypted data server, installed with one command at home, on a rented server, in Docker or on Cloudflare.</h4>

<p align="center">
  <a href="https://github.com/sudharamachandranrajeev/adisthanam/releases"><img src="https://img.shields.io/github/v/release/sudharamachandranrajeev/adisthanam?include_prereleases&color=b8860b" alt="Release"></a>
  <img src="https://img.shields.io/badge/targets-home%20%7C%20VPS%20%7C%20Docker%20%7C%20Cloudflare-555" alt="Targets">
  <img src="https://img.shields.io/badge/Node.js-24%2B-5fa04e?logo=nodedotjs" alt="Node.js 24+">
  <img src="https://img.shields.io/badge/data-end--to--end%20encrypted-2b2a6b" alt="End-to-end encrypted">
  <img src="https://img.shields.io/badge/part%20of-Brahma-8a5cf6" alt="Part of Brahma">
</p>

<p align="center">
  <a href="#key-features">Key Features</a> •
  <a href="#how-to-use">How To Use</a> •
  <a href="#download">Download</a> •
  <a href="#credits">Credits</a> •
  <a href="#related">Related</a> •
  <a href="#license">License</a>
</p>

> **Status: in development.** Nothing is released yet. The features below are the target for the
> first release, which ships only once every one of them passes the acceptance tests on a real home
> server.

Adisthanam (अधिष्ठानम्, "foundation") installs, protects, watches, backs up and moves the
[Brahma sync server](https://github.com/sudharamachandranrajeev/brahma/tree/main/server). Every
Brahma app — Brahma, Artha, Vidya, Udyoga, Graha Anveshana, Vahana Anveshana, Bhojana, Vani, Bahya
Nireekshana and the apps that join later — signs in to it and keeps its data there. Each device
locks (encrypts) the data before sending it, so the server holds everything and can read none of it.

## Key Features

* **One command, anywhere** – the same `adisthanam install` sets up a computer at home, a rented
  Linux server, a Docker host or Cloudflare. Running it again repairs; it never half-installs.
* **One login for every app** – one account signs in to every Brahma app. Sign-up needs the owner's
  one-time setup code or a single-use invite. Passwords never reach the server.
* **Every app's data in one place** – all data entered in any Brahma app is stored on your server,
  end-to-end encrypted on the device first. The server sees e-mail addresses, device ids and sync
  times, nothing else.
* **Private by default** – at home it is reachable only through Tailscale, over HTTPS, with the
  server itself listening on this computer only. Nothing is opened to the internet unless you choose
  a public target, and then only over TLS.
* **Locked-down service** – runs as its own unprivileged user in a systemd sandbox: read-only system,
  no access to your home folder, no special rights, limited memory and CPU, so it can never slow down
  or harm the computer it runs on.
* **Devices you can see and remove** – every signed-in device is listed with when it last synced.
  Sign one out, or sign out everywhere. A new device signing in sends you an alert.
* **Backups that work** – a daily backup, encrypted, checked by opening it again, with the newest 14
  kept. Optionally a second copy goes off the computer to storage that cannot be overwritten or
  deleted from here, so ransomware cannot reach it.
* **Health watch** – checks itself every minute, restarts after a crash, stops a crash loop instead
  of hiding it, and warns before the disk fills or the clock drifts.
* **Network watch** – the server may only talk to the few addresses it needs. Anything else, a new
  listening port, or a burst of failed sign-ins raises an alert on your phone (ntfy).
* **Sentinel on the server** – server-side security events show up in Sentinel in every Brahma app,
  next to each device's own checks, with what to do about them.
* **Safe updates** – releases are signed; an update takes a backup first, checks the new version,
  and rolls back by itself if it fails.
* **Move it any time** – `export` on the old server and `import` on the new one moves every account
  and device, home to cloud or back, without anyone signing in again.
* **Plain-words doctor** – `adisthanam doctor` checks the firewall, Tailscale, backups, disk, clock
  and certificates, and says how to fix what it finds.

<details>
<summary><b>What the server can and cannot see</b></summary>

- **Can see:** account e-mail addresses, device ids and names, when each device synced, the size of
  what was synced.
- **Cannot see:** anything you type into an app. Rows are encrypted on the device with
  XChaCha20-Poly1305 under keys derived from your password (Argon2id, HKDF). The server stores a keyed
  hash of a secret derived from the password, never the password.
- **Your recovery key** is the only way back in without your password. Write it down when the app
  shows it; the server cannot recover your data for you.

</details>

## How To Use

### Home server

On a Linux computer that stays on (an old laptop is fine), with Git, Node.js 24 or newer and
[Tailscale](https://tailscale.com/download):

```bash
# Clone this repository
$ git clone https://github.com/sudharamachandranrajeev/adisthanam

# Go into it
$ cd adisthanam

# Install, start and print the setup link
$ ./adisthanam install --target home
```

It asks once for your password (`sudo`) for the firewall rule and for starting with the computer,
and shows each command before running it. Then, in any Brahma app, choose **Sync across my devices
→ I have a server**, scan the QR code or paste the link, and create your account.

Good to know:

- Keep the computer plugged in, and set it never to sleep, also with the lid closed.
- Install Tailscale on every phone and computer that should sync.

### Rented server, Docker or Cloudflare

```bash
$ ./adisthanam install --target vps          # Caddy in front, automatic HTTPS
$ ./adisthanam install --target docker       # prints a compose file to start
$ ./adisthanam install --target cloudflare   # Worker + D1 on Cloudflare's free plan
```

### Looking after it

| Command | What it does |
| --- | --- |
| `adisthanam status` | Running? Version, accounts, devices, last backup, database check |
| `adisthanam doctor` | Everything `status` checks, plus the fix for each problem found |
| `adisthanam link` | The setup link and QR code again |
| `adisthanam backup` | Back up now (a daily backup runs by itself) |
| `adisthanam restore FILE` | Put a backup back (the current data is saved first) |
| `adisthanam update` | Install the newest signed release; rolls back if it fails |
| `adisthanam rollback` | Go back to the previous release |
| `adisthanam export` / `import FILE` | Move the server to another computer or target |
| `adisthanam uninstall` | Remove the server (asks before deleting data) |

<details>
<summary><b>Develop</b></summary>

```bash
$ npm ci
$ npm test          # unit tests and the acceptance suite against a throwaway install
$ npm run check     # type check, secret scan and the personal-information scan
```

Every commit is scanned for secrets and for anything that identifies a person, home or machine.
Examples use documentation addresses only (`192.0.2.0/24`, `2001:db8::/32`, `example.com`).

</details>

## Download

Releases will be on the [releases page](https://github.com/sudharamachandranrajeev/adisthanam/releases)
(0.x versions are pre-releases). Each release has `SHA256SUMS.txt` and a signature; `adisthanam
update` checks both and refuses a file that does not match.

## Credits

This software uses the following open source packages and services:

- [Node.js](https://nodejs.org) and its built-in `node:sqlite`
- [Tailscale](https://tailscale.com) for private access and HTTPS at home
- [Caddy](https://caddyserver.com) for HTTPS on rented servers
- [Cloudflare Workers](https://workers.cloudflare.com) and D1 for the cloud target
- [age](https://age-encryption.org) for encrypted backups
- [ntfy](https://ntfy.sh) for alerts

## Related

* [Brahma](https://github.com/sudharamachandranrajeev/brahma) – the suite app, its shared core and
  the sync server Adisthanam runs
* [Artha](https://github.com/sudharamachandranrajeev/artha) – finance, accounting and investments
* [Vidya](https://github.com/sudharamachandranrajeev/vidya) – learning and knowledge
* [Udyoga](https://github.com/sudharamachandranrajeev/udyoga) – career and job search
* [Graha Anveshana](https://github.com/sudharamachandranrajeev/graha-anveshana) – property
* [Vahana Anveshana](https://github.com/sudharamachandranrajeev/vahana-anveshana) – cars
* [Bhojana](https://github.com/sudharamachandranrajeev/bhojana) – groceries and shopping
* [Bahya Nireekshana](https://github.com/sudharamachandranrajeev/bahya-nireekshana) – network monitoring

## License

No licence has been chosen yet; all rights reserved.

---

> GitHub [@sudharamachandranrajeev](https://github.com/sudharamachandranrajeev)
