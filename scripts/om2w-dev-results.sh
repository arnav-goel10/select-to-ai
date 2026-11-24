#!/usr/bin/env bash
# Downloads the artifacts of one Online-Mind2Web dev run and decrypts them.
#
#   scripts/om2w-dev-results.sh <run id>
#
# Needs gh (signed in) and the dev key at ~/.config/select-to-ai/om2w-dev.key,
# the same value as the repository's OM2W_DEV_KEY secret. The key is read
# from the file and never printed. The plain results land in
# ~/Documents/select-to-ai-v3/bench-results/om2w-dev-<run id>/, one folder per
# encrypted artifact, beside the clear counts. Downloading and decrypting
# only: nothing is run.
set -euo pipefail

run="${1:-}"
[[ "$run" =~ ^[0-9]+$ ]] || { echo "usage: scripts/om2w-dev-results.sh <run id>" >&2; exit 1; }
repo="${OM2W_REPO:-arnav-goel10/select-to-ai}"
key="${OM2W_DEV_KEY_FILE:-$HOME/.config/select-to-ai/om2w-dev.key}"
out="${OM2W_RESULTS_DIR:-$HOME/Documents/select-to-ai-v3/bench-results}/om2w-dev-$run"
here="$(cd "$(dirname "$0")/.." && pwd)"

[ -f "$key" ] || { echo "No dev key at $key." >&2; exit 1; }
OM2W_PASS="$(tr -d '[:space:]' < "$key")"
export OM2W_PASS

umask 077
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
gh run download "$run" --repo "$repo" --dir "$tmp/dl" --pattern 'om2w-dev-*' --pattern 'om2w-summary'

mkdir -p "$out"
found=0
while IFS= read -r f; do
  name="$(basename "$f" .tar.gz.enc)"
  bash "$here/tests/bench/om2w-crypt.sh" open "$f" "$out/$name"
  found=$((found + 1))
done < <(find "$tmp/dl" -type f -name 'om2w-dev-*.tar.gz.enc' | sort)
# The clear counts and summaries, as they were uploaded.
find "$tmp/dl" -type f -name '*.json' -exec cp {} "$out/" \;
echo "Decrypted $found artifact(s) of run $run into $out"
