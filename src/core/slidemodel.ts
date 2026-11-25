/**
 * Common model of a presentation for pptx, odp and ppt.
 * A slide is a fixed-size canvas with absolutely positioned objects.
 * Coordinates and sizes are pixels at 96 dots per inch, font sizes are points.
 */
import type { ChartModel } from './chart';
import type { DocImage, Inline } from './docmodel';

export interface SlidePara {
  runs: Inline[];
  align?: 'left' | 'center' | 'right' | 'justify';
  marker?: string;
  /** Colour of the marker, if it differs from the text. */
  markerColor?: string;
  level?: number;
  /** Space before the paragraph in points. */
  mt?: number;
}

export interface SlideCell {
  paras: SlidePara[];
  bg?: string;
  colSpan?: number;
  rowSpan?: number;
  skip?: boolean;
}

export interface SlideShape {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Rotation in degrees. */
  rot?: number;
  fill?: string;
  stroke?: string;
  shape?: 'rect' | 'round' | 'ellipse' | 'line';
  /** Name of an Office preset shape (triangle, rightArrow, star5, …): the outline is drawn from it. */
  geom?: string;
  /** Freeform outline: M, L, C, Z commands with coordinates as fractions of the shape frame (0–1). */
  path?: (string | number)[];
  /** Gradient fill: angle in degrees and colour stops (position 0–1). */
  gradient?: { angle: number; stops: { at: number; color: string }[] };
  /** Fill opacity 0–1. */
  alpha?: number;
  /** Outline width in pixels and dashed outline. */
  strokeWidth?: number;
  dash?: boolean;
  shadow?: boolean;
  flipH?: boolean;
  flipV?: boolean;
  /** Arrowheads at the line ends. */
  /** Elbow or curved connector: number of elbows and their positions as fractions of the frame (width, height, width). */
  connector?: { kind: 'bent' | 'curved'; elbows: number; adj?: number[] };
  arrowStart?: boolean;
  arrowEnd?: boolean;
  /** Picture cropping: fractions cut off each side. */
  crop?: { l: number; t: number; r: number; b: number };
  /** The text is rotated: 90 is top to bottom, 270 is bottom to top. */
  textRot?: 90 | 270;
  chart?: ChartModel;
  img?: string;
  paras?: SlidePara[];
  anchor?: 'top' | 'middle' | 'bottom';
  /** Table: rows of cells and column widths in pixels. */
  table?: { rows: SlideCell[][]; widths: number[] };
  /** An object that cannot be shown: a frame with a caption is output. */
  placeholder?: string;
  /** The text must not overflow the frame: font shrink as a fraction of one (from the file). */
  fontScale?: number;
}

export interface Slide {
  bg?: string;
  bgGradient?: SlideShape['gradient'];
  bgImg?: string;
  shapes: SlideShape[];
}

export interface SlidesModel {
  width: number;
  height: number;
  slides: Slide[];
  images: Record<string, DocImage>;
  /** true: only the slide text is known, without object positions (legacy ppt). */
  outline?: boolean;
}
