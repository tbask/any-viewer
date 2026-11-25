/**
 * Shape rendering, shared by slides, shapes in text documents and SmartArt.
 * A shape is an absolutely positioned block; a complex outline is drawn as vector (SVG) with the text on top.
 */
import { fontFamilyCss, type Inline } from '../core/docmodel';
import { renderMath } from './math';
import type { SlideCell, SlidePara, SlideShape } from '../core/slidemodel';
import type { Labels } from '../types';
import { renderChart } from './chart';
import { clamp, el } from './types';

const NS = 'http://www.w3.org/2000/svg';

function star(points: number, inner: number, w: number, h: number): string {
  let d = '';
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    const r = i % 2 ? inner : 1;
    d += `${i ? 'L' : 'M'}${((0.5 + (Math.cos(a) * r) / 2) * w).toFixed(1)} ${((0.5 + (Math.sin(a) * r) / 2) * h).toFixed(1)} `;
  }
  return `${d}Z`;
}
function polygon(points: [number, number][], w: number, h: number): string {
  return `${points.map(([x, y], i) => `${i ? 'L' : 'M'}${(x * w).toFixed(1)} ${(y * h).toFixed(1)}`).join(' ')} Z`;
}
function regular(sides: number, w: number, h: number, rotate = -Math.PI / 2): string {
  return polygon(Array.from({ length: sides }, (_, i) => [0.5 + Math.cos(rotate + (i * 2 * Math.PI) / sides) / 2, 0.5 + Math.sin(rotate + (i * 2 * Math.PI) / sides) / 2] as [number, number]), w, h);
}

/**
 * Scales a path written in unit coordinates (0–1 on both axes) to the frame. Commands M, L, C, Q, A and Z;
 * for A the radii are scaled, the three flags are kept.
 */
function unit(d: string, w: number, h: number): string {
  const tokens = d.match(/[MLCQAZ]|-?\d*\.?\d+/g) ?? [];
  let out = '';
  let cmd = '';
  let k = 0;
  for (const t of tokens) {
    if (/[MLCQAZ]/.test(t)) {
      cmd = t;
      k = 0;
      out += t;
      continue;
    }
    const v = Number(t);
    let scaled: number;
    if (cmd === 'A') {
      const i = k % 7;
      scaled = i === 0 || i === 5 ? v * w : i === 1 || i === 6 ? v * h : v;
    } else scaled = k % 2 === 0 ? v * w : v * h;
    out += `${Math.round(scaled * 10) / 10} `;
    k++;
  }
  return out.trim();
}
/** Full ellipse as a closed path in unit coordinates. */
const oval = (cx: number, cy: number, rx: number, ry: number): string => `M${cx - rx} ${cy} A${rx} ${ry} 0 1 1 ${cx + rx} ${cy} A${rx} ${ry} 0 1 1 ${cx - rx} ${cy} Z`;
/** A line drawn there and back: it is stroked but encloses no area, so the fill is not affected. */
const crease = (...pts: number[]): string => {
  let d = `M${pts[0]} ${pts[1]}`;
  for (let i = 2; i < pts.length; i += 2) d += ` L${pts[i]} ${pts[i + 1]}`;
  for (let i = pts.length - 4; i >= 0; i -= 2) d += ` L${pts[i]} ${pts[i + 1]}`;
  return `${d} Z`;
};
function gear(teeth: number): string {
  const pts: string[] = [];
  const step = (2 * Math.PI) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = -Math.PI / 2 + i * step;
    for (const [da, r] of [[-0.3, 0.37], [-0.17, 0.5], [0.17, 0.5], [0.3, 0.37]] as const) pts.push(`${(0.5 + Math.cos(a + da * step) * r).toFixed(3)} ${(0.5 + Math.sin(a + da * step) * r).toFixed(3)}`);
  }
  return `M${pts.join(' L')} Z`;
}
function sun(): string {
  let d = oval(0.5, 0.5, 0.25, 0.25);
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const p = (r: number, da: number) => `${(0.5 + Math.cos(a + da) * r).toFixed(3)} ${(0.5 + Math.sin(a + da) * r).toFixed(3)}`;
    d += ` M${p(0.5, 0)} L${p(0.32, 0.2)} L${p(0.32, -0.2)} Z`;
  }
  return d;
}

/** Outlines written in unit coordinates; see {@link unit}. */
const UNIT_SHAPES: Record<string, string> = {
  lightningBolt: 'M.392 0 L.595 .281 L.512 .315 L.767 .556 L.684 .596 L1 1 L.464 .69 L.566 .648 L.232 .449 L.352 .388 L0 .18 Z',
  moon: 'M1 0 A1 .5 0 0 0 1 1 A.5 .5 0 0 1 1 0 Z',
  teardrop: 'M.5 0 L1 0 L1 .5 A.5 .5 0 1 1 .5 0 Z',
  wave: 'M0 .14 C.33 -.14 .67 .42 1 .14 L1 .86 C.67 1.14 .33 .58 0 .86 Z',
  doubleWave: 'M0 .12 C.17 -.1 .33 .34 .5 .12 C.67 -.1 .83 .34 1 .12 L1 .88 C.83 1.1 .67 .66 .5 .88 C.33 1.1 .17 .66 0 .88 Z',
  flowChartPunchedTape: 'M0 .1 C.17 .3 .33 .3 .5 .1 C.67 -.1 .83 -.1 1 .1 L1 .9 C.83 .7 .67 .7 .5 .9 C.33 1.1 .17 1.1 0 .9 Z',
  donut: `${oval(0.5, 0.5, 0.5, 0.5)} ${oval(0.5, 0.5, 0.25, 0.25)}`,
  noSmoking: `${oval(0.5, 0.5, 0.5, 0.5)} ${oval(0.5, 0.5, 0.38, 0.38)} M.19 .28 L.28 .19 L.81 .72 L.72 .81 Z`,
  smileyFace: `${oval(0.5, 0.5, 0.5, 0.5)} ${oval(0.33, 0.36, 0.05, 0.06)} ${oval(0.67, 0.36, 0.05, 0.06)} M.26 .62 Q.5 .9 .74 .62 Q.5 .82 .26 .62 Z`,
  frame: 'M0 0 L1 0 L1 1 L0 1 Z M.125 .125 L.125 .875 L.875 .875 L.875 .125 Z',
  bevel: `M0 0 L1 0 L1 1 L0 1 Z ${crease(0, 0, 0.125, 0.125, 0.875, 0.125, 1, 0)} ${crease(0.875, 0.125, 0.875, 0.875, 1, 1)} ${crease(0.875, 0.875, 0.125, 0.875, 0, 1)} ${crease(0.125, 0.875, 0.125, 0.125)}`,
  cube: `M0 .25 L.25 0 L1 0 L1 .75 L.75 1 L0 1 Z ${crease(0, 0.25, 0.75, 0.25, 0.75, 1)} ${crease(0.75, 0.25, 1, 0)}`,
  foldedCorner: `M0 0 L1 0 L1 .83 L.83 1 L0 1 Z ${crease(0.83, 1, 0.86, 0.86, 1, 0.83)}`,
  pie: 'M.5 .5 L1 .5 A.5 .5 0 1 1 .5 0 Z',
  chord: 'M.854 .854 A.5 .5 0 1 1 .5 0 Z',
  arc: 'M.5 0 A.5 .5 0 0 1 1 .5',
  blockArc: 'M0 .5 A.5 .5 0 0 1 1 .5 L.75 .5 A.25 .25 0 0 0 .25 .5 Z',
  plaque: 'M.16 0 L.84 0 A.16 .16 0 0 0 1 .16 L1 .84 A.16 .16 0 0 0 .84 1 L.16 1 A.16 .16 0 0 0 0 .84 L0 .16 A.16 .16 0 0 0 .16 0 Z',
  bracketPair: 'M.1 0 A.1 .1 0 0 0 0 .1 L0 .9 A.1 .1 0 0 0 .1 1 M.9 1 A.1 .1 0 0 0 1 .9 L1 .1 A.1 .1 0 0 0 .9 0',
  bracePair: 'M.14 0 Q.07 0 .07 .1 L.07 .4 Q.07 .5 0 .5 Q.07 .5 .07 .6 L.07 .9 Q.07 1 .14 1 M.86 1 Q.93 1 .93 .9 L.93 .6 Q.93 .5 1 .5 Q.93 .5 .93 .4 L.93 .1 Q.93 0 .86 0',
  leftBracket: 'M1 0 A1 .08 0 0 0 0 .08 L0 .92 A1 .08 0 0 0 1 1',
  rightBracket: 'M0 0 A1 .08 0 0 1 1 .08 L1 .92 A1 .08 0 0 1 0 1',
  leftBrace: 'M1 0 Q.5 0 .5 .08 L.5 .42 Q.5 .5 0 .5 Q.5 .5 .5 .58 L.5 .92 Q.5 1 1 1',
  rightBrace: 'M0 0 Q.5 0 .5 .08 L.5 .42 Q.5 .5 1 .5 Q.5 .5 .5 .58 L.5 .92 Q.5 1 0 1',
  ribbon: 'M0 0 L.33 0 L.33 .17 L.67 .17 L.67 0 L1 0 L.88 .42 L1 .83 L.75 .83 L.75 1 L.25 1 L.25 .83 L0 .83 L.12 .42 Z',
  ribbon2: 'M0 .17 L.25 .17 L.25 0 L.75 0 L.75 .17 L1 .17 L.88 .58 L1 1 L.67 1 L.67 .83 L.33 .83 L.33 1 L0 1 L.12 .58 Z',
  ellipseRibbon: 'M0 0 Q.5 .3 1 0 L.88 .42 L1 .83 Q.5 1.1 0 .83 L.12 .42 Z',
  ellipseRibbon2: 'M0 .17 Q.5 -.1 1 .17 L.88 .58 L1 1 Q.5 .7 0 1 L.12 .58 Z',
  quadArrow: 'M.5 0 L.68 .18 L.57 .18 L.57 .43 L.82 .43 L.82 .32 L1 .5 L.82 .68 L.82 .57 L.57 .57 L.57 .82 L.68 .82 L.5 1 L.32 .82 L.43 .82 L.43 .57 L.18 .57 L.18 .68 L0 .5 L.18 .32 L.18 .43 L.43 .43 L.43 .18 L.32 .18 Z',
  leftRightUpArrow: 'M.5 0 L.68 .22 L.57 .22 L.57 .64 L.82 .64 L.82 .53 L1 .75 L.82 1 L.82 .86 L.18 .86 L.18 1 L0 .75 L.18 .53 L.18 .64 L.43 .64 L.43 .22 L.32 .22 Z',
  leftUpArrow: 'M.72 0 L1 .25 L.83 .25 L.83 .83 L.25 .83 L.25 1 L0 .72 L.25 .45 L.25 .62 L.62 .62 L.62 .25 L.45 .25 Z',
  bentUpArrow: 'M.75 0 L1 .28 L.86 .28 L.86 1 L0 1 L0 .75 L.64 .75 L.64 .28 L.5 .28 Z',
  bentArrow: 'M0 1 L0 .42 Q0 .2 .22 .2 L.72 .2 L.72 0 L1 .3 L.72 .6 L.72 .42 L.26 .42 Q.24 .42 .24 .46 L.24 1 Z',
  uturnArrow: 'M0 1 L0 .4 A.36 .4 0 0 1 .72 .4 L.72 .58 L.88 .58 L.62 .9 L.36 .58 L.5 .58 L.5 .4 A.14 .17 0 0 0 .22 .4 L.22 1 Z',
  notchedRightArrow: 'M0 .25 L.7 .25 L.7 0 L1 .5 L.7 1 L.7 .75 L0 .75 L.12 .5 Z',
  stripedRightArrow: 'M0 .25 L.04 .25 L.04 .75 L0 .75 Z M.08 .25 L.15 .25 L.15 .75 L.08 .75 Z M.2 .25 L.7 .25 L.7 0 L1 .5 L.7 1 L.7 .75 L.2 .75 Z',
  curvedRightArrow: 'M0 .1 Q0 .78 .72 .82 L.72 .66 L1 .84 L.72 1 L.72 .9 Q0 .92 0 .1 Z',
  curvedLeftArrow: 'M1 .1 Q1 .78 .28 .82 L.28 .66 L0 .84 L.28 1 L.28 .9 Q1 .92 1 .1 Z',
  curvedDownArrow: 'M.1 1 Q.78 1 .82 .28 L.66 .28 L.84 0 L1 .28 L.9 .28 Q.92 1 .1 1 Z',
  curvedUpArrow: 'M.1 0 Q.78 0 .82 .72 L.66 .72 L.84 1 L1 .72 L.9 .72 Q.92 0 .1 0 Z',
  circularArrow: 'M.12 .5 A.38 .38 0 0 1 .86 .38 L.96 .36 L.82 .6 L.62 .42 L.73 .4 A.25 .25 0 0 0 .25 .5 Z',
  halfFrame: 'M0 0 L1 0 L.67 .33 L.33 .33 L.33 .67 L0 1 Z',
  corner: 'M0 0 L.5 0 L.5 .5 L1 .5 L1 1 L0 1 Z',
  diagStripe: 'M0 .5 L.5 0 L1 0 L0 1 Z',
  mathPlus: 'M.38 .12 L.62 .12 L.62 .38 L.88 .38 L.88 .62 L.62 .62 L.62 .88 L.38 .88 L.38 .62 L.12 .62 L.12 .38 L.38 .38 Z',
  mathMinus: 'M.12 .38 L.88 .38 L.88 .62 L.12 .62 Z',
  mathMultiply: 'M.2 .32 L.32 .2 L.5 .38 L.68 .2 L.8 .32 L.62 .5 L.8 .68 L.68 .8 L.5 .62 L.32 .8 L.2 .68 L.38 .5 Z',
  mathDivide: `M.12 .4 L.88 .4 L.88 .6 L.12 .6 Z ${oval(0.5, 0.2, 0.1, 0.1)} ${oval(0.5, 0.8, 0.1, 0.1)}`,
  mathEqual: 'M.12 .22 L.88 .22 L.88 .44 L.12 .44 Z M.12 .56 L.88 .56 L.88 .78 L.12 .78 Z',
  mathNotEqual: 'M.12 .22 L.88 .22 L.88 .44 L.12 .44 Z M.12 .56 L.88 .56 L.88 .78 L.12 .78 Z M.6 .05 L.7 .1 L.4 .95 L.3 .9 Z',
  flowChartAlternateProcess: 'M.1 0 L.9 0 Q1 0 1 .17 L1 .83 Q1 1 .9 1 L.1 1 Q0 1 0 .83 L0 .17 Q0 0 .1 0 Z',
  flowChartPredefinedProcess: `M0 0 L1 0 L1 1 L0 1 Z ${crease(0.125, 0, 0.125, 1)} ${crease(0.875, 0, 0.875, 1)}`,
  flowChartInternalStorage: `M0 0 L1 0 L1 1 L0 1 Z ${crease(0.125, 0, 0.125, 1)} ${crease(0, 0.125, 1, 0.125)}`,
  flowChartManualInput: 'M0 .2 L1 0 L1 1 L0 1 Z',
  flowChartManualOperation: 'M0 0 L1 0 L.8 1 L.2 1 Z',
  flowChartConnector: oval(0.5, 0.5, 0.5, 0.5),
  flowChartOffpageConnector: 'M0 0 L1 0 L1 .8 L.5 1 L0 .8 Z',
  flowChartPunchedCard: 'M.2 0 L1 0 L1 1 L0 1 L0 .2 Z',
  flowChartSummingJunction: `${oval(0.5, 0.5, 0.5, 0.5)} ${crease(0.146, 0.146, 0.854, 0.854)} ${crease(0.854, 0.146, 0.146, 0.854)}`,
  flowChartOr: `${oval(0.5, 0.5, 0.5, 0.5)} ${crease(0.5, 0, 0.5, 1)} ${crease(0, 0.5, 1, 0.5)}`,
  flowChartCollate: 'M0 0 L1 0 L.5 .5 Z M.5 .5 L1 1 L0 1 Z',
  flowChartSort: `M.5 0 L1 .5 L.5 1 L0 .5 Z ${crease(0, 0.5, 1, 0.5)}`,
  flowChartDelay: 'M0 0 L.5 0 A.5 .5 0 0 1 .5 1 L0 1 Z',
  flowChartDisplay: 'M0 .5 L.17 0 L.83 0 A.17 .5 0 0 1 .83 1 L.17 1 Z',
  flowChartOnlineStorage: 'M.17 0 L1 0 A.17 .5 0 0 0 1 1 L.17 1 A.17 .5 0 0 1 .17 0 Z',
  flowChartMagneticTape: `M.5 1 A.5 .5 0 1 1 .85 .86 L1 .86 L1 1 Z`,
  flowChartMagneticDrum: 'M.15 0 L.85 0 A.15 .5 0 0 1 .85 1 L.15 1 A.15 .5 0 0 1 .15 0 Z M.85 0 A.15 .5 0 0 0 .85 1 A.15 .5 0 0 0 .85 0 Z',
  flowChartMultidocument: 'M0 .2 L.86 .2 L.86 .84 C.6 .76 .5 1.04 0 .92 Z M.07 .2 L.07 .1 L.93 .1 L.93 .74 L.86 .74 M.14 .1 L.14 0 L1 0 L1 .64 L.93 .64',
  leftArrowCallout: 'M.35 0 L1 0 L1 1 L.35 1 L.35 .62 L.22 .62 L.22 .75 L0 .5 L.22 .25 L.22 .38 L.35 .38 Z',
  rightArrowCallout: 'M0 0 L.65 0 L.65 .38 L.78 .38 L.78 .25 L1 .5 L.78 .75 L.78 .62 L.65 .62 L.65 1 L0 1 Z',
  upArrowCallout: 'M0 .35 L.38 .35 L.38 .22 L.25 .22 L.5 0 L.75 .22 L.62 .22 L.62 .35 L1 .35 L1 1 L0 1 Z',
  downArrowCallout: 'M0 0 L1 0 L1 .65 L.62 .65 L.62 .78 L.75 .78 L.5 1 L.25 .78 L.38 .78 L.38 .65 L0 .65 Z',
  snip2SameRect: 'M.17 0 L.83 0 L1 .17 L1 1 L0 1 L0 .17 Z',
  snip2DiagRect: 'M0 0 L.83 0 L1 .17 L1 1 L.17 1 L0 .83 Z',
  trapezoidInv: 'M0 0 L1 0 L.75 1 L.25 1 Z',
};

/** Outline of an Office preset shape in the coordinates of its frame. null: draw a plain rectangle. */
export function presetPath(name: string, w: number, h: number): string | null {
  const m = Math.min(w, h);
  // Arrowhead length along the arrow axis and the share of the shaft thickness.
  const headX = Math.min(w * 0.5, h * 0.5) / w;
  const headY = Math.min(w * 0.5, h * 0.5) / h;
  switch (name) {
    case 'triangle':
    case 'flowChartExtract':
      return polygon([[0.5, 0], [1, 1], [0, 1]], w, h);
    case 'rtTriangle':
      return polygon([[0, 0], [1, 1], [0, 1]], w, h);
    case 'flowChartMerge':
      return polygon([[0, 0], [1, 0], [0.5, 1]], w, h);
    case 'diamond':
    case 'flowChartDecision':
      return polygon([[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]], w, h);
    case 'parallelogram':
    case 'flowChartInputOutput':
      return polygon([[0.2, 0], [1, 0], [0.8, 1], [0, 1]], w, h);
    case 'trapezoid':
      return polygon([[0.2, 0], [0.8, 0], [1, 1], [0, 1]], w, h);
    case 'pentagon':
      return regular(5, w, h);
    case 'hexagon':
    case 'flowChartPreparation':
      return polygon([[0.2, 0], [0.8, 0], [1, 0.5], [0.8, 1], [0.2, 1], [0, 0.5]], w, h);
    case 'heptagon':
      return regular(7, w, h);
    case 'octagon':
      return polygon([[0.29, 0], [0.71, 0], [1, 0.29], [1, 0.71], [0.71, 1], [0.29, 1], [0, 0.71], [0, 0.29]], w, h);
    case 'rightArrow':
      return polygon([[0, 0.25], [1 - headX, 0.25], [1 - headX, 0], [1, 0.5], [1 - headX, 1], [1 - headX, 0.75], [0, 0.75]], w, h);
    case 'leftArrow':
      return polygon([[1, 0.25], [headX, 0.25], [headX, 0], [0, 0.5], [headX, 1], [headX, 0.75], [1, 0.75]], w, h);
    case 'upArrow':
      return polygon([[0.25, 1], [0.25, headY], [0, headY], [0.5, 0], [1, headY], [0.75, headY], [0.75, 1]], w, h);
    case 'downArrow':
      return polygon([[0.25, 0], [0.25, 1 - headY], [0, 1 - headY], [0.5, 1], [1, 1 - headY], [0.75, 1 - headY], [0.75, 0]], w, h);
    case 'leftRightArrow':
      return polygon([[0, 0.5], [headX, 0], [headX, 0.25], [1 - headX, 0.25], [1 - headX, 0], [1, 0.5], [1 - headX, 1], [1 - headX, 0.75], [headX, 0.75], [headX, 1]], w, h);
    case 'upDownArrow':
      return polygon([[0.5, 0], [1, headY], [0.75, headY], [0.75, 1 - headY], [1, 1 - headY], [0.5, 1], [0, 1 - headY], [0.25, 1 - headY], [0.25, headY], [0, headY]], w, h);
    case 'chevron':
      return polygon([[0, 0], [1 - headX, 0], [1, 0.5], [1 - headX, 1], [0, 1], [headX, 0.5]], w, h);
    case 'homePlate':
      return polygon([[0, 0], [1 - headX, 0], [1, 0.5], [1 - headX, 1], [0, 1]], w, h);
    case 'plus':
      return polygon([[0.33, 0], [0.67, 0], [0.67, 0.33], [1, 0.33], [1, 0.67], [0.67, 0.67], [0.67, 1], [0.33, 1], [0.33, 0.67], [0, 0.67], [0, 0.33], [0.33, 0.33]], w, h);
    case 'star4':
      return star(4, 0.38, w, h);
    case 'star5':
      return star(5, 0.38, w, h);
    case 'star6':
      return star(6, 0.58, w, h);
    case 'star7':
      return star(7, 0.6, w, h);
    case 'star8':
      return star(8, 0.75, w, h);
    case 'star10':
      return star(10, 0.8, w, h);
    case 'star12':
      return star(12, 0.75, w, h);
    case 'star16':
    case 'star24':
    case 'star32':
    case 'irregularSeal1':
    case 'irregularSeal2':
      return star(16, 0.78, w, h);
    case 'flowChartTerminator': {
      const r = Math.min(h / 2, w / 2);
      return `M${r} 0 H${w - r} A${r} ${h / 2} 0 0 1 ${w - r} ${h} H${r} A${r} ${h / 2} 0 0 1 ${r} 0 Z`;
    }
    case 'wedgeRectCallout':
      return polygon([[0, 0], [1, 0], [1, 0.8], [0.42, 0.8], [0.2, 1], [0.25, 0.8], [0, 0.8]], w, h);
    case 'wedgeRoundRectCallout': {
      const r = m * 0.14;
      const b = h * 0.8;
      return `M${r} 0 H${w - r} Q${w} 0 ${w} ${r} V${b - r} Q${w} ${b} ${w - r} ${b} H${w * 0.42} L${w * 0.2} ${h} L${w * 0.25} ${b} H${r} Q0 ${b} 0 ${b - r} V${r} Q0 0 ${r} 0 Z`;
    }
    case 'wedgeEllipseCallout': {
      const ry = h * 0.42;
      return `M${w * 0.28} ${ry * 1.9} L${w * 0.15} ${h} L${w * 0.42} ${ry * 2} A${w / 2} ${ry} 0 1 0 ${w * 0.28} ${ry * 1.9} Z`;
    }
    case 'cloud':
    case 'cloudCallout': {
      // Cloud: several arcs along the outline.
      const p = (x: number, y: number) => `${(x * w).toFixed(1)} ${(y * h).toFixed(1)}`;
      const a = (rx: number, ry: number, x: number, y: number) => `A${(rx * w).toFixed(1)} ${(ry * h).toFixed(1)} 0 0 1 ${p(x, y)}`;
      return `M${p(0.2, 0.75)} ${a(0.16, 0.2, 0.12, 0.42)} ${a(0.16, 0.2, 0.3, 0.2)} ${a(0.17, 0.18, 0.56, 0.14)} ${a(0.16, 0.18, 0.82, 0.24)} ${a(0.15, 0.2, 0.9, 0.56)} ${a(0.16, 0.2, 0.74, 0.82)} ${a(0.17, 0.16, 0.46, 0.86)} ${a(0.16, 0.16, 0.2, 0.75)} Z`;
    }
    case 'heart': {
      const p = (x: number, y: number) => `${(x * w).toFixed(1)} ${(y * h).toFixed(1)}`;
      return `M${p(0.5, 0.28)} C${p(0.5, 0)} ${p(0, 0)} ${p(0, 0.33)} C${p(0, 0.62)} ${p(0.34, 0.8)} ${p(0.5, 1)} C${p(0.66, 0.8)} ${p(1, 0.62)} ${p(1, 0.33)} C${p(1, 0)} ${p(0.5, 0)} ${p(0.5, 0.28)} Z`;
    }
    case 'can':
    case 'flowChartMagneticDisk': {
      const ry = Math.min(h * 0.12, w * 0.25);
      return `M0 ${ry} A${w / 2} ${ry} 0 0 1 ${w} ${ry} V${h - ry} A${w / 2} ${ry} 0 0 1 0 ${h - ry} Z M0 ${ry} A${w / 2} ${ry} 0 0 0 ${w} ${ry}`;
    }
    case 'flowChartDocument':
      return `M0 0 H${w} V${h * 0.85} C${w * 0.75} ${h * 0.7} ${w * 0.6} ${h * 0.75} ${w * 0.5} ${h * 0.87} C${w * 0.35} ${h * 1.02} ${w * 0.2} ${h} 0 ${h * 0.9} Z`;
    case 'snip1Rect':
      return polygon([[0, 0], [0.84, 0], [1, 0.16], [1, 1], [0, 1]], w, h);
    case 'round1Rect':
    case 'round2SameRect':
    case 'round2DiagRect':
    case 'snipRoundRect':
      return null;
    case 'gear6':
      return unit(gear(6), w, h);
    case 'gear9':
      return unit(gear(9), w, h);
    case 'sun':
      return unit(sun(), w, h);
    case 'decagon':
      return regular(10, w, h);
    case 'dodecagon':
      return regular(12, w, h);
    default: {
      const d = UNIT_SHAPES[name];
      return d ? unit(d, w, h) : null;
    }
  }
}

export interface ShapeRenderer {
  shape(shape: SlideShape): HTMLElement;
  paras(paras: SlidePara[], parent: HTMLElement, scale: number): void;
}

export function createShapeRenderer(options: { imageUrl: (id: string | undefined) => string | undefined; labels: Labels; lang?: string }): ShapeRenderer {
  const { imageUrl, labels } = options;

  const renderRuns = (runs: Inline[], parent: HTMLElement, scale: number): void => {
    for (const run of runs) {
      if (run.k === 'br') parent.appendChild(el('br'));
      else if (run.k === 'tab') parent.appendChild(document.createTextNode('\t'));
      else if (run.k === 'text') {
        let span: HTMLElement;
        if (run.href && /^(https?:|mailto:)/i.test(run.href)) {
          const a = el('a');
          a.href = run.href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.style.color = 'inherit';
          span = a;
        } else span = el('span');
        span.textContent = run.text;
        const s = run.s;
        if (s) {
          if (s.size) span.style.fontSize = `${clamp(s.size * scale, 4, 400)}pt`;
          if (s.b) span.style.fontWeight = '700';
          if (s.i) span.style.fontStyle = 'italic';
          if (s.u) span.style.textDecoration = 'underline';
          if (s.s) span.style.textDecoration = s.u ? 'underline line-through' : 'line-through';
          if (s.color) span.style.color = s.color;
          if (s.bg) span.style.backgroundColor = s.bg;
          if (s.outline) span.style.setProperty('-webkit-text-stroke', `${Math.max(0.6, ((s.size ?? 18) * scale) / 40)}px ${s.outline}`);
          if (s.shadow) span.style.textShadow = '0.04em 0.04em 0.06em rgba(0, 0, 0, 0.45)';
          if (s.font) span.style.fontFamily = fontFamilyCss(s.font);
          if (s.caps === 'small') span.style.fontVariant = 'small-caps';
          else if (s.caps === 'all') span.style.textTransform = 'uppercase';
          if (s.ls) span.style.letterSpacing = `${s.ls * scale}pt`;
          if (s.va) span.style.verticalAlign = s.va === 'sup' ? 'super' : 'sub';
        }
        parent.appendChild(span);
      } else if (run.k === 'math') {
        const box = el('span');
        box.style.fontSize = `${clamp((run.size ?? 24) * scale, 6, 200)}pt`;
        box.appendChild(renderMath(run.node));
        parent.appendChild(box);
      }
    }
  };

  const renderParas = (paras: SlidePara[], parent: HTMLElement, scale: number): void => {
    for (const para of paras) {
      const p = el('p');
      if (para.align) p.style.textAlign = para.align;
      if (para.mt) p.style.marginTop = `${para.mt * scale}pt`;
      if (para.marker !== undefined || para.level) p.style.marginLeft = `${(para.level ?? 0) * 0.45 + (para.marker !== undefined ? 0.35 : 0)}in`;
      if (para.marker) {
        const first = para.runs.find((r) => r.k === 'text');
        const marker = el('span', 'fv-shape-marker', para.marker);
        if (first && first.k === 'text') {
          if (first.s?.size) marker.style.fontSize = `${first.s.size * scale}pt`;
          if (first.s?.color) marker.style.color = first.s.color;
        }
        if (para.markerColor) marker.style.color = para.markerColor;
        {
        }
        if (para.marker.length > 1) marker.style.width = '1.6em';
        if (para.marker.length > 1) marker.style.marginLeft = '-1.6em';
        p.appendChild(marker);
      }
      renderRuns(para.runs, p, scale);
      parent.appendChild(p);
    }
  };

  const renderCell = (cell: SlideCell, tr: HTMLElement): void => {
    if (cell.skip) return;
    const td = el('td');
    if (cell.colSpan) td.colSpan = cell.colSpan;
    if (cell.rowSpan) td.rowSpan = cell.rowSpan;
    if (cell.bg) td.style.backgroundColor = cell.bg;
    renderParas(cell.paras, td, 1);
    tr.appendChild(td);
  };

  const fillCss = (shape: SlideShape): string | undefined => {
    if (shape.gradient && shape.gradient.stops.length > 1) {
      // In Office 0° is left to right and the angle grows clockwise; in CSS 0° is bottom to top.
      return `linear-gradient(${shape.gradient.angle + 90}deg, ${shape.gradient.stops.map((s) => `${s.color} ${Math.round(s.at * 100)}%`).join(', ')})`;
    }
    return shape.fill;
  };

  const svgShape = (shape: SlideShape, d: string): SVGSVGElement => {
    const w = Math.max(shape.w, 1);
    const h = Math.max(shape.h, 1);
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('class', 'fv-shape-svg');
    let fill = shape.fill ?? 'none';
    if (shape.gradient && shape.gradient.stops.length > 1) {
      const id = `fvg${Math.random().toString(36).slice(2)}`;
      const grad = document.createElementNS(NS, 'linearGradient');
      grad.setAttribute('id', id);
      const a = (shape.gradient.angle * Math.PI) / 180;
      grad.setAttribute('x1', String(0.5 - Math.cos(a) / 2));
      grad.setAttribute('y1', String(0.5 - Math.sin(a) / 2));
      grad.setAttribute('x2', String(0.5 + Math.cos(a) / 2));
      grad.setAttribute('y2', String(0.5 + Math.sin(a) / 2));
      for (const s of shape.gradient.stops) {
        const stop = document.createElementNS(NS, 'stop');
        stop.setAttribute('offset', String(s.at));
        stop.setAttribute('stop-color', s.color);
        grad.appendChild(stop);
      }
      const defs = document.createElementNS(NS, 'defs');
      defs.appendChild(grad);
      svg.appendChild(defs);
      fill = `url(#${id})`;
    }
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill-rule', 'evenodd');
    path.setAttribute('fill', fill);
    if (shape.alpha !== undefined) path.setAttribute('fill-opacity', String(shape.alpha));
    if (shape.stroke) {
      path.setAttribute('stroke', shape.stroke);
      path.setAttribute('stroke-width', String(shape.strokeWidth ?? 1.5));
      path.setAttribute('stroke-linejoin', 'round');
      if (shape.dash) path.setAttribute('stroke-dasharray', '6 4');
    }
    svg.appendChild(path);
    return svg;
  };

  const lineShape = (shape: SlideShape): SVGSVGElement => {
    const w = Math.max(shape.w, 1);
    const h = Math.max(shape.h, 1);
    const color = shape.stroke ?? '#000000';
    const width = shape.strokeWidth ?? 2;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('class', 'fv-shape-svg');
    svg.style.overflow = 'visible';
    // The line runs from the top-left corner of the frame to the bottom-right; flips change the direction.
    let x1 = shape.flipH ? w : 0;
    let y1 = shape.flipV ? h : 0;
    let x2 = shape.flipH ? 0 : w;
    let y2 = shape.flipV ? 0 : h;
    if (shape.h < 2) y1 = y2 = h / 2;
    if (shape.w < 2) x1 = x2 = w / 2;
    // Points before the line ends: arrowheads are oriented by them.
    let nearStart: [number, number] = [x2, y2];
    let nearEnd: [number, number] = [x1, y1];
    let line: SVGElement;
    const c = shape.connector;
    if (c && shape.w >= 2 && shape.h >= 2) {
      line = document.createElementNS(NS, 'path');
      // Elbows alternate: along the width, along the height, along the width.
      const ax = (i: number) => x1 + (x2 - x1) * (c.adj?.[i] ?? 0.5);
      const ay = (i: number) => y1 + (y2 - y1) * (c.adj?.[i] ?? 0.5);
      const pts: [number, number][] = [[x1, y1]];
      if (c.elbows <= 1) pts.push([x2, y1]);
      else if (c.elbows === 2) pts.push([ax(0), y1], [ax(0), y2]);
      else if (c.elbows === 3) pts.push([ax(0), y1], [ax(0), ay(1)], [x2, ay(1)]);
      else pts.push([ax(0), y1], [ax(0), ay(1)], [ax(2), ay(1)], [ax(2), y2]);
      pts.push([x2, y2]);
      nearStart = pts[1];
      nearEnd = pts[pts.length - 2];
      let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
      if (c.kind === 'bent') for (const p of pts.slice(1)) d += ` L${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
      else {
        // A smooth line through the midpoints of the polyline segments.
        for (let i = 1; i < pts.length - 1; i++) {
          const next = i === pts.length - 2 ? pts[i + 1] : [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2];
          d += ` Q${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)} ${next[0].toFixed(1)} ${next[1].toFixed(1)}`;
        }
      }
      line.setAttribute('d', d);
      line.setAttribute('fill', 'none');
    } else {
      line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', String(x1));
      line.setAttribute('y1', String(y1));
      line.setAttribute('x2', String(x2));
      line.setAttribute('y2', String(y2));
    }
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', String(width));
    if (shape.dash) line.setAttribute('stroke-dasharray', '6 4');
    svg.appendChild(line);
    const head = (tx: number, ty: number, fx: number, fy: number) => {
      const a = Math.atan2(ty - fy, tx - fx);
      const size = Math.max(8, width * 4);
      const pt = (da: number) => `${(tx - Math.cos(a + da) * size).toFixed(1)},${(ty - Math.sin(a + da) * size).toFixed(1)}`;
      const tri = document.createElementNS(NS, 'polygon');
      tri.setAttribute('points', `${tx},${ty} ${pt(0.42)} ${pt(-0.42)}`);
      tri.setAttribute('fill', color);
      svg.appendChild(tri);
    };
    if (shape.arrowEnd) head(x2, y2, nearEnd[0], nearEnd[1]);
    if (shape.arrowStart) head(x1, y1, nearStart[0], nearStart[1]);
    return svg;
  };

  const renderShape = (shape: SlideShape): HTMLElement => {
    const box = el('div', 'fv-shape');
    box.style.left = `${shape.x}px`;
    box.style.top = `${shape.y}px`;
    box.style.width = `${Math.max(shape.w, 1)}px`;
    box.style.height = `${Math.max(shape.h, 1)}px`;
    if (shape.rot) box.style.transform = `rotate(${shape.rot}deg)`;
    if (shape.shape === 'line') {
      box.style.overflow = 'visible';
      box.appendChild(lineShape(shape));
      return box;
    }
    let path = shape.geom ? presetPath(shape.geom, Math.max(shape.w, 1), Math.max(shape.h, 1)) : null;
    if (shape.path) {
      // Outline coordinates are fractions of the frame: even numbers along the width, odd along the height.
      let d = '';
      let k = 0;
      for (const item of shape.path) {
        if (typeof item === 'string') {
          d += `${item} `;
          k = 0;
        } else d += `${(item * (k++ % 2 ? Math.max(shape.h, 1) : Math.max(shape.w, 1))).toFixed(1)} `;
      }
      path = d;
    }
    if (path) {
      const svg = svgShape(shape, path);
      if (shape.flipH || shape.flipV) svg.style.transform = `scale(${shape.flipH ? -1 : 1}, ${shape.flipV ? -1 : 1})`;
      if (shape.shadow) svg.style.filter = 'drop-shadow(3px 3px 3px rgba(0, 0, 0, 0.35))';
      box.style.overflow = 'visible';
      box.appendChild(svg);
    } else {
      const fill = fillCss(shape);
      if (fill) {
        if (shape.alpha !== undefined && shape.fill && !shape.gradient) {
          const n = parseInt(shape.fill.slice(1), 16);
          box.style.background = `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${shape.alpha})`;
        } else box.style.background = fill;
      }
      if (shape.stroke) box.style.border = `${shape.strokeWidth ?? 1.5}px ${shape.dash ? 'dashed' : 'solid'} ${shape.stroke}`;
      if (shape.shape === 'ellipse') box.style.borderRadius = '50%';
      else if (shape.shape === 'round') box.style.borderRadius = `${Math.min(shape.w, shape.h) * 0.16}px`;
      if (shape.shadow) box.style.boxShadow = '3px 3px 6px rgba(0, 0, 0, 0.35)';
    }

    const url = imageUrl(shape.img);
    if (url) {
      const img = el('img', 'fv-shape-img');
      img.src = url;
      img.alt = '';
      img.draggable = false;
      img.decoding = 'async';
      if (shape.crop) {
        // Cropping: the picture is larger than the frame and shifted so that the wanted part stays in the frame.
        const { l, t, r, b } = shape.crop;
        const kx = 1 / Math.max(0.02, 1 - l - r);
        const ky = 1 / Math.max(0.02, 1 - t - b);
        img.style.width = `${kx * 100}%`;
        img.style.height = `${ky * 100}%`;
        img.style.left = `${-l * kx * 100}%`;
        img.style.top = `${-t * ky * 100}%`;
        img.style.objectFit = 'fill';
        img.style.maxWidth = 'none';
        box.style.overflow = 'hidden';
      }
      if (shape.flipH || shape.flipV) img.style.transform = `scale(${shape.flipH ? -1 : 1}, ${shape.flipV ? -1 : 1})`;
      box.appendChild(img);
    }
    if (shape.chart) {
      box.style.background = '#ffffff';
      box.appendChild(renderChart(shape.chart, Math.max(160, Math.round(shape.w)), Math.max(110, Math.round(shape.h)), options.lang));
    } else if (shape.placeholder) {
      box.appendChild(el('div', 'fv-shape-note', shape.placeholder === 'chart' ? labels.chart : labels.object));
    }
    if (shape.table) {
      const table = el('table');
      const group = el('colgroup');
      for (const w of shape.table.widths) {
        const col = el('col');
        col.style.width = `${w}px`;
        group.appendChild(col);
      }
      table.appendChild(group);
      const tbody = el('tbody');
      for (const row of shape.table.rows) {
        const tr = el('tr');
        for (const cell of row) renderCell(cell, tr);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      box.appendChild(table);
    }
    if (shape.paras) {
      const text = el('div', 'fv-shape-text');
      text.style.justifyContent = shape.anchor === 'middle' ? 'center' : shape.anchor === 'bottom' ? 'flex-end' : 'flex-start';
      if (shape.textRot) {
        // Vertical text: the text is set in a rotated frame with swapped sides.
        text.style.inset = 'auto';
        text.style.width = `${Math.max(shape.h, 1)}px`;
        text.style.height = `${Math.max(shape.w, 1)}px`;
        text.style.left = `${(shape.w - shape.h) / 2}px`;
        text.style.top = `${(shape.h - shape.w) / 2}px`;
        text.style.transform = `rotate(${shape.textRot}deg)`;
      }
      renderParas(shape.paras, text, shape.fontScale ?? 1);
      box.appendChild(text);
    }
    return box;
  };

  return { shape: renderShape, paras: renderParas };
}
