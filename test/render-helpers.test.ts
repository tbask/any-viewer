import { describe, expect, it } from 'vitest';
import { splitIntoChunks } from '../src/renderers/text';
import { columnName } from '../src/renderers/grid';

describe('splitting text into blocks', () => {
  it('joining the blocks restores the source text', () => {
    const text = Array.from({ length: 2000 }, (_, i) => `строка ${i}`).join('\n');
    const chunks = splitIntoChunks(text);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.join('\n')).toBe(text);
  });
  it('empty lines at a block boundary are not lost', () => {
    const text = 'a\n'.repeat(299) + '\n\n\nb';
    expect(splitIntoChunks(text).join('\n')).toBe(text);
  });
  it('an overlong line is cut by force', () => {
    const text = 'x'.repeat(500_000);
    const chunks = splitIntoChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(text);
  });
  it('empty text', () => {
    expect(splitIntoChunks('')).toEqual([]);
  });
});

describe('column names', () => {
  it('as in spreadsheets', () => {
    expect([0, 25, 26, 27, 701, 702, 16383].map(columnName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA', 'XFD']);
  });
});
