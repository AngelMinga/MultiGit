// Grupos de repos: filtro por nombre o patrón y valores raros en la configuración.
import { describe, expect, it } from 'vitest';
import { filterByGroup, isGroupEffective, normalizeGroups } from '../src/git/repoGroups';

const repos = ['mflogin', 'mftheme', 'shell', 'api'].map((name) => ({ name }));
const groups = { front: ['mf*', 'shell'], back: ['api'], vacio: [], fantasma: ['no-existe'] };
const names = (list: Array<{ name: string }>) => list.map((r) => r.name);

describe('repoGroups', () => {
  it('filtra por nombre y por patrón con *', () => {
    expect(names(filterByGroup(repos, groups, 'front'))).toEqual(['mflogin', 'mftheme', 'shell']);
    expect(names(filterByGroup(repos, groups, 'back'))).toEqual(['api']);
  });

  it('sin grupo, grupo vacío, inexistente o sin repos del workspace: todos', () => {
    for (const g of [undefined, 'vacio', 'nada', 'fantasma']) expect(filterByGroup(repos, groups, g)).toHaveLength(4);
    expect(isGroupEffective(repos, groups, 'fantasma')).toBe(false);
    expect(isGroupEffective(repos, groups, 'front')).toBe(true);
  });

  it('el patrón no interpreta otros caracteres de regex', () => {
    expect(names(filterByGroup([{ name: 'a.b' }, { name: 'axb' }], { g: ['a.*'] }, 'g'))).toEqual(['a.b']);
  });

  it('normalizeGroups ignora valores que no son listas de textos', () => {
    expect(normalizeGroups({ a: ['x', 1, ''], b: 'x', c: null })).toEqual({ a: ['x'] });
    expect(normalizeGroups(undefined)).toEqual({});
  });
});
