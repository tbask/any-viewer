import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ZipReader, ZipError, crc32 } from '../src/core/zip';
import { inflateRaw, InflateError } from '../src/core/inflate';
import { bytes, makeZip } from './helpers';

function randomBytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = s >>> 16;
  }
  return out;
}

describe('crc32', () => {
  it('matches the reference value', () => {
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('inflateRaw (own implementation)', () => {
  const cases: Record<string, Uint8Array> = {
    'empty input': new Uint8Array(0),
    'short text': bytes('hello hello hello hello'),
    'repeating text': bytes('Привет, мир! '.repeat(5000)),
    'random data': randomBytes(100_000),
    'mixed data': new Uint8Array([...randomBytes(3000, 7), ...bytes('abc'.repeat(4000)), ...randomBytes(3000, 9)]),
    'long runs of zeros': new Uint8Array(300_000),
  };
  for (const [name, data] of Object.entries(cases)) {
    for (const level of [0, 1, 6, 9]) {
      it(`${name}, level ${level}`, () => {
        const packed = new Uint8Array(deflateRawSync(data, { level }));
        expect(inflateRaw(packed)).toEqual(data);
        expect(inflateRaw(packed, data.length)).toEqual(data);
      });
    }
  }
  it('fixed Huffman codes', () => {
    const data = bytes('fixed huffman block test');
    const packed = new Uint8Array(deflateRawSync(data, { strategy: 4 /* Z_FIXED */ }));
    expect(inflateRaw(packed)).toEqual(data);
  });
  it('rejects a truncated stream', () => {
    const packed = new Uint8Array(deflateRawSync(bytes('x'.repeat(1000) + 'yz'.repeat(500))));
    expect(() => inflateRaw(packed.subarray(0, packed.length - 3))).toThrow(InflateError);
  });
  it('respects the size limit', () => {
    const packed = new Uint8Array(deflateRawSync(new Uint8Array(1_000_000)));
    expect(() => inflateRaw(packed, undefined, 1000)).toThrow(InflateError);
  });
});

describe('ZipReader', () => {
  const files = [
    { name: 'mimetype', data: bytes('application/vnd.oasis.opendocument.text'), store: true },
    { name: 'word/document.xml', data: bytes('<doc>' + 'текст '.repeat(2000) + '</doc>') },
    { name: 'папка/файл.bin', data: randomBytes(50_000, 3) },
    { name: 'empty.txt', data: new Uint8Array(0) },
    { name: 'dir/', data: new Uint8Array(0), store: true },
  ];

  for (const forceJsInflate of [false, true]) {
    it(`reads entries (${forceJsInflate ? 'own inflate' : 'DecompressionStream'})`, async () => {
      const zip = await ZipReader.open(makeZip(files), { forceJsInflate });
      expect(zip.entries.map((e) => e.name)).toEqual(files.map((f) => f.name));
      for (const f of files) expect(await zip.read(f.name)).toEqual(f.data);
      expect(await zip.readText('mimetype')).toBe('application/vnd.oasis.opendocument.text');
      expect(zip.get('dir/')!.isDirectory).toBe(true);
    });
  }

  it('accepts a Blob and an archive with a comment', async () => {
    const zip = await ZipReader.open(new Blob([makeZip(files, 'комментарий к архиву') as BlobPart]));
    expect(zip.has('word/document.xml')).toBe(true);
    expect(zip.has('нет такого')).toBe(false);
  });

  it('detects corruption by CRC', async () => {
    const data = makeZip([{ name: 'a.txt', data: bytes('abcdefgh'), store: true }]);
    data[30 + 5 + 2] ^= 0xff; // corrupt the content
    const zip = await ZipReader.open(data);
    await expect(zip.read('a.txt')).rejects.toThrow(ZipError);
  });

  it('rejects a non-archive and oversized entries', async () => {
    await expect(ZipReader.open(bytes('это точно не zip-архив, а просто текст'))).rejects.toThrow(ZipError);
    const zip = await ZipReader.open(makeZip(files), { maxEntrySize: 100 });
    await expect(zip.read('папка/файл.bin')).rejects.toThrow(ZipError);
  });

  it('reads an archive made by a third-party program (python zipfile, including ZIP64)', async () => {
    // The archive was made with Python's zipfile module; big.bin is the same pseudo-random sequence as in randomBytes.
    const path = join(__dirname, 'fixtures', 'ext', 'python.zip');
    const zip = await ZipReader.open(readFileSync(path));
    expect(await zip.readText('привет.txt')).toBe('Привет из Python');
    expect(await zip.read('big.bin')).toEqual(randomBytes(200_000, 11));
    expect(await zip.readText('forced64.txt')).toBe('zip64 entry');
  });
});
