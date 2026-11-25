/** Equation rendering: fractions, powers, roots and sum signs are built from nested blocks. */
import type { MathNode } from '../core/docmodel';
import { el } from './types';

function render(node: MathNode): HTMLElement {
  switch (node.t) {
    case 'text': {
      const span = el('span', node.upright ? 'fv-math-up' : 'fv-math-t', node.v);
      return span;
    }
    case 'row': {
      const row = el('span', 'fv-math-row');
      for (const item of node.items) row.appendChild(render(item));
      return row;
    }
    case 'frac': {
      const frac = el('span', 'fv-math-frac');
      const num = el('span', 'fv-math-num');
      num.appendChild(render(node.num));
      const den = el('span', 'fv-math-den');
      den.appendChild(render(node.den));
      frac.append(num, den);
      return frac;
    }
    case 'script': {
      const row = el('span', 'fv-math-row');
      row.appendChild(render(node.base));
      const scripts = el('span', 'fv-math-scripts');
      const sup = el('span', 'fv-math-sup');
      if (node.sup) sup.appendChild(render(node.sup));
      const sub = el('span', 'fv-math-sub');
      if (node.sub) sub.appendChild(render(node.sub));
      scripts.append(sup, sub);
      row.appendChild(scripts);
      return row;
    }
    case 'rad': {
      const row = el('span', 'fv-math-row');
      if (node.deg) {
        const deg = el('span', 'fv-math-deg');
        deg.appendChild(render(node.deg));
        row.appendChild(deg);
      }
      // The radical sign is drawn as a line and stretches to the height of the radicand: the "√" glyph sits at
      // a different height in different fonts and does not join the bar.
      const sign = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      sign.setAttribute('viewBox', '0 0 10 20');
      sign.setAttribute('preserveAspectRatio', 'none');
      sign.setAttribute('class', 'fv-math-radsign');
      const stroke = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      stroke.setAttribute('d', 'M0.5 12 L3 11 L6 19.5 L10 0.5');
      stroke.setAttribute('fill', 'none');
      stroke.setAttribute('stroke', 'currentColor');
      stroke.setAttribute('stroke-width', '1.1');
      stroke.setAttribute('vector-effect', 'non-scaling-stroke');
      sign.appendChild(stroke);
      row.style.alignItems = 'stretch';
      row.appendChild(sign);
      const body = el('span', 'fv-math-radbody');
      body.appendChild(render(node.e));
      row.appendChild(body);
      return row;
    }
    case 'nary': {
      const row = el('span', 'fv-math-row');
      const op = el('span', 'fv-math-nary');
      const sup = el('span', 'fv-math-lim');
      if (node.sup) sup.appendChild(render(node.sup));
      const sub = el('span', 'fv-math-lim');
      if (node.sub) sub.appendChild(render(node.sub));
      op.append(sup, el('span', 'fv-math-op', node.chr), sub);
      row.append(op, render(node.e));
      return row;
    }
    case 'delim': {
      const row = el('span', 'fv-math-row');
      if (node.open) row.appendChild(el('span', 'fv-math-paren', node.open));
      node.items.forEach((item, i) => {
        if (i && node.sep) row.appendChild(el('span', 'fv-math-up', node.sep));
        row.appendChild(render(item));
      });
      if (node.close) row.appendChild(el('span', 'fv-math-paren', node.close));
      return row;
    }
    case 'over': {
      const wrap = el('span', node.mark === '¯' ? 'fv-math-bar' : 'fv-math-acc');
      if (node.mark !== '¯') wrap.appendChild(el('span', 'fv-math-accmark', node.mark));
      wrap.appendChild(render(node.e));
      return wrap;
    }
    case 'lim': {
      const wrap = el('span', 'fv-math-nary');
      const lim = el('span', 'fv-math-lim');
      lim.appendChild(render(node.lim));
      if (node.upper) wrap.append(lim, render(node.e));
      else wrap.append(render(node.e), lim);
      return wrap;
    }
    case 'matrix': {
      const table = el('span', 'fv-math-matrix');
      table.style.gridTemplateColumns = `repeat(${Math.max(1, ...node.rows.map((r) => r.length))}, auto)`;
      for (const row of node.rows) for (const cell of row) table.appendChild(render(cell));
      return table;
    }
  }
}

export function renderMath(node: MathNode): HTMLElement {
  const root = el('span', 'fv-math');
  root.appendChild(render(node));
  return root;
}
