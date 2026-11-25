/**
 * Features added after the independent review of 0.7.0: hidden paragraphs in odt, chapter numbering, frames,
 * text effects, nested RTF tables, tab leaders, symbol font bullets, MathML formulas, freeform outlines,
 * preset shapes, spreadsheet patterns.
 */
import { describe, expect, it } from 'vitest';
import { bytes, makeZip } from './helpers';
import { parseOdt } from '../src/formats/odt';
import { parseRtf } from '../src/formats/rtf';
import { parseMathMl } from '../src/formats/mathml';
import { custGeomPath } from '../src/formats/drawingml';
import { isPlainRectPath } from '../src/formats/odf-draw';
import { patternCss } from '../src/formats/xlsx';
import { parseXml } from '../src/core/xml';
import { isSymbolFont, symbolChar } from '../src/core/symbols';
import { presetPath } from '../src/renderers/shapes';
import { formatSize } from '../src/renderers/archive';
import { resolveLabels, LABELS_EN, LABELS_RU } from '../src/labels';
import type { Block, DocModel } from '../src/core/docmodel';

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"';

function odt(body: string, automatic = '', styles = ''): Blob {
  const content = `<?xml version="1.0"?><office:document-content ${NS}><office:automatic-styles>${automatic}</office:automatic-styles><office:body><office:text>${body}</office:text></office:body></office:document-content>`;
  const stylesXml = `<?xml version="1.0"?><office:document-styles ${NS}><office:styles>${styles}</office:styles></office:document-styles>`;
  return new Blob([makeZip([{ name: 'mimetype', data: bytes('application/vnd.oasis.opendocument.text') }, { name: 'content.xml', data: bytes(content) }, { name: 'styles.xml', data: bytes(stylesXml) }]) as BlobPart]);
}
const texts = (m: DocModel): string[] => m.blocks.map((b) => (b.k === 'p' ? `${b.marker ? `${b.marker} ` : ''}${b.runs.map((r) => (r.k === 'text' ? r.text : '')).join('')}` : `<${b.k}>`));
const para = (b: Block | undefined) => {
  if (!b || b.k !== 'p') throw new Error('not a paragraph');
  return b;
};

describe('odt: hidden content, chapter numbering, frames, effects', () => {
  it('a paragraph hidden by a field and a hidden section are not shown', async () => {
    const m = await parseOdt(
      odt(
        '<text:p>visible</text:p>' +
          '<text:p>SECRET-PARA<text:hidden-paragraph text:condition="ooow:1" text:is-hidden="true"/></text:p>' +
          '<text:p>shown<text:hidden-paragraph text:condition="ooow:0" text:is-hidden="false"/></text:p>' +
          '<text:section text:name="s1" text:display="none"><text:p>SECRET-SECTION</text:p></text:section>' +
          '<text:section text:name="s2" text:display="condition" text:is-hidden="true"><text:p>SECRET-CONDITION</text:p></text:section>' +
          '<text:p>a<text:hidden-text text:condition="ooow:1" text:string-value="SECRET-TEXT" text:is-hidden="true"/>b</text:p>',
      ),
    );
    expect(texts(m)).toEqual(['visible', 'shown', 'ab']);
  });

  it('headings are numbered by the outline style', async () => {
    const outline =
      '<text:outline-style style:name="Outline"><text:outline-level-style text:level="1" style:num-format="1" style:num-suffix="."/>' +
      '<text:outline-level-style text:level="2" style:num-format="1" style:num-suffix="." text:display-levels="2"/></text:outline-style>';
    const m = await parseOdt(odt('<text:h text:outline-level="1">A</text:h><text:h text:outline-level="2">B</text:h><text:h text:outline-level="2">C</text:h><text:h text:outline-level="1">D</text:h>', '', outline));
    expect(texts(m)).toEqual(['1. A', '1.1. B', '1.2. C', '2. D']);
  });

  it('a frame becomes a floated block with its background and border; character effects are kept', async () => {
    const automatic =
      '<style:style style:name="fr1" style:family="graphic"><style:graphic-properties style:horizontal-pos="right" fo:background-color="#fef3c7" fo:border="0.99pt solid #b45309"/></style:style>' +
      '<style:style style:name="T1" style:family="text"><style:text-properties fo:font-variant="small-caps" fo:letter-spacing="2pt" style:text-scale="150%" fo:text-shadow="1pt 1pt"/></style:style>' +
      '<style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:border="1pt solid #1d4ed8"><style:drop-cap style:lines="3"/></style:paragraph-properties></style:style>';
    const m = await parseOdt(
      odt(
        '<text:p><draw:frame draw:style-name="fr1" text:anchor-type="paragraph" svg:width="2in"><draw:text-box><text:p>in frame</text:p></draw:text-box></draw:frame>around</text:p>' +
          '<text:p text:style-name="P1"><text:span text:style-name="T1">effects</text:span></text:p>',
        automatic,
      ),
    );
    const frame = m.blocks[0];
    expect(frame).toMatchObject({ k: 'frame', float: 'right', bg: '#fef3c7', border: '1px solid #b45309', w: 144 });
    const p = para(m.blocks[2]);
    expect(p.s).toMatchObject({ border: '#1d4ed8', dropCap: { lines: 3, chars: 1 } });
    expect(p.runs[0]).toMatchObject({ s: { caps: 'small', ls: 2, scale: 1.5, shadow: 1 } });
  });
});

describe('rtf: nested tables, paragraph look, tabs, footnotes written by LibreOffice', () => {
  const rtf = (body: string) => parseRtf(bytes(`{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}{\\f1\\fcharset2 Wingdings;}}{\\colortbl;\\red255\\green242\\blue204;\\red0\\green0\\blue255;}${body}}`));

  it('a table inside a cell stays a table', () => {
    const m = rtf(
      '\\trowd\\cellx3000\\cellx6000\\pard\\intbl outer\\cell\\pard\\intbl\\itap2 a\\nestcell{\\nonesttables\\par}b\\nestcell{\\nonesttables\\par}' +
        '{\\*\\nesttableprops\\trowd\\cellx1000\\cellx2000\\nestrow}\\pard\\intbl\\itap2 c\\nestcell d\\nestcell{\\*\\nesttableprops\\trowd\\cellx1000\\cellx2000\\nestrow}\\pard\\intbl\\itap1\\cell\\row\\pard after\\par',
    );
    const table = m.blocks[0];
    if (table.k !== 'table') throw new Error('expected a table');
    expect(table.rows[0].cells).toHaveLength(2);
    const inner = table.rows[0].cells[1].blocks.find((b) => b.k === 'table');
    if (!inner || inner.k !== 'table') throw new Error('expected a nested table');
    expect(inner.rows.map((r) => r.cells.map((c) => texts({ blocks: c.blocks, images: {} }).join('')))).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('shading, border, capitals, spacing, tab stop with a leader and a drop cap', () => {
    const m = rtf(
      '\\pard\\brdrt\\brdrs\\brdrl\\brdrs\\brdrb\\brdrs\\brdrr\\brdrs\\brdrcf2\\cbpat1 boxed\\par' +
        '\\pard\\tqr\\tldot\\tx8000 {\\scaps small}{\\caps all}{\\expndtw40 wide}\\tab 5\\par' +
        '\\pard\\dropcapli3 D\\par\\pard rop cap\\par',
    );
    expect(para(m.blocks[0]).s).toMatchObject({ bg: '#fff2cc', border: '#0000ff' });
    const second = para(m.blocks[1]);
    expect(second.s?.tabs).toEqual([{ pos: 400, align: 'right', leader: '.' }]);
    // Character properties set inside a group end with the group.
    expect(second.runs.map((r) => (r.k === 'text' ? [r.text, r.s?.caps, r.s?.ls] : r.k))).toEqual([['small', 'small', undefined], ['all', 'all', undefined], ['wide', undefined, 2], 'tab', ['5', undefined, undefined]]);
    const third = para(m.blocks[2]);
    expect(texts({ blocks: [third], images: {} })).toEqual(['Drop cap']);
    expect(third.s?.dropCap).toEqual({ lines: 3, chars: 1 });
  });

  it('footnotes in an optional group and symbol font characters', () => {
    const m = parseRtf(bytes('{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}{\\f1\\fcharset2 Wingdings;}}text{\\super\\chftn{\\*\\footnote\\chftn note body}}\\par{\\f1\\u-3844 ?} done\\par}'), { labels: { footnotes: 'Footnotes' } });
    const all = texts(m).join('|');
    expect(all).toContain('note body');
    expect(all).toContain('✔ done');
  });
});

describe('symbols, formulas, outlines', () => {
  it('symbol font characters are mapped, real Unicode is kept', () => {
    expect(symbolChar('Wingdings', '')).toBe('✔');
    expect(symbolChar('Wingdings 3', '')).toBe('▶');
    expect(symbolChar('Symbol', '')).toBe('•');
    expect(symbolChar('Wingdings 3', '✔')).toBe('✔');
    expect(symbolChar('Arial', 'A')).toBe('A•');
    expect(isSymbolFont('Wingdings 2')).toBe(true);
    expect(isSymbolFont('Calibri')).toBe(false);
  });

  it('MathML: fraction, root, scripts, sum, matrix', () => {
    const math = parseMathMl(
      parseXml(
        '<math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>x</mi><mo>=</mo><mfrac><mrow><mo>-</mo><mi>b</mi></mrow><msqrt><msup><mi>b</mi><mn>2</mn></msup></msqrt></mfrac>' +
          '<munderover><mo>∑</mo><mi>i</mi><mi>n</mi></munderover><mtable><mtr><mtd><mn>1</mn></mtd><mtd><mn>2</mn></mtd></mtr></mtable></mrow><annotation encoding="StarMath 5.0">ignored</annotation></semantics></math>',
      ),
    );
    const json = JSON.stringify(math);
    expect(json).toContain('"t":"frac"');
    expect(json).toContain('"t":"rad"');
    expect(json).toContain('"t":"script"');
    expect(json).toContain('"t":"nary","chr":"∑"');
    expect(json).toContain('"t":"matrix"');
    expect(json).not.toContain('ignored');
    expect(parseMathMl(parseXml('<svg/>'))).toBeUndefined();
  });

  it('freeform DrawingML outline: lines, curves and an arc', () => {
    const spPr = parseXml(
      '<p:spPr xmlns:p="p" xmlns:a="a"><a:custGeom><a:pathLst><a:path w="200" h="100"><a:moveTo><a:pt x="100" y="0"/></a:moveTo><a:lnTo><a:pt x="200" y="100"/></a:lnTo>' +
        '<a:arcTo wR="100" hR="50" stAng="0" swAng="5400000"/><a:close/></a:path></a:pathLst></a:custGeom></p:spPr>',
    );
    const path = custGeomPath(spPr)!;
    expect(path.slice(0, 6)).toEqual(['M', 0.5, 0, 'L', 1, 1]);
    expect(path.filter((t) => t === 'C')).toHaveLength(1);
    expect(path[path.length - 1]).toBe('Z');
    // A guide name instead of a number: the outline cannot be built.
    expect(custGeomPath(parseXml('<p:spPr xmlns:p="p" xmlns:a="a"><a:custGeom><a:pathLst><a:path w="10" h="10"><a:moveTo><a:pt x="hc" y="0"/></a:moveTo></a:path></a:pathLst></a:custGeom></p:spPr>'))).toBeUndefined();
  });

  it('a right triangle on the unit square is not a plain rectangle', () => {
    expect(isPlainRectPath(['M', 0, 1, 'L', 1, 0, 'L', 1, 1, 'Z'])).toBe(false);
    expect(isPlainRectPath(['M', 0, 0, 'L', 1, 0, 'L', 1, 1, 'L', 0, 1, 'Z'])).toBe(true);
  });

  it('preset shapes of the second review document have outlines', () => {
    for (const name of ['lightningBolt', 'moon', 'sun', 'gear6', 'smileyFace', 'donut', 'noSmoking', 'frame', 'bevel', 'cube', 'foldedCorner', 'teardrop', 'wave', 'heart', 'cloud', 'can']) {
      const d = presetPath(name, 120, 100);
      expect(d, name).toBeTruthy();
      expect(d!, name).not.toMatch(/NaN|undefined/);
    }
    expect(presetPath('frame', 100, 100)).toBe('M0 0 L100 0 L100 100 L0 100 ZM12.5 12.5 L12.5 87.5 L87.5 87.5 L87.5 12.5 Z');
    expect(presetPath('noSuchShape', 10, 10)).toBeNull();
  });
});

describe('spreadsheets and interface', () => {
  it('fill patterns become CSS backgrounds', () => {
    expect(patternCss('darkGrid', '#0070c0')).toContain('repeating-linear-gradient(0deg, #0070c0');
    expect(patternCss('gray125', '#000000')).toBe('linear-gradient(#00000020, #00000020)');
  });

  it('file sizes and labels follow the interface language', () => {
    expect(formatSize(2970)).toBe('2.9 KB');
    expect(formatSize(2970, LABELS_RU.sizeUnits, LABELS_RU.decimalSeparator)).toBe('2,9 КБ');
    expect(resolveLabels('ru-RU')).toBe(LABELS_RU);
    expect(resolveLabels('kk-KZ')).toBe(LABELS_EN);
    expect(resolveLabels('en')).toBe(LABELS_EN);
  });
});
