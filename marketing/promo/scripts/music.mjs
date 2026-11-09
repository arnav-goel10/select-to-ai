// Procedural soundtrack v2, timed from src/beat.json (bars and beats).
// ~128.6 BPM house/future-pop in A minor: Am - F - C - G.
// Kick-ducked supersaw chords, house bass, claps, hats, pluck arp and a bell
// hook; trailer hits on the opening words, an impact on every section cut, a
// build with a half-beat of silence before the drop, and a ringing final chord.
// Writes public/music.wav (44.1 kHz, 16-bit stereo).
import fs from 'node:fs';
import path from 'node:path';

const J = JSON.parse(fs.readFileSync(new URL('../src/beat.json', import.meta.url)));
const SR = 44100;
const BEAT = J.beatFrames / J.fps, BAR = BEAT * 4;
const SECONDS = J.bars * BAR + 0.2, N = Math.ceil(SECONDS * SR);
const T = (bar, beat = 0) => (bar * 4 + beat) * BEAT;
const L = new Float32Array(N), R = new Float32Array(N), SEND = new Float32Array(N);
const DUCK = new Float32Array(N).fill(1); // sidechain gain, driven by the kick
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const idx = (s) => Math.floor(s * SR);
// Tracks that pump with the kick go through a separate bus.
const PL = new Float32Array(N), PR = new Float32Array(N);
function add(i, v, pan = 0, send = 0, pump = false) {
  if (i < 0 || i >= N) return;
  const l = v * Math.min(1, 1 - pan), r = v * Math.min(1, 1 + pan);
  if (pump) { PL[i] += l; PR[i] += r; } else { L[i] += l; R[i] += r; }
  SEND[i] += v * send;
}
const lp1 = () => { let y = 0; return (x, a) => (y += a * (x - y)); };
// 2-pole state-variable filter for resonant lowpass sweeps
const svf = () => { let lo = 0, bp = 0; return (x, cutoffHz, q = 0.7) => { const f = 2 * Math.sin(Math.PI * Math.min(cutoffHz, SR / 6) / SR); lo += f * bp; const hi = x - lo - q * bp; bp += f * hi; return lo; }; };

const CHORDS = [[57, 60, 64, 67, 71], [53, 57, 60, 64, 69], [48, 52, 55, 60, 64], [55, 59, 62, 67, 71]];
const ROOTS = [33, 29, 36, 31];
const SEC = J.sections, END = SEC.end[0], AGENT = SEC.agent[0], TUNNEL = SEC.tunnel ? SEC.tunnel[0] : SEC.bento[0];
const inGroove = (bar) => bar >= 2 && bar < END;

// ---- kick (and the sidechain it drives) ----
function kick(t0, gain = 1, duck = true) {
  let ph = 0;
  for (let i = idx(t0); i < idx(t0 + 0.5) && i < N; i++) {
    const t = i / SR - t0; const f = 48 + 140 * Math.exp(-t * 35); ph += f / SR;
    const body = Math.sin(2 * Math.PI * ph) * Math.exp(-t * 6.5);
    const click = t < 0.004 ? rnd() * (1 - t / 0.004) * 0.6 : 0;
    add(i, Math.tanh((body + click) * 1.6) * 0.62 * gain);
    if (duck) DUCK[i] = Math.min(DUCK[i], 1 - 0.78 * Math.exp(-t / 0.085) * Math.min(1, t / 0.003 + 0.2));
  }
}
function noiseBurst(t0, dur, gain, hp, lpA, pan = 0, send = 0.2, decay = 6) {
  const a = lp1(), b = lp1();
  for (let i = idx(t0); i < idx(t0 + dur) && i < N; i++) {
    const t = i / SR - t0; const n = rnd();
    const v = (a(n, lpA) - b(n, hp)) * Math.exp(-t * (decay / dur));
    add(i, v * gain, pan, send);
  }
}
const clap = (t0, g = 1) => { for (const o of [0, 0.011, 0.023]) noiseBurst(t0 + o, 0.16, 0.42 * g, 0.08, 0.55, 0, 0.45, 5); };
const hat = (t0, open = false, g = 1, pan = 0) => noiseBurst(t0, open ? 0.22 : 0.045, (open ? 0.1 : 0.075) * g, 0.6, 0.98, pan, 0.08, open ? 4 : 7);

// ---- supersaw chords, pumped by the kick ----
function chord(bar, t0, dur, cutoffStart, cutoffEnd, gain = 1) {
  const notes = CHORDS[bar % 4];
  notes.forEach((note, k) => {
    for (let v = 0; v < 5; v++) {
      const det = (v - 2) * 0.0045, f = mtof(note) * (1 + det), f2 = mtof(note - 12) * (1 + det * 0.7);
      const pan = ((v - 2) / 2) * 0.8; const filt = svf(); let p1 = rnd(), p2 = rnd();
      for (let i = idx(t0); i < idx(t0 + dur + 0.15) && i < N; i++) {
        const t = i / SR - t0; p1 += f / SR; p2 += f2 / SR;
        const env = Math.min(1, t / 0.01) * Math.min(1, Math.max(0, (dur + 0.15 - t) / 0.15));
        const saw = ((p1 % 1) * 2 - 1) + 0.5 * ((p2 % 1) * 2 - 1);
        const cut = cutoffStart + (cutoffEnd - cutoffStart) * Math.min(1, t / Math.max(0.01, dur));
        add(i, filt(saw, cut, 0.9) * env * 0.0105 * gain * (k === 0 ? 1.2 : 1), pan, 0.35, true);
      }
    }
  });
}
// ---- bass: offbeat house bass + sub on the one, pumped ----
function bass(bar) {
  const root = ROOTS[bar % 4];
  for (let e = 0; e < 8; e++) {
    const t0 = T(bar, e * 0.5), off = e % 2 === 1; const f = mtof(root + (off ? 12 : 0));
    const filt = svf(); let ph = rnd();
    const len = off ? BEAT * 0.45 : BEAT * 0.4;
    for (let i = idx(t0); i < idx(t0 + len) && i < N; i++) {
      const t = i / SR - t0; ph += f / SR;
      const saw = (ph % 1) * 2 - 1; const sub = Math.sin(2 * Math.PI * ph * (off ? 0.5 : 1));
      const env = Math.min(1, t / 0.004) * Math.exp(-t * (off ? 5 : 3));
      add(i, (filt(saw, 300 + 900 * Math.exp(-t * 18), 1.2) * 0.5 + sub * 0.5) * env * 0.3, 0, 0, true);
    }
  }
}
// ---- pluck arp and bell hook ----
function pluck(t0, note, g = 1, pan = 0) {
  const f = mtof(note); let ph = 0; const filt = lp1();
  for (let i = idx(t0); i < idx(t0 + 0.3) && i < N; i++) {
    const t = i / SR - t0; ph += f / SR;
    const tri = 1 - 4 * Math.abs((ph % 1) - 0.5);
    add(i, filt(tri, 0.3) * Math.exp(-t * 16) * 0.055 * g, pan, 0.5, true);
  }
}
function bell(t0, note, g = 1) {
  const f = mtof(note); let ph = 0, mph = 0;
  for (let i = idx(t0); i < idx(t0 + 1.2) && i < N; i++) {
    const t = i / SR - t0; ph += f / SR; mph += (f * 3.5) / SR;
    const v = Math.sin(2 * Math.PI * ph + 1.6 * Math.exp(-t * 5) * Math.sin(2 * Math.PI * mph));
    add(i, v * Math.exp(-t * 3.2) * 0.07 * g, 0.15, 0.6);
  }
}
const HOOK = [[0, 76], [0.75, 74], [1.5, 72], [2.5, 71], [3, 69]]; // E5 D5 C5 B4 A4 over each bar (adapted per chord below)
const HOOK_SHIFT = [0, -3, 0, -2];

// ---- FX ----
function impact(t0, g = 1) {
  kick(t0, 1.3 * g, false);
  noiseBurst(t0, 1.2, 0.3 * g, 0.02, 0.5, 0, 0.9, 5);
  let ph = 0; for (let i = idx(t0); i < idx(t0 + 2.2) && i < N; i++) { const t = i / SR - t0; ph += (42 + 20 * Math.exp(-t * 8)) / SR; add(i, Math.sin(2 * Math.PI * ph) * Math.exp(-t * 1.6) * 0.34 * g); }
}
function trailerHit(t0) {
  kick(t0, 1.1, false);
  noiseBurst(t0, 0.5, 0.22, 0.03, 0.3, 0, 0.9, 4);
  let ph = 0; for (let i = idx(t0); i < idx(t0 + 1); i++) { const t = i / SR - t0; ph += 55 / SR; add(i, Math.sin(2 * Math.PI * ph) * Math.exp(-t * 3) * 0.3); }
}
function riser(t0, t1, g = 1) {
  const filt = svf(); let ph = 0;
  for (let i = idx(t0); i < idx(t1) && i < N; i++) {
    const x = (i / SR - t0) / (t1 - t0); ph += (200 + 1800 * x * x) / SR;
    const v = filt(rnd(), 300 + 9000 * x * x, 1.4) * 0.6 + Math.sin(2 * Math.PI * ph) * 0.08;
    add(i, v * x * x * 0.22 * g, Math.sin(x * 20) * 0.3, 0.5);
  }
}
function whoosh(tc, g = 1) {
  const t0 = tc - 0.35, t1 = tc + 0.3; const filt = svf();
  const fifth = tonicHz(4) * 1.5, root = tonicHz(4); let p1 = 0, p2 = 0;
  for (let i = idx(t0); i < idx(t1) && i < N; i++) {
    const t = i / SR; const x = t < tc ? (t - t0) / (tc - t0) : 1 - (t - tc) / (t1 - tc);
    p1 += root * (1 + 0.5 * x) / SR; p2 += fifth * (1 + 0.5 * x) / SR;
    const shimmer = (Math.sin(2 * Math.PI * p1) + Math.sin(2 * Math.PI * p2)) * 0.04; // tuned air, in the key
    add(i, (filt(rnd(), 400 + 6000 * x * x, 1.1) * 0.35 + shimmer) * x * x * g, Math.sin((t - t0) * 9) * 0.6, 0.4);
  }
}
// In tune with the music: UI sounds use the major pentatonic of the key
// (the same five notes as its relative minor), which sits on any chord.
const KEY = J.key || {tonic: 0, mode: 'major'};
const PENTA_ROOT = (KEY.mode === 'minor' ? KEY.tonic + 3 : KEY.tonic) % 12;
const PENTA = [0, 2, 4, 7, 9].map((d) => (PENTA_ROOT + d) % 12).sort((a, b) => a - b);
const pentaNote = (i, base = 72) => base + PENTA[((i % 5) + 5) % 5] + 12 * Math.floor(i / 5);
const tonicHz = (oct = 3) => mtof(12 * (oct + 1) + KEY.tonic);
const tick = (t0, g = 1) => noiseBurst(t0, 0.03, 0.3 * g, 0.5, 0.95, 0.1, 0.1, 8);
function thock(t0) { const f0 = tonicHz(3); let ph = 0; for (let i = idx(t0); i < idx(t0 + 0.16); i++) { const t = i / SR - t0; ph += (f0 * (1 + 0.5 * Math.exp(-t * 60))) / SR; add(i, Math.sin(2 * Math.PI * ph) * Math.exp(-t * 26) * 0.4); } tick(t0, 0.8); }
// A soft bell-like blip on a pentatonic note; successive blips climb the scale.
let blipStep = 0;
function blip(t0) {
  const f = mtof(pentaNote(blipStep++, 76)); let ph = 0, mph = 0;
  for (let i = idx(t0); i < idx(t0 + 0.45); i++) { const t = i / SR - t0; ph += f / SR; mph += (f * 2) / SR; const v = Math.sin(2 * Math.PI * ph + 0.8 * Math.exp(-t * 12) * Math.sin(2 * Math.PI * mph)); add(i, v * Math.exp(-t * 9) * 0.075, (blipStep % 2 ? 0.25 : -0.25), 0.5); }
}

// With a licensed track (src/beat.json "music"), only the UI sounds and
// transition whooshes are rendered, to sit under it: public/sfx.wav.
const SFX_ONLY = process.argv.includes('--sfx');
if (SFX_ONLY) {
  for (const bar of Object.keys(J.cuts).map(Number)) whoosh(T(bar), 0.8);
  for (const [b, bt] of J.clicks) tick(T(b, bt), 1.2);
  for (const [b, bt] of J.keys) thock(T(b, bt));
  for (const [[b0, t0], [b1, t1]] of J.typing) { let t = T(b0, t0); const end = T(b1, t1); while (t < end) { tick(t, 0.35 + 0.15 * Math.abs(rnd())); t += BEAT / 4 * (0.5 + Math.abs(rnd()) * 0.5); } }
  for (const [b, bt] of J.pops) blip(T(b, bt));
}
// ================= arrangement =================
if (!SFX_ONLY) {
// Bar 0: filtered chord swell, hat ticks, a trailer hit per word.
chord(0, T(0), BAR, 250, 900, 0.8);
for (let e = 0; e < 8; e++) hat(T(0, e * 0.5), false, 0.6, e % 2 ? 0.3 : -0.3);
for (const [b, bt] of J.hits) trailerHit(T(b, bt));
// Bar 1: logo impact, riser, snare roll, filter opening; silence on the last half beat.
chord(1, T(1), BAR - BEAT * 0.5, 600, 5000, 0.9);
riser(T(1, 0.5), T(1, 3.5), 1.2);
for (let k = 0; k < 16; k++) { const t = T(1, 1.5 + k * (2 / 16)); noiseBurst(t, 0.08, 0.1 + 0.2 * (k / 16), 0.1, 0.6, 0, 0.3, 6); }
// Groove.
for (let bar = 2; bar < END; bar++) {
  const energy = bar >= AGENT ? 1.1 : 1;
  for (let b = 0; b < 4; b++) kick(T(bar, b));
  clap(T(bar, 1), energy); clap(T(bar, 3), energy);
  for (let s = 0; s < 16; s++) hat(T(bar, s * 0.25), false, s % 2 ? 0.55 : 0.9, s % 4 < 2 ? -0.25 : 0.25);
  for (let b = 0; b < 4; b++) hat(T(bar, b + 0.5), true, energy);
  chord(bar, T(bar), BAR, 2600, 2600, energy);
  bass(bar);
  const order = [0, 2, 4, 2, 1, 3, 4, 3];
  for (let s = 0; s < 16; s++) if (bar >= 6 || s % 2 === 0) pluck(T(bar, s * 0.25), CHORDS[bar % 4][order[s % 8]] + 12, s % 4 === 0 ? 1.2 : 0.8, s % 2 ? 0.45 : -0.45);
  if (bar % 2 === 0 || bar >= AGENT) for (const [off, n] of HOOK) bell(T(bar, off), n + HOOK_SHIFT[bar % 4] + (bar >= AGENT + 4 ? 12 : 0), 1);
}
// Builds into the section changes.
riser(T(AGENT - 1, 2), T(AGENT), 0.9); for (let k = 0; k < 8; k++) clap(T(AGENT - 1, 3 + k / 8), 0.3 + k * 0.05);
riser(T(TUNNEL - 1, 0), T(TUNNEL), 1.1);
// Impacts on section cuts, whooshes on the transitions.
for (const [b, bt] of J.impacts) impact(T(b, bt), b === END ? 1.3 : b === 1 ? 1.2 : 0.8);
for (const bar of Object.keys(J.cuts).map(Number)) whoosh(T(bar), 1);
// End: final chord rings out, no drums.
chord(END, T(END), BAR * 2, 5000, 400, 1.2);
bell(T(END), 69, 1.2); bell(T(END, 0.02), 81, 0.8);
// UI sounds.
for (const [b, bt] of J.clicks) tick(T(b, bt), 1.2);
for (const [b, bt] of J.keys) thock(T(b, bt));
for (const [[b0, t0], [b1, t1]] of J.typing) { let t = T(b0, t0); const end = T(b1, t1); while (t < end) { tick(t, 0.35 + 0.15 * Math.abs(rnd())); t += BEAT / 4 * (0.5 + Math.abs(rnd()) * 0.5); } }
for (const [b, bt] of J.pops) blip(T(b, bt));
}

// ================= mix =================
function reverb(input, seedOff) {
  const out = new Float32Array(N);
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((d) => d + seedOff);
  for (const d of combs) { const buf = new Float32Array(d); let k = 0, damp = 0; for (let i = 0; i < N; i++) { const y = buf[k]; damp = y * 0.55 + damp * 0.45; buf[k] = input[i] + damp * 0.84; k = (k + 1) % d; out[i] += y * 0.12; } }
  for (const d of [556, 441, 341, 225].map((x) => x + seedOff)) { const buf = new Float32Array(d); let k = 0; for (let i = 0; i < N; i++) { const b = buf[k]; const y = -out[i] + b; buf[k] = out[i] + b * 0.5; out[i] = y; k = (k + 1) % d; } }
  return out;
}
const wetL = reverb(SEND, 0), wetR = reverb(SEND, 23);
const mL = new Float32Array(N), mR = new Float32Array(N);
for (let i = 0; i < N; i++) {
  const d = DUCK[i];
  mL[i] = L[i] + PL[i] * d + wetL[i] * 0.3 * (0.5 + 0.5 * d);
  mR[i] = R[i] + PR[i] * d + wetR[i] * 0.3 * (0.5 + 0.5 * d);
}
// Glue compressor (slow RMS) + soft clip + normalise.
let env = 0; const att = Math.exp(-1 / (0.005 * SR)), rel = Math.exp(-1 / (0.12 * SR)); let peak = 0;
for (let i = 0; i < N; i++) {
  const lvl = Math.max(Math.abs(mL[i]), Math.abs(mR[i]));
  env = lvl > env ? att * env + (1 - att) * lvl : rel * env + (1 - rel) * lvl;
  const g = env > 0.5 ? Math.pow(0.5 / env, 0.6) : 1;
  mL[i] = Math.tanh(mL[i] * g * 1.25); mR[i] = Math.tanh(mR[i] * g * 1.25);
  peak = Math.max(peak, Math.abs(mL[i]), Math.abs(mR[i]));
}
const gain = 0.93 / peak;
const fadeStart = N - idx(1.2);
const data = Buffer.alloc(N * 4);
for (let i = 0; i < N; i++) {
  const fade = i > fadeStart ? 1 - (i - fadeStart) / (N - fadeStart) : 1;
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, mL[i] * gain * fade)) * 32767), i * 4);
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, mR[i] * gain * fade)) * 32767), i * 4 + 2);
}
const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8); header.write('fmt ', 12);
header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22); header.writeUInt32LE(SR, 24);
header.writeUInt32LE(SR * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
const outFile = SFX_ONLY ? 'sfx.wav' : 'music.wav';
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../public', outFile), Buffer.concat([header, data]));
console.log(`${outFile}: ${SECONDS.toFixed(2)}s at ${(60 / BEAT).toFixed(2)} BPM`);
