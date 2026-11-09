import React from 'react';
import {Img, staticFile, useCurrentFrame} from 'remotion';
// The extension's own answer renderer, so answers look exactly like the product.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import ANSWER from '../../../extension/answerFormat.js';
import {INTER, MONO} from './components';

export const renderAnswer = (md: string, shift = 1): string => ANSWER.renderAnswerHtml(md, [], {headingShift: shift});

/** Answer typography for both themes (mirrors agent.html / commandPalette.js). */
export const AnswerStyles: React.FC = () => (
  <style>{`
    .ans { font-family: ${INTER}; }
    .ans p { margin: 0 0 12px; }
    .ans h3, .ans h4, .ans h5 { margin: 4px 0 10px; font-weight: 700; letter-spacing: -0.01em; }
    .ans h3 { font-size: 1.18em; } .ans h4 { font-size: 1.05em; } .ans h5 { font-size: 1em; }
    .ans ul, .ans ol { margin: 0 0 12px; padding-left: 1.4em; }
    .ans li { margin: 5px 0; }
    .ans strong { font-weight: 700; }
    .ans code { font-family: ${MONO}; font-size: 0.9em; padding: 1px 6px; border-radius: 6px; background: rgba(127,127,127,0.14); }
    .ans .table-wrap { border-radius: 12px; overflow: hidden; margin: 6px 0 12px; }
    .ans table { border-collapse: collapse; width: 100%; font-size: 0.92em; color: inherit; }
    .ans th, .ans td { text-align: left; padding: 9px 14px; }
    .ans.light .table-wrap { border: 1px solid #e4e4e7; } .ans.light th { background: #f4f4f5; } .ans.light td { border-top: 1px solid #ececef; }
    .ans.dark .table-wrap { border: 1px solid #2e2e34; } .ans.dark th { background: #1c1c21; } .ans.dark td { border-top: 1px solid #25252b; }
    .ans.dark { color: #ececf0; } .ans.light { color: #18181b; }
    .ans.dark h3, .ans.dark h4 { color: #fafafa; }
  `}</style>
);

export const Caret: React.FC<{color?: string; h?: number}> = ({color = '#18181b', h = 26}) => {
  const f = useCurrentFrame();
  return <span style={{display: 'inline-block', width: 2.5, height: h, background: color, marginLeft: 2, verticalAlign: 'text-bottom', opacity: Math.floor(f / 8) % 2 ? 0.15 : 1}} />;
};

/** The ⌘K quick box (light), as in commandPalette.js. */
export const QuickBox: React.FC<{text: string; label: string; dot: string; answerHtml?: string; caret?: boolean; width?: number}> = ({text, label, dot, answerHtml, caret = true, width = 900}) => (
  <div style={{width, borderRadius: 22, background: '#fff', overflow: 'hidden', boxShadow: '0 60px 140px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.06)', fontFamily: INTER}}>
    <div style={{display: 'flex', alignItems: 'center', gap: 18, padding: '26px 30px', borderBottom: '1px solid #ededf0'}}>
      <Img src={staticFile('icon128.png')} style={{width: 44, height: 44, borderRadius: 11}} />
      <div style={{fontSize: 28, color: text ? '#18181b' : '#9aa1ae', letterSpacing: -0.3}}>
        {text || 'Ask a question, or tell the agent what to do'}
        {caret && <Caret h={30} />}
      </div>
    </div>
    {answerHtml !== undefined && (
      <div className="ans light" style={{padding: '22px 30px 8px', fontSize: 21, lineHeight: 1.55, minHeight: 60}} dangerouslySetInnerHTML={{__html: answerHtml}} />
    )}
    <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 30px', background: '#f8f8fa', borderTop: '1px solid #ededf0', fontSize: 17, color: '#52525b'}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 10, fontWeight: 600}}>
        <span style={{width: 9, height: 9, borderRadius: 5, background: dot}} />
        {label}
      </div>
      <div style={{display: 'flex', gap: 16, alignItems: 'center'}}>
        <span><Kbd>Enter</Kbd> run</span>
        <span><Kbd>Esc</Kbd> close</span>
      </div>
    </div>
  </div>
);

const Kbd: React.FC<{children: React.ReactNode}> = ({children}) => (
  <span style={{display: 'inline-block', border: '1px solid rgba(16,18,24,0.16)', borderBottomWidth: 2, borderRadius: 6, padding: '1px 7px', background: '#fff', color: '#4b5563', fontSize: 14, marginRight: 6}}>{children}</span>
);

export type Msg =
  | {role: 'user'; text: string}
  | {role: 'assistant'; html?: string; progress?: string; notice?: boolean; children?: React.ReactNode};

/** The agent side panel in dark mode, as in agent.html. */
export const SidePanel: React.FC<{messages: Msg[]; input?: string; inputCaret?: boolean; header?: string; scroll?: number}> = ({messages, input = '', inputCaret = false, header = 'OpenRouter · free models', scroll = 0}) => (
  <div style={{position: 'absolute', inset: 0, background: '#111113', color: '#ececf0', fontFamily: INTER, display: 'flex', flexDirection: 'column'}}>
    <div style={{height: 64, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px', borderBottom: '1px solid #232328', flexShrink: 0}}>
      <svg width="24" height="24" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16" stroke="#d4d4d8" strokeWidth="2" strokeLinecap="round" /></svg>
      <div style={{fontSize: 16, color: '#a1a1aa', border: '1px solid #2e2e34', borderRadius: 10, padding: '6px 12px', fontWeight: 600}}>{header}</div>
    </div>
    <div style={{flex: 1, overflow: 'hidden', position: 'relative'}}>
      <div style={{position: 'absolute', left: 0, right: 0, top: 0, padding: '22px 22px', transform: `translateY(${-scroll}px)`, display: 'flex', flexDirection: 'column', gap: 22}}>
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} style={{alignSelf: 'flex-end', maxWidth: '82%', background: '#1a1a1e', border: '1px solid #2e2e34', borderRadius: 20, padding: '14px 18px', fontSize: 19, lineHeight: 1.45}}>{m.text}</div>
          ) : (
            <div key={i} style={{display: 'flex', gap: 14, alignItems: 'flex-start'}}>
              <Img src={staticFile('icon128.png')} style={{width: 34, height: 34, borderRadius: 9, flexShrink: 0}} />
              <div style={{flex: 1, minWidth: 0, ...(m.notice ? {background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 14, padding: '14px 16px'} : {})}}>
                {m.progress && <Progress text={m.progress} />}
                {m.html !== undefined && <div className="ans dark" style={{fontSize: 18, lineHeight: 1.55}} dangerouslySetInnerHTML={{__html: m.html}} />}
                {m.children}
              </div>
            </div>
          ),
        )}
      </div>
    </div>
    <div style={{padding: '14px 18px 20px', flexShrink: 0}}>
      <div style={{border: '1px solid #3a3a42', borderRadius: 22, padding: '15px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 18, color: input ? '#ececf0' : '#71717a', background: '#18181c'}}>
        <span style={{whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '85%'}}>
          {input || 'Describe a task…'}
          {inputCaret && <Caret color="#ececf0" h={22} />}
        </span>
        <div style={{width: 38, height: 38, borderRadius: 19, background: input ? '#fafafa' : '#3f3f46', display: 'grid', placeItems: 'center'}}>
          <svg width="16" height="16" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7" stroke={input ? '#111' : '#a1a1aa'} strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </div>
      </div>
    </div>
  </div>
);

/** "Reading the page…" with a moving shimmer, like .progress-line. */
export const Progress: React.FC<{text: string}> = ({text}) => {
  const f = useCurrentFrame();
  const x = ((f * 4) % 300) - 100;
  return (
    <div style={{fontSize: 18, fontWeight: 500, backgroundImage: `linear-gradient(90deg, #71717a ${x - 30}%, #fafafa ${x}%, #71717a ${x + 30}%)`, WebkitBackgroundClip: 'text', color: 'transparent', padding: '6px 0'}}>{text}</div>
  );
};

/** Chrome's right-click menu with the Select to AI submenu. */
export const ContextMenu: React.FC<{hover: number; sub: boolean; subHover: number; appear: number}> = ({hover, sub, subHover, appear}) => {
  const items = ['Copy', 'Look up “night trains”', 'Print…', 'Select to AI'];
  const subItems = ['Send to ChatGPT', 'Send to Gemini', 'Send to Perplexity', 'Send to Claude', 'Ask the agent about this'];
  const box: React.CSSProperties = {background: 'rgba(250,250,251,0.97)', borderRadius: 12, padding: 6, boxShadow: '0 24px 60px rgba(0,0,0,0.28), 0 0 0 1px rgba(0,0,0,0.08)', fontSize: 17, color: '#18181b', fontFamily: INTER};
  const row = (active: boolean): React.CSSProperties => ({padding: '9px 16px', borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 30, background: active ? '#2563eb' : 'transparent', color: active ? '#fff' : '#18181b', whiteSpace: 'nowrap'});
  return (
    <div style={{display: 'flex', alignItems: 'flex-start', gap: 4, transformOrigin: 'bottom left', transform: `scale(${appear})`, opacity: Math.min(1, appear * 1.5)}}>
      <div style={{...box, width: 300}}>
        {items.map((t, i) => (
          <React.Fragment key={t}>
            {i === 3 && <div style={{height: 1, background: '#e4e4e7', margin: '5px 8px'}} />}
            <div style={row(hover === i)}>
              <span style={{display: 'flex', alignItems: 'center', gap: 10}}>
                {i === 3 && <Img src={staticFile('icon128.png')} style={{width: 20, height: 20, borderRadius: 5}} />}
                {t}
              </span>
              {i === 3 && <span>›</span>}
            </div>
          </React.Fragment>
        ))}
      </div>
      {sub && (
        <div style={{...box, width: 290, marginTop: 128}}>
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
