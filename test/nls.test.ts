// Traducciones del package.json: cada %clave% existe en inglés (package.nls.json) y en español.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
const en = JSON.parse(readFileSync(new URL('../package.nls.json', import.meta.url), 'utf8')) as Record<string, string>;
const es = JSON.parse(readFileSync(new URL('../package.nls.es.json', import.meta.url), 'utf8')) as Record<string, string>;
const used = [...new Set([...pkg.matchAll(/"%([^"%]+)%"/g)].map((m) => m[1]!))];

describe('package.nls', () => {
  it('cada clave usada existe en inglés y en español', () => {
    expect(used.filter((k) => !(k in en))).toEqual([]);
    expect(used.filter((k) => !(k in es))).toEqual([]);
  });

  it('no hay claves de más ni textos vacíos', () => {
    expect(Object.keys(en).filter((k) => !used.includes(k))).toEqual([]);
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    expect(Object.entries({ ...en, ...es }).filter(([, v]) => !v.trim())).toEqual([]);
  });

  it('el inglés no tiene textos en español', () => {
    const spanish = Object.entries(en).filter(([, v]) => /[áéíóúñ¿¡]|\b(los|las|para|cuando|repositorio)\b/i.test(v));
    expect(spanish).toEqual([]);
  });
});
