import { describe, expect, it } from 'vitest';
import { builtinFormat, createLocale, formatGeneral, formatValue, isDateFormat } from '../src/core/numfmt';

const en = createLocale('en-US');
const ru = createLocale('ru-RU');
const f = (v: number, code: string, loc = en) => formatValue(v, code, loc);

describe('number formats', () => {
  it('general format', () => {
    expect(formatGeneral(42, en)).toBe('42');
    expect(formatGeneral(0.1 + 0.2, en)).toBe('0.3');
    expect(formatGeneral(1234.5678, ru)).toBe('1234,5678');
    expect(formatGeneral(1e21, en)).toBe('1E+21');
    expect(formatGeneral(1.5e-7, en)).toBe('1.5E-07');
    expect(formatGeneral(123456789012, en)).toBe('123456789012');
  });
  it('grouping and decimals', () => {
    expect(f(1234567.891, '#,##0.00')).toBe('1,234,567.89');
    expect(f(1234567.891, '#,##0.00', ru)).toBe('1 234 567,89');
    expect(f(0.5, '0.00')).toBe('0.50');
    expect(f(12, '0000')).toBe('0012');
    expect(f(1.5, '0.###')).toBe('1.5');
    expect(f(1, '0.###')).toBe('1');
    expect(f(0.25, '#.##')).toBe('.25');
    expect(f(999.999, '0.00')).toBe('1000.00');
  });
  it('rounding as spreadsheets do', () => {
    expect(f(1.005, '0.00')).toBe('1.01');
    expect(f(2.675, '0.00')).toBe('2.68');
    expect(f(0.285, '0.00')).toBe('0.29');
  });
  it('percent, exponent, scale', () => {
    expect(f(0.256, '0%')).toBe('26%');
    expect(f(0.07, '0.00%')).toBe('7.00%');
    expect(f(12345, '0.00E+00')).toBe('1.23E+04');
    expect(f(0.00012, '0.0E+0')).toBe('1.2E-4');
    expect(f(1234567, '#,##0,')).toBe('1,235');
    expect(f(1234567, '0.0,,"M"')).toBe('1.2M');
  });
  it('sections and negative numbers', () => {
    expect(f(-5, '0.00')).toBe('-5.00');
    expect(f(-1234.5, '#,##0.00;(#,##0.00)')).toBe('(1,234.50)');
    expect(f(0, '0;-0;"ноль"')).toBe('ноль');
    expect(f(-0.001, '0.00')).toBe('0.00');
    expect(f(-3, '#,##0;[Red]-#,##0')).toBe('-3');
    expect(f(5, '"да";"нет"')).toBe('да');
    expect(f(-5, '"да";"нет"')).toBe('нет');
  });
  it('currency and literals', () => {
    expect(f(1500, '#,##0.00 [$₸-43F]', ru)).toBe('1 500,00 ₸');
    expect(f(1500, '[$$-409]#,##0.00')).toBe('$1,500.00');
    expect(f(1500, '_-* #,##0.00 "₽"_-;-* #,##0.00 "₽"_-', ru)).toBe(' 1 500,00 ₽ ');
    expect(f(12, '0" шт."')).toBe('12 шт.');
    expect(f(7, '0\\ \\к\\г')).toBe('7 кг');
    expect(f(1234567, '000-00-00')).toBe('123-45-67');
  });
  it('dates', () => {
    const d = 45986; // 25 November 2025
    expect(f(d, 'dd.mm.yyyy')).toBe('25.11.2025');
    expect(f(d, 'yyyy-mm-dd')).toBe('2025-11-25');
    expect(f(d, 'd mmmm yyyy')).toBe('25 November 2025');
    expect(f(d, 'd mmm yy', ru)).toMatch(/^25 нояб\.? 25$/);
    expect(f(d, 'dddd')).toBe('Tuesday');
    expect(f(d, builtinFormat(14)!, ru)).toBe('25.11.2025');
    expect(f(d, builtinFormat(14)!, en)).toBe('11/25/2025');
    expect(f(1, 'dd.mm.yyyy')).toBe('01.01.1900');
    expect(f(61, 'dd.mm.yyyy')).toBe('01.03.1900');
    expect(formatValue(0, 'dd.mm.yyyy', en, true)).toBe('01.01.1904');
  });
  it('time and durations', () => {
    expect(f(0.5, 'h:mm')).toBe('12:00');
    expect(f(0.75, 'hh:mm:ss')).toBe('18:00:00');
    expect(f(0.75, 'h:mm AM/PM')).toBe('6:00 PM');
    expect(f(45986.604166667, 'dd.mm.yyyy hh:mm')).toBe('25.11.2025 14:30');
    expect(f(1.5, '[h]:mm:ss')).toBe('36:00:00');
    expect(f(0.000011574074, 'mm:ss')).toBe('00:01');
    expect(f(45986.99999999, 'dd.mm.yyyy hh:mm:ss')).toBe('26.11.2025 00:00:00'); // rounding of seconds carries into the date
    expect(f(0.5000057870, 'hh:mm:ss.0')).toBe('12:00:00.5');
  });
  it('date format recognition', () => {
    expect(isDateFormat('dd.mm.yyyy')).toBe(true);
    expect(isDateFormat('h:mm')).toBe(true);
    expect(isDateFormat('[h]:mm')).toBe(true);
    expect(isDateFormat('0.00')).toBe(false);
    expect(isDateFormat('#,##0 "days"')).toBe(false);
    expect(isDateFormat('[Red]0.00')).toBe(false);
    expect(isDateFormat('General')).toBe(false);
    expect(isDateFormat(builtinFormat(14)!)).toBe(true);
  });
});
