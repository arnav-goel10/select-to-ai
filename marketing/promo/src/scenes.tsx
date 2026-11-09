import React from 'react';
import {AbsoluteFill, Img, staticFile} from 'remotion';
import CAP from '../public/captures/captures.json';
import {BEAT, BRAND, Browser, Caption, ClaudeMark, Cursor, INTER, Keycap, LogoBloom, Metal, Shot, Stage, TAGLINE, bt} from './kit';
import {AnswerStyles, ClaudePanel, ContextMenu, Msg, QuickBox, SidePanel, smoothAnswer} from './ui2';
import {expoOut, inOut, path, tween, typed} from './util';

export type SceneProps = {f: number; abs: number};

/** Camera: eased keyframes (in beats) for x, y, scale and rotation, plus the beat punch. */
function camera(b: number, keys: {b: number; x?: number; y?: number; s?: number; rx?: number; ry?: number}[], abs: number) {
  const val = (k: 'x' | 'y' | 's' | 'rx' | 'ry', d: number) => {
    const ks = keys.filter((q) => q[k] !== undefined) as any[];
    if (!ks.length) return d;
    if (b <= ks[0].b) return ks[0][k];
    for (let i = 1; i < ks.length; i++) if (b <= ks[i].b) { const t = inOut((b - ks[i - 1].b) / (ks[i].b - ks[i - 1].b)); return ks[i - 1][k] + (ks[i][k] - ks[i - 1][k]) * t; }
    return ks[ks.length - 1][k];
  };
  return `translate(${val('x', 0)}px, ${val('y', 0)}px) scale(${val('s', 1)}) rotateX(${val('rx', 0)}deg) rotateY(${val('ry', 0)}deg)`;
}
const Favicon: React.FC<{bg: string; fg?: string; ch: string}> = ({bg, fg = '#fff', ch}) => (
  <div style={{width: 16, height: 16, borderRadius: 4, background: bg, color: fg, fontSize: 10, display: 'grid', placeItems: 'center', fontWeight: 800}}>{ch}</div>
);

// ================================================================ 1. Hook
// Each word carries its object, as good launch films do: a real selection
// sweeps behind "Highlight.", a ⌘K keycap presses beside "Ask.", and the
// agent's cursor clicks "Delegate." and boxes it the way it sees pages.
export const Hook: React.FC<SceneProps> = ({f}) => {
  const b = f / BEAT;
  const WORDS = ['Highlight.', 'Ask.', 'Delegate.'];
  const bloom = tween(f, bt(4), bt(5.7), 0, 1, (t) => t);
  return (
    <Stage glow={0.7 + (b >= 4 ? 0.6 : 0)}>
      <AbsoluteFill style={{display: 'grid', placeItems: 'center'}}>
        {WORDS.map((w, k) => {
          const t0 = bt(k), t1 = k < 2 ? bt(k + 1) : bt(3);
          if (f < t0 - 2 || f > t1 + 10) return null;
          const inn = tween(f, t0, t0 + 12, 0, 1, expoOut);
          const out = tween(f, t1, t1 + 9, 0, 1, inOut);
          const sel = k === 0 ? tween(f, bt(0.25), bt(0.75), 0, 1, inOut) : 0;
          const agentBox = k === 2 ? tween(f, bt(2.5), bt(2.5) + 10, 0, 1, expoOut) : 0;
          const cur = k === 2 ? path(f, [{f: bt(2), x: 900, y: 330}, {f: bt(2.45), x: 700, y: 250}]) : null;
          return (
            <div key={w} style={{position: 'absolute', display: 'flex', alignItems: 'center', gap: 40, transform: `scale(${1.45 - 0.45 * inn - 0.12 * out})`, opacity: inn * (1 - out), filter: `blur(${(1 - inn) * 26 + out * 22}px)`}}>
              <div style={{position: 'relative'}}>
                {k === 0 && sel > 0 && <div style={{position: 'absolute', left: -8, top: 30, height: 230, width: `calc(${sel * 100}% + 16px)`, background: 'rgba(96,165,250,0.45)', borderRadius: 10}} />}
                {k === 0 && sel > 0 && sel < 1 && <div style={{position: 'absolute', left: `${sel * 100}%`, top: 20, width: 5, height: 250, background: '#fafafa', borderRadius: 3}} />}
                {k === 2 && agentBox > 0 && (
                  <>
                    <div style={{position: 'absolute', inset: '14px -22px -6px -22px', border: '5px solid rgba(250,250,250,0.9)', borderRadius: 26, opacity: agentBox, transform: `scale(${1.08 - 0.08 * agentBox})`}} />
                    <div style={{position: 'absolute', left: -22, top: -36, background: '#fafafa', color: '#111', fontSize: 38, fontWeight: 800, padding: '4px 16px', borderRadius: 12, opacity: agentBox, fontFamily: INTER}}>[7] link</div>
                  </>
                )}
                <div style={{position: 'relative'}}><Metal size={250} weight={900}>{w}</Metal></div>
                {cur && f < bt(3) && <div style={{position: 'absolute', left: cur.x, top: cur.y, transform: 'scale(2.4)', transformOrigin: '0 0'}}><Cursor ai tag={false} x={0} y={0} clicks={[bt(2.5)]} /></div>}
              </div>
              {k === 1 && <div style={{transform: `translateY(20px) rotateX(20deg) scale(${tween(f, bt(1.1), bt(1.1) + 10, 0.6, 1, expoOut)})`, opacity: tween(f, bt(1.1), bt(1.1) + 8, 0, 1)}}><div style={{display: 'flex', gap: 18}}><Keycap label="⌘" pressAt={bt(1.5)} size={150} /><Keycap label="K" pressAt={bt(1.5) + 4} size={150} /></div></div>}
            </div>
          );
        })}
        {f >= bt(3) - 2 && f < bt(4) + 6 && (
          <div style={{position: 'absolute', display: 'flex', gap: 34, transform: `scale(${tween(f, bt(3.7), bt(4.05), 1, 0.2, inOut)})`, opacity: tween(f, bt(3.75), bt(4.05), 1, 0), filter: `blur(${tween(f, bt(3.7), bt(4.05), 0, 14)}px)`}}>
            {WORDS.map((w, k) => {
              const p = tween(f, bt(3 + k * 0.25), bt(3 + k * 0.25) + 10, 0, 1, expoOut);
              return <span key={w} style={{opacity: p, transform: `translateY(${(1 - p) * 30}px)`, display: 'inline-block'}}><Metal size={96}>{w}</Metal></span>;
            })}
          </div>
        )}
        {f >= bt(4) - 1 && (
          <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 46, marginTop: 30}}>
            <LogoBloom size={300} p={bloom} tilt={{x: Math.sin(f / 50) * 5, y: Math.sin(f / 40) * 8}} />
            <div style={{opacity: tween(f, bt(5.4), bt(5.4) + 16, 0, 1), transform: `translateY(${tween(f, bt(5.4), bt(5.4) + 22, 30, 0, expoOut)}px)`, filter: `blur(${tween(f, bt(5.4), bt(5.4) + 16, 12, 0)}px)`}}>
              <Metal size={104}>{BRAND}</Metal>
            </div>
          </div>
        )}
      </AbsoluteFill>
    </Stage>
  );
};

// ================================================================ 2. Highlight (Wikipedia -> Claude)
const WL = CAP.wiki.lines as {y: number; h: number; x0: number; x1: number}[];
export const Highlight: React.FC<SceneProps> = ({f, abs}) => {
  const b = f / BEAT;
  const sel = tween(f, bt(2), bt(4.5), 0, 1, (t) => t);
  const li = Math.max(0, Math.min(WL.length - 1, Math.floor(sel * WL.length - 1e-6)));
  const lf = Math.max(0, Math.min(1, sel * WL.length - li));
  const end = WL[WL.length - 1];
  const endPt = {x: end.x1, y: end.y + end.h};
  let cur;
  if (f < bt(2)) cur = path(f, [{f: 0, x: 1000, y: 620}, {f: bt(1.8), x: WL[0].x0 - 2, y: WL[0].y + 12}]);
  else if (f < bt(4.6)) cur = {x: WL[li].x0 + (WL[li].x1 - WL[li].x0) * lf, y: WL[li].y + 12};
  else cur = path(f, [{f: bt(4.6), x: endPt.x, y: endPt.y}, {f: bt(5.9), x: endPt.x + 150, y: endPt.y - 34}, {f: bt(6.4), x: endPt.x + 175, y: endPt.y - 32}, {f: bt(7.4), x: endPt.x + 410, y: endPt.y + 76}]);
  const menu = f >= bt(5) && f < bt(8.3) ? tween(f, bt(5), bt(5) + 10, 0, 1, expoOut) : f >= bt(8.3) ? tween(f, bt(8.3), bt(8.3) + 8, 1, 0) : 0;
  const side = tween(f, bt(8), bt(8.8), 0, 470, expoOut);
  const fly = tween(f, bt(8), bt(9.1), 0, 1, inOut);
  const md = 'Think of it as a place where gravity has **completely won**.\n\n- So much mass is packed into so little space that its pull becomes overwhelming.\n- Past its edge, the **event horizon**, nothing gets back out, not even light.\n- No light can leave, so it looks **black**.';
  const answer = f >= bt(10) ? smoothAnswer(md, tween(f, bt(10), bt(14.5), 0, 1, (t) => t)) : undefined;
  const cam = camera(b, [{b: 0, x: 0, y: 0, s: 1, ry: 11, rx: 3}, {b: 4.6, x: -40, y: 0, s: 1.04, ry: 8, rx: 2}, {b: 5.8, x: -660, y: 30, s: 1.45, ry: 4, rx: 1}, {b: 7.6, x: -690, y: 30, s: 1.47, ry: 4, rx: 1}, {b: 9.4, x: -520, y: 30, s: 1.26, ry: 3, rx: 1}, {b: 15, x: -560, y: 30, s: 1.3, ry: 2, rx: 1}], abs);
  const dof = tween(f, bt(10), bt(11), 0, 1) * tween(f, bt(15), bt(15.8), 1, 0);
  return (
    <Stage>
      <AnswerStyles />
      <Caption kicker="Highlight" text="Right-click any text." at={bt(0.7)} out={bt(4.9)} size={66} style={{left: 110, top: 150, width: 460}} />
      <AbsoluteFill style={{perspective: 2400}}>
        <div style={{position: 'absolute', left: 590, top: 140, transform: cam, transformOrigin: '30% 50%'}}>
          <Browser url="en.wikipedia.org/wiki/Black_hole" title="Black hole - Wikipedia" width={1280} height={800} favicon={<Favicon bg="#fff" fg="#111" ch="W" />} blur={dof * 6} sideWidth={side} side={<ClaudePanel prompt={f >= bt(9) ? 'Explain this simply: “A black hole is an astronomical body so compact that its gravity prevents anything, including light, from escaping…”' : undefined} promptIn={tween(f, bt(9), bt(9) + 14, 0, 1, expoOut)} answerHtml={answer} />}>
            <Shot src="wiki.png">
              {WL.map((l, i) => {
                const p = Math.max(0, Math.min(1, sel * WL.length - i));
                return p > 0 ? <div key={i} style={{position: 'absolute', left: l.x0 - 1, top: l.y - 2, width: (l.x1 - l.x0 + 2) * p, height: l.h + 4, background: '#b4d5fe', mixBlendMode: 'multiply'}} /> : null;
              })}
              {menu > 0 && (
                <div style={{position: 'absolute', left: endPt.x + 4, top: endPt.y - 196}}>
                  <ContextMenu hover={f >= bt(6) ? 3 : -1} sub={f >= bt(6.2)} subAppear={tween(f, bt(6.2), bt(6.2) + 8, 0, 1)} subHover={f >= bt(7.2) ? 3 : f >= bt(6.6) ? 0 : -1} appear={menu} />
                </div>
              )}
              {fly > 0 && fly < 1 && (
                <div style={{position: 'absolute', left: WL[0].x0 + fly * 560, top: WL[0].y + fly * -150, width: 470, padding: '12px 16px', borderRadius: 14, background: '#dbeafe', color: '#1e3a8a', fontSize: 16, lineHeight: 1.5, boxShadow: `0 ${24 * Math.sin(fly * Math.PI)}px 50px rgba(30,58,138,${0.3 * Math.sin(fly * Math.PI)})`, transform: `scale(${1 - fly * 0.3}) rotate(${Math.sin(fly * Math.PI) * -5}deg)`, opacity: tween(fly, 0.8, 1, 1, 0), fontFamily: 'Georgia, serif'}}>
                  A black hole is an astronomical body so compact that its gravity prevents anything, including light, from escaping…
                </div>
              )}
              <Cursor x={cur.x} y={cur.y} clicks={[bt(5), bt(8)]} opacity={f < bt(8.4) ? 1 : tween(f, bt(8.4), bt(8.9), 1, 0)} />
            </Shot>
          </Browser>
        </div>
      </AbsoluteFill>
    </Stage>
  );
};

// ================================================================ 3. Ask (Allrecipes, quick box)
export const Ask: React.FC<SceneProps> = ({f, abs}) => {
  const b = f / BEAT;
  const keysIn = tween(f, bt(0.9), bt(1.3), 0, 1, expoOut);
  const keysOut = tween(f, bt(2.2), bt(2.7), 0, 1, inOut);
  const box = tween(f, bt(2), bt(2) + 14, 0, 1, expoOut);
  const dim = tween(f, bt(2), bt(2.4), 0, 1);
  const q = 'How long do I bake these, and at what temperature?';
  const text = f >= bt(2.5) ? q.slice(0, Math.round(tween(f, bt(2.5), bt(4.5), 0, q.length, (t) => t))) : '';
  const sent = f >= bt(5);
  const md = '### 350°F (175°C) for about 10 minutes\nBake until the **edges are golden brown** and the middles are mostly set. They keep setting as they cool.\n\n| Step | |\n| --- | --- |\n| Oven | 350°F (175°C), preheated |\n| Time | About 10 minutes |\n| Done when | Golden edges, soft middle |';
  const answer = f >= bt(5.4) ? smoothAnswer(md, tween(f, bt(5.4), bt(8.8), 0, 1, (t) => t)) : undefined;
  const cam = camera(b, [{b: 0, x: 0, y: 0, s: 1, ry: 9, rx: 3}, {b: 5.2, x: -40, y: 0, s: 1.03, ry: 6, rx: 2}, {b: 7, x: -330, y: 10, s: 1.42, ry: 2, rx: 1}, {b: 12, x: -345, y: 10, s: 1.45, ry: 1.5, rx: 1}], abs);
  const dof = tween(f, bt(7), bt(8), 0, 1);
  return (
    <Stage>
      <AnswerStyles />
      <Caption kicker="⌘K on any page" text="Ask the page you're on." at={bt(0.5)} out={bt(5.6)} size={66} style={{left: 110, top: 150, width: 470}} />
      <AbsoluteFill style={{perspective: 2400}}>
        <div style={{position: 'absolute', left: 590, top: 140, transform: cam, transformOrigin: '30% 50%'}}>
          <Browser url="allrecipes.com/recipe/10813/best-chocolate-chip-cookies" title="Best Chocolate Chip Cookies" width={1280} height={800} favicon={<Favicon bg="#e04a1f" ch="a" />} blur={dim * 3 + dof * 5}
            overlay={box > 0 ? (
              <div style={{position: 'absolute', left: 230, top: 60, transform: `translateY(${(1 - box) * 40}px) scale(${0.94 + 0.06 * box})`, opacity: box, transformOrigin: 'top center'}}>
                <QuickBox text={text} caret={!sent} label={text ? 'Answer from this page' : 'Type to begin'} dot={text ? '#18181b' : '#9aa1ae'} answerHtml={answer} />
              </div>
            ) : undefined}>
            <Shot src="recipe.png" />
            <div style={{position: 'absolute', inset: 0, background: `rgba(12,12,14,${dim * 0.45})`}} />
          </Browser>
        </div>
        {f < bt(2.8) && keysIn > 0 && (
          <div style={{position: 'absolute', left: 860, top: 430, display: 'flex', gap: 36, transform: `translateZ(${(1 - keysIn) * -700 + keysOut * 1100}px) rotateX(${30 - keysIn * 12}deg) rotateY(-14deg)`, opacity: keysIn * (1 - keysOut)}}>
            <Keycap label="⌘" pressAt={bt(1.5)} size={200} />
            <Keycap label="K" pressAt={bt(2)} size={200} />
          </div>
        )}
      </AbsoluteFill>
    </Stage>
  );
};

// ================================================================ 4. Agent (Amazon)
const AM = CAP.amazon as any;
const CARDS = AM.cards as {x: number; y: number; w: number; h: number; title: string; rating: string; reviews: string}[];
// From the live capture: high rating backed by many reviews. Two 5.0 listings have under 60 reviews.
const PICKS = [0, 3, 1]; // Soundcore Q20i, Bose QuietComfort, Sony WH-CH720N
export const Agent: React.FC<SceneProps> = ({f, abs}) => {
  const b = f / BEAT;
  const task = 'Find the best-reviewed noise-cancelling headphones on Amazon';
  const input = f < bt(3.5) ? task.slice(0, Math.round(tween(f, bt(1), bt(3.25), 0, task.length, (t) => t))) : '';
  const query = f >= bt(5.5) ? 'noise cancelling headphones'.slice(0, Math.round(tween(f, bt(5.5), bt(6.75), 0, 27, (t) => t))) : '';
  const results = tween(f, bt(7.4), bt(7.4) + 10, 0, 1);
  const scroll = path(f, [{f: bt(7.5), x: 0, y: 0}, {f: bt(9), x: 0, y: 420}, {f: bt(10.5), x: 0, y: 900}, {f: bt(11.6), x: 0, y: 120}, {f: bt(12.3), x: 0, y: 120}, {f: bt(12.8), x: 0, y: 810}, {f: bt(13.3), x: 0, y: 810}, {f: bt(13.8), x: 0, y: 300}, {f: bt(14.6), x: 0, y: 150}]).y;
  const cur = path(f, [
    {f: bt(4), x: 1240, y: 420}, {f: bt(4.9), x: AM.homeBox.x + 120, y: AM.homeBox.y + 22}, {f: bt(7.3), x: AM.homeBox.x + 130, y: AM.homeBox.y + 24},
    {f: bt(8.5), x: 760, y: 300}, {f: bt(10), x: 820, y: 520}, {f: bt(11.2), x: 700, y: 360},
    {f: bt(11.9), x: 640, y: CARDS[0].y + 110 - 120}, {f: bt(12.9), x: 640, y: CARDS[3].y + 100 - 810}, {f: bt(13.9), x: 640, y: CARDS[1].y + 130 - 300}, {f: bt(14.8), x: 900, y: 360},
  ]);
  const hovered = (i: number) => {const k = PICKS.indexOf(i); return k < 0 ? 0 : tween(f, bt(12 + k), bt(12 + k) + 10, 0, 1, expoOut);};
  const md = '### Best reviewed\n| Pick | Rating | Reviews |\n| --- | --- | --- |\n| **Soundcore Q20i** | ★ 4.5 | 75.3K |\n| Bose QuietComfort | ★ 4.5 | 21.9K |\n| Sony WH-CH720N | ★ 4.4 | 757 |\n\n**Soundcore Q20i**: top rating, by far the most reviews. I skipped two 5.0 listings with under 60 reviews each.';
  const progress = f < bt(4) ? 'Thinking…' : f < bt(7.5) ? 'Searching Amazon…' : f < bt(11) ? 'Reading 16 results…' : f < bt(15) ? 'Comparing ratings…' : '';
  const confirm = tween(f, bt(19), bt(19) + 14, 0, 1, expoOut);
  const added = tween(f, bt(21), bt(21) + 18, 0, 1, expoOut);
  const msgs: Msg[] = [];
  if (f >= bt(3.5)) msgs.push({role: 'user', text: task, appear: tween(f, bt(3.5), bt(3.5) + 14, 0, 1, expoOut)});
  if (f >= bt(3.8)) msgs.push({role: 'assistant', appear: tween(f, bt(3.8), bt(3.8) + 12, 0, 1, expoOut), progress: progress || undefined, html: f >= bt(15) ? smoothAnswer(md, tween(f, bt(15), bt(18.5), 0, 1, (t) => t)) : undefined, children: f >= bt(19) ? (
    <div style={{position: 'relative', marginTop: 14, borderRadius: 16, border: '1px solid #3a3a42', background: '#18181c', padding: '15px 16px', opacity: confirm, transform: `translateY(${(1 - confirm) * 14}px) scale(${0.95 + confirm * 0.05})`, transformOrigin: 'top left'}}>
      <div style={{fontSize: 17, lineHeight: 1.45}}>Add <b>Soundcore Q20i</b> to your cart?</div>
      <div style={{display: 'flex', gap: 10, marginTop: 12, position: 'relative'}}>
        {/* The payoff: you click, and the button becomes a confirmation. */}
        <div style={{position: 'relative', background: added > 0 ? '#e7f6ec' : '#fafafa', color: '#111', fontWeight: 700, borderRadius: 10, padding: '9px 15px', fontSize: 15, width: added > 0 ? 165 : 98, transition: 'none', display: 'flex', alignItems: 'center', gap: 8, transform: `scale(${1 + Math.sin(Math.min(1, added) * Math.PI) * 0.08})`, overflow: 'visible'}}>
          {added > 0 ? (
            <>
              <svg width="18" height="18" viewBox="0 0 24 24" style={{flexShrink: 0}}><circle cx="12" cy="12" r="11" fill="#16a34a" /><path d="M7 12.5l3.2 3.2L17 9" stroke="#fff" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="16" strokeDashoffset={16 * (1 - added)} /></svg>
              <span style={{color: '#14532d', whiteSpace: 'nowrap'}}>Added to cart</span>
            </>
          ) : 'Add to cart'}
          {added > 0 && added < 1 && Array.from({length: 12}, (_, i) => {
            const a = (i / 12) * Math.PI * 2, r = 20 + added * 70;
            return <div key={i} style={{position: 'absolute', left: 40 + Math.cos(a) * r, top: 17 + Math.sin(a) * r * 0.7, width: 6, height: 6, borderRadius: 3, background: i % 2 ? '#e4e4e7' : '#a1a1aa', opacity: 1 - added}} />;
          })}
        </div>
        <div style={{border: '1px solid #3a3a42', borderRadius: 10, padding: '9px 15px', fontSize: 15, color: '#d4d4d8', opacity: 1 - added * 0.6}}>Not now</div>
        {f >= bt(20) && f < bt(22.5) && <Cursor x={path(f, [{f: bt(20), x: 330, y: 90}, {f: bt(20.9), x: 58, y: 22}]).x} y={path(f, [{f: bt(20), x: 330, y: 90}, {f: bt(20.9), x: 58, y: 22}]).y} clicks={[bt(21)]} opacity={tween(f, bt(20), bt(20.3), 0, 1) * tween(f, bt(22), bt(22.5), 1, 0)} />}
      </div>
    </div>
  ) : undefined});
  const panelScroll = tween(f, bt(18.6), bt(19.4), 0, 130, inOut);
  const cam = camera(b, [{b: 0, x: -250, y: 0, s: 1.12, ry: -4, rx: 2}, {b: 3.6, x: -230, y: 0, s: 1.1, ry: -3, rx: 2}, {b: 5, x: 20, y: 0, s: 1, ry: 3, rx: 3}, {b: 7.6, x: 20, y: 0, s: 1.02, ry: 3, rx: 2}, {b: 8.8, x: 170, y: -140, s: 1.32, ry: 2, rx: 1}, {b: 14.4, x: 180, y: -150, s: 1.34, ry: 1, rx: 1}, {b: 16, x: -420, y: 30, s: 1.22, ry: -2, rx: 1}, {b: 19.2, x: -560, y: -210, s: 1.42, ry: -2, rx: 1}, {b: 24, x: -580, y: -215, s: 1.46, ry: -2, rx: 1}], abs);
  const dof = tween(f, bt(19.2), bt(20), 0, 1) * tween(f, bt(23.5), bt(24.3), 1, 0);
  const vision = f >= bt(8) && f < bt(11.4);
  const scanY = tween(f, bt(8), bt(11), 150, 1500, (t) => t);
  return (
    <Stage>
      <AnswerStyles />
      <Caption kicker="The agent" text="Or let it do the clicking." at={bt(0.6)} out={bt(15)} size={60} style={{left: 110, top: 52, width: 1200}} />
      <AbsoluteFill style={{perspective: 2600}}>
        <div style={{position: 'absolute', left: 90, top: 190, transform: cam, transformOrigin: '50% 50%'}}>
          <Browser url={results > 0.5 ? 'amazon.com/s?k=noise+cancelling+headphones' : 'amazon.com'} title={results > 0.5 ? 'Amazon.com : noise cancelling…' : 'Amazon.com'} width={1740} height={820} favicon={<Favicon bg="#131921" fg="#ff9900" ch="a" />} blur={dof * 6} sideWidth={460} side={<SidePanel messages={msgs} input={input} inputCaret={f >= bt(1) && f < bt(3.5)} scroll={panelScroll} />}>
            <Shot src="amazon-home.png" opacity={1 - results}>
              {query && <div style={{position: 'absolute', left: AM.homeBox.x + 6, top: AM.homeBox.y + 3, width: AM.homeBox.w - 12, height: AM.homeBox.h - 6, background: '#fff', display: 'flex', alignItems: 'center', fontSize: 16, color: '#0f1111', fontFamily: 'Arial, sans-serif', paddingLeft: 4}}>{query}</div>}
            </Shot>
            {results > 0 && (
              <Shot src="amazon-results.png" scroll={scroll} opacity={results}>
                {vision && CARDS.slice(0, 8).map((c, i) => (c.y + 40 > scanY ? null : (
                  <React.Fragment key={i}>
                    <div style={{position: 'absolute', left: c.x + 400, top: c.y + 8, width: c.w - 410, height: 40, borderRadius: 8, border: '2px solid rgba(24,24,27,0.75)'}} />
                    <div style={{position: 'absolute', left: c.x + 400, top: c.y - 14, background: '#18181b', color: '#fff', fontSize: 13, fontWeight: 700, padding: '3px 8px', borderRadius: 7, fontFamily: INTER}}>[{12 + i * 3}] link</div>
                    <div style={{position: 'absolute', left: c.x + 400, top: c.y + 62, background: '#18181b', color: '#fff', fontSize: 12, fontWeight: 700, padding: '2px 7px', borderRadius: 6, fontFamily: INTER}}>[{13 + i * 3}] {c.rating}★</div>
                  </React.Fragment>
                )))}
                {vision && <div style={{position: 'absolute', left: 0, right: 0, top: scanY, height: 3, background: 'linear-gradient(90deg, transparent, rgba(24,24,27,0.85), transparent)', boxShadow: '0 0 28px rgba(24,24,27,0.5)'}} />}
                {CARDS.map((c, i) => {const g = hovered(i); return g ? <div key={i} style={{position: 'absolute', left: c.x - 6, top: c.y - 6, width: c.w + 12, height: c.h + 12, borderRadius: 16, border: `3px solid rgba(24,24,27,${g})`, boxShadow: `0 0 0 ${g * 8}px rgba(24,24,27,0.08)`}} /> : null;})}
              </Shot>
            )}
            {f >= bt(4) && f < bt(15.2) && <Cursor ai x={cur.x} y={cur.y} clicks={[bt(5), bt(12), bt(13), bt(14)]} opacity={tween(f, bt(4), bt(4.4), 0, 1) * tween(f, bt(14.8), bt(15.2), 1, 0)} />}
          </Browser>
        </div>
      </AbsoluteFill>
      {f >= bt(19) && (
        <>
          <AbsoluteFill style={{background: 'linear-gradient(90deg, rgba(5,5,6,0.94) 0%, rgba(5,5,6,0.8) 34%, rgba(5,5,6,0) 58%)', opacity: confirm}} />
          <Caption kicker="Always" text="It asks before anything that costs money." at={bt(19.1)} size={62} style={{left: 110, top: 380, width: 620}} />
        </>
      )}
    </Stage>
  );
};

// ================================================================ 5a. Tunnel
// Real sites fly past on both sides while the line lands word by word.
const TUNNEL = ['tunnel-airbnb.jpg', 'wiki.png', 'tunnel-github.jpg', 'amazon-home.png', 'tunnel-booking.jpg', 'recipe.png', 'tunnel-docs.jpg'];
export const Tunnel: React.FC<SceneProps> = ({f}) => {
  const panels = Array.from({length: 16}, (_, i) => {
    const side = i % 2 ? 1 : -1;
    const r = (k: number) => ((Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1 + 1) % 1;
    return {src: TUNNEL[i % TUNNEL.length], side, x: side * (780 + r(1) * 280), y: -330 + r(2) * 660, z0: -4400 + i * 260, tilt: r(3) * 10 - 5};
  });
  const v = 34; // px per frame toward the camera
  const words = [['Works', 0], ['on every', 1], ['site.', 2]] as const;
  return (
    <Stage glow={1.1}>
      <AbsoluteFill style={{perspective: 1100, perspectiveOrigin: '50% 50%'}}>
        {panels.map((p, i) => {
          const z = p.z0 + v * (f + 20);
          if (z > 950 || z < -4600) return null;
          const fadeIn = Math.max(0, Math.min(1, (z + 4400) / 1400));
          return (
            <div key={i} style={{position: 'absolute', left: 960 - 290 + p.x, top: 540 - 180 + p.y, width: 580, height: 362, borderRadius: 18, overflow: 'hidden', transform: `translateZ(${z}px) rotateY(${p.side * -34}deg) rotateZ(${p.tilt}deg)`, opacity: fadeIn, boxShadow: '0 40px 90px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.12)'}}>
              <Img src={staticFile(`captures/${p.src}`)} style={{width: 580, display: 'block'}} />
            </div>
          );
        })}
      </AbsoluteFill>
      <AbsoluteFill style={{background: 'radial-gradient(ellipse 46% 34% at 50% 50%, rgba(5,5,6,0.95) 30%, transparent 100%)', zIndex: 5}} />
      <AbsoluteFill style={{display: 'grid', placeItems: 'center', zIndex: 6}}>
        <div style={{display: 'flex', gap: 32}}>
          {words.map(([w, beat]) => {
            const p = tween(f, bt(beat), bt(beat) + 14, 0, 1, expoOut);
            return <span key={w} style={{opacity: p, transform: `translateY(${(1 - p) * 40}px) scale(${1.2 - 0.2 * p})`, filter: `blur(${(1 - p) * 16}px)`, display: 'inline-block'}}><Metal size={132} weight={900}>{w}</Metal></span>;
          })}
        </div>
      </AbsoluteFill>
    </Stage>
  );
};

// ================================================================ 5. Bento
const Card: React.FC<{title: string; line: string; children: React.ReactNode; p: number; big?: boolean}> = ({title, line, children, p}) => (
  <div style={{width: '100%', height: '100%', borderRadius: 30, padding: 32, boxSizing: 'border-box', background: 'linear-gradient(160deg, #19191c, #0e0e10)', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 30px 80px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.08)', color: '#fafafa', fontFamily: INTER, display: 'flex', flexDirection: 'column', opacity: p, transform: `translateY(${(1 - p) * 40}px) scale(${0.92 + 0.08 * p})`, filter: `blur(${(1 - p) * 10}px)`, overflow: 'hidden'}}>
    <div style={{flex: 1, display: 'flex', alignItems: 'center'}}>{children}</div>
    <div style={{fontSize: 28, fontWeight: 700, letterSpacing: -0.7}}>{title}</div>
    <div style={{fontSize: 18, color: '#a1a1aa', marginTop: 6, lineHeight: 1.4}}>{line}</div>
  </div>
);

export const Bento: React.FC<SceneProps> = ({f, abs}) => {
  const b = f / BEAT;
  const at = [0.25, 0.5, 0.75, 1, 1.25, 1.5]; // one card per eighth note
  const p = (i: number) => tween(f, bt(at[i]), bt(at[i]) + 14, 0, 1, expoOut);
  const conv = tween(f, bt(3.1), bt(4), 0, 1, inOut);
  const W = 520, H = 300, G = 24, X0 = (1920 - (3 * W + 2 * G)) / 2, Y0 = 312;
  const cards = [
    <Card key="free" p={p(0)} title="Free to start" line="Runs on free models. No card needed."><Metal size={120} weight={800}>$0</Metal></Card>,
    <Card key="read" p={p(1)} title="Reads like you do" line="Finds the part of the page that answers you.">
      <div style={{width: '100%'}}>{[0.95, 0.8, 0.9, 0.6].map((w, i) => <div key={i} style={{height: 12, width: `${w * 100}%`, borderRadius: 6, marginBottom: 12, background: i === 1 || i === 2 ? '#b4d5fe' : '#2e2e34', opacity: i === 1 || i === 2 ? 0.9 : 1}} />)}</div>
    </Card>,
    <Card key="click" p={p(2)} title="Does the clicking" line="Searches, compares and fills forms for you.">
      <div style={{position: 'relative', width: '100%', height: 100}}>
        {[0, 1, 2].map((i) => <div key={i} style={{position: 'absolute', left: i * 132, top: 22, width: 118, height: 62, borderRadius: 12, border: `2px solid ${i === 1 ? '#fafafa' : '#3a3a42'}`}}><div style={{position: 'absolute', top: -12, left: 8, background: '#fafafa', color: '#111', fontSize: 12, fontWeight: 800, padding: '1px 6px', borderRadius: 5}}>[{12 + i}]</div></div>)}
        <div style={{position: 'absolute', left: 200, top: 58, width: 24, height: 24, borderRadius: 12, background: '#111', border: '3px solid #fff'}} />
      </div>
    </Card>,
    <Card key="pay" p={p(3)} title="Asks before you pay" line="Purchases and deletions wait for your OK.">
      <div style={{border: '1px solid #3a3a42', borderRadius: 14, padding: '14px 16px', background: '#141417', fontSize: 17}}>Add to cart?<div style={{display: 'flex', gap: 8, marginTop: 10}}><span style={{background: '#fafafa', color: '#111', borderRadius: 8, padding: '6px 12px', fontWeight: 700, fontSize: 14}}>Add</span><span style={{border: '1px solid #3a3a42', borderRadius: 8, padding: '6px 12px', fontSize: 14, color: '#d4d4d8'}}>Not now</span></div></div>
    </Card>,
    <Card key="mem" p={p(4)} title="Remembers you" line="Your preferences, and the sites you use.">
      <div style={{display: 'flex', flexWrap: 'wrap', gap: 10}}>{['Prices in SGD', 'Window seat', 'Vegetarian'].map((t) => <span key={t} style={{border: '1px solid #3a3a42', borderRadius: 999, padding: '8px 14px', fontSize: 16, color: '#e4e4e7', background: '#141417'}}>{t}</span>)}</div>
    </Card>,
    <Card key="keys" p={p(5)} title="Works with the AI you use" line="ChatGPT, Claude, Gemini, Perplexity or your own key.">
      <div style={{display: 'flex', alignItems: 'center', gap: 18}}><ClaudeMark size={54} /><div style={{fontSize: 22, color: '#d4d4d8', fontWeight: 600}}>ChatGPT · Gemini · Perplexity</div></div>
    </Card>,
  ];
  const cam = `scale(${1 + b * 0.015})`;
  return (
    <Stage glow={1.2}>
      <div style={{position: 'absolute', left: 0, right: 0, top: 96, textAlign: 'center', opacity: 1 - conv}}>
        <Caption kicker="Built for real browsing" text="Everything it needs." at={0} size={70} align="center" style={{position: 'relative'}} />
      </div>
      <AbsoluteFill style={{transform: cam}}>
        {cards.map((c, i) => {
          const x = X0 + (i % 3) * (W + G), y = Y0 + Math.floor(i / 3) * (H + G);
          const dx = (960 - (x + W / 2)) * conv, dy = (540 - (y + H / 2)) * conv;
          return <div key={i} style={{position: 'absolute', left: x, top: y, width: W, height: H, transform: `translate(${dx}px, ${dy}px) scale(${1 - conv * 0.8})`, opacity: 1 - conv * conv}}>{c}</div>;
        })}
      </AbsoluteFill>
    </Stage>
  );
};

// ================================================================ 6. End card
export const End: React.FC<SceneProps> = ({f}) => {
  const bloom = tween(f, 0, bt(1.7), 0, 1, (t) => t);
  const name = tween(f, bt(1.2), bt(1.2) + 18, 0, 1, expoOut);
  const tag = tween(f, bt(2), bt(2) + 18, 0, 1, expoOut);
  const cta = tween(f, bt(3), bt(3) + 16, 0, 1, expoOut);
  const works = tween(f, bt(4), bt(4) + 20, 0, 1);
  return (
    <Stage glow={1.35}>
      <AbsoluteFill style={{display: 'grid', placeItems: 'center'}}>
        <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
          <LogoBloom size={230} p={bloom} tilt={{x: Math.sin(f / 60) * 4, y: Math.sin(f / 45) * 7}} />
          <div style={{marginTop: 42, opacity: name, transform: `translateY(${(1 - name) * 36}px)`, filter: `blur(${(1 - name) * 12}px)`}}><Metal size={128} weight={900}>{BRAND}</Metal></div>
          <div style={{fontSize: 40, fontWeight: 500, color: '#a1a1aa', marginTop: 4, letterSpacing: -0.8, opacity: tag, transform: `translateY(${(1 - tag) * 22}px)`, fontFamily: INTER}}>{TAGLINE}</div>
          <div style={{marginTop: 44, opacity: cta, transform: `scale(${0.86 + cta * 0.14})`}}>
            <div style={{display: 'inline-flex', alignItems: 'center', gap: 14, padding: '20px 36px', borderRadius: 999, background: '#fafafa', color: '#0a0a0b', fontSize: 28, fontWeight: 700, boxShadow: `0 20px ${60 + 30 * Math.sin(f / 20)}px rgba(255,255,255,0.2)`, fontFamily: INTER}}>
              <Img src={staticFile('icon128.png')} style={{width: 30, height: 30, borderRadius: 8}} />Free on the Chrome Web Store
            </div>
          </div>
          <div style={{marginTop: 28, fontSize: 21, color: '#71717a', opacity: works, fontFamily: INTER}}>Works with ChatGPT · Claude · Gemini · Perplexity · your own API key</div>
        </div>
      </AbsoluteFill>
    </Stage>
  );
};
