# Syncthing between your own computers

`adisthanam sync` keeps [Syncthing](https://syncthing.net) on this computer to a plan you write
once, and checks it stays that way. It runs as you (Syncthing does), never with sudo, and talks
only to this computer's Syncthing through its local API.

```sh
adisthanam sync status             # devices, folders, and anything that breaks the rules
adisthanam sync apply --dry-run    # what apply would change
adisthanam sync apply              # make it so
```

## What it enforces

- **Private network only.** Global discovery, relays, NAT traversal (UPnP/NAT-PMP), LAN
  broadcast, crash and usage reports are off. Syncthing listens on one fixed address (your
  Tailscale address), and devices are dialled at fixed addresses.
- **A GUI password.** Without one, any program or account on this computer can drive Syncthing
  and read every synced file. `apply` makes a random password once, keeps it in
  `~/.local/state/adisthanam/sync-gui-password` (mode 600), and Syncthing stores only its bcrypt
  hash. The GUI stays on 127.0.0.1.
- **Only your devices, and only folders you planned.** Devices never accept folders by
  themselves and are never introducers. A device or folder offered from outside is reported by
  `status`, never accepted.
- **No lost data.**
  - Each folder has its own path. A folder inside another is refused unless the outer one
    ignores it.
  - No folder may be, or contain, `~`, `~/.ssh`, `~/.gnupg`, `~/.password-store`,
    `~/.claude/.credentials.json`, Syncthing's own state, `/etc`, or Adisthanam's data and
    backups.
  - Deleted and replaced files are kept for 30 days (staggered versioning, in each folder's
    `.stversions`).
  - Moving a folder to another path removes it and adds it again, so the other devices never
    see "every file deleted". `apply` never deletes a file.
- **Ignore rules** from the plan go in a marked block at the top of each folder's `.stignore`,
  written before the folder is added; your own lines below it are kept.

## The plan

`~/.config/adisthanam/sync.json` (on Windows `%USERPROFILE%\.config\adisthanam\sync.json`).
The **same file goes on every computer**: each one finds itself in it by its Syncthing device ID,
so a plan can never be applied as the wrong computer. Keep it to yourself; it names your
devices. The shape, with example values:

```json
{
  "guiUser": "admin",
  "devices": {
    "desk":   { "id": "P56IOI7-MZJNU2Y-IQGDREY-DM2MGTI-MGL3BXN-PQ6W5BM-TBBZ4TJ-XZWICQ2",
                "addresses": ["tcp://desk.example.com:22000", "quic://desk.example.com:22000"] },
    "laptop": { "id": "<its device ID>", "addresses": ["tcp://laptop.example.com:22000"] },
    "win":    { "id": "<its device ID>", "addresses": ["dynamic"] }
  },
  "folders": {
    "work": {
      "label": "Work",
      "paths": { "desk": "~/Work", "laptop": "~/Work", "win": "C:\\Users\\you\\Work" },
      "devices": ["desk", "laptop", "win"]
    },
    "notes": {
      "label": "Notes",
      "paths": { "desk": "~/Notes", "laptop": "~/Documents/Notes" },
      "devices": ["desk", "laptop"],
      "ignore": ["/drafts"],
      "paused": true
    }
  },
  "ignore": ["(?d)build", "(?d)node_modules", ".git", "*.jks", "*.keystore", "key.properties", ".env"],
  "versionDays": 30
}
```

- `devices`: each computer's device ID (checked, check digits included, before anything
  changes) and where the others dial it: its Tailscale name (`desk.example.com` stands in for it here). With discovery off, at least one side of each pair
  needs a fixed address. A device listens on its Tailscale IPv4 (`tailscale ip -4`), TCP and
  QUIC on port 22000, unless it has its own `"listen"`.
- `folders`: every computer in `devices` shares the folder with all the others (a full mesh).
  `paths` gives each computer's path; a computer not in `devices` does not have the folder.
- `paused`: added or kept paused, for a folder that must not move data yet. Keep it in the
  plan, not in Syncthing's GUI: `apply` puts it back, and resuming a folder in the GUI before
  every computer has it at the right path pulls the wrong files in.
- `repos`: Git repositories inside the folder. Syncthing never carries them: a working tree
  synced without its `.git`, or a `.git` synced while Git writes to it, can corrupt a
  repository. Push and pull them with Git instead. `apply` also ignores any repository it
  finds (three levels deep), and `status` names the ones missing from `repos` and the ones
  with no remote.
- `strays`: top-level entries that do not belong in the folder. They are ignored, never
  synced, and `quarantine FOLDER --strays` moves them out (see below).

## Moving out what a device wrongly put in a folder

When a folder was accepted at the wrong path, the files of one device end up in another
device's folder. The safe way out is to list them as `strays`, then:

```sh
adisthanam sync apply                                 # Syncthing now ignores them
adisthanam sync quarantine notes --strays --dry-run   # read the list first
adisthanam sync quarantine notes --strays
```

It moves them only once Syncthing has loaded them as ignored. An ignored entry that
disappears is never announced as deleted, so no other computer loses anything, even where
two folders shared one path. They go to `~/syncthing-quarantine-<date>/<folder>/` with a
`MANIFEST.txt`.

`quarantine --from DEVICE` instead picks what one device changed last. Removing those entries
**is** announced as deletes once the folder runs again, so use it only where no other folder
shares the path (it refuses when the paths overlap):

```sh
adisthanam sync quarantine notes --from laptop --dry-run   # read the list first
adisthanam sync quarantine notes --from laptop
```

It picks the top-level entries that `laptop` changed last, by Syncthing's own records (so the
folder must be running), pauses the folder, and moves them to `~/syncthing-quarantine-<date>/`
with a `MANIFEST.txt`. The folder stays paused until the plan unpauses it; then the other
devices see those entries as removed from the folder, and keep them in their versions for 30
days. Run it **before** `apply` moves that folder: moving resets Syncthing's records.

## Windows

The same commands, through `install\sync-windows.ps1` in this repository (Node.js 24+ and
Tailscale needed):

```powershell
powershell -ExecutionPolicy Bypass -File install\sync-windows.ps1 status
```

## Firewall

Allow the sync port on the Tailscale interface only, the same way as the server's:
`sudo ufw allow in on tailscale0 to any port 22000 proto tcp` (and `udp` for QUIC). On Windows,
allow Syncthing on the Tailscale network only when Windows Defender Firewall asks.
