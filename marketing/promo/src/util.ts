import {Easing, interpolate, spring} from 'remotion';

export const expoOut = Easing.bezier(0.16, 1, 0.3, 1);
export const inOut = Easing.bezier(0.65, 0, 0.35, 1);
export const backOut = Easing.bezier(0.34, 1.56, 0.64, 1);

/** Clamped interpolation between two frames with easing. */
export const tween = (f: number, from: number, to: number, a: number, b: number, easing = expoOut) =>
  interpolate(f, [from, to], [a, b], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing});

export const pop = (f: number, fps: number, delay = 0, stiffness = 180, damping = 16) =>
  spring({frame: f - delay, fps, config: {stiffness, damping, mass: 0.9}});

/** Piecewise path through keyframes [{f, x, y}], eased between each pair. */
export function path(f: number, keys: {f: number; x: number; y: number}[], easing = inOut) {
  if (f <= keys[0].f) return {x: keys[0].x, y: keys[0].y};
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (f <= b.f) {
      const t = easing((f - a.f) / Math.max(1, b.f - a.f));
      return {x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t};
    }
  }
  const last = keys[keys.length - 1];
  return {x: last.x, y: last.y};
}

/** Text typed from `start` at `cps` characters per second. */
export const typed = (text: string, f: number, start: number, cps = 22, fps = 30) =>
  text.slice(0, Math.max(0, Math.floor(((f - start) / fps) * cps)));

/** Streamed text: whole words appear, like a model answering. */
export function streamed(text: string, f: number, start: number, end: number) {
  const words = text.split(/(\s+)/);
  const n = Math.round(tween(f, start, end, 0, words.length, (t) => t));
  const out = words.slice(0, n).join('');
  // Close a bold phrase that is still arriving, as streaming UIs do,
  // so a half-sent **phrase never shows its asterisks.
  return (out.match(/\*\*/g) || []).length % 2 ? `${out}**` : out;
}

/**
 * Smooth streaming for rendered Markdown: the complete layout is placed at
 * once (so tables and lists never break or reflow), then words fade in in
 * reading order. `progress` counts words; each fades over `soft` words.
 */
export function revealHtml(html: string, progress: number, soft = 5): {html: string; words: number} {
  let n = 0;
  const parts = html.split(/(<[^>]+>)/);
  let pendingLi = -1; // index of an <li> whose bullet waits for its first word
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k];
    if (!part) continue;
    if (part.startsWith('<')) { if (/^<li[\s>]/.test(part)) pendingLi = k; continue; }
    parts[k] = part.split(/(\s+)/).map((w) => {
      if (!w.trim()) return w;
      const o = Math.max(0, Math.min(1, (progress - n) / soft));
      n++;
      // A list bullet appears with the first word of its item, not before.
      if (pendingLi >= 0) { if (o < 0.3) parts[pendingLi] = parts[pendingLi].replace(/^<li/, '<li class="pm"'); pendingLi = -1; }
      return `<span style="opacity:${o.toFixed(3)};filter:blur(${((1 - o) * 3).toFixed(2)}px)">${w}</span>`;
    }).join('');
  }
  return {html: parts.join(''), words: n};
}
