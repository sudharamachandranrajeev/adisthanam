#!/usr/bin/env bash
# Refuses anything that should never reach a public repository: secrets
# (gitleaks), and anything that points at a person, home, network or
# machine. Run by the pre-commit and pre-push hooks and by `npm run check`.
#
#   scripts/check-public.sh            tracked and staged files
#   scripts/check-public.sh --history  every commit as well (before a push)
#
# A personal deny-list (names, machine names, addresses, one per line) can
# live OUTSIDE the repo at ${XDG_CONFIG_HOME:-~/.config}/adisthanam/denylist,
# so the list itself is never published.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
history=false
[[ ${1:-} == --history ]] && history=true
problems=0
flag() { printf 'check-public: %s\n' "$*" >&2; problems=$((problems + 1)); }

# What to scan: the files as they will be committed, or the whole history.
corpus() {
  if $history; then
    git log --all -p --no-color --format='commit %H%nAuthor: %ae%nCommitter: %ce%n%B'
  else
    git ls-files -z --cached | while IFS= read -r -d '' f; do
      # This script's own patterns would match themselves.
      [[ $f == scripts/check-public.sh ]] || git show ":$f"
    done
  fi
}
text="$(corpus | grep -av '^Binary files' || true)"
body="$text"

# Private and Tailscale IPv4 addresses. Network names like 10.0.0.0/8 and the
# documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24) pass.
ips="$(printf '%s\n' "$body" | grep -aoE '\b(10|100|172|192)\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b(/[0-9]+)?' |
  grep -vE '/[0-9]+$' | grep -vE '^(192\.0\.2|198\.51\.100|203\.0\.113)\.' |
  awk -F. '($1==10)||($1==100&&$2>=64&&$2<128)||($1==172&&$2>=16&&$2<32)||($1==192&&$2==168)' | sort -u || true)"
[[ -z $ips ]] || flag "private or tailnet addresses: $(tr '\n' ' ' <<<"$ips")"

paths="$(printf '%s\n' "$body" | grep -aoE '/(home|Users)/[A-Za-z0-9._-]+' | sort -u || true)"
[[ -z $paths ]] || flag "home-folder paths: $(tr '\n' ' ' <<<"$paths")"

nets="$(printf '%s\n' "$body" | grep -aoiE '[a-z0-9-]+\.[a-z0-9-]+\.ts\.net' | grep -viE '^(host|node)\.(tailnet|example)\.ts\.net$' | sort -u || true)"
[[ -z $nets ]] || flag "tailnet names: $(tr '\n' ' ' <<<"$nets")"

mails="$(printf '%s\n' "$body" | grep -aoiE '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}' |
  grep -viE '@(users\.noreply\.github\.com|example\.(com|org|net))$|^noreply@anthropic\.com$' | sort -u || true)"
[[ -z $mails ]] || flag "e-mail addresses: $(tr '\n' ' ' <<<"$mails")"

links="$(printf '%s\n' "$body" | grep -aoE '[a-z]+://(setup|pair)\?[^ )"]*' | grep -vE 'i=<|k=<|s=<|\$' | sort -u || true)"
[[ -z $links ]] || flag "real setup or pairing links: $(tr '\n' ' ' <<<"$links")"

deny="${XDG_CONFIG_HOME:-$HOME/.config}/adisthanam/denylist"
if [[ -f $deny ]]; then
  while IFS= read -r term; do
    [[ -z $term || $term == \#* ]] && continue
    printf '%s\n' "$text" | grep -qaiF -- "$term" && flag "a term from your deny-list (line: ${term:0:3}…)"
  done <"$deny"
else
  printf 'check-public: no personal deny-list at %s (optional)\n' "$deny" >&2
fi

if command -v gitleaks >/dev/null; then
  if $history; then
    gitleaks git --no-banner --redact . >&2 || flag "gitleaks found secrets in the history"
  else
    gitleaks git --no-banner --redact --staged . >&2 || flag "gitleaks found secrets in staged changes"
    gitleaks dir --no-banner --redact . >&2 || flag "gitleaks found secrets in the files"
  fi
elif [[ ${ADISTHANAM_ALLOW_NO_GITLEAKS:-} == 1 ]]; then
  printf 'check-public: gitleaks not installed; secret scan skipped\n' >&2
else
  flag "gitleaks is not installed (Arch: sudo pacman -S gitleaks)"
fi

if ((problems)); then
  printf 'check-public: %d problem(s); nothing may be published until they are fixed.\n' "$problems" >&2
  exit 1
fi
echo "check-public: clean"
