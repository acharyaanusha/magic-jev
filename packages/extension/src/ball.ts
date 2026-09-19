/**
 * The ball: a Magic 8 Ball fixed to the bottom-right corner of the page.
 *
 * Everything lives in an open shadow root so GitHub's styles cannot reach it
 * and ours cannot leak out. The ball knows nothing about pull requests or the
 * worker: it is handed `onAsk`, shakes while that runs, and shows what it
 * returns. All dynamic text is written with textContent, never as markup.
 */
import { HAZY } from '../../core/src/index.js';

export interface Ball {
  destroy(): void;
}

/** What one ask ends on. With `onReasonClick` the reason line is drawn as a link that calls it. */
export interface BallAnswer {
  phrase: string;
  reason: string;
  onReasonClick?: () => void;
}

// ---------------------------------------------------------------------------
// Geometry, in CSS pixels at the ball's resting size.
// ---------------------------------------------------------------------------

const BALL = 96;
/** The round window on the answer face. */
const WINDOW = 76;
/** Side of the equilateral triangle that floats up in the window. */
const TRI_SIDE = 62;
const TRI_HEIGHT = (TRI_SIDE * Math.sqrt(3)) / 2;
/** How much wider the triangle gets for each pixel further from its apex. */
const WIDTH_PER_PX = TRI_SIDE / TRI_HEIGHT;
/** Gap kept between the text and the triangle's wide edge, and its slanted sides. */
const EDGE_PAD = 3.5;
const SIDE_PAD = 2.5;
const LINE_HEIGHT = 1.12;
const MAX_FONT = 12.5;
const LETTER_SPACING_EM = 0.04;
/** The ball grows by this much to show the answer, so the phrase can be read. */
const ANSWER_SCALE = 1.75;
/** The answer never lands sooner than this after the click. */
const MIN_SHAKE_MS = 900;
const SHAKE_CYCLE_MS = 120;

/** The triangle's box, for anything that needs to check a layout against it. */
export const TRIANGLE = { side: TRI_SIDE, height: TRI_HEIGHT, sidePad: SIDE_PAD, maxFont: MAX_FONT, lineHeight: LINE_HEIGHT } as const;

const PHRASE_FONT = '"Avenir Next Condensed", "Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif';
const UI_FONT = 'system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif';

const HOST_ATTRIBUTE = 'data-magic-jev';

// ---------------------------------------------------------------------------
// Fitting the phrase into the triangle.
// ---------------------------------------------------------------------------

export interface PhraseFit {
  /** Which way the triangle points. A real ball's die floats up either way. */
  orientation: 'up' | 'down';
  /** Uppercase lines in reading order, three at most. */
  lines: string[];
  fontSize: number;
  /** Top of each line box, measured from the top of the triangle's box. */
  tops: number[];
}

/** Width of a line at a font size of 1 px. */
export type Measure = (line: string) => number;

/** A rough width for bold condensed capitals, used when no canvas is available. */
export const estimateWidth: Measure = (line) => line.length * (0.6 + LETTER_SPACING_EM);

/**
 * The largest font size at which every line fits, and where the block sits.
 * `widths` run from the apex towards the wide edge, each at a font size of 1 px.
 * The returned tops are distances from the apex in that same order.
 *
 * A line is tightest at its edge nearest the apex, where the triangle is
 * `WIDTH_PER_PX * distance` wide. With the block pushed against the wide edge,
 * line i of n starts at `H - EDGE_PAD - (n - i) * LINE_HEIGHT * f`, which gives
 * a closed form for the largest f. The block is then moved towards the
 * centroid as far as the widths allow, so short phrases sit in the middle.
 */
function solve(widths: number[]): { fontSize: number; tops: number[] } {
  const n = widths.length;
  const room = WIDTH_PER_PX * (TRI_HEIGHT - EDGE_PAD) - 2 * SIDE_PAD;
  let fontSize = MAX_FONT;
  widths.forEach((width, i) => {
    fontSize = Math.min(fontSize, room / (width + WIDTH_PER_PX * LINE_HEIGHT * (n - i)));
  });
  const line = LINE_HEIGHT * fontSize;
  let needed = 0;
  widths.forEach((width, i) => {
    needed = Math.max(needed, (fontSize * width + 2 * SIDE_PAD) / WIDTH_PER_PX - i * line);
  });
  const centred = (2 / 3) * TRI_HEIGHT - (n * line) / 2;
  const lowest = TRI_HEIGHT - EDGE_PAD - n * line;
  const blockTop = Math.min(Math.max(needed, centred), lowest);
  return { fontSize, tops: widths.map((_, i) => blockTop + i * line) };
}

/** Lays out lines already chosen. `widths` are in reading order, at 1 px. */
function layOut(lines: string[], orientation: 'up' | 'down', widths: number[]): PhraseFit {
  if (orientation === 'up') {
    const { fontSize, tops } = solve(widths);
    return { orientation, lines, fontSize, tops };
  }
  // Pointing down is the same problem seen upside down: the last line is nearest the apex.
  const { fontSize, tops } = solve([...widths].reverse());
  const line = LINE_HEIGHT * fontSize;
  const flipped = tops.map((top) => TRI_HEIGHT - top - line).reverse();
  return { orientation, lines, fontSize, tops: flipped };
}

/** Every way to break the words into one, two or three lines without reordering them. */
function lineBreaks(words: string[]): string[][] {
  const out: string[][] = [[words.join(' ')]];
  for (let a = 1; a < words.length; a++) {
    out.push([words.slice(0, a).join(' '), words.slice(a).join(' ')]);
    for (let b = a + 1; b < words.length; b++) {
      out.push([words.slice(0, a).join(' '), words.slice(a, b).join(' '), words.slice(b).join(' ')]);
    }
  }
  return out;
}

/**
 * Picks the line breaks and the triangle's direction that let the phrase be
 * set largest. Ties go to fewer lines, then to the more even lines, then to
 * the triangle pointing up.
 */
export function fitPhrase(phrase: string, measure: Measure = estimateWidth): PhraseFit {
  const words = phrase.toUpperCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return layOut([''], 'up', [0]);

  let best: PhraseFit | null = null;
  let bestWidest = Infinity;
  for (const lines of lineBreaks(words)) {
    const widths = lines.map(measure);
    const widest = Math.max(...widths);
    for (const orientation of ['up', 'down'] as const) {
      const fit = layOut(lines, orientation, widths);
      const better =
        best === null ||
        fit.fontSize > best.fontSize + 0.01 ||
        (Math.abs(fit.fontSize - best.fontSize) <= 0.01 &&
          (lines.length < best.lines.length || (lines.length === best.lines.length && widest < bestWidest - 0.01)));
      if (better) {
        best = fit;
        bestWidest = widest;
      }
    }
  }
  return best ?? layOut([words.join(' ')], 'up', [measure(words.join(' '))]);
}

/** Measures with a canvas in the phrase font. Falls back to the estimate where there is no canvas. */
function canvasMeasure(): Measure {
  try {
    const context = document.createElement('canvas').getContext('2d');
    if (!context) return estimateWidth;
    context.font = `700 100px ${PHRASE_FONT}`;
    return (line) => context.measureText(line).width / 100 + line.length * LETTER_SPACING_EM;
  } catch {
    return estimateWidth;
  }
}

// ---------------------------------------------------------------------------
// Styles.
// ---------------------------------------------------------------------------

/**
 * Keyframes for a decal riding the sphere as it rolls about its horizontal
 * axis. At angle t from the front the decal has moved `R * sin t` towards the
 * top and is squashed to `cos t` of its height. Ease-in-out is baked into the
 * stops because a CSS timing function would apply between stops, not overall.
 */
function rollKeyframes(name: string, fromDeg: number, toDeg: number): string {
  const stops = [0, 0.15, 0.3, 0.4, 0.5, 0.6, 0.7, 0.85, 1];
  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const frames = stops.map((stop) => {
    const angle = ((fromDeg + (toDeg - fromDeg) * ease(stop)) * Math.PI) / 180;
    const y = (-(BALL / 2) * Math.sin(angle)).toFixed(2);
    const squash = Math.max(0, Math.cos(angle)).toFixed(4);
    return `${(stop * 100).toFixed(0)}%{transform:translateY(${y}px) scaleY(${squash})}`;
  });
  return `@keyframes ${name}{${frames.join('')}}`;
}

function buildCss(): string {
  return `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }

.root {
  --scale: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  font-family: ${UI_FONT};
  transform-origin: 100% 100%;
  animation: mj-enter 460ms cubic-bezier(.2, 1.3, .4, 1) backwards;
  -webkit-font-smoothing: antialiased;
}
.root[data-state="answer"] { --scale: ${ANSWER_SCALE}; }
.root.leaving { opacity: 0; transform: scale(.8); transition: opacity 140ms ease, transform 140ms ease; }

.stage { position: relative; width: ${BALL}px; height: ${BALL}px; }

/* Grows the ball for the answer and lifts it while it is being shaken. */
.lift {
  width: 100%;
  height: 100%;
  transform-origin: 100% 100%;
  transform: scale(var(--scale));
  transition: transform 520ms cubic-bezier(.2, 1.25, .35, 1);
}
.root[data-state="idle"] .stage:hover .lift { transform: translateY(-2px) scale(1.04); transition-duration: 180ms; }
.root[data-state="asking"] .lift { transform: translateY(-8px) scale(1.06); transition-duration: 220ms; }

.ball {
  all: unset;
  box-sizing: border-box;
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  overflow: hidden;
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  background: radial-gradient(circle at 34% 28%, #4c4c55 0%, #1e1e23 22%, #0a0a0d 48%, #000 78%);
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, .09),
    0 12px 26px rgba(0, 0, 0, .45),
    0 3px 7px rgba(0, 0, 0, .4);
  transition: box-shadow 220ms ease;
}
.ball:focus-visible { outline: 2px solid #58a6ff; outline-offset: 3px; }
.root[data-state="asking"] .ball {
  cursor: progress;
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, .09),
    0 22px 34px rgba(0, 0, 0, .38),
    0 6px 12px rgba(0, 0, 0, .3);
  animation: mj-shake ${SHAKE_CYCLE_MS}ms ease-in-out infinite;
}

/* The white circle with the 8. */
.face8 {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 46px;
  height: 46px;
  margin: -23px 0 0 -23px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: radial-gradient(circle at 40% 32%, #fff 0%, #f1f1f4 55%, #cfcfd8 100%);
  box-shadow: inset 0 -2px 4px rgba(0, 0, 0, .18);
}
.eight {
  font: 700 33px/1 "Helvetica Neue", Helvetica, Arial, sans-serif;
  color: #0b0b0d;
  transform: translateY(-1px);
}

/* The answer face: a round window onto dark liquid. Rolled out of sight until there is an answer. */
.window {
  position: absolute;
  left: 50%;
  top: 50%;
  width: ${WINDOW}px;
  height: ${WINDOW}px;
  margin: ${-WINDOW / 2}px 0 0 ${-WINDOW / 2}px;
  border-radius: 50%;
  overflow: hidden;
  background: radial-gradient(circle at 50% 38%, #111c66 0%, #080d36 52%, #02030f 100%);
  box-shadow:
    inset 0 4px 9px rgba(0, 0, 0, .95),
    inset 0 -1px 2px rgba(120, 140, 255, .25),
    0 0 0 2px #1a1a1f,
    0 0 0 3px rgba(255, 255, 255, .07);
  transform: translateY(${BALL / 2}px) scaleY(0);
}
.glass {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: radial-gradient(ellipse 72% 38% at 50% 6%, rgba(255, 255, 255, .17), transparent 72%);
  pointer-events: none;
}

.tri {
  position: absolute;
  left: ${(WINDOW - TRI_SIDE) / 2}px;
  width: ${TRI_SIDE}px;
  height: ${TRI_HEIGHT.toFixed(2)}px;
  opacity: 0;
  /* Used when the animation below is taken away: the die sinks back as the ball is picked up again. */
  transition: opacity 160ms ease;
  background: linear-gradient(180deg, #6f80ff, #3a48d0);
}
.tri, .tri-inner { clip-path: polygon(50% 0, 100% 100%, 0 100%); }
.tri[data-orientation="up"] { top: ${(WINDOW / 2 - (2 / 3) * TRI_HEIGHT).toFixed(2)}px; transform-origin: 50% 66.67%; }
.tri[data-orientation="down"] { top: ${(WINDOW / 2 - (1 / 3) * TRI_HEIGHT).toFixed(2)}px; transform-origin: 50% 33.33%; }
.tri[data-orientation="down"], .tri[data-orientation="down"] .tri-inner { clip-path: polygon(0 0, 100% 0, 50% 100%); }
.tri-inner {
  position: absolute;
  inset: 0;
  transform: scale(.94);
  transform-origin: inherit;
  background: linear-gradient(180deg, #3243d6 0%, #1c2796 100%);
}
.line {
  position: absolute;
  left: 0;
  width: 100%;
  text-align: center;
  white-space: nowrap;
  color: #fff;
  font-family: ${PHRASE_FONT};
  font-weight: 700;
  letter-spacing: ${LETTER_SPACING_EM}em;
  text-transform: uppercase;
  text-shadow: 0 .5px 0 rgba(0, 0, 20, .55);
}
.line > span { display: inline-block; }

/* Light on the sphere. Sits above both faces so they read as being under the shell. */
.gloss {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  pointer-events: none;
  background:
    radial-gradient(circle at 74% 90%, rgba(130, 150, 255, .17), transparent 42%),
    radial-gradient(circle at 50% 50%, transparent 62%, rgba(0, 0, 0, .55) 100%);
}
.gloss::before {
  content: "";
  position: absolute;
  left: 13%;
  top: 8%;
  width: 40%;
  height: 22%;
  border-radius: 50%;
  background: radial-gradient(ellipse at 50% 40%, rgba(255, 255, 255, .62), rgba(255, 255, 255, 0) 70%);
  transform: rotate(-32deg);
  filter: blur(1px);
}

/* Rolling between the two faces. */
.root[data-state="answer"] .face8 { animation: mj-8-out 440ms linear both; }
.root[data-state="answer"] .window { animation: mj-window-in 440ms linear both; }
.root.reask[data-state="asking"] .face8 { animation: mj-8-in 260ms linear both; }
.root.reask[data-state="asking"] .window { animation: mj-window-out 260ms linear both; }
.root[data-state="answer"] .tri {
  animation:
    mj-surface 900ms cubic-bezier(.25, .8, .3, 1) 240ms both,
    mj-bob 4200ms ease-in-out 1140ms infinite alternate;
}

/* The question, shown beside the resting ball. */
.hint {
  position: absolute;
  right: calc(100% + 10px);
  top: 50%;
  transform: translate(6px, -50%);
  opacity: 0;
  pointer-events: none;
  white-space: nowrap;
  font: 500 12px/1 ${UI_FONT};
  color: #f0f3f6;
  background: rgba(13, 17, 23, .94);
  border: 1px solid rgba(255, 255, 255, .16);
  border-radius: 999px;
  padding: 7px 11px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, .3);
  transition: opacity 160ms ease, transform 160ms ease;
}
.root[data-state="idle"] .stage:hover .hint,
.root[data-state="idle"] .stage:has(.ball:focus-visible) .hint {
  opacity: 1;
  transform: translate(0, -50%);
  transition-delay: 250ms;
}

/* The x. It follows the top-right of the ball as the ball grows. */
.close {
  all: unset;
  box-sizing: border-box;
  position: absolute;
  top: -6px;
  right: -6px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  cursor: pointer;
  font: 700 13px/1 ${UI_FONT};
  color: #f0f3f6;
  background: rgba(13, 17, 23, .94);
  border: 1px solid rgba(255, 255, 255, .22);
  box-shadow: 0 2px 6px rgba(0, 0, 0, .35);
  opacity: 0;
  /* Up with the growing ball, and a little inwards so it stays near the sphere's edge. */
  transform: translate(calc((var(--scale) - 1) * -8px), calc((var(--scale) - 1) * ${-BALL + 8}px));
  transition: opacity 140ms ease, transform 520ms cubic-bezier(.2, 1.25, .35, 1), background 140ms ease;
}
.stage:hover .close, .close:focus-visible, .stage:has(.ball:focus-visible) .close { opacity: 1; }
.close:hover { background: #30363d; }
.close:focus-visible { outline: 2px solid #58a6ff; outline-offset: 2px; }
.root[data-state="asking"] .close { opacity: 0; pointer-events: none; }

/* The reason line. The grid row opens from nothing so the ball rises smoothly to make room. */
.answer {
  display: grid;
  grid-template-rows: 0fr;
  /* The clip below is padded so the pill's shadow is not cut off. These margins take that padding back. */
  margin: 0 -12px -12px 0;
  transition: grid-template-rows 320ms ease;
}
.answer-clip { min-height: 0; overflow: hidden; padding: 0 12px 12px; display: flex; justify-content: flex-end; }
.pill {
  display: block;
  margin: 10px 0 0;
  max-width: 300px;
  font: 500 12px/1.35 ${UI_FONT};
  color: #f0f3f6;
  text-align: right;
  background: rgba(13, 17, 23, .94);
  border: 1px solid rgba(255, 255, 255, .16);
  border-radius: 13px;
  padding: 5px 11px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, .28);
  opacity: 0;
  transform: translateY(-4px);
  transition: opacity 200ms ease, transform 200ms ease;
}
/* The reason line as a link, for "open the options page first". */
.pill-link { all: unset; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.pill-link:hover { color: #58a6ff; }
.pill-link:focus-visible { outline: 2px solid #58a6ff; outline-offset: 3px; border-radius: 4px; }
.root[data-state="answer"] .answer { grid-template-rows: 1fr; transition-delay: 260ms; }
.root[data-state="answer"] .pill { opacity: 1; transform: none; transition-delay: 520ms; }
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

@keyframes mj-enter {
  from { opacity: 0; transform: translateY(18px) scale(.55); }
  to { opacity: 1; transform: none; }
}
/* One cycle every ${SHAKE_CYCLE_MS} ms. It starts and ends at rest so it can stop on a cycle boundary without a jump. */
@keyframes mj-shake {
  0% { transform: translate(0, 0) rotate(0); }
  20% { transform: translate(-6px, 2px) rotate(-8deg); }
  45% { transform: translate(5px, -3px) rotate(6deg); }
  70% { transform: translate(-4px, -2px) rotate(-5deg); }
  88% { transform: translate(3px, 2px) rotate(3deg); }
  100% { transform: translate(0, 0) rotate(0); }
}
/* The die drifting up out of the murk, then idling. */
@keyframes mj-surface {
  0% { opacity: 0; transform: scale(.5) rotate(-18deg); filter: blur(3px); }
  55% { opacity: 1; transform: scale(1.05) rotate(3deg); filter: blur(0); }
  78% { opacity: 1; transform: scale(.99) rotate(-1deg); filter: blur(0); }
  100% { opacity: 1; transform: none; filter: blur(0); }
}
@keyframes mj-bob {
  from { transform: translateY(0) rotate(0); }
  to { transform: translateY(-.8px) rotate(1.4deg); }
}
${rollKeyframes('mj-8-out', 0, 90)}
${rollKeyframes('mj-8-in', 90, 0)}
${rollKeyframes('mj-window-in', -90, 0)}
${rollKeyframes('mj-window-out', 0, -90)}

/* Reduced motion: nothing shakes, rolls or grows on screen. The faces cross-fade over 900 ms instead. */
@media (prefers-reduced-motion: reduce) {
  .root, .root *, .root *::before { animation: none !important; }
  .lift, .close { transition: opacity 140ms ease !important; }
  .root[data-state="idle"] .stage:hover .lift,
  .root[data-state="asking"] .lift { transform: scale(var(--scale)); }
  .root.reask[data-state="asking"] { --scale: ${ANSWER_SCALE}; }
  .pill { transform: none !important; }
  .hint { transform: translate(0, -50%); transition: opacity 160ms ease; }
  .answer { transition: none; }
  .face8 { transition: opacity ${MIN_SHAKE_MS}ms linear; }
  .window { transform: none; opacity: 0; transition: opacity ${MIN_SHAKE_MS}ms linear; }
  .tri { opacity: 1; }
  .root[data-state="asking"] .face8, .root[data-state="answer"] .face8 { opacity: 0; }
  .root[data-state="answer"] .window { opacity: 1; transition-duration: 400ms; }
}
`;
}

// ---------------------------------------------------------------------------
// The ball.
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function mountBall(onAsk: () => Promise<BallAnswer>): Ball {
  // A ball left behind by an earlier copy of this script (the extension was reloaded) would sit under ours.
  document.querySelectorAll(`[${HOST_ATTRIBUTE}]`).forEach((stale) => stale.remove());

  const host = document.createElement('div');
  host.setAttribute(HOST_ATTRIBUTE, '');
  // Inline, so neither the page's stylesheets nor our own :host reset can move it.
  host.style.cssText = 'all: initial; position: fixed; right: 24px; bottom: 24px; z-index: 2147483000;';
  const shadow = host.attachShadow({ mode: 'open' });

  // A constructed stylesheet is not subject to the page's style-src policy. A <style> element is the fallback.
  const css = buildCss();
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = css;
    shadow.append(style);
  }

  const root = el('div', 'root');
  root.dataset.state = 'idle';
  const stage = el('div', 'stage');
  const lift = el('div', 'lift');

  const button = el('button', 'ball');
  button.type = 'button';
  button.setAttribute('aria-label', 'Ask Magic Jev: should I approve this?');

  const face8 = el('span', 'face8');
  const eight = el('span', 'eight');
  eight.textContent = '8';
  face8.append(eight);

  const windowFace = el('span', 'window');
  const tri = el('span', 'tri');
  tri.dataset.orientation = 'up';
  const triInner = el('span', 'tri-inner');
  const linesBox = el('span', 'lines');
  tri.append(triInner, linesBox);
  windowFace.append(tri, el('span', 'glass'));

  // The faces are decoration for assistive tech: the button has its label and the answer is announced below.
  for (const face of [face8, windowFace]) face.setAttribute('aria-hidden', 'true');
  button.append(face8, windowFace, el('span', 'gloss'));
  lift.append(button);

  const hint = el('span', 'hint');
  hint.setAttribute('aria-hidden', 'true');
  hint.textContent = 'Should I approve this?';

  const close = el('button', 'close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Hide Magic Jev on this page');
  close.textContent = '×';

  stage.append(lift, hint, close);

  const answer = el('div', 'answer');
  answer.setAttribute('aria-live', 'polite');
  answer.setAttribute('aria-atomic', 'true');
  const answerClip = el('div', 'answer-clip');
  const spoken = el('span', 'sr');
  const pill = el('span', 'pill');
  answerClip.append(spoken, pill);
  answer.append(answerClip);

  root.append(stage, answer);
  shadow.append(root);
  // On <html>, not <body>: Turbo swaps the body when GitHub navigates, which would take the ball with it.
  document.documentElement.append(host);

  const measure = canvasMeasure();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let state: 'idle' | 'asking' | 'answer' = 'idle';
  let destroyed = false;

  function setState(next: typeof state): void {
    state = next;
    root.dataset.state = next;
  }

  function drawLines(fit: PhraseFit): HTMLSpanElement[] {
    tri.dataset.orientation = fit.orientation;
    const spans = fit.lines.map((text, i) => {
      const line = el('span', 'line');
      line.style.top = `${(fit.tops[i] ?? 0).toFixed(2)}px`;
      line.style.fontSize = `${fit.fontSize.toFixed(2)}px`;
      line.style.lineHeight = String(LINE_HEIGHT);
      const inner = document.createElement('span');
      inner.textContent = text;
      line.append(inner);
      return inner;
    });
    linesBox.replaceChildren(...spans.map((inner) => inner.parentElement as HTMLElement));
    return spans;
  }

  function showPhrase(phrase: string): void {
    const fit = fitPhrase(phrase, measure);
    const spans = drawLines(fit);
    // The canvas and the page can disagree about a font. Measure what was really drawn and lay out once more.
    // offsetWidth is in layout pixels, so the ball's scale does not distort it.
    const real = spans.map((span) => span.offsetWidth / fit.fontSize);
    if (real.every((width) => width > 0)) drawLines(layOut(fit.lines, fit.orientation, real));
  }

  /** Resolves when the running shake cycle ends, so the ball comes to rest instead of snapping there. */
  function shakeComesToRest(): Promise<void> {
    if (reducedMotion.matches) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        button.removeEventListener('animationiteration', onIteration);
        clearTimeout(timer);
        resolve();
      };
      const onIteration = (event: AnimationEvent) => {
        if (event.animationName === 'mj-shake') done();
      };
      // The timer covers a tab in the background, where animation events may not fire.
      const timer = setTimeout(done, SHAKE_CYCLE_MS + 40);
      button.addEventListener('animationiteration', onIteration);
    });
  }

  async function ask(): Promise<void> {
    if (state === 'asking' || destroyed) return;
    root.classList.toggle('reask', state === 'answer');
    setState('asking');
    button.setAttribute('aria-busy', 'true');
    // Emptied now so that the same phrase twice in a row is still announced. The pill keeps its text while it fades.
    spoken.textContent = '';

    const clickedAt = performance.now();
    let result: BallAnswer;
    try {
      result = await onAsk();
    } catch {
      // A ball that hangs is worse than a ball that shrugs.
      result = { phrase: HAZY, reason: 'something went wrong' };
    }
    const remaining = MIN_SHAKE_MS - (performance.now() - clickedAt);
    if (remaining > 0) await delay(remaining);
    if (destroyed) return;
    await shakeComesToRest();
    if (destroyed) return;

    showPhrase(result.phrase);
    spoken.textContent = `${result.phrase}. `;
    const { onReasonClick } = result;
    if (onReasonClick) {
      const link = el('button', 'pill-link');
      link.type = 'button';
      link.textContent = result.reason;
      link.addEventListener('click', () => onReasonClick());
      pill.replaceChildren(link);
    } else {
      pill.textContent = result.reason;
    }
    button.removeAttribute('aria-busy');
    setState('answer');
    root.classList.remove('reask');
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    host.remove();
  }

  button.addEventListener('click', () => void ask());
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    if (destroyed) return;
    root.classList.add('leaving');
    setTimeout(destroy, 150);
  });

  return { destroy };
}
