/** Preset shape types of the legacy format → names of outlines the viewer can draw. */
export const LEGACY_SHAPE_TYPES: Record<number, string> = {
  4: 'diamond', 5: 'triangle', 6: 'rtTriangle', 7: 'parallelogram', 8: 'trapezoid', 9: 'hexagon', 10: 'octagon', 11: 'plus', 12: 'star5',
  13: 'rightArrow', 15: 'homePlate', 55: 'chevron', 56: 'pentagon', 58: 'star8', 59: 'star16', 60: 'star32', 61: 'wedgeRectCallout',
  62: 'wedgeRoundRectCallout', 63: 'wedgeEllipseCallout', 66: 'leftArrow', 67: 'downArrow', 68: 'upArrow', 69: 'leftRightArrow',
  70: 'upDownArrow', 74: 'heart', 92: 'star24', 106: 'cloudCallout', 110: 'flowChartDecision', 111: 'flowChartInputOutput',
  114: 'flowChartDocument', 116: 'flowChartTerminator', 117: 'flowChartPreparation', 127: 'flowChartExtract', 128: 'flowChartMerge',
  132: 'flowChartMagneticDisk', 22: 'can', 187: 'star4', 235: 'star6', 236: 'star7', 237: 'star10', 238: 'star12',
};

/**
 * Freeform outline of a legacy-format shape (doc, ppt): an array of vertices and a description of the segments between them.
 * geo is the bounds of the outline's coordinate system (left, top, right, bottom). The result is in fractions of the shape frame.
 */
export function customShapePath(raw: Uint8Array | undefined, segments: Uint8Array | undefined, geo: (number | undefined)[]): (string | number)[] | undefined {
  if (!raw || raw.length < 6) return undefined;
  const rv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const count = rv.getUint16(0, true);
  const size = rv.getUint16(4, true) === 0xfff0 ? 4 : rv.getUint16(4, true);
  if ((size !== 4 && size !== 8) || 6 + count * size > raw.length || count < 2 || count > 5000) return undefined;
  const left = (geo[0] ?? 0) | 0;
  const top = (geo[1] ?? 0) | 0;
  const w = (((geo[2] ?? 21600) | 0) - left) || 21600;
  const h = (((geo[3] ?? 21600) | 0) - top) || 21600;
  const points: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * size;
    // A coordinate that refers to a formula: the outline cannot be built without evaluating formulas.
    if (size === 8 && (rv.getUint32(at, true) >>> 16 === 0x8000 || rv.getUint32(at + 4, true) >>> 16 === 0x8000)) return undefined;
    points.push(size === 4 ? [(rv.getInt16(at, true) - left) / w, (rv.getInt16(at + 2, true) - top) / h] : [(rv.getInt32(at, true) - left) / w, (rv.getInt32(at + 4, true) - top) / h]);
  }
  const out: (string | number)[] = [];
  if (segments && segments.length >= 8) {
    const sv = new DataView(segments.buffer, segments.byteOffset, segments.byteLength);
    const n = sv.getUint16(0, true);
    const step = sv.getUint16(4, true) === 0xfff0 ? 2 : sv.getUint16(4, true);
    let next = 0;
    const take = () => points[Math.min(next++, points.length - 1)];
    for (let i = 0; i < n && 6 + i * step + 2 <= segments.length; i++) {
      const code = sv.getUint16(6 + i * step, true);
      const kind = code >> 13;
      const repeat = Math.max(1, code & 0x1fff);
      if (kind === 2) out.push('M', ...take());
      else if (kind === 0) for (let k = 0; k < repeat && next < points.length; k++) out.push('L', ...take());
      else if (kind === 1) for (let k = 0; k < repeat && next + 2 < points.length + 1; k++) out.push('C', ...take(), ...take(), ...take());
      else if (kind === 3) out.push('Z');
      else if (kind === 4) break;
      // Other codes (arcs, service ones) do not change the outline materially: skipped.
    }
  }
  if (out.length < 6) {
    out.length = 0;
    points.forEach((pt, i) => out.push(i ? 'L' : 'M', ...pt));
    out.push('Z');
  }
  return out;
}
