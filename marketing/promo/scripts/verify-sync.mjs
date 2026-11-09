// After sync-music: check that the edit's cuts and beats really land on the
// song. Measures onset strength (how much new sound starts) at every beat and
// cut of the edit, against the average and against half-beat offsets. A good
// sync has strong onsets on the grid and weak ones between.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const J = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'beat.json'), 'utf8'));
const SR = 22050, HOP = 256, WIN = 1024;
const tmp = path.join(ROOT, 'out', 'verify.wav');
execFileSync('npx', ['remotion', 'ffmpeg', '-v', 'error', '-y', '-i', path.join(ROOT, 'public', 'music-edit.wav'), '-ac', '1', '-ar', String(SR), '-f', 'wav', tmp], {cwd: ROOT});
const b = fs.readFileSync(tmp); let off = 12, pcm;
while (off < b.length) { const id = b.toString('ascii', off, off + 4); const size = b.readUInt32LE(off + 4); if (id === 'data') { pcm = b.subarray(off + 8, off + 8 + size); break; } off += 8 + size; }
const x = new Float32Array(pcm.length / 2); for (let i = 0; i < x.length; i++) x[i] = pcm.readInt16LE(i * 2) / 32768;
// Energy-rise onset envelope (cheap and robust for a check).
const n = Math.floor((x.length - WIN) / HOP); const env = new Float32Array(n); let prev = 0;
for (let f = 0; f < n; f++) { let e = 0; for (let i = 0; i < WIN; i++) e += x[f * HOP + i] ** 2; const l = Math.log1p(1000 * e); env[f] = Math.max(0, l - prev); prev = l; }
const at = (sec) => { const f = Math.round((sec * SR - WIN / 2) / HOP); let m = 0; for (let k = f - 2; k <= f + 2; k++) if (k >= 0 && k < n) m = Math.max(m, env[k]); return m; };
const beatSec = J.beatFrames / J.fps;
const beats = [], offs = [];
for (let k = 0; k < J.bars * 4; k++) { beats.push(at(k * beatSec)); offs.push(at((k + 0.5) * beatSec)); }
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const cuts = Object.keys(J.cuts).map(Number).map((bar) => ({bar, v: at(bar * 4 * beatSec)}));
console.log(`${J.music ? J.music.source : 'generated'}: ${(60 / beatSec).toFixed(2)} BPM, key ${J.key ? J.key.name : '?'}`);
console.log(`onset on beats ${mean(beats).toFixed(2)} vs between beats ${mean(offs).toFixed(2)} (ratio ${(mean(beats) / Math.max(1e-6, mean(offs))).toFixed(2)}; above ~1.3 is locked)`);
console.log(`cuts: ${cuts.map((c) => `bar ${c.bar} ${c.v.toFixed(2)}`).join(', ')}`);
fs.rmSync(tmp, {force: true});
