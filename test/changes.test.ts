import { describe, expect, it } from 'vitest';
import { describeCounts, parseStashList, parseStatusFiles, planCommit, planRollback } from '../src/git/changes';

const z = (...records: string[]) => records.map((r) => `${r}\0`).join('');

describe('parseStatusFiles', () => {
  const files = parseStatusFiles(
    z(
      '# branch.head develop',
      '1 .M N... 100644 100644 100644 aaa bbb src/hooks/useOTP.js',
      '1 M. N... 100644 100644 100644 aaa bbb src/con espacio.jsx',
      '1 A. N... 000000 100644 100644 000 bbb src/nuevo.ts',
      '1 .A N... 000000 000000 100644 000 000 src/intent.ts',
      '1 .D N... 100644 100644 000000 aaa bbb viejo.css',
      '2 R. N... 100644 100644 100644 aaa bbb R100 src/despues.ts',
      'src/antes.ts',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflicto.ts',
      '? notas/borrador.md',
    ),
  );

  it('rutas (con espacios) y estado', () => {
    expect(files.map((f) => [f.status, f.path])).toEqual([
      ['M', 'src/hooks/useOTP.js'],
      ['M', 'src/con espacio.jsx'],
      ['A', 'src/nuevo.ts'],
      ['A', 'src/intent.ts'],
      ['D', 'viejo.css'],
      ['R', 'src/despues.ts'],
      ['U', 'src/conflicto.ts'],
      ['?', 'notas/borrador.md'],
    ]);
  });

  it('ruta original y tipo', () => {
    expect(files[5]).toMatchObject({ origPath: 'src/antes.ts', kind: 'tracked' });
    expect(files[6]!.kind).toBe('conflict');
    expect(files[7]!.kind).toBe('untracked');
  });
});

describe('planCommit', () => {
  it('agrega los sin versionar e incluye la ruta original de renombrados', () => {
    const files = parseStatusFiles(
      z('1 .M N... 1 1 1 a b a.ts', '2 R. N... 1 1 1 a b R100 nuevo.ts', 'viejo.ts', '? extra.ts'),
    );
    expect(planCommit(files)).toEqual({ add: ['extra.ts'], paths: ['a.ts', 'nuevo.ts', 'viejo.ts', 'extra.ts'] });
  });
});

describe('planRollback', () => {
  it('restore para modificados/borrados, rm --cached para añadidos; ignora sin versionar y conflictos', () => {
    const files = parseStatusFiles(
      z(
        '1 .M N... 1 1 1 a b mod.ts',
        '1 D. N... 1 1 1 a b borrado.ts',
        '1 A. N... 1 1 1 a b nuevo.ts',
        '2 R. N... 1 1 1 a b R100 renombrado.ts',
        'original.ts',
        'u UU N... 1 1 1 1 a b c conflicto.ts',
        '? suelto.ts',
      ),
    );
    expect(planRollback(files)).toEqual({
      restore: ['mod.ts', 'borrado.ts', 'original.ts'],
      unstage: ['nuevo.ts', 'renombrado.ts'],
      added: ['nuevo.ts', 'renombrado.ts'],
    });
    expect(describeCounts(files)).toBe('1 modified, 1 added, 1 deleted, 1 renamed, 1 unversioned');
  });
});

describe('parseStashList', () => {
  it('quita el prefijo "On <rama>: "', () => {
    expect(parseStashList('stash@{0}\0On dev-x: MultiGit: wip login\nstash@{1}\0WIP on develop: abc1234 algo\n')).toEqual([
      { ref: 'stash@{0}', message: 'MultiGit: wip login' },
      { ref: 'stash@{1}', message: 'abc1234 algo' },
    ]);
  });
});

describe('ignorados', () => {
  it('parseStatusFiles lee las entradas "!" y planCommit no las incluye', () => {
    const files = parseStatusFiles(['1 .M N... 1 1 1 a b a.ts', '! node_modules/', '! .env', ''].join('\0'));
    expect(files.map((f) => [f.kind, f.status, f.path])).toEqual([
      ['tracked', 'M', 'a.ts'],
      ['ignored', '!', 'node_modules/'],
      ['ignored', '!', '.env'],
    ]);
    expect(planCommit(files)).toEqual({ add: [], paths: ['a.ts'] });
  });
});
