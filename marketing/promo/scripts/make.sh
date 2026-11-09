#!/bin/sh
# Build the promo for one music track, start to finish.
#   sh scripts/make.sh ~/Downloads/track.mp3 name
# Outputs out/<name>-4k.mp4 (3840x2160 master), out/<name>-1080p.mp4 (upload),
# out/<name>-phone.mp4 (under 30 MB).
set -e
cd "$(dirname "$0")/.."
TRACK="$1"; NAME="$2"
cp src/beat.json out/beat.base.json
node scripts/sync-music.mjs "$TRACK"
node scripts/edit-music.mjs
node scripts/music.mjs --sfx
node scripts/verify-sync.mjs
npx remotion render src/index.ts Promo "out/$NAME-4k.mp4" --scale=2 --codec=h264 --crf=16 --x264-preset=slow --log=error
npx remotion ffmpeg -v error -y -i "out/$NAME-4k.mp4" -vf "scale=1920:1080:flags=lanczos" -c:v libx264 -crf 15 -preset slow -pix_fmt yuv420p -c:a aac -b:a 256k -movflags +faststart "out/$NAME-1080p.mp4"
npx remotion ffmpeg -v error -y -i "out/$NAME-4k.mp4" -vf "scale=1920:1080:flags=lanczos" -c:v libx264 -crf 24 -preset slow -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart "out/$NAME-phone.mp4"
cp out/beat.base.json src/beat.json
ls -la out/$NAME-*.mp4
