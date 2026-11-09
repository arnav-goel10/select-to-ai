import React from 'react';
import {AbsoluteFill, Audio, Composition, Sequence, staticFile, useCurrentFrame} from 'remotion';
import J from './beat.json';
import {B, FrameCtx} from './kit';
import {Agent, Ask, Bento, End, Highlight, Hook, SceneProps, Tunnel} from './scenes';
import {inOut} from './util';

const T = 24; // transition length in frames, centred on the bar line
const H = T / 2;
const CUTS = J.cuts as Record<string, string>;
const SCENES: [keyof typeof J.sections, React.FC<SceneProps>][] = [
  ['hook', Hook], ['highlight', Highlight], ['ask', Ask], ['agent', Agent], ['tunnel', Tunnel], ['bento', Bento], ['end', End],
];
const clamp = (x: number) => Math.max(0, Math.min(1, x));

/** Style for one side of a cut. p runs 0..1 across the transition. */
function present(type: string, dir: 'in' | 'out', p: number, id: string): {style: React.CSSProperties; blur?: [number, number]} {
  const e = inOut(p);
  const swing = Math.sin(p * Math.PI);
  switch (type) {
    case 'zoom':
      return dir === 'out'
        ? {style: {transform: `scale(${1 + 4 * e * e})`, transformOrigin: '50% 44%', opacity: 1 - clamp((p - 0.45) / 0.55)}}
        : {style: {transform: `scale(${1.3 - 0.3 * e})`, opacity: clamp(p * 1.6), filter: `blur(${(1 - e) * 18}px)`}};
    case 'whipLeft':
      return dir === 'out'
        ? {style: {transform: `translateX(${-e * 1500}px)`, opacity: 1 - e * 0.6, filter: `url(#${id})`}, blur: [swing * 70, 0]}
        : {style: {transform: `translateX(${(1 - e) * 1500}px)`, opacity: 0.4 + 0.6 * e, filter: `url(#${id})`}, blur: [swing * 70, 0]};
    case 'whipUp':
      return dir === 'out'
        ? {style: {transform: `translateY(${-e * 1100}px)`, opacity: 1 - e * 0.6, filter: `url(#${id})`}, blur: [0, swing * 60]}
        : {style: {transform: `translateY(${(1 - e) * 1100}px)`, opacity: 0.4 + 0.6 * e, filter: `url(#${id})`}, blur: [0, swing * 60]};
    case 'pull':
      return dir === 'out'
        ? {style: {transform: `scale(${1 - 0.4 * e})`, opacity: 1 - e, filter: `blur(${e * 12}px)`, borderRadius: 40 * e, overflow: 'hidden'}}
        : {style: {transform: `scale(${1.14 - 0.14 * e})`, opacity: e, filter: `blur(${(1 - e) * 14}px)`}};
    default: // converge
      return dir === 'out' ? {style: {opacity: 1 - e}} : {style: {transform: `scale(${1.12 - 0.12 * e})`, opacity: e, filter: `blur(${(1 - e) * 12}px)`}};
  }
}

const Clip: React.FC<{name: string; Scene: React.FC<SceneProps>; start: number; end: number; enter?: string; exit?: string}> = ({name, Scene, start, end, enter, exit}) => {
  const local = useCurrentFrame();
  const lead = enter ? H : 0;
  const f = local - lead;
  const len = end - start;
  let style: React.CSSProperties = {};
  let blur: [number, number] | undefined;
  const id = `mb-${name}`;
  if (enter && f < H) ({style, blur} = present(enter, 'in', clamp((f + H) / T), id));
  else if (exit && f > len - H) ({style, blur} = present(exit, 'out', clamp((f - (len - H)) / T), id));
  return (
    <FrameCtx.Provider value={f}>
      {blur && (
        <svg style={{position: 'absolute', width: 0, height: 0}}>
          <filter id={id} x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation={`${blur[0].toFixed(1)} ${blur[1].toFixed(1)}`} /></filter>
        </svg>
      )}
      <AbsoluteFill style={style}>
        <Scene f={f} abs={start + f} />
      </AbsoluteFill>
    </FrameCtx.Provider>
  );
};

/** A soft white bloom exactly on each cut. */
const CutFlash: React.FC = () => {
  const f = useCurrentFrame();
  let o = 0;
  for (const bar of Object.keys(CUTS).map(Number)) { const d = Math.abs(f - B(bar)); if (d < 10) o = Math.max(o, (1 - d / 10) * 0.16); }
  return o > 0 ? <AbsoluteFill style={{background: 'radial-gradient(circle at 50% 45%, rgba(255,255,255,1), rgba(255,255,255,0.3) 45%, transparent 75%)', opacity: o, pointerEvents: 'none'}} /> : null;
};

/** A chosen track (scripts/sync-music.mjs) with the UI sounds under it, or the generated one. */
const Soundtrack: React.FC = () => {
  const M = (J as any).music as {file: string; start: number} | undefined;
  if (!M) return <Audio src={staticFile('music.wav')} />;
  return (
    <>
      <Audio src={staticFile('music-edit.wav')} volume={0.9} />
      <Audio src={staticFile('sfx.wav')} volume={0.5} />
    </>
  );
};

export const Promo: React.FC = () => (
  <AbsoluteFill style={{background: '#050506'}}>
    {SCENES.map(([key, Scene]) => {
      const [s, e] = J.sections[key];
      const enter = s > 0 ? CUTS[String(s)] : undefined;
      const exit = e < J.bars ? CUTS[String(e)] : undefined;
      const start = B(s), end = B(e);
      const from = start - (enter ? H : 0);
      const dur = end - start + (enter ? H : 0) + (exit ? H : 0);
      return (
        <Sequence key={key} from={from} durationInFrames={dur} name={key}>
          <Clip name={key} Scene={Scene} start={start} end={end} enter={enter} exit={exit} />
        </Sequence>
      );
    })}
    <CutFlash />
    <Soundtrack />
  </AbsoluteFill>
);

export const Root: React.FC = () => (
  <Composition id="Promo" component={Promo} durationInFrames={B(J.bars)} fps={J.fps} width={1920} height={1080} />
);
