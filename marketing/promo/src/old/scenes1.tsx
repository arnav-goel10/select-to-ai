import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {Browser, Caption, Cursor, Keycap, Logo3D, Stage, INTER} from './components';
import {AnswerStyles, ContextMenu, QuickBox, renderAnswer, Caret} from './ui';
import {expoOut, inOut, path, pop, streamed, tween, typed} from './util';

/**
 * Push-through cut shared by every scene: the outgoing shot rushes past the
 * camera into a blur, the next one resolves out of it. It never passes
 * through black, so there is no blink at the cut.
 */
export const Shell: React.FC<{dur: number; children: React.ReactNode; noEnter?: boolean; noExit?: boolean}> = ({dur, children, noEnter, noExit}) => {
  const f = useCurrentFrame();
  const enter = noEnter ? 1 : tween(f, 0, 14, 0, 1);
  const exit = noExit ? 0 : tween(f, dur - 10, dur, 0, 1, (t) => t * t);
  return (
    <AbsoluteFill style={{opacity: (0.55 + 0.45 * enter) * (1 - exit * 0.45), transform: `scale(${0.9 + 0.1 * enter + 0.22 * exit})`, filter: `blur(${(1 - enter) * 22 + exit * 26}px) brightness(${1 + exit * 0.25})`}}>
      {children}
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- 1. Hook
export const Hook: React.FC = () => {
  const f = useCurrentFrame();
  const {fps} = useVideoConfig();
  const back = tween(f, 48, 66, 0, 1, inOut);
  const logoIn = pop(f, fps, 50, 120, 14);
  const title = pop(f, fps, 74, 140, 18);
  return (
    <Shell dur={120} noEnter>
      <Stage glow={0.6 + logoIn * 0.6}>
        <AbsoluteFill style={{display: 'grid', placeItems: 'center', perspective: 1800}}>
          <div style={{textAlign: 'center', transform: `translateZ(${-back * 900}px)`, opacity: 1 - back, filter: `blur(${back * 10}px)`}}>
            <Caption text="Every tab" at={6} size={150} align="center" style={{position: 'relative'}} />
            <Caption text="is a question." at={22} size={150} align="center" style={{position: 'relative', color: '#a1a1aa'}} />
          </div>
        </AbsoluteFill>
        <AbsoluteFill style={{display: 'grid', placeItems: 'center', perspective: 1600}}>
          <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 44, marginTop: 20}}>
            <div style={{transform: `translateZ(${(1 - logoIn) * -1600}px) rotateY(${(1 - logoIn) * -140}deg)`, opacity: Math.min(1, logoIn * 2), transformStyle: 'preserve-3d'}}>
              <Logo3D size={300} rx={Math.sin(f / 30) * 6} ry={Math.sin(f / 22) * 10} sheen={tween(f, 70, 100, 0, 1, inOut)} />
            </div>
            <div style={{fontSize: 96, fontWeight: 800, letterSpacing: -4, color: '#fafafa', opacity: title, transform: `translateY(${(1 - title) * 40}px)`, filter: `blur(${(1 - title) * 10}px)`}}>
              Select to AI
            </div>
          </div>
        </AbsoluteFill>
      </Stage>
    </Shell>
  );
};

// ---------------------------------------------------------------- 2. Right-click
const LINES = [
  'Overnight trains between Paris, Berlin and Vienna now run',
  'every night of the week, and most sell out days ahead. Rail',
  'operators say demand has doubled since 2023, driven by',
  'travellers who would rather sleep than queue at airports.',
];
const CH = 11.2; // average character width of the article face at 24px
const LX = 110, LY = 336, LH = 42;

const ArticlePage: React.FC<{sel: number}> = ({sel}) => (
  <div style={{position: 'absolute', inset: 0, background: '#fff', fontFamily: 'Georgia, "Times New Roman", serif', color: '#1f2328'}}>
    <div style={{height: 56, borderBottom: '1px solid #eee', display: 'flex', alignItems: 'center', padding: '0 110px', gap: 28, fontFamily: INTER, fontSize: 15, color: '#6b7280'}}>
      <b style={{color: '#111', fontSize: 20, letterSpacing: -0.5}}>The Platform</b><span>Travel</span><span>Cities</span><span>Climate</span>
    </div>
    <div style={{position: 'absolute', left: LX, top: 92, width: 820}}>
      <div style={{fontFamily: INTER, fontSize: 15, color: '#b45309', fontWeight: 700, letterSpacing: 1, marginBottom: 12}}>TRAVEL</div>
      <div style={{fontSize: 52, fontWeight: 700, letterSpacing: -1, lineHeight: 1.1}}>The night trains are back</div>
      <div style={{fontFamily: INTER, fontSize: 15, color: '#6b7280', marginTop: 14}}>By Mara Lind · 6 min read</div>
    </div>
    {LINES.map((line, i) => {
      const p = Math.max(0, Math.min(1, sel * LINES.length - i));
      return (
        <div key={i} style={{position: 'absolute', left: LX, top: LY + i * LH, fontSize: 24, lineHeight: `${LH}px`, whiteSpace: 'nowrap'}}>
          <span style={{background: `linear-gradient(90deg, #b4d5fe ${p * 100}%, transparent ${p * 100}%)`, padding: '4px 0'}}>{line}</span>
        </div>
      );
    })}
    <div style={{position: 'absolute', left: LX, top: LY + 4 * LH + 26, width: 760, fontSize: 24, lineHeight: `${LH}px`, color: '#374151'}}>
      Sleeper cars have been rebuilt with private cabins, showers and breakfast served at the border. Tickets start at €49 for a seat and €129 for a cabin.
    </div>
  </div>
);

export const RightClick: React.FC = () => {
  const f = useCurrentFrame();
  const {fps} = useVideoConfig();
  const settle = tween(f, 0, 34, 0, 1);
  const sel = tween(f, 45, 85, 0, 1, (t) => t);
  // End of the selection: follows the lines as they fill.
  const li = Math.max(0, Math.min(LINES.length - 1, Math.floor(sel * LINES.length - 1e-6)));
  const lf = Math.max(0, Math.min(1, sel * LINES.length - li));
  const selEnd = {x: LX + LINES[li].length * CH * lf, y: LY + li * LH + 28};
  const endPt = {x: LX + LINES[3].length * CH, y: LY + 3 * LH + 28};
  let cur;
  if (f < 45) cur = path(f, [{f: 0, x: 980, y: 700}, {f: 40, x: LX, y: LY + 26}]);
  else if (f < 88) cur = selEnd;
  // The menu opens upward (no room below), as Chrome does near the bottom.
  else cur = path(f, [{f: 88, x: endPt.x, y: endPt.y}, {f: 100, x: endPt.x + 150, y: endPt.y - 30}, {f: 110, x: endPt.x + 175, y: endPt.y - 28}, {f: 124, x: endPt.x + 440, y: endPt.y + 88}]);
  const menu = f >= 96 && f < 136 ? pop(f, fps, 96, 260, 20) : f >= 136 ? tween(f, 136, 142, 1, 0) : 0;
  const hover = f >= 100 ? 3 : -1;
  const sub = f >= 110;
  const subHover = f >= 124 ? 3 : f >= 116 ? 0 : -1;
  const side = tween(f, 136, 160, 0, 540);
  // The selected text lifts off the page and flies into the chat panel.
  const fly = tween(f, 134, 166, 0, 1, inOut);
  const flyOn = f >= 134 && f < 172;
  const prompt = 'Explain this: “Overnight trains between Paris, Berlin and Vienna now run every night of the week…”';
  const answer = streamed('Night trains are coming back because three things changed:\n\n1. **Demand**: more people choose to sleep on the way instead of flying.\n2. **Better cabins**: private rooms, showers and breakfast.\n3. **Price**: a cabin costs about the same as a flight plus a hotel.', f, 174, 228);
  const rot = 12 - settle * 4 + Math.sin(f / 60) * 1.2;
  return (
    <Shell dur={240}>
      <Stage>
        <AnswerStyles />
        <Caption kicker="Right-click" text="Highlight. Right-click. Asked." at={22} size={68} style={{left: 110, top: 150, width: 520}} />
        <AbsoluteFill style={{perspective: 2200}}>
          <div style={{position: 'absolute', left: 600, top: 150, transformStyle: 'preserve-3d', transform: `translateZ(${(1 - settle) * -700}px) rotateY(${rot + (1 - settle) * 22}deg) rotateX(${4 + (1 - settle) * 10}deg)`, transformOrigin: '0% 50%'}}>
            <Browser url="theplatform.news/travel/night-trains" title="The night trains are back" width={1320} height={800} favicon="P" sideWidth={side} side={side > 1 ? <ChatSide prompt={f >= 166 ? prompt : ''} answer={f >= 174 ? answer : ''} /> : undefined}>
              <ArticlePage sel={sel} />
              {menu > 0 && (
                <div style={{position: 'absolute', left: endPt.x + 4, top: endPt.y - 190}}>
                  <ContextMenu hover={hover} sub={sub} subHover={subHover} appear={menu} />
                </div>
              )}
              {flyOn && (
                <div style={{position: 'absolute', left: LX + fly * 640, top: LY + fly * -250, width: 700, padding: '16px 20px', borderRadius: 14, background: '#dbeafe', color: '#1e3a8a', fontFamily: 'Georgia, serif', fontSize: 21, lineHeight: 1.5, boxShadow: `0 ${30 * Math.sin(fly * Math.PI)}px 60px rgba(30,58,138,${0.35 * Math.sin(fly * Math.PI)})`, transform: `scale(${1 - fly * 0.35}) rotate(${Math.sin(fly * Math.PI) * -4}deg)`, transformOrigin: 'left top', opacity: f > 164 ? tween(f, 164, 172, 1, 0) : 1}}>
                  {LINES.join(' ').slice(0, 118)}…
                </div>
              )}
              <Cursor x={cur.x} y={cur.y} clicks={[95, 132]} opacity={f < 140 ? 1 : tween(f, 140, 150, 1, 0)} />
            </Browser>
          </div>
        </AbsoluteFill>
      </Stage>
    </Shell>
  );
};

const ChatSide: React.FC<{prompt: string; answer: string}> = ({prompt, answer}) => (
  <div style={{position: 'absolute', inset: 0, width: 540, background: '#faf9f7', fontFamily: INTER, display: 'flex', flexDirection: 'column'}}>
    <div style={{height: 60, display: 'flex', alignItems: 'center', gap: 12, padding: '0 22px', borderBottom: '1px solid #ecebe8', fontSize: 18, fontWeight: 600, color: '#27272a'}}>
      <div style={{width: 30, height: 30, borderRadius: 15, background: '#27272a', color: '#fff', display: 'grid', placeItems: 'center', fontSize: 14}}>C</div>
      Claude
      <span style={{marginLeft: 'auto', fontSize: 14, color: '#8a8a93', fontWeight: 500}}>side panel</span>
    </div>
    <div style={{padding: 22, display: 'flex', flexDirection: 'column', gap: 18}}>
      {prompt && <div style={{alignSelf: 'flex-end', background: '#ecebe6', borderRadius: 18, padding: '14px 18px', fontSize: 18, lineHeight: 1.45, color: '#27272a', maxWidth: '90%'}}>{prompt}</div>}
      {answer && <div className="ans light" style={{fontSize: 18, lineHeight: 1.55}} dangerouslySetInnerHTML={{__html: renderAnswer(answer)}} />}
    </div>
  </div>
);

// ---------------------------------------------------------------- 3. Quick box
const DocsPage: React.FC = () => (
  <div style={{position: 'absolute', inset: 0, background: '#fff', fontFamily: INTER, color: '#18181b'}}>
    <div style={{height: 60, borderBottom: '1px solid #eee', display: 'flex', alignItems: 'center', padding: '0 60px', gap: 26, fontSize: 16, color: '#6b7280'}}>
      <b style={{color: '#111', fontSize: 20}}>Loop Studio</b><span>Help Center</span><span>Billing</span><span>Account</span>
    </div>
    <div style={{display: 'flex'}}>
      <div style={{width: 260, padding: '40px 0 0 60px', fontSize: 16, color: '#6b7280', lineHeight: 2.3}}>
        <div style={{color: '#111', fontWeight: 600}}>Refunds</div><div>Plans</div><div>Invoices</div><div>Taxes</div><div>Cancel</div>
      </div>
      <div style={{padding: '40px 60px', maxWidth: 820}}>
        <div style={{fontSize: 44, fontWeight: 700, letterSpacing: -1}}>Refunds and cancellations</div>
        <p style={{fontSize: 19, lineHeight: 1.7, color: '#3f3f46'}}>We want you to be happy with Loop Studio. If it is not right for you, you can cancel any time from Settings.</p>
        <div style={{fontSize: 24, fontWeight: 700, marginTop: 30}}>Refund windows</div>
        <p style={{fontSize: 19, lineHeight: 1.7, color: '#3f3f46'}}>Monthly plans can be refunded within 14 days of a charge. Annual plans can be refunded in full within 60 days of purchase…</p>
        <div style={{fontSize: 24, fontWeight: 700, marginTop: 30}}>How to request one</div>
        <p style={{fontSize: 19, lineHeight: 1.7, color: '#3f3f46'}}>Go to Settings, then Billing, then Request a refund. Refunds reach your card in 5 to 10 days.</p>
      </div>
    </div>
  </div>
);

export const QuickBoxScene: React.FC = () => {
  const f = useCurrentFrame();
  const {fps} = useVideoConfig();
  const settle = tween(f, 0, 30, 0, 1);
  const keysIn = pop(f, fps, 10, 150, 15);
  const keysOut = tween(f, 46, 60, 0, 1, inOut);
  const box = pop(f, fps, 44, 220, 18);
  const dim = tween(f, 44, 56, 0, 1);
  const q = 'Can I get a refund after 30 days?';
  const text = typed(q, f, 62, 22);
  const sent = f >= 115;
  const md = '### Yes, on an annual plan\nAnnual plans are refunded **in full within 60 days**. Monthly plans only within **14 days**.\n\n| Plan | Refund window |\n| --- | --- |\n| Monthly | 14 days |\n| Annual | 60 days |\n\nRequest it from **Settings → Billing → Request a refund**.';
  const answer = f >= 122 ? renderAnswer(streamed(md, f, 122, 212), 0) : undefined;
  return (
    <Shell dur={240}>
      <Stage>
        <AnswerStyles />
        <Caption kicker="⌘K on any page" text="Ask the page you're on." at={20} size={68} style={{left: 110, top: 150, width: 520}} />
        <AbsoluteFill style={{perspective: 2200}}>
          <div style={{position: 'absolute', left: 620, top: 140, transform: `translateZ(${(1 - settle) * -500}px) rotateY(${10 - settle * 3}deg) rotateX(3deg)`, transformOrigin: '0% 50%'}}>
            <Browser url="help.loopstudio.app/billing/refunds" title="Refunds and cancellations" width={1200} height={820} favicon="L">
              <DocsPage />
              <div style={{position: 'absolute', inset: 0, background: `rgba(15,15,18,${dim * 0.42})`, backdropFilter: `blur(${dim * 6}px)`}} />
            </Browser>
          </div>
          <div style={{position: 'absolute', left: 770, top: 250, transform: `translateZ(${(1 - box) * -300 + 140}px) rotateY(6deg) translateY(${(1 - box) * 60}px)`, opacity: Math.min(1, box * 1.6)}}>
            <QuickBox width={900} text={text} caret={!sent} label={text ? 'Answer from this page' : 'Type to begin'} dot={text ? '#18181b' : '#9aa1ae'} answerHtml={answer} />
          </div>
          {f < 62 && (
            <div style={{position: 'absolute', left: 820, top: 440, display: 'flex', gap: 34, transform: `translateZ(${(1 - keysIn) * -600 + keysOut * 900}px) rotateX(${28 - keysIn * 10}deg) rotateY(-12deg)`, opacity: Math.min(1, keysIn * 1.5) * (1 - keysOut)}}>
              <Keycap label="⌘" pressAt={34} size={190} />
              <Keycap label="K" pressAt={40} size={190} />
            </div>
          )}
        </AbsoluteFill>
      </Stage>
    </Shell>
  );
};

export {Caret, expoOut};
