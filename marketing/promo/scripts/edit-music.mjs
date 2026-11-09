// Prepare a chosen track for the edit (after scripts/sync-music.mjs):
// trim it to start at the synced point, and before every cut swell in a
// reversed slice of the music just after the cut, so each transition is
// built from the song itself. Fades out at the end. Writes
// public/music-edit.wav, which the video plays when a track is chosen.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const J = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'beat.json'), 'utf8'));
if (!J.music) { console.error('No track chosen: run scripts/sync-music.mjs first.'); process.exit(1); }
const SR = 44100;
const BEAT = J.beatFrames / J.fps;
const LEN = (J.bars * 4 * J.beatFrames) / J.fps;
const raw = path.join(ROOT, 'out', 'edit-tmp.wav');
fs.mkdirSync(path.dirname(raw), {recursive: true});
execFileSync('npx', ['remotion', 'ffmpeg', '-v', 'error', '-y', '-ss', String(J.music.start), '-i', path.join(ROOT, 'public', J.music.file), '-t', String(LEN + 1), '-ac', '2', '-ar', String(SR), '-f', 'wav', '-c:a', 'pcm_s16le', raw], {cwd: ROOT, stdio: 'inherit'});
const b = fs.readFileSync(raw);
let off = 12, pcm = null;
while (off < b.length) { const id = b.toString('ascii', off, off + 4); const size = b.readUInt32LE(off + 4); if (id === 'data') { pcm = b.subarray(off + 8, off + 8 + Math.min(size, b.length - off - 8)); break; } off += 8 + size; }
const src = new Float32Array(pcm.length / 2);
for (let i = 0; i < src.length; i++) src[i] = pcm.readInt16LE(i * 2) / 32768;
const N = Math.ceil(LEN * SR);
const out = new Float32Array(N * 2);
for (let i = 0; i < Math.min(N * 2, src.length); i++) out[i] = src[i];

// Reverse swell: the beat after each cut, played backwards, rising into it.
const cuts = Object.keys(J.cuts).map(Number).map((bar) => bar * 4 * BEAT);
for (const tc of cuts) {
  const len = Math.round(BEAT * SR), c = Math.round(tc * SR);
  for (let k = 0; k < len; k++) {
    const from = c + (len - 1 - k); // reversed
    const to = c - len + k;
    if (to < 0 || from >= N) continue;
    const env = Math.pow(k / len, 2.2) * 0.55;
    out[to * 2] += src[from * 2] * env;
    out[to * 2 + 1] += src[from * 2 + 1] * env;
  }
}
// Fade out over the last 1.5 s, then normalise with headroom.
const fade = Math.round(1.5 * SR);
let peak = 0;
for (let i = 0; i < N; i++) {
  const g = i > N - fade ? (N - i) / fade : 1;
  out[i * 2] *= g; out[i * 2 + 1] *= g;
  peak = Math.max(peak, Math.abs(out[i * 2]), Math.abs(out[i * 2 + 1]));
}
const gain = peak > 0.95 ? 0.95 / peak : 1;
const data = Buffer.alloc(N * 4);
for (let i = 0; i < N; i++) {
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, out[i * 2] * gain)) * 32767), i * 4);
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, out[i * 2 + 1] * gain)) * 32767), i * 4 + 2);
}
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
fs.writeFileSync(path.join(ROOT, 'public', 'music-edit.wav'), Buffer.concat([h, data]));
fs.rmSync(raw, {force: true});
console.log(`music-edit.wav: ${LEN.toFixed(1)}s from ${J.music.source}, ${cuts.length} reverse swells into the cuts`);
