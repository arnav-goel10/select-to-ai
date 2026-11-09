import React from 'react';
import {AbsoluteFill, Img, staticFile, useCurrentFrame} from 'remotion';
import {loadFont} from '@remotion/google-fonts/Inter';
import J from './beat.json';
import {expoOut, tween} from './util';

export const {fontFamily: INTER} = loadFont('normal', {weights: ['400', '500', '600', '700', '800', '900'], subsets: ['latin']});
export const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';

/** The product name, in one place, so a rename is one line. */
export const BRAND = 'Select to AI';
export const TAGLINE = 'Highlight. Ask. Delegate.';

/** Frames since the current scene's first bar (negative during the incoming transition). */
export const FrameCtx = React.createContext<number | null>(null);
export const useF = () => {
  const ctx = React.useContext(FrameCtx);
  const f = useCurrentFrame();
  return ctx ?? f;
};

export const FPS = J.fps;
export const BEAT = J.beatFrames;
export const BAR = BEAT * 4;
/** Absolute frame of a bar and beat. */
export const B = (bar: number, beat = 0) => Math.round((bar * 4 + beat) * BEAT);
/** Frames of `beats` beats. */
export const bt = (beats: number) => beats * BEAT;

/** 1 on every beat, decaying fast: drives the camera punch in the groove. */
export function pulse(absFrame: number) {
  const bar = absFrame / BAR;
  if (bar < 2 || bar >= 18) return 0;
  const since = absFrame % BEAT;
  return Math.exp(-since / 5);
}

/** Near-black stage: moving silver light, grain and a vignette under the content. */
export const Stage: React.FC<{children?: React.ReactNode; glow?: number}> = ({children, glow = 1}) => {
  const f = useCurrentFrame();
  const x = 50 + Math.sin(f / 170) * 14;
  const y = 32 + Math.cos(f / 230) * 9;
  return (
    <AbsoluteFill style={{background: '#050506', fontFamily: INTER, overflow: 'hidden'}}>
      <AbsoluteFill style={{background: `radial-gradient(1400px 820px at ${x}% ${y}%, rgba(255,255,255,${0.09 * glow}), transparent 70%)`}} />
      <AbsoluteFill style={{background: `radial-gradient(1000px 700px at ${100 - x}% ${96 - y}%, rgba(161,161,170,${0.06 * glow}), transparent 70%)`}} />
      <AbsoluteFill style={{background: 'radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.6) 100%)'}} />
      {children}
      <Grain />
    </AbsoluteFill>
  );
};

const Grain: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{opacity: 0.06, mixBlendMode: 'overlay', pointerEvents: 'none'}}>
      <svg width="100%" height="100%">
        <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed={Math.floor(f / 3) % 60} /></filter>
        <rect width="100%" height="100%" filter="url(#grain)" />
      </svg>
    </AbsoluteFill>
  );
};

/** Chrome-silver type, with a light sweep moving across it. */
export const Metal: React.FC<{children: React.ReactNode; size: number; weight?: number; style?: React.CSSProperties; sweep?: number}> = ({children, size, weight = 800, style, sweep}) => {
  const f = useF();
  const s = sweep ?? ((f * 1.2) % 300) - 100;
  return (
    <span style={{fontSize: size, fontWeight: weight, letterSpacing: -size * 0.045, lineHeight: 1, backgroundImage: `linear-gradient(100deg, rgba(255,255,255,0) ${s - 18}%, rgba(255,255,255,0.95) ${s}%, rgba(255,255,255,0) ${s + 18}%), linear-gradient(180deg, #ffffff 0%, #e4e4e7 45%, #9d9da6 100%)`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', display: 'inline-block', paddingBottom: size * 0.08, ...style}}>
      {children}
    </span>
  );
};

/**
 * The logo, built from its two layers so the flower can bloom: the tile pops
 * in, the petals spin up from a point and open past full size before they
 * settle, with a flash and a shockwave. The mark is 6-fold symmetric, so a
 * full turn lands exactly where it started.
 */
export const LogoBloom: React.FC<{size: number; p: number; glow?: number; tilt?: {x: number; y: number}}> = ({size, p, glow = 1, tilt = {x: 0, y: 0}}) => {
  const tileIn = tween(p, 0, 0.35, 0, 1, expoOut);
  const petal = tween(p, 0.08, 1, 0, 1, expoOut);
  const over = Math.sin(Math.min(1, petal) * Math.PI) * 0.1;
  const flash = Math.max(0, 1 - Math.abs(p - 0.18) / 0.18);
  const wave = tween(p, 0.1, 0.8, 0, 1, expoOut);
  return (
    <div style={{width: size, height: size, position: 'relative', transform: `perspective(1400px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`}}>
      <div style={{position: 'absolute', left: '50%', top: '50%', width: size * 2.6, height: size * 2.6, marginLeft: -size * 1.3, marginTop: -size * 1.3, borderRadius: '50%', background: `radial-gradient(circle, rgba(255,255,255,${0.22 * glow * (0.35 + flash)}), transparent 60%)`}} />
      {wave > 0 && wave < 1 && <div style={{position: 'absolute', left: '50%', top: '50%', width: size, height: size, marginLeft: -size / 2, marginTop: -size / 2, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.6)', transform: `scale(${0.5 + wave * 2.4})`, opacity: (1 - wave) * 0.7}} />}
      <Img src={staticFile('logo-tile.png')} style={{position: 'absolute', inset: 0, width: size, height: size, transform: `scale(${0.55 + 0.45 * tileIn})`, opacity: tileIn, filter: `drop-shadow(0 ${size * 0.12}px ${size * 0.25}px rgba(0,0,0,0.65))`}} />
      <Img src={staticFile('logo-petals.png')} style={{position: 'absolute', inset: 0, width: size, height: size, transform: `rotate(${-360 * (1 - petal)}deg) scale(${Math.max(0.001, petal + over)})`, opacity: Math.min(1, petal * 3), filter: `blur(${(1 - petal) * 6}px) brightness(${1 + flash * 0.9})`}} />
    </div>
  );
};

/** Claude's spark mark: tapered rays of uneven length in Claude's coral. */
export const ClaudeMark: React.FC<{size: number}> = ({size}) => {
  const rays = [1, 0.8, 0.95, 0.78, 1, 0.84, 0.97, 0.76, 0.93, 0.82, 1, 0.79];
  const jitter = [0, 4, -3, 2, -2, 5, -4, 3, -1, 4, -3, 2];
  const r = 48;
  return (
    <svg width={size} height={size} viewBox="-50 -50 100 100">
      {rays.map((len, i) => {
        const a = ((i * 30 + jitter[i]) * Math.PI) / 180;
        const L = r * len, w0 = 5.2, w1 = 2.6;
        const cx = Math.cos(a), sy = Math.sin(a), nx = -sy, ny = cx;
        const p = [[nx * w0, ny * w0], [cx * L + nx * w1, sy * L + ny * w1], [cx * L - nx * w1, sy * L - ny * w1], [-nx * w0, -ny * w0]];
        return (
          <g key={i} fill="#D97757">
            <polygon points={p.map((q) => q.join(',')).join(' ')} />
            <circle cx={cx * L} cy={sy * L} r={w1} />
          </g>
        );
      })}
      <circle r="7" fill="#D97757" />
    </svg>
  );
};

/** Browser window with a real page inside. */
/**
 * Browser window with a real page inside. `blur` softens only the page and
 * the browser chrome (depth of field); the side panel and `overlay` (the quick
 * box) stay sharp, so the focus never bleeds into what we want read.
 */
export const Browser: React.FC<{url: string; title: string; width: number; height: number; children: React.ReactNode; favicon?: React.ReactNode; side?: React.ReactNode; sideWidth?: number; style?: React.CSSProperties; blur?: number; overlay?: React.ReactNode}> = ({url, title, width, height, children, favicon, side, sideWidth = 0, style, blur = 0, overlay}) => (
  <div style={{width, height, borderRadius: 20, overflow: 'hidden', background: '#fff', boxShadow: '0 90px 180px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.1)', display: 'flex', flexDirection: 'column', position: 'relative', ...style}}>
    <div style={{height: 88, background: '#ececef', display: 'flex', flexDirection: 'column', borderBottom: '1px solid #dcdce0', flexShrink: 0, filter: blur > 0.01 ? `blur(${blur}px)` : undefined}}>
      <div style={{height: 42, display: 'flex', alignItems: 'flex-end', paddingLeft: 18, gap: 14}}>
        <div style={{display: 'flex', gap: 8, alignSelf: 'center'}}>{['#ff5f57', '#febc2e', '#28c840'].map((c) => <div key={c} style={{width: 12, height: 12, borderRadius: 6, background: c}} />)}</div>
        <div style={{marginLeft: 18, height: 34, width: 270, background: '#fff', borderRadius: '10px 10px 0 0', display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px', fontSize: 14, color: '#3f3f46', fontFamily: INTER}}>
          {favicon}
          <span style={{whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>{title}</span>
        </div>
      </div>
      <div style={{flex: 1, background: '#fff', display: 'flex', alignItems: 'center', padding: '0 16px', gap: 12, fontFamily: INTER}}>
        <div style={{color: '#a1a1aa', fontSize: 18}}>‹ ›</div>
        <div style={{flex: 1, height: 32, borderRadius: 16, background: '#f1f1f3', display: 'flex', alignItems: 'center', padding: '0 16px', fontSize: 15, color: '#52525b', gap: 8}}>
          <svg width="12" height="14" viewBox="0 0 12 14"><rect x="1" y="6" width="10" height="7" rx="2" fill="#71717a" /><path d="M3.5 6V4a2.5 2.5 0 015 0v2" stroke="#71717a" strokeWidth="1.6" fill="none" /></svg>
          {url}
        </div>
        <Img src={staticFile('icon128.png')} style={{width: 22, height: 22, borderRadius: 6}} />
      </div>
    </div>
    <div style={{flex: 1, display: 'flex', minHeight: 0}}>
      <div style={{flex: 1, position: 'relative', overflow: 'hidden', filter: blur > 0.01 ? `blur(${blur}px)` : undefined}}>{children}</div>
      {sideWidth > 1 && <div style={{width: sideWidth, flexShrink: 0, position: 'relative', overflow: 'hidden', borderLeft: '1px solid rgba(0,0,0,0.12)'}}>{side}</div>}
    </div>
    {overlay && <div style={{position: 'absolute', left: 0, top: 88, right: sideWidth, bottom: 0}}>{overlay}</div>}
  </div>
);

/** A captured page (1280 css px wide), scrolled by `scroll` px. */
export const Shot: React.FC<{src: string; scroll?: number; children?: React.ReactNode; opacity?: number}> = ({src, scroll = 0, children, opacity = 1}) => (
  <div style={{position: 'absolute', inset: 0, opacity}}>
    <div style={{position: 'absolute', left: 0, top: -scroll, width: 1280}}>
      <Img src={staticFile(`captures/${src}`)} style={{width: 1280, display: 'block'}} />
      {children}
    </div>
  </div>
);

/** macOS pointer, or the agent's own glowing pointer with its name tag. */
export const Cursor: React.FC<{x: number; y: number; clicks?: number[]; ai?: boolean; opacity?: number; tag?: boolean}> = ({x, y, clicks = [], ai = false, opacity = 1, tag = true}) => {
  const f = useF();
  const press = clicks.some((c) => f >= c && f < c + 8);
  return (
    <div style={{position: 'absolute', left: x, top: y, pointerEvents: 'none', opacity, zIndex: 50}}>
      {clicks.map((c) => {
        const t = f - c;
        if (t < 0 || t > 30) return null;
        return <div key={c} style={{position: 'absolute', left: -24, top: -24, width: 48, height: 48, borderRadius: 24, border: `2.5px solid ${ai ? 'rgba(24,24,27,0.7)' : 'rgba(37,99,235,0.6)'}`, transform: `scale(${tween(t, 0, 30, 0.3, 1.8)})`, opacity: 1 - t / 30}} />;
      })}
      {ai ? (
        <>
          <div style={{position: 'absolute', left: -17, top: -17, width: 34, height: 34, borderRadius: 17, background: 'radial-gradient(circle at 35% 30%, #52525b, #111 70%)', border: '3px solid #fff', boxShadow: '0 8px 26px rgba(0,0,0,0.45), 0 0 40px rgba(24,24,27,0.35)', transform: `scale(${press ? 0.78 : 1})`}} />
          {tag && <div style={{position: 'absolute', left: 24, top: 16, display: 'flex', alignItems: 'center', gap: 7, background: '#111', color: '#fff', fontSize: 15, fontWeight: 700, padding: '6px 11px 6px 7px', borderRadius: 9, whiteSpace: 'nowrap', boxShadow: '0 6px 18px rgba(0,0,0,0.3)', fontFamily: INTER}}>
            <Img src={staticFile('icon128.png')} style={{width: 18, height: 18, borderRadius: 5}} />{BRAND}
          </div>}
        </>
      ) : (
        <svg width="30" height="30" viewBox="0 0 24 24" style={{transform: `scale(${press ? 0.86 : 1})`, transformOrigin: '0 0', filter: 'drop-shadow(0 3px 6px rgba(0,0,0,0.35))'}}>
          <path d="M3 2l15 11.5-6.6.9 3.9 7.2-2.6 1.4-3.9-7.3L3 20z" fill="#fff" stroke="#111" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
      )}
    </div>
  );
};

/** A 3D keycap that presses down at `pressAt`. */
export const Keycap: React.FC<{label: string; pressAt: number; size?: number}> = ({label, pressAt, size = 170}) => {
  const f = useF();
  const t = f - pressAt;
  const down = t >= 0 && t < 14 ? (t < 5 ? tween(t, 0, 5, 0, 1) : tween(t, 5, 14, 1, 0)) : 0;
  return (
    <div style={{width: size, height: size, position: 'relative'}}>
      <div style={{position: 'absolute', inset: 0, top: 20, borderRadius: 30, background: '#09090b', boxShadow: '0 50px 80px rgba(0,0,0,0.75)'}} />
      <div style={{position: 'absolute', left: 0, right: 0, top: down * 16, height: size - 16, borderRadius: 28, background: 'linear-gradient(180deg, #3f3f46, #1c1c21)', boxShadow: `inset 0 2px 0 rgba(255,255,255,0.2), inset 0 -10px 18px rgba(0,0,0,0.5), 0 16px 0 #111114, 0 0 ${down * 60}px rgba(255,255,255,${down * 0.25})`, display: 'grid', placeItems: 'center', color: '#fafafa', fontSize: size * 0.42, fontWeight: 600, fontFamily: INTER}}>{label}</div>
    </div>
  );
};

/** Kinetic caption: words rise out of a blur on the beat. */
export const Caption: React.FC<{text: string; at: number; out?: number; kicker?: string; size?: number; align?: 'left' | 'center'; style?: React.CSSProperties}> = ({text, at, out, kicker, size = 60, align = 'left', style}) => {
  const f = useF();
  const words = text.split(' ');
  const leave = out !== undefined ? tween(f, out, out + 14, 0, 1) : 0;
  if (f < at - 10 || leave >= 1) return null;
  return (
    <div style={{position: 'absolute', textAlign: align, opacity: 1 - leave, transform: `translateY(${-leave * 24}px)`, filter: `blur(${leave * 10}px)`, ...style}}>
      {kicker && <div style={{fontSize: 19, letterSpacing: 5, textTransform: 'uppercase', color: '#a1a1aa', marginBottom: 16, opacity: tween(f, at - 6, at + 10, 0, 1), fontWeight: 600, fontFamily: INTER}}>{kicker}</div>}
      <div style={{lineHeight: 1.04}}>
        {words.map((w, i) => {
          const p = tween(f, at + i * 3, at + i * 3 + 16, 0, 1, expoOut);
          return (
            <span key={i} style={{display: 'inline-block', marginRight: size * 0.24, transform: `translateY(${(1 - p) * size * 0.6}px)`, opacity: p, filter: `blur(${(1 - p) * 14}px)`}}>
              <Metal size={size}>{w}</Metal>
            </span>
          );
        })}
      </div>
    </div>
  );
};

/** Screen-space depth of field: everything but an ellipse around (x, y) goes soft. */
export const DepthOfField: React.FC<{x: number; y: number; amount: number; rx?: number; ry?: number}> = ({x, y, amount, rx = 34, ry = 38}) =>
  amount <= 0.01 ? null : (
    <AbsoluteFill style={{backdropFilter: `blur(${amount * 7}px)`, WebkitMaskImage: `radial-gradient(ellipse ${rx}% ${ry}% at ${x}% ${y}%, transparent 55%, black 100%)`, maskImage: `radial-gradient(ellipse ${rx}% ${ry}% at ${x}% ${y}%, transparent 55%, black 100%)`, pointerEvents: 'none'}} />
  );
