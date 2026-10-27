#!/usr/bin/env bash
# Extracts the pinned Brahma sync server (brahma.lock) into DEST/brahma.
#
#   scripts/fetch-brahma.sh [DEST]     default: vendor/
#
# It takes the files from `git archive` of the pinned commit, never from a
# working tree or a release tarball, so what runs is exactly what the commit
# holds. It fails if the commit cannot be found or any listed path is missing.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="${1:-$root/vendor}"
# shellcheck source=../brahma.lock
. "$root/brahma.lock"

[[ $BRAHMA_COMMIT =~ ^[0-9a-f]{40}$ ]] || { echo "brahma.lock: BRAHMA_COMMIT must be a full 40-character commit id" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git -c advice.detachedHead=false clone --quiet --filter=blob:none --no-checkout "$BRAHMA_REPO" "$tmp/repo"
[[ $(git -C "$tmp/repo" rev-parse --verify "$BRAHMA_COMMIT^{commit}") == "$BRAHMA_COMMIT" ]] ||
  { echo "Commit $BRAHMA_COMMIT not found in $BRAHMA_REPO" >&2; exit 1; }

# shellcheck disable=SC2086
git -C "$tmp/repo" archive --format=tar "$BRAHMA_COMMIT" $BRAHMA_PATHS >"$tmp/brahma.tar"
rm -rf "$dest/brahma.new"
mkdir -p "$dest/brahma.new"
tar -xf "$tmp/brahma.tar" -C "$dest/brahma.new"
for p in $BRAHMA_PATHS; do
  [[ -f $dest/brahma.new/$p ]] || { echo "Missing $p in Brahma $BRAHMA_COMMIT" >&2; exit 1; }
done
echo "$BRAHMA_COMMIT" >"$dest/brahma.new/COMMIT"
rm -rf "$dest/brahma"
mv "$dest/brahma.new" "$dest/brahma"
echo "Brahma server ${BRAHMA_COMMIT:0:12} extracted to $dest/brahma"
