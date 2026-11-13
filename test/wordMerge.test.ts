// Diff y merge por palabras de la ventana de merge.
import { describe, expect, it } from 'vitest';
import { changedSegments, mergeWords, tokenize } from '../src/git/wordMerge';

describe('tokenize', () => {
  it('palabras (con acentos), espacios y signos; juntos dan el texto', () => {
    const text = 'const año = fetch(url, { método: "POST" });\n';
    expect(tokenize(text).join('')).toBe(text);
    expect(tokenize('a.b = 10')).toEqual(['a', '.', 'b', ' ', '=', ' ', '10']);
  });
});

describe('changedSegments', () => {
  it('marca solo las palabras que cambian', () => {
    expect(changedSegments('timeout: 30000', 'timeout: 60000')).toEqual([
      { text: 'timeout: ', changed: false },
      { text: '60000', changed: true },
    ]);
    const segs = changedSegments('axios.post(url, data)', 'fetch(url, data)')!;
    expect(segs.filter((s) => s.changed).map((s) => s.text)).toEqual(['fetch']);
  });
});

describe('mergeWords (varita)', () => {
  it('cada lado cambió palabras distintas de la misma línea: se combinan', () => {
    expect(mergeWords('const total = 10;\n', 'const suma = 10;\n', 'const total = 20;\n')).toBe('const suma = 20;\n');
  });

  it('los dos cambiaron la misma palabra distinto: conflicto real', () => {
    expect(mergeWords('timeout: 30000\n', 'timeout: 60000\n', 'timeout: 90000\n')).toBeUndefined();
  });

  it('añadidos en sitios distintos de varias líneas', () => {
    const base = 'a\nb\nc\n';
    expect(mergeWords(base, 'a1\nb\nc\n', 'a\nb\nc3\n')).toBe('a1\nb\nc3\n');
  });

  it('los dos añaden en el mismo punto: conflicto', () => {
    expect(mergeWords('x()\n', 'x(1)\n', 'x(2)\n')).toBeUndefined();
  });

  it('el mismo cambio en los dos lados no se duplica si no se tocan… y si se tocan es conflicto (conservador)', () => {
    expect(mergeWords('a b c\n', 'A b c\n', 'a b C\n')).toBe('A b C\n');
  });
});
