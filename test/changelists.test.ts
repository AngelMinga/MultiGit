// Changelists: estado, sincronización con los cambios, mover, activar y borrar.
import { describe, expect, it } from 'vitest';
import {
  addList,
  DEFAULT_LIST,
  editList,
  initialState,
  listOf,
  moveTo,
  normalize,
  orderedLists,
  removeList,
  setActive,
  sync,
  validateName,
} from '../src/git/changelists';

describe('changelists', () => {
  it('los archivos nuevos van a la activa y se olvidan los que ya no tienen cambios', () => {
    let s = addList(initialState(), 'b', 'Tarea B');
    s = setActive(s, 'b');
    s = sync(s, ['r\0a.ts', 'r\0b.ts']);
    expect(s.assign).toEqual({ 'r\0a.ts': 'b', 'r\0b.ts': 'b' });
    s = moveTo(s, ['r\0a.ts'], DEFAULT_LIST);
    s = setActive(s, DEFAULT_LIST);
    s = sync(s, ['r\0a.ts', 'r\0c.ts']);
    expect(s.assign).toEqual({ 'r\0a.ts': DEFAULT_LIST, 'r\0c.ts': DEFAULT_LIST });
    // Sin cambios: el mismo objeto (no se guarda de nuevo).
    expect(sync(s, ['r\0a.ts', 'r\0c.ts'])).toBe(s);
    expect(listOf(s, 'r\0nuevo')).toBe(DEFAULT_LIST);
  });

  it('borrar una lista: sus archivos a la de por defecto; la de por defecto no se borra', () => {
    let s = addList(initialState(), 'x', 'X');
    s = setActive(moveTo(sync(s, ['k1', 'k2']), ['k1'], 'x'), 'x');
    s = removeList(s, 'x');
    expect(s.lists.map((l) => l.id)).toEqual([DEFAULT_LIST]);
    expect(s.active).toBe(DEFAULT_LIST);
    expect(s.assign).toEqual({ k1: DEFAULT_LIST, k2: DEFAULT_LIST });
    expect(removeList(s, DEFAULT_LIST)).toBe(s);
    expect(moveTo(s, ['k1'], 'no-existe')).toBe(s);
  });

  it('nombres, edición, orden y estado guardado dañado', () => {
    let s = addList(addList(initialState(), 'z', 'Zeta'), 'a', 'Alfa');
    expect(validateName(s, '  ')).toBe('empty');
    expect(validateName(s, 'alfa')).toBe('duplicate');
    expect(validateName(s, 'Alfa', 'a')).toBeUndefined();
    s = editList(s, 'a', ' Alfa 2 ', ' descripción ');
    expect(s.lists.find((l) => l.id === 'a')).toEqual({ id: 'a', name: 'Alfa 2', comment: 'descripción' });
    expect(orderedLists(s).map((l) => l.name)).toEqual(['Changes', 'Alfa 2', 'Zeta']);
    expect(normalize({ lists: [{ id: 'q', name: 'Q' }], active: 'nada', assign: { k: 'q', j: 'borrada' } })).toEqual({
      lists: [{ id: DEFAULT_LIST, name: 'Changes' }, { id: 'q', name: 'Q' }],
      active: DEFAULT_LIST,
      assign: { k: 'q' },
    });
    expect(normalize(undefined)).toEqual(initialState());
  });
});
