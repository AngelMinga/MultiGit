// Traducción: los módulos puros devuelven inglés por defecto y español con el bundle conectado.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { describeCounts, parseStatusFiles, statusLabel } from '../src/git/changes';
import { basicBlocker, formatSummary } from '../src/git/preflight';
import { formatMessage, setTranslator, t } from '../src/i18n';

const es = JSON.parse(readFileSync(new URL('../l10n/bundle.l10n.es.json', import.meta.url), 'utf8')) as Record<string, string>;
const spanish = (message: string, ...args: Array<string | number | boolean | null | undefined>) =>
  formatMessage(es[message] ?? message, ...args);

afterEach(() => setTranslator(formatMessage));

describe('i18n', () => {
  it('sin traductor: inglés con las variables reemplazadas', () => {
    expect(t('{0} file(s) with changes', 3)).toBe('3 file(s) with changes');
    expect(t('Align with \'{0}\'', null)).toBe("Align with 'null'");
  });

  it('con el bundle español: los módulos puros se traducen', () => {
    setTranslator(spanish);
    const files = parseStatusFiles(['1 .M N... 1 1 1 a b a.ts', '? b.ts', ''].join('\0'));
    expect(describeCounts(files)).toBe('1 modificado(s), 1 sin versionar');
    expect(statusLabel('A')).toBe('Añadido');
    expect(basicBlocker({ operation: 'rebase', status: undefined }, false)).toMatch(/no se pudo leer/);
    expect(formatSummary([{ repo: 'shell', state: 'pending' }])).toBe('⏭ shell: no ejecutado');
  });

  it('el bundle tiene los mismos marcadores {n} que el inglés', () => {
    const wrong = Object.entries(es).filter(([en, translated]) => {
      const marks = (s: string) => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(',');
      return marks(en) !== marks(translated);
    });
    expect(wrong).toEqual([]);
  });
});
