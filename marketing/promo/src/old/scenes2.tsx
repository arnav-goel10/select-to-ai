import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {Browser, Caption, Cursor, Logo3D, Pill, Stage, INTER} from './components';
import {AnswerStyles, Msg, SidePanel, renderAnswer} from './ui';
import {Shell} from './scenes1';
import {inOut, path, pop, streamed, tween, typed} from './util';

// ---------------------------------------------------------------- 4. Agent
const PRODUCTS = [
  {name: 'Aurora 2', price: 179, stars: 4.8, reviews: '1,204', hue: '#27272a'},
  {name: 'Pulse ANC', price: 149, stars: 4.3, reviews: '612', hue: '#1e3a8a'},
  {name: 'Studio One', price: 249, stars: 4.7, reviews: '988', hue: '#7c2d12'},
  {name: 'Drift Lite', price: 89, stars: 3.9, reviews: '301', hue: '#065f46'},
  {name: 'Nova Max', price: 199, stars: 4.6, reviews: '845', hue: '#e4e4e7'},
  {name: 'Echo 3', price: 129, stars: 4.1, reviews: '455', hue: '#9f1239'},
  {name: 'Halo Pro', price: 299, stars: 4.9, reviews: '2,010', hue: '#78716c'},
  {name: 'Wave', price: 59, stars: 3.6, reviews: '190', hue: '#0e7490'},
];
const PICKS = [0, 4, 1];
const cardPos = (i: number) => ({x: 30 + (i % 4) * 252, y: 150 + Math.floor(i / 4) * 290});

const Headphones: React.FC<{color: string}> = ({color}) => (
  <svg width="120" height="110" viewBox="0 0 120 110">
    <defs>
      <linearGradient id={`g${color}`} x1="0" x2="1"><stop offset="0" stopColor={color} /><stop offset="1" stopColor="#71717a" /></linearGradient>
    </defs>
    <path d="M18 70 C18 25 102 25 102 70" stroke={`url(#g${color})`} strokeWidth="9" fill="none" strokeLinecap="round" />
    <rect x="8" y="60" width="26" height="42" rx="12" fill={color} />
    <rect x="86" y="60" width="26" height="42" rx="12" fill={color} />
    <rect x="13" y="66" width="8" height="30" rx="4" fill="rgba(255,255,255,0.25)" />
  </svg>
);

const ShopPage: React.FC<{f: number; query: string; results: boolean}> = ({f, query, results}) => (
  <div style={{position: 'absolute', inset: 0, background: '#fafaf9', fontFamily: INTER, color: '#1c1917'}}>
    <div style={{height: 72, background: '#fff', borderBottom: '1px solid #eee', display: 'flex', alignItems: 'center', padding: '0 30px', gap: 30}}>
      <b style={{fontSize: 26, letterSpacing: -1}}>parcel</b>
      <div style={{width: 520, height: 42, borderRadius: 21, border: '1.5px solid #d6d3d1', display: 'flex', alignItems: 'center', padding: '0 18px', fontSize: 17, color: query ? '#1c1917' : '#a8a29e', background: '#fff'}}>
        {query || 'Search Parcel'}
      </div>
      <span style={{marginLeft: 'auto', fontSize: 15, color: '#78716c'}}>Cart (0)</span>
    </div>
    {!results ? (
      <div style={{margin: 30, height: 300, borderRadius: 22, background: 'linear-gradient(120deg, #1c1917, #57534e)', color: '#fff', padding: 44}}>
        <div style={{fontSize: 16, letterSpacing: 3, opacity: 0.7}}>AUTUMN SOUND SALE</div>
        <div style={{fontSize: 46, fontWeight: 800, marginTop: 10, letterSpacing: -1}}>Quiet, finally.</div>
        <div style={{fontSize: 19, opacity: 0.8, marginTop: 8}}>Up to 30% off headphones this week.</div>
      </div>
    ) : (
      <>
        <div style={{position: 'absolute', left: 30, top: 96, fontSize: 17, color: '#57534e'}}>24 results for “noise cancelling headphones”</div>
        {PRODUCTS.map((p, i) => {
          const {x, y} = cardPos(i);
          const inn = tween(f, 160 + i * 3, 172 + i * 3, 0, 1);
          return (
            <div key={p.name} style={{position: 'absolute', left: x, top: y, width: 232, height: 270, borderRadius: 16, background: '#fff', border: '1px solid #e7e5e4', padding: 16, opacity: inn, transform: `translateY(${(1 - inn) * 20}px)`}}>
              <div style={{height: 130, borderRadius: 12, background: '#f5f5f4', display: 'grid', placeItems: 'center'}}><Headphones color={p.hue} /></div>
              <div style={{fontSize: 18, fontWeight: 700, marginTop: 12}}>{p.name}</div>
              <div style={{fontSize: 15, color: '#b45309', marginTop: 4}}>{'★'.repeat(Math.round(p.stars))}<span style={{color: '#a8a29e'}}> {p.stars} ({p.reviews})</span></div>
              <div style={{fontSize: 20, fontWeight: 800, marginTop: 6}}>${p.price}</div>
            </div>
          );
        })}
      </>
    )}
  </div>
);

const NewTab: React.FC = () => (
  <div style={{position: 'absolute', inset: 0, background: '#fff', display: 'grid', placeItems: 'center', fontFamily: INTER}}>
    <div style={{width: 560, height: 50, borderRadius: 25, border: '1px solid #e4e4e7', boxShadow: '0 2px 8px rgba(0,0,0,0.06)'}} />
  </div>
);

/** Numbered boxes: the elements the agent sees, as it scans the results. */
const VisionOverlay: React.FC<{f: number}> = ({f}) => {
  if (f < 168 || f > 222) return null;
  const scan = tween(f, 168, 208, 120, 740, (t) => t);
  const fade = tween(f, 212, 222, 1, 0);
  return (
    <div style={{position: 'absolute', inset: 0, opacity: fade, pointerEvents: 'none'}}>
      <div style={{position: 'absolute', left: 0, right: 0, top: scan, height: 2, background: 'linear-gradient(90deg, transparent, rgba(24,24,27,0.8), transparent)', boxShadow: '0 0 24px rgba(24,24,27,0.5)'}} />
      {PRODUCTS.map((p, i) => {
        const {x, y} = cardPos(i);
        if (y + 40 > scan) return null;
        return (
          <React.Fragment key={p.name}>
            <div style={{position: 'absolute', left: x - 4, top: y - 4, width: 240, height: 278, borderRadius: 18, border: '2px solid rgba(24,24,27,0.7)'}} />
            <div style={{position: 'absolute', left: x - 4, top: y - 16, background: '#18181b', color: '#fff', fontSize: 13, fontWeight: 700, padding: '3px 8px', borderRadius: 7, fontFamily: INTER}}>[{14 + i * 2}] link</div>
            <div style={{position: 'absolute', left: x + 150, top: y + 226, background: '#18181b', color: '#fff', fontSize: 12, fontWeight: 700, padding: '2px 6px', borderRadius: 6, fontFamily: INTER}}>[{15 + i * 2}]</div>
          </React.Fragment>
        );
      })}
    </div>
  );
};

export const AgentScene: React.FC = () => {
  const f = useCurrentFrame();
  const {fps} = useVideoConfig();
  const settle = tween(f, 0, 36, 0, 1);
  const task = 'Find noise-cancelling headphones under $200 with the best reviews';
  const input = f < 60 ? typed(task, f, 10, 46) : '';
  const query = f >= 118 ? typed('noise cancelling headphones', f, 118, 26) : '';
  const results = f >= 158;
  const url = f < 80 ? 'New Tab' : results ? 'parcel.shop/search?q=noise+cancelling+headphones' : 'parcel.shop';
  const progress = f < 66 ? '' : f < 115 ? 'Opening parcel.shop…' : f < 165 ? 'Searching for noise cancelling headphones…' : f < 215 ? 'Reading 24 results…' : f < 255 ? 'Comparing the top 3…' : '';
  const md = '### Best under $200\n| Pick | Price | Reviews |\n| --- | --- | --- |\n| **Aurora 2** | $179 | ★ 4.8 (1,204) |\n| Nova Max | $199 | ★ 4.6 (845) |\n| Pulse ANC | $149 | ★ 4.3 (612) |\n\n**Aurora 2** has the best reviews of the three.';
  const answerHtml = f >= 255 ? renderAnswer(streamed(md, f, 255, 305), 0) : undefined;
  const confirm = pop(f, fps, 318, 200, 18);
  const msgs: Msg[] = [];
  if (f >= 60) msgs.push({role: 'user', text: task});
  if (f >= 66) msgs.push({role: 'assistant', progress: progress || undefined, html: answerHtml, children: f >= 318 ? (
    <div style={{marginTop: 14, borderRadius: 14, border: '1px solid #3a3a42', background: '#18181c', padding: '14px 16px', transform: `scale(${0.92 + confirm * 0.08})`, opacity: confirm, transformOrigin: 'top left'}}>
      <div style={{fontSize: 17, lineHeight: 1.45}}>Add <b>Aurora 2</b> ($179) to your cart?</div>
      <div style={{display: 'flex', gap: 10, marginTop: 12}}>
        <div style={{background: '#fafafa', color: '#111', fontWeight: 700, borderRadius: 10, padding: '8px 14px', fontSize: 15}}>Add to cart</div>
        <div style={{border: '1px solid #3a3a42', borderRadius: 10, padding: '8px 14px', fontSize: 15, color: '#d4d4d8'}}>Not now</div>
      </div>
    </div>
  ) : undefined});
  const scroll = tween(f, 290, 330, 0, 120, inOut);
  // The agent's cursor: from the panel to the search box, then over the picks.
  const pick = (k: number) => {const {x, y} = cardPos(PICKS[k]); return {x: x + 150, y: y + 200};};
  const cur = path(f, [
    {f: 90, x: 1040, y: 420}, {f: 112, x: 420, y: 36}, {f: 158, x: 430, y: 40},
    {f: 222, x: pick(0).x, y: pick(0).y}, {f: 234, x: pick(1).x, y: pick(1).y}, {f: 246, x: pick(2).x, y: pick(2).y}, {f: 262, x: pick(2).x + 40, y: pick(2).y + 20},
  ]);
  const cursorOn = f >= 88 && f < 272;
  const glow = (i: number) => {const k = PICKS.indexOf(i); if (k < 0 || f < 222 + k * 12) return 0; return tween(f, 222 + k * 12, 230 + k * 12, 0, 1);};
  const pageFade = tween(f, 78, 90, 0, 1);
  const rot = 7 - settle * 3 + Math.sin(f / 70) * 1.2;
  return (
    <Shell dur={360}>
      <Stage>
        <AnswerStyles />
        <Caption kicker="The agent" text="Or let it do the clicking." at={16} size={60} style={{left: 110, top: 64, width: 1200}} />
        {f >= 318 && (
          <div style={{position: 'absolute', right: 110, top: 96, opacity: confirm, transform: `translateY(${(1 - confirm) * 16}px)`}}>
            <Pill>
              <svg width="18" height="20" viewBox="0 0 12 14"><rect x="1" y="6" width="10" height="7" rx="2" fill="#e4e4e7" /><path d="M3.5 6V4a2.5 2.5 0 015 0v2" stroke="#e4e4e7" strokeWidth="1.6" fill="none" /></svg>
              It asks before anything that costs money.
            </Pill>
          </div>
        )}
        <AbsoluteFill style={{perspective: 2400}}>
          <div style={{position: 'absolute', left: 200, top: 190, transform: `translateZ(${(1 - settle) * -800}px) rotateY(${rot}deg) rotateX(${5 - settle * 2}deg)`, transformOrigin: '0% 50%'}}>
            <Browser url={url} title={f < 80 ? 'New Tab' : 'Parcel · Headphones'} width={1580} height={820} favicon={f < 80 ? '+' : 'p'} sideWidth={520} side={<SidePanel messages={msgs} input={input} inputCaret={f >= 10 && f < 60} scroll={scroll} />}>
              <NewTab />
              <div style={{position: 'absolute', inset: 0, opacity: pageFade}}>
                <ShopPage f={f} query={query} results={results} />
                {PRODUCTS.map((p, i) => {
                  const g = glow(i);
                  if (!g) return null;
                  const {x, y} = cardPos(i);
                  return <div key={p.name} style={{position: 'absolute', left: x - 6, top: y - 6, width: 244, height: 282, borderRadius: 20, border: `3px solid rgba(24,24,27,${g})`, boxShadow: `0 0 0 ${g * 6}px rgba(24,24,27,0.08)`}} />;
                })}
                <VisionOverlay f={f} />
              </div>
              {cursorOn && <Cursor ai x={cur.x} y={cur.y} clicks={[115]} opacity={tween(f, 88, 96, 0, 1) * (f > 262 ? tween(f, 262, 272, 1, 0) : 1)} />}
            </Browser>
          </div>
        </AbsoluteFill>
      </Stage>
    </Shell>
  );
};

// ---------------------------------------------------------------- 5. Features
const ICONS: Record<string, React.ReactNode> = {
  free: <path d="M12 3v18M17 7.5c-1-1.3-2.8-2-5-2-2.8 0-4.5 1.3-4.5 3.2 0 4.3 9.5 2.3 9.5 6.8 0 2-1.9 3.4-5 3.4-2.3 0-4.2-.8-5.2-2.2" />,
  read: <><path d="M4 5h9M4 10h16M4 15h12M4 20h7" /><circle cx="18" cy="18" r="3" /><path d="M20.5 20.5L23 23" /></>,
  click: <><path d="M9 4l10 8-4.5.8 2.6 5-2 1-2.6-5L9 17z" /></>,
  shield: <><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="M8.5 12l2.5 2.5 4.5-5" /></>,
  learn: <><path d="M12 5c-3-2-7-2-9 0v14c2-2 6-2 9 0 3-2 7-2 9 0V5c-2-2-6-2-9 0z" /><path d="M12 5v14" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M16 7l3 3M18 5l2 2" /></>,
};
const FEATURES = [
  {icon: 'free', title: 'Free to start', line: 'Runs on free models through OpenRouter. No card needed.'},
  {icon: 'read', title: 'Reads like you do', line: 'Picks the parts of a page that matter, not the whole thing.'},
  {icon: 'click', title: 'Does the clicking', line: 'Searches, fills forms and compares across tabs.'},
  {icon: 'shield', title: 'Asks before paying', line: 'Purchases, payments and deletions wait for your OK.'},
  {icon: 'learn', title: 'Learns your ways', line: 'Remembers what you tell it and the sites you use.'},
  {icon: 'key', title: 'Your keys stay yours', line: 'Keys and memory live in your browser, not on our server.'},
];

export const Features: React.FC = () => {
  const f = useCurrentFrame();
  const {fps} = useVideoConfig();
  // Card i reaches the centre at frame 25 + 25i, exactly when it lights up.
  const orbit = 17 * (2.5 - (f - 25) / 25);
  const R = 1500;
  return (
    <Shell dur={180}>
      <Stage glow={1.2}>
        <Caption kicker="Built for real browsing" text="Everything it needs. Nothing it doesn't." at={6} size={62} align="center" style={{left: 0, right: 0, top: 90}} />
        <AbsoluteFill style={{perspective: 1700}}>
          <div style={{position: 'absolute', left: '50%', top: 560, transformStyle: 'preserve-3d', transform: `translateZ(${-R + 200}px) rotateY(${orbit}deg)`}}>
            {FEATURES.map((c, i) => {
              const angle = (i - 2.5) * 17;
              const lit = pop(f, fps, 25 + i * 25, 170, 16);
              const on = f >= 25 + i * 25;
              return (
                <div key={c.title} style={{position: 'absolute', left: -190, top: -150, width: 380, height: 300, transformStyle: 'preserve-3d', transform: `rotateY(${angle}deg) translateZ(${R}px) translateY(${Math.sin(f / 25 + i) * 8}px) scale(${1 + lit * 0.06})`}}>
                  <div style={{width: '100%', height: '100%', borderRadius: 28, padding: 34, boxSizing: 'border-box', background: `linear-gradient(160deg, rgba(255,255,255,${on ? 0.13 : 0.06}), rgba(255,255,255,0.02))`, border: `1px solid rgba(255,255,255,${on ? 0.28 : 0.1})`, boxShadow: on ? `0 40px 90px rgba(0,0,0,0.5), 0 0 ${60 * lit}px rgba(255,255,255,${0.12 * lit})` : '0 40px 90px rgba(0,0,0,0.5)', color: '#fafafa'}}>
                    <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke={on ? '#fafafa' : '#71717a'} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{ICONS[c.icon]}</svg>
                    <div style={{fontSize: 32, fontWeight: 700, marginTop: 26, letterSpacing: -0.8, opacity: on ? 1 : 0.55}}>{c.title}</div>
                    <div style={{fontSize: 20, lineHeight: 1.45, marginTop: 12, color: on ? '#d4d4d8' : '#71717a'}}>{c.line}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </AbsoluteFill>
      </Stage>
    </Shell>
  );
};

// ---------------------------------------------------------------- 6. End card
export const EndCard: React.FC = () => {
  const f = useCurrentFrame();
  const {fps} = useVideoConfig();
  const logo = pop(f, fps, 8, 110, 13);
  const name = pop(f, fps, 34, 150, 18);
  const tag = pop(f, fps, 50, 150, 18);
  const cta = pop(f, fps, 68, 170, 16);
  const works = tween(f, 86, 100, 0, 1);
  const fade = tween(f, 166, 180, 0, 1, inOut);
  return (
    <Shell dur={180} noExit>
      <Stage glow={1.3}>
        <AbsoluteFill style={{display: 'grid', placeItems: 'center', perspective: 1600, opacity: 1 - fade}}>
          <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
            <div style={{transform: `translateZ(${(1 - logo) * -1400}px) rotateY(${(1 - logo) * 200}deg)`, opacity: Math.min(1, logo * 2), transformStyle: 'preserve-3d'}}>
              <Logo3D size={220} rx={Math.sin(f / 28) * 5} ry={Math.sin(f / 20) * 8} sheen={tween(f, 36, 70, 0, 1, inOut)} />
            </div>
            <div style={{fontSize: 118, fontWeight: 800, letterSpacing: -5, color: '#fafafa', marginTop: 40, opacity: name, transform: `translateY(${(1 - name) * 40}px)`, filter: `blur(${(1 - name) * 12}px)`}}>Select to AI</div>
            <div style={{fontSize: 40, fontWeight: 500, color: '#a1a1aa', marginTop: 6, letterSpacing: -0.8, opacity: tag, transform: `translateY(${(1 - tag) * 24}px)`}}>Highlight. Ask. Delegate.</div>
            <div style={{marginTop: 46, opacity: cta, transform: `scale(${0.85 + cta * 0.15})`}}>
              <div style={{display: 'inline-flex', alignItems: 'center', gap: 14, padding: '20px 34px', borderRadius: 999, background: '#fafafa', color: '#0a0a0b', fontSize: 28, fontWeight: 700, boxShadow: '0 20px 60px rgba(255,255,255,0.18)'}}>
                Free on the Chrome Web Store
              </div>
            </div>
            <div style={{marginTop: 30, fontSize: 22, color: '#71717a', opacity: works}}>Works with ChatGPT · Claude · Gemini · Perplexity · your own API key</div>
          </div>
        </AbsoluteFill>
      </Stage>
    </Shell>
  );
};
