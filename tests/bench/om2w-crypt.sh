#!/usr/bin/env bash
# Encrypts and decrypts what an Online-Mind2Web job uploads, so that no
# artifact of this public repository holds a gated task's text, a transcript,
# a screenshot, a judge's reasons or a sealed shard's own counts in the clear.
#
#   OM2W_PASS=... tests/bench/om2w-crypt.sh seal <dir> <out.tar.gz.enc>
#   OM2W_PASS=... tests/bench/om2w-crypt.sh open <in.tar.gz.enc> <dir>
#
# AES-256-CBC, the key from the passphrase by PBKDF2 (SHA-256, 200,000
# rounds), as the holdout tasks are. The passphrase is read from OM2W_PASS
# and never printed: dev artifacts use the OM2W_DEV_KEY secret (the owner
# keeps a copy in ~/.config/select-to-ai/om2w-dev.key and opens them with
# scripts/om2w-dev-results.sh), sealed counts and census shards use a key the
# jobs derive from HOLDOUT_KEY for one workflow run.
set -euo pipefail

if [ -z "${OM2W_PASS:-}" ]; then echo "om2w-crypt: OM2W_PASS is not set" >&2; exit 1; fi
if [ "${#OM2W_PASS}" -lt 32 ]; then echo "om2w-crypt: OM2W_PASS is shorter than 32 characters" >&2; exit 1; fi
cmd="${1:-}"
src="${2:-}"
dst="${3:-}"
enc=(enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -pass env:OM2W_PASS)

case "$cmd" in
  seal)
    [ -d "$src" ] || { echo "om2w-crypt: $src is not a folder" >&2; exit 1; }
    mkdir -p "$(dirname "$dst")"
    tar -C "$src" -czf - . | openssl "${enc[@]}" -salt -out "$dst"
    ;;
  open)
    [ -f "$src" ] || { echo "om2w-crypt: $src is not a file" >&2; exit 1; }
    mkdir -p "$dst"
    openssl "${enc[@]}" -d -in "$src" | tar -C "$dst" -xzf -
    ;;
  *)
    echo "usage: om2w-crypt.sh seal <dir> <out.enc> | open <in.enc> <dir>" >&2
    exit 1
    ;;
esac
