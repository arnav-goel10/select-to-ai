import React from 'react';
import {AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {loadFont} from '@remotion/google-fonts/Inter';
import {expoOut, pop, tween} from './util';

export const {fontFamily: INTER} = loadFont('normal', {weights: ['400', '500', '600', '700', '800'], subsets: ['latin']});
export const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';

/** Near-black stage with a slow silver light, grain and a vignette. */
export const Stage: React.FC<{children?: React.ReactNode; glow?: number}> = ({children, glow = 1}) => {
  const f = useCurrentFrame();
  const x = 50 + Math.sin(f / 90) * 12;
  const y = 30 + Math.cos(f / 120) * 8;
  return (
    <AbsoluteFill style={{background: '#060608', fontFamily: INTER, overflow: 'hidden'}}>
      <AbsoluteFill style={{background: `radial-gradient(1300px 800px at ${x}% ${y}%, rgba(255,255,255,${0.085 * glow}), transparent 70%)`}} />
      <AbsoluteFill style={{background: `radial-gradient(900px 600px at ${100 - x}% ${95 - y}%, rgba(148,163,184,${0.06 * glow}), transparent 70%)`}} />
      <AbsoluteFill style={{background: 'radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.55) 100%)', pointerEvents: 'none'}} />
      {children}
      <Grain />
    </AbsoluteFill>
  );
};

const Grain: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{opacity: 0.07, mixBlendMode: 'overlay', pointerEvents: 'none'}}>
      <svg width="100%" height="100%">
        <filter id="grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed={Math.floor(f / 2) % 50} />
        </filter>
        <rect width="100%" height="100%" filter="url(#grain)" />
      </svg>
    </AbsoluteFill>
  );
};

/** The real logo as a 3D tile: stacked layers give it thickness, a sheen sweeps across. */
export const Logo3D: React.FC<{size: number; rx?: number; ry?: number; sheen?: number; depth?: number}> = ({size, rx = 0, ry = 0, sheen = -1, depth = 14}) => {
  const layers = Array.from({length: depth}, (_, i) => i);
  return (
    <div style={{width: size, height: size, position: 'relative', transformStyle: 'preserve-3d', transform: `rotateX(${rx}deg) rotateY(${ry}deg)`}}>
      {layers.map((i) => (
        <div key={i} style={{position: 'absolute', inset: size * 0.045, borderRadius: size * 0.2, background: `rgb(${22 + i},${22 + i},${26 + i})`, transform: `translateZ(${-i * (size / 160)}px)`}} />
      ))}
      <Img src={staticFile('logo.png')} style={{position: 'absolute', inset: 0, width: size, height: size, transform: 'translateZ(1px)', filter: 'drop-shadow(0 30px 60px rgba(0,0,0,0.6))'}} />
      {sheen >= 0 && sheen <= 1 && (
        <div style={{position: 'absolute', inset: size * 0.045, borderRadius: size * 0.2, overflow: 'hidden', transform: 'translateZ(2px)'}}>
          <div style={{position: 'absolute', top: -size, bottom: -size, width: size * 0.35, left: `${-50 + sheen * 200}%`, transform: 'rotate(20deg)', background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.35), transparent)'}} />
        </div>
      )}
    </div>
  );
};

/** A browser window (light page inside) that can be placed in 3D. */
export const Browser: React.FC<{url: string; title: string; width: number; height: number; children: React.ReactNode; favicon?: string; style?: React.CSSProperties; side?: React.ReactNode; sideWidth?: number}> = ({url, title, width, height, children, favicon = '•', style, side, sideWidth = 0}) => (
  <div style={{width, height, borderRadius: 18, overflow: 'hidden', background: '#fff', boxShadow: '0 80px 160px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', ...style}}>
    <div style={{height: 88, background: '#ececef', display: 'flex', flexDirection: 'column', borderBottom: '1px solid #dcdce0', flexShrink: 0}}>
      <div style={{height: 42, display: 'flex', alignItems: 'flex-end', paddingLeft: 18, gap: 14}}>
        <div style={{display: 'flex', gap: 8, alignSelf: 'center'}}>
          {['#ff5f57', '#febc2e', '#28c840'].map((c) => <div key={c} style={{width: 12, height: 12, borderRadius: 6, background: c}} />)}
        </div>
        <div style={{marginLeft: 18, height: 34, width: 260, background: '#fff', borderRadius: '10px 10px 0 0', display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px', fontSize: 14, color: '#3f3f46'}}>
          <div style={{width: 16, height: 16, borderRadius: 4, background: '#18181b', color: '#fff', fontSize: 10, display: 'grid', placeItems: 'center', fontWeight: 700}}>{favicon}</div>
          <span style={{whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>{title}</span>
        </div>
      </div>
      <div style={{flex: 1, background: '#fff', display: 'flex', alignItems: 'center', padding: '0 16px', gap: 12}}>
        <div style={{color: '#a1a1aa', fontSize: 18}}>‹ ›</div>
        <div style={{flex: 1, height: 32, borderRadius: 16, background: '#f1f1f3', display: 'flex', alignItems: 'center', padding: '0 16px', fontSize: 15, color: '#52525b', gap: 8}}>
          <svg width="12" height="14" viewBox="0 0 12 14"><rect x="1" y="6" width="10" height="7" rx="2" fill="#71717a" /><path d="M3.5 6V4a2.5 2.5 0 015 0v2" stroke="#71717a" strokeWidth="1.6" fill="none" /></svg>
          {url}
        </div>
        <Img src={staticFile('icon128.png')} style={{width: 22, height: 22, borderRadius: 6}} />
      </div>
    </div>
    <div style={{flex: 1, display: 'flex', minHeight: 0}}>
      <div style={{flex: 1, position: 'relative', overflow: 'hidden'}}>{children}</div>
      {side && <div style={{width: sideWidth, borderLeft: '1px solid #26262b', flexShrink: 0, position: 'relative', overflow: 'hidden'}}>{side}</div>}
    </div>
  </div>
);

/** macOS-style pointer with a click ripple. */
export const Cursor: React.FC<{x: number; y: number; clicks?: number[]; ai?: boolean; opacity?: number}> = ({x, y, clicks = [], ai = false, opacity = 1}) => {
  const f = useCurrentFrame();
  const press = clicks.some((c) => f >= c && f < c + 5);
  return (
    <div style={{position: 'absolute', left: x, top: y, pointerEvents: 'none', opacity, zIndex: 50}}>
      {clicks.map((c) => {
        const t = f - c;
        if (t < 0 || t > 18) return null;
        const s = tween(t, 0, 18, 0.2, 1.6);
        return <div key={c} style={{position: 'absolute', left: -22, top: -22, width: 44, height: 44, borderRadius: 22, border: `2px solid ${ai ? 'rgba(255,255,255,0.9)' : 'rgba(24,24,27,0.5)'}`, transform: `scale(${s})`, opacity: 1 - t / 18}} />;
      })}
      {ai ? (
        <>
          <div style={{position: 'absolute', left: -16, top: -16, width: 32, height: 32, borderRadius: 16, background: 'radial-gradient(circle at 35% 30%, #52525b, #18181b 70%)', border: '3px solid #fff', boxShadow: '0 0 0 2px rgba(24,24,27,0.35), 0 8px 24px rgba(24,24,27,0.45), 0 0 36px rgba(24,24,27,0.35)', transform: `scale(${press ? 0.8 : 1})`}} />
          <div style={{position: 'absolute', left: 22, top: 14, background: '#18181b', color: '#fff', fontSize: 14, fontWeight: 700, padding: '5px 10px', borderRadius: 8, whiteSpace: 'nowrap', boxShadow: '0 6px 18px rgba(0,0,0,0.3)', fontFamily: INTER}}>Select to AI</div>
        </>
      ) : (
        <svg width="30" height="30" viewBox="0 0 24 24" style={{transform: `scale(${press ? 0.88 : 1})`, transformOrigin: '0 0', filter: 'drop-shadow(0 3px 6px rgba(0,0,0,0.35))'}}>
          <path d="M3 2l15 11.5-6.6.9 3.9 7.2-2.6 1.4-3.9-7.3L3 20z" fill="#fff" stroke="#111" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
      )}
    </div>
  );
};

/** A 3D keycap that presses down at `pressAt`. */
export const Keycap: React.FC<{label: string; pressAt: number; size?: number; wide?: number}> = ({label, pressAt, size = 150, wide = 1}) => {
  const f = useCurrentFrame();
  const t = f - pressAt;
  const down = t >= 0 && t < 8 ? tween(t, 0, 3, 0, 1) * (t < 4 ? 1 : tween(t, 4, 8, 1, 0)) : 0;
  const w = size * wide;
  return (
    <div style={{width: w, height: size, position: 'relative'}}>
      <div style={{position: 'absolute', inset: 0, top: 18, borderRadius: 28, background: '#0c0c0f', boxShadow: '0 40px 70px rgba(0,0,0,0.7)'}} />
      <div style={{position: 'absolute', left: 0, right: 0, top: down * 14, height: size - 14, borderRadius: 26, background: 'linear-gradient(180deg, #3a3a40, #1d1d22)', boxShadow: 'inset 0 2px 0 rgba(255,255,255,0.18), inset 0 -8px 16px rgba(0,0,0,0.5), 0 14px 0 #121216', display: 'grid', placeItems: 'center', color: '#f4f4f5', fontSize: size * 0.4, fontWeight: 600}}>
        {label}
      </div>
    </div>
  );
};

/** Kinetic caption: words rise out of a blur, one after another. */
export const Caption: React.FC<{text: string; at: number; kicker?: string; size?: number; align?: 'left' | 'center'; style?: React.CSSProperties; out?: number}> = ({text, at, kicker, size = 64, align = 'left', style, out}) => {
  const f = useCurrentFrame();
  const {fps} = useVideoConfig();
  const words = text.split(' ');
  const leave = out !== undefined ? tween(f, out, out + 12, 0, 1) : 0;
  return (
    <div style={{position: 'absolute', textAlign: align, color: '#fafafa', opacity: 1 - leave, transform: `translateY(${-leave * 20}px)`, ...style}}>
      {kicker && (
        <div style={{fontSize: 20, letterSpacing: 4, textTransform: 'uppercase', color: '#a1a1aa', marginBottom: 14, opacity: tween(f, at - 6, at + 8, 0, 1), fontWeight: 600}}>{kicker}</div>
      )}
      <div style={{fontSize: size, fontWeight: 700, letterSpacing: -size * 0.035, lineHeight: 1.05}}>
        {words.map((w, i) => {
          const p = pop(f, fps, at + i * 4, 140, 18);
          return (
            <span key={i} style={{display: 'inline-block', marginRight: size * 0.24, transform: `translateY(${(1 - p) * size * 0.5}px)`, opacity: Math.min(1, p * 1.4), filter: `blur(${(1 - Math.min(1, p)) * 12}px)`}}>
              {w}
            </span>
          );
        })}
      </div>
    </div>
  );
};

/** Soft dark glass pill. */
export const Pill: React.FC<{children: React.ReactNode; style?: React.CSSProperties}> = ({children, style}) => (
  <div style={{display: 'inline-flex', alignItems: 'center', gap: 10, padding: '10px 18px', borderRadius: 999, background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.14)', color: '#e4e4e7', fontSize: 20, fontWeight: 500, backdropFilter: 'blur(12px)', ...style}}>
    {children}
  </div>
);

export {expoOut};
