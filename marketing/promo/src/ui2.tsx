import React from 'react';
import {Img, staticFile} from 'remotion';
// The extension's own answer renderer, so answers look exactly like the product.
// @ts-ignore
import ANSWER from '../../../extension/answerFormat.js';
import {ClaudeMark, INTER, MONO, useF} from './kit';
import {revealHtml} from './util';

const render = (md: string, shift = 0): string => ANSWER.renderAnswerHtml(md, [], {headingShift: shift});

/** Answer HTML revealed smoothly: `t` runs 0..1 over the whole answer. */
export function smoothAnswer(md: string, t: number, shift = 0) {
  const full = render(md, shift);
  const total = revealHtml(full, 0).words;
  return revealHtml(full, t * (total + 6)).html;
}

export const AnswerStyles: React.FC = () => (
  <style>{`
    .ans { font-family: ${INTER}; }
    .ans p { margin: 0 0 12px; }
    .ans h3, .ans h4, .ans h5 { margin: 2px 0 10px; font-weight: 700; letter-spacing: -0.01em; }
    .ans h3 { font-size: 1.2em; } .ans h4 { font-size: 1.07em; }
    .ans ul, .ans ol { margin: 0 0 12px; padding-left: 1.3em; }
    .ans li { margin: 6px 0; }
    .ans li.pm::marker { color: transparent; }
    .ans strong { font-weight: 700; }
    .ans code { font-family: ${MONO}; font-size: 0.9em; padding: 1px 6px; border-radius: 6px; background: rgba(127,127,127,0.14); }
    .ans .table-wrap { border-radius: 12px; overflow: hidden; margin: 8px 0 12px; }
    .ans table { border-collapse: collapse; width: 100%; font-size: 0.93em; color: inherit; }
    .ans th, .ans td { text-align: left; padding: 10px 14px; }
    .ans.light .table-wrap { border: 1px solid #e4e4e7; } .ans.light th { background: #f4f4f5; } .ans.light td { border-top: 1px solid #ececef; }
    .ans.dark .table-wrap { border: 1px solid #2e2e34; } .ans.dark th { background: #1c1c21; } .ans.dark td { border-top: 1px solid #25252b; }
    .ans.dark { color: #ececf0; } .ans.light { color: #18181b; }
    .ans.claude { font-family: Georgia, "Tiempos Text", serif; color: #2b2a27; }
    .ans.claude strong { font-weight: 700; }
  `}</style>
);

export const Caret: React.FC<{color?: string; h?: number}> = ({color = '#18181b', h = 26}) => {
  const f = useF();
  return <span style={{display: 'inline-block', width: 2.5, height: h, background: color, marginLeft: 2, verticalAlign: 'text-bottom', opacity: Math.floor(f / 16) % 2 ? 0.1 : 1}} />;
};

/** The ⌘K quick box (light), as in commandPalette.js. */
export const QuickBox: React.FC<{text: string; label: string; dot: string; answerHtml?: string; caret?: boolean; width?: number}> = ({text, label, dot, answerHtml, caret = true, width = 820}) => (
  <div style={{width, borderRadius: 22, background: 'rgba(255,255,255,0.98)', overflow: 'hidden', boxShadow: '0 70px 160px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,0,0,0.06)', fontFamily: INTER}}>
    <div style={{display: 'flex', alignItems: 'center', gap: 18, padding: '24px 28px', borderBottom: '1px solid #ededf0'}}>
      <Img src={staticFile('icon128.png')} style={{width: 42, height: 42, borderRadius: 11}} />
      <div style={{fontSize: 26, color: text ? '#18181b' : '#9aa1ae', letterSpacing: -0.3}}>
        {text || 'Ask a question, or tell the agent what to do'}
        {caret && <Caret h={28} />}
      </div>
    </div>
    {answerHtml !== undefined && <div className="ans light" style={{padding: '22px 28px 6px', fontSize: 20, lineHeight: 1.55}} dangerouslySetInnerHTML={{__html: answerHtml}} />}
    <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 28px', background: '#f8f8fa', borderTop: '1px solid #ededf0', fontSize: 16, color: '#52525b'}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 10, fontWeight: 600}}><span style={{width: 9, height: 9, borderRadius: 5, background: dot}} />{label}</div>
      <div style={{display: 'flex', gap: 16, alignItems: 'center'}}><span><Kbd>Enter</Kbd> run</span><span><Kbd>Esc</Kbd> close</span></div>
    </div>
  </div>
);

const Kbd: React.FC<{children: React.ReactNode}> = ({children}) => (
  <span style={{display: 'inline-block', border: '1px solid rgba(16,18,24,0.16)', borderBottomWidth: 2, borderRadius: 6, padding: '1px 7px', background: '#fff', color: '#4b5563', fontSize: 13, marginRight: 6}}>{children}</span>
);

export type Msg = {role: 'user'; text: string; appear?: number} | {role: 'assistant'; html?: string; progress?: string; children?: React.ReactNode; appear?: number};

/** The agent side panel (dark), as in agent.html. The input wraps and grows. */
export const SidePanel: React.FC<{messages: Msg[]; input?: string; inputCaret?: boolean; scroll?: number}> = ({messages, input = '', inputCaret = false, scroll = 0}) => (
  <div style={{position: 'absolute', inset: 0, background: '#111113', color: '#ececf0', fontFamily: INTER, display: 'flex', flexDirection: 'column'}}>
    <div style={{height: 60, display: 'flex', alignItems: 'center', padding: '0 20px', borderBottom: '1px solid #232328', flexShrink: 0, gap: 12}}>
      <svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16" stroke="#d4d4d8" strokeWidth="2" strokeLinecap="round" /></svg>
    </div>
    <div style={{flex: 1, overflow: 'hidden', position: 'relative'}}>
      <div style={{position: 'absolute', left: 0, right: 0, top: 0, padding: '22px 20px', transform: `translateY(${-scroll}px)`, display: 'flex', flexDirection: 'column', gap: 20}}>
        {messages.map((m, i) => {
          const a = m.appear ?? 1;
          const st: React.CSSProperties = {opacity: a, transform: `translateY(${(1 - a) * 18}px) scale(${0.97 + 0.03 * a})`, filter: `blur(${(1 - a) * 6}px)`};
          return m.role === 'user' ? (
            <div key={i} style={{alignSelf: 'flex-end', maxWidth: '86%', background: '#1c1c20', border: '1px solid #2e2e34', borderRadius: 20, padding: '13px 17px', fontSize: 18, lineHeight: 1.45, transformOrigin: 'right bottom', ...st}}>{m.text}</div>
          ) : (
            <div key={i} style={{display: 'flex', gap: 13, alignItems: 'flex-start', ...st}}>
              <Img src={staticFile('icon128.png')} style={{width: 32, height: 32, borderRadius: 9, flexShrink: 0}} />
              <div style={{flex: 1, minWidth: 0}}>
                {m.progress && <Progress text={m.progress} />}
                {m.html !== undefined && <div className="ans dark" style={{fontSize: 17.5, lineHeight: 1.55}} dangerouslySetInnerHTML={{__html: m.html}} />}
                {m.children}
              </div>
            </div>
          );
        })}
      </div>
    </div>
    <div style={{padding: '12px 16px 18px', flexShrink: 0}}>
      <div style={{border: '1px solid #3a3a42', borderRadius: 22, padding: '14px 16px 14px 18px', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, fontSize: 18, lineHeight: 1.4, color: input ? '#ececf0' : '#71717a', background: '#18181c'}}>
        <span style={{flex: 1, whiteSpace: 'normal', overflowWrap: 'anywhere', paddingBottom: 6}}>
          {input || 'Describe a task…'}
          {inputCaret && <Caret color="#ececf0" h={21} />}
        </span>
        <div style={{width: 38, height: 38, borderRadius: 19, background: input ? '#fafafa' : '#3f3f46', display: 'grid', placeItems: 'center', flexShrink: 0}}>
          <svg width="16" height="16" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7" stroke={input ? '#111' : '#a1a1aa'} strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </div>
      </div>
    </div>
  </div>
);

export const Progress: React.FC<{text: string}> = ({text}) => {
  const f = useF();
  const x = ((f * 2.4) % 300) - 100;
  return <div style={{fontSize: 17.5, fontWeight: 500, backgroundImage: `linear-gradient(90deg, #71717a ${x - 30}%, #fafafa ${x}%, #71717a ${x + 30}%)`, WebkitBackgroundClip: 'text', color: 'transparent', padding: '5px 0'}}>{text}</div>;
};

/** Claude in the side panel: its mark and name, cream surface, serif answers. */
export const ClaudePanel: React.FC<{prompt?: string; promptIn?: number; answerHtml?: string}> = ({prompt, promptIn = 1, answerHtml}) => (
  <div style={{position: 'absolute', inset: 0, background: '#faf9f5', fontFamily: INTER, display: 'flex', flexDirection: 'column'}}>
    <div style={{height: 60, display: 'flex', alignItems: 'center', gap: 10, padding: '0 22px', borderBottom: '1px solid #ebe8df', flexShrink: 0}}>
      <ClaudeMark size={26} />
      <span style={{fontSize: 21, fontWeight: 600, color: '#2b2a27', letterSpacing: -0.3}}>Claude</span>
    </div>
    <div style={{padding: 22, display: 'flex', flexDirection: 'column', gap: 18}}>
      {prompt && <div style={{alignSelf: 'flex-end', background: '#f0eee6', borderRadius: 18, padding: '14px 18px', fontSize: 17.5, lineHeight: 1.45, color: '#2b2a27', maxWidth: '92%', opacity: promptIn, transform: `translateY(${(1 - promptIn) * 16}px)`, filter: `blur(${(1 - promptIn) * 6}px)`}}>{prompt}</div>}
      {answerHtml && (
        <div style={{display: 'flex', gap: 12}}>
          <div style={{flexShrink: 0, marginTop: 2}}><ClaudeMark size={22} /></div>
          <div className="ans claude" style={{fontSize: 19, lineHeight: 1.6}} dangerouslySetInnerHTML={{__html: answerHtml}} />
        </div>
      )}
    </div>
  </div>
);

/** Chrome's right-click menu with the extension's submenu (real labels). */
export const ContextMenu: React.FC<{hover: number; sub: boolean; subHover: number; appear: number; subAppear: number}> = ({hover, sub, subHover, appear, subAppear}) => {
  const items = ['Copy', 'Search for “A black hole is…”', 'Print…', 'Select to AI'];
  const subItems = ['Send to ChatGPT', 'Send to Gemini', 'Send to Perplexity', 'Send to Claude', 'Ask the agent about this'];
  const box: React.CSSProperties = {background: 'rgba(250,250,251,0.97)', borderRadius: 12, padding: 6, boxShadow: '0 24px 60px rgba(0,0,0,0.28), 0 0 0 1px rgba(0,0,0,0.08)', fontSize: 16, color: '#18181b', fontFamily: INTER};
  const row = (active: boolean): React.CSSProperties => ({padding: '9px 15px', borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 26, background: active ? '#2563eb' : 'transparent', color: active ? '#fff' : '#18181b', whiteSpace: 'nowrap'});
  return (
    <div style={{display: 'flex', alignItems: 'flex-end', gap: 4, transformOrigin: 'bottom left', transform: `scale(${0.9 + 0.1 * appear})`, opacity: appear}}>
      <div style={{...box, width: 300}}>
        {items.map((t, i) => (
          <React.Fragment key={t}>
            {i === 3 && <div style={{height: 1, background: '#e4e4e7', margin: '5px 8px'}} />}
            <div style={row(hover === i)}>
              <span style={{display: 'flex', alignItems: 'center', gap: 10}}>{i === 3 && <Img src={staticFile('icon128.png')} style={{width: 20, height: 20, borderRadius: 5}} />}{t}</span>
              {i === 3 && <span>›</span>}
            </div>
          </React.Fragment>
        ))}
      </div>
      {sub && (
        <div style={{...box, width: 270, marginBottom: -140, opacity: subAppear, transform: `translateX(${(1 - subAppear) * -10}px)`}}>
          {subItems.map((t, i) => (
            <React.Fragment key={t}>
              {i === 4 && <div style={{height: 1, background: '#e4e4e7', margin: '5px 8px'}} />}
              <div style={row(subHover === i)}>{t}</div>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
};
