// Fit the edit to any music track.
//
//   node scripts/sync-music.mjs path/to/track.mp3
//
// Detects the track's tempo, beat grid and downbeats (spectral-flux onsets,
// autocorrelation for tempo, comb alignment for phase), finds the drop (the
// biggest jump in loudness between bars), and writes src/beat.json so that
// the drop lands on bar 2, where the product first appears. Every animation
// and cut is timed in beats, so the whole edit follows the track. The track
// is copied to public/music-track.<ext>.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const input = process.argv[2];
if (!input || !fs.existsSync(input)) { console.error('Usage: node scripts/sync-music.mjs <track.mp3|wav>'); process.exit(1); }

// ---- decode to mono 22.05 kHz with Remotion's bundled ffmpeg ----
const SR = 22050;
const tmp = path.join(ROOT, 'out', 'sync-tmp.wav');
fs.mkdirSync(path.dirname(tmp), {recursive: true});
execFileSync('npx', ['remotion', 'ffmpeg', '-v', 'error', '-y', '-i', input, '-ac', '1', '-ar', String(SR), '-f', 'wav', tmp], {cwd: ROOT, stdio: 'inherit'});
const buf = fs.readFileSync(tmp);
let off = 12; let data = null;
while (off < buf.length) { const id = buf.toString('ascii', off, off + 4); const size = buf.readUInt32LE(off + 4); if (id === 'data') { data = buf.subarray(off + 8, off + 8 + size); break; } off += 8 + size; }
const N = data.length / 2; const x = new Float32Array(N);
for (let i = 0; i < N; i++) x[i] = data.readInt16LE(i * 2) / 32768;
const duration = N / SR;

// ---- spectral flux onset envelope (full band and low band) ----
const WIN = 1024, HOP = 256, FR = SR / HOP;
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const a = i + k, b = a + len / 2; const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } }
  }
}
const hann = Float32Array.from({length: WIN}, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN));
const frames = Math.floor((N - WIN) / HOP);
const flux = new Float32Array(frames), low = new Float32Array(frames), rms = new Float32Array(frames);
const chroma = new Float64Array(12); // pitch-class energy, for the key
let prev = new Float32Array(WIN / 2);
const lowBin = Math.round((150 / SR) * WIN);
for (let f = 0; f < frames; f++) {
  const re = new Float32Array(WIN), im = new Float32Array(WIN); let e = 0;
  for (let i = 0; i < WIN; i++) { const v = x[f * HOP + i]; re[i] = v * hann[i]; e += v * v; }
  rms[f] = Math.sqrt(e / WIN);
  fft(re, im);
  let s = 0, sl = 0;
  const mag = new Float32Array(WIN / 2);
  for (let k = 1; k < WIN / 2; k++) {
    const m = Math.hypot(re[k], im[k]);
    mag[k] = Math.log1p(100 * m); const d = mag[k] - prev[k]; if (d > 0) { s += d; if (k <= lowBin) sl += d; }
    const hz = (k * SR) / WIN;
    if (hz > 60 && hz < 2000) { const pc = ((Math.round(12 * Math.log2(hz / 440)) % 12) + 12 + 9) % 12; chroma[pc] += m * m; }
  }
  flux[f] = s; low[f] = sl; prev = mag;
}
// Normalise and remove the slow trend so only transients remain.
function detrend(v) {
  const out = new Float32Array(v.length); const w = Math.round(FR * 0.5);
  let acc = 0; for (let i = 0; i < v.length; i++) { acc += v[i]; if (i >= w) acc -= v[i - w]; const mean = acc / Math.min(i + 1, w); out[i] = Math.max(0, v[i] - mean); }
  let m = 0; for (const q of out) m = Math.max(m, q); for (let i = 0; i < out.length; i++) out[i] /= m || 1; return out;
}
const onset = detrend(flux), onsetLow = detrend(low);
// Beats are carried by the kick: for the grid's phase, low-end hits count
// most, so bright offbeat hats and claps cannot pull it half a beat off.
const onsetBeat = onsetLow.map((v, i) => 2 * v + 0.5 * onset[i]);

// ---- tempo: autocorrelation, weighted toward 90-150 BPM ----
let best = {bpm: 120, score: -1};
for (let bpm = 80; bpm <= 175; bpm += 0.05) {
  const lag = (60 / bpm) * FR; let sc = 0;
  for (let i = 0; i + 4 * lag < onset.length; i += 2) {
    const a = onset[i];
    sc += a * (interp(onset, i + lag) + 0.5 * interp(onset, i + 2 * lag) + 0.25 * interp(onset, i + 4 * lag));
  }
  const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.45, 2));
  sc *= prior;
  if (sc > best.score) best = {bpm, score: sc};
}
function interp(v, t) { const i = Math.floor(t), fr = t - i; return i + 1 < v.length ? v[i] * (1 - fr) + v[i + 1] * fr : 0; }
// ---- refine tempo and phase together over the whole track ----
// A grid that is slightly off drifts across 80 beats, so the best joint fit
// pins the tempo far more precisely than the autocorrelation peak.
function gridScore(bpmT, ph) { const per = (60 / bpmT) * FR; let sc = 0; for (let t = ph; t < onsetBeat.length; t += per) sc += interp(onsetBeat, t); return sc; }
function bestPhase(bpmT) { const per = (60 / bpmT) * FR; let ph = 0, sc = -1; for (let p = 0; p < per; p += 0.25) { const v = gridScore(bpmT, p); if (v > sc) { sc = v; ph = p; } } return {ph, sc}; }
let fit = {bpm: best.bpm, ...bestPhase(best.bpm)};
for (const step of [0.05, 0.01, 0.002]) {
  for (let b = fit.bpm - step * 20; b <= fit.bpm + step * 20; b += step) { const r = bestPhase(b); if (r.sc > fit.sc) fit = {bpm: b, ...r}; }
}
const bpm = fit.bpm, period = (60 / bpm) * FR;
const phase = fit.ph;
// ---- downbeat: which of the 4 beats carries the most low end (kick on the one) ----
let bar0 = 0, barScore = -1;
for (let k = 0; k < 4; k++) { let sc = 0; for (let t = phase + k * period; t < onset.length; t += 4 * period) sc += interp(onsetLow, t) + 0.5 * interp(onset, t); if (sc > barScore) { barScore = sc; bar0 = k; } }
const barSec = (4 * 60) / bpm;
// Frame times are window centres; then step back to the earliest downbeat.
let firstDownbeat = (phase + bar0 * period) / FR + WIN / 2 / SR;
while (firstDownbeat - barSec >= -0.05) firstDownbeat -= barSec;
firstDownbeat = Math.max(0, firstDownbeat); // seconds

// ---- the drop: largest loudness rise from one bar to the next, early in the track ----
const bars = [];
for (let t = firstDownbeat; t + barSec <= duration; t += barSec) {
  const a = Math.floor(t * FR), b = Math.floor((t + barSec) * FR); let e = 0; for (let i = a; i < b; i++) e += rms[i] * rms[i];
  bars.push({t, level: Math.sqrt(e / Math.max(1, b - a))});
}
let drop = 2, dropJump = -1;
for (let i = 2; i < Math.min(bars.length - 18, Math.max(4, Math.floor(bars.length * 0.6))); i++) {
  const before = (bars[i - 1].level + bars[i - 2].level) / 2; const jump = bars[i].level - before;
  if (jump > dropJump) { dropJump = jump; drop = i; }
}
// Start the track 2 bars before the drop, so the drop lands on bar 2.
const startBar = Math.max(0, drop - 2);
const musicStart = bars[startBar] ? bars[startBar].t : firstDownbeat;

// ---- key: correlate the chroma with major and minor key profiles ----
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function corr(a, b) { const ma = a.reduce((x, y) => x + y) / 12, mb = b.reduce((x, y) => x + y) / 12; let n = 0, da = 0, db = 0; for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return n / Math.sqrt(da * db); }
let key = {tonic: 9, mode: 'minor', score: -2};
for (let t = 0; t < 12; t++) for (const [mode, prof] of [['major', MAJOR], ['minor', MINOR]]) {
  const rot = Array.from({length: 12}, (_, i) => prof[(i - t + 12) % 12]);
  const c = corr(Array.from(chroma), rot);
  if (c > key.score) key = {tonic: t, mode, score: c};
}

const ext = path.extname(input).toLowerCase();
const outName = `music-track${ext}`;
fs.copyFileSync(input, path.join(ROOT, 'public', outName));
const beatPath = path.join(ROOT, 'src', 'beat.json');
const J = JSON.parse(fs.readFileSync(beatPath, 'utf8'));
J.beatFrames = +(J.fps * 60 / bpm).toFixed(4);
J.music = {file: outName, bpm: +bpm.toFixed(2), start: +musicStart.toFixed(3), dropBar: drop, source: path.basename(input)};
J.key = {tonic: key.tonic, mode: key.mode, name: `${NAMES[key.tonic]} ${key.mode}`};
fs.writeFileSync(beatPath, JSON.stringify(J, null, 2));
fs.rmSync(tmp, {force: true});
const need = (J.bars * 4 * 60) / bpm;
console.log(`key ${NAMES[key.tonic]} ${key.mode} (fit ${key.score.toFixed(2)})`);
console.log(`tempo ${bpm.toFixed(2)} BPM, first downbeat ${firstDownbeat.toFixed(3)}s, drop at bar ${drop} (${bars[drop] ? bars[drop].t.toFixed(2) : '?'}s)`);
console.log(`track starts at ${musicStart.toFixed(2)}s; edit length ${need.toFixed(1)}s; track has ${(duration - musicStart).toFixed(1)}s from there${duration - musicStart < need ? ' (TOO SHORT: it will end early)' : ''}`);
