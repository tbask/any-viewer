import { describe, expect, it } from 'vitest';
import { LABELS_EN, LABELS_KK, LABELS_RU, LABEL_SETS, normalizeLanguageTag, resolveLabels } from '../src/labels';
import { createLocale } from '../src/core/numfmt';

describe('interface languages', () => {
  it('every built-in set has the same keys, none of them empty', () => {
    const keys = Object.keys(LABELS_EN).sort();
    for (const [code, set] of Object.entries(LABEL_SETS)) {
      expect(Object.keys(set).sort(), code).toEqual(keys);
      for (const [key, value] of Object.entries(set)) {
        if (Array.isArray(value)) expect(value.every((v) => typeof v === 'string' && v.length > 0), `${code}.${key}`).toBe(true);
        else expect(typeof value === 'string' && value.length > 0, `${code}.${key}`).toBe(true);
      }
    }
  });

  it('placeholders survive translation', () => {
    for (const [code, set] of Object.entries(LABEL_SETS)) {
      expect(set.mediaCodecUnsupported, code).toContain('{codec}');
      expect(set.shownByContent, code).toContain('{format}');
    }
  });

  it('a language tag selects its set; unknown languages give English', () => {
    expect(resolveLabels('ru')).toBe(LABELS_RU);
    expect(resolveLabels('ru-RU')).toBe(LABELS_RU);
    expect(resolveLabels('en-GB')).toBe(LABELS_EN);
    expect(resolveLabels('kk')).toBe(LABELS_KK);
    expect(resolveLabels('kk-KZ')).toBe(LABELS_KK);
    expect(resolveLabels('KK_kz')).toBe(LABELS_KK);
    expect(resolveLabels('de-DE')).toBe(LABELS_EN);
  });

  it('Kazakh written with the country code is understood', () => {
    expect(resolveLabels('kz')).toBe(LABELS_KK);
    expect(resolveLabels('kz-KZ')).toBe(LABELS_KK);
    expect(normalizeLanguageTag('kz-KZ')).toBe('kk-KZ');
    expect(normalizeLanguageTag('kz')).toBe('kk');
    expect(normalizeLanguageTag('kk-KZ')).toBe('kk-KZ');
    expect(normalizeLanguageTag('en-GB')).toBe('en-GB');
    expect(normalizeLanguageTag(undefined)).toBeUndefined();
  });

  it('the normalised Kazakh tag gives Kazakh number formatting, not the fallback', () => {
    const kk = createLocale(normalizeLanguageTag('kz-KZ'));
    expect(kk.decimal).toBe(',');
    expect(kk.months[0]).not.toBe(createLocale('en').months[0]);
  });
});
