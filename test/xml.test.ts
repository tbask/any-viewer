import { describe, expect, it } from 'vitest';
import { attr, child, childrenOf, decodeEntities, decodeXmlBytes, localName, parseXml, parseXmlSax, textContent, XmlError } from '../src/core/xml';

describe('parseXml', () => {
  it('parses elements, attributes and text', () => {
    const root = parseXml(`<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://example/w">
  <w:body>
    <w:p w:id='1'><w:r><w:t xml:space="preserve">Привет, </w:t></w:r><w:r><w:t>мир</w:t></w:r></w:p>
    <w:p w:id="2"/>
  </w:body>
</w:document>`);
    expect(root.name).toBe('w:document');
    const body = child(root, 'body')!;
    const ps = childrenOf(body, 'p');
    expect(ps).toHaveLength(2);
    expect(attr(ps[0], 'id')).toBe('1');
    expect(textContent(ps[0])).toBe('Привет, мир');
    expect(textContent(ps[0].children[0])).toBe('Привет, ');
    expect(textContent(body).replace(/\s+/g, ' ').trim()).toBe('Привет, мир');
    expect(ps[1].children).toHaveLength(0);
    expect(localName('w:p')).toBe('p');
  });

  it('handles entities, CDATA, comments and DOCTYPE', () => {
    const root = parseXml(`<!DOCTYPE r [ <!ENTITY x "y"> ]><r a="1 &lt; 2 &amp; &quot;q&quot;"><!-- c --><![CDATA[<raw> & ]]>&#1055;&#x440;&amp;&unknown;</r>`);
    expect(attr(root, 'a')).toBe('1 < 2 & "q"');
    expect(textContent(root)).toBe('<raw> & Пр&&unknown;');
  });

  it('keeps the order of mixed content', () => {
    const root = parseXml('<p>a<b>b</b>c<i/>d</p>');
    expect(root.children.map((c) => (c.name === '#text' ? c.text : `<${c.name}>`))).toEqual(['a', '<b>', 'c', '<i>', 'd']);
  });

  it('allows > in an attribute value and a BOM', () => {
    const root = parseXml('﻿<a x="1>2" y = \'it"s\' />');
    expect(root.attrs).toEqual({ x: '1>2', y: 'it"s' });
  });

  it('reports errors', () => {
    expect(() => parseXml('<a><b></a>')).toThrow(XmlError);
    expect(() => parseXml('<a>')).toThrow(XmlError);
    expect(() => parseXml('<a x=1/>')).toThrow(XmlError);
    expect(() => parseXml('<a><!-- oops </a>')).toThrow(XmlError);
    expect(() => parseXml('   ')).toThrow(XmlError);
  });

  it('does not expand entities declared in a DTD (billion laughs guard)', () => {
    const root = parseXml('<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><lolz>&lol2;</lolz>');
    expect(textContent(root)).toBe('&lol2;');
  });
});

describe('parseXmlSax', () => {
  it('emits events in reading order', () => {
    const events: string[] = [];
    parseXmlSax('<a><b k="v"/>t</a>', {
      open: (n, a, s) => events.push(`+${n}${s ? '/' : ''}${a.k ? ':' + a.k : ''}`),
      close: (n) => events.push(`-${n}`),
      text: (t) => events.push(`"${t}"`),
    });
    expect(events).toEqual(['+a', '+b/:v', '-b', '"t"', '-a']);
  });

  it('copes with a large document', () => {
    const xml = '<rows>' + Array.from({ length: 50_000 }, (_, i) => `<c r="${i}"><v>${i}</v></c>`).join('') + '</rows>';
    let sum = 0;
    let inV = false;
    parseXmlSax(xml, { open: (n) => (inV = n === 'v'), close: () => (inV = false), text: (t) => inV && (sum += Number(t)) });
    expect(sum).toBe((49_999 * 50_000) / 2);
  });
});

describe('helper functions', () => {
  it('decodeEntities', () => {
    expect(decodeEntities('a &amp; b &#65;&#x42; &apos;')).toBe("a & b AB '");
    expect(decodeEntities('без сущностей')).toBe('без сущностей');
    expect(decodeEntities('&#0; &#x110000;')).toBe('&#0; &#x110000;');
  });
  it('decodeXmlBytes honours the encoding', () => {
    const utf16 = new Uint8Array([0xff, 0xfe, ...new Uint8Array(new Uint16Array([...'<a>я</a>'].map((c) => c.charCodeAt(0))).buffer)]);
    expect(decodeXmlBytes(utf16)).toBe('<a>я</a>');
    const cp1251 = new Uint8Array([...new TextEncoder().encode('<?xml version="1.0" encoding="windows-1251"?><a>'), 0xff, ...new TextEncoder().encode('</a>')]);
    expect(decodeXmlBytes(cp1251)).toContain('<a>я</a>');
  });
});
