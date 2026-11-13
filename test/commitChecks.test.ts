// Comprobaciones antes del commit: TODO, marcas de conflicto, secretos y parseo del diff.
import { describe, expect, it } from 'vitest';
import { addedLinesByFile, allLines, formatSize, scanAddedLines } from '../src/git/commitChecks';

const all = { todo: true, conflictMarkers: true, secrets: true };
const scan = (...texts: string[]) => scanAddedLines('repo', 'a.js', texts.map((text, i) => ({ line: i + 1, text })), all);

describe('scanAddedLines', () => {
  it('TODO/FIXME/XXX, pero no palabras que los contienen', () => {
    expect(scan('// TODO: quitar', 'x = 1 // FIXME', 'todos.map()', 'XXX', 'TODOS').map((f) => [f.kind, f.line])).toEqual([
      ['todo', 1],
      ['todo', 2],
      ['todo', 4],
    ]);
  });

  it('marcas de conflicto solo al principio de la línea', () => {
    expect(scan('<<<<<<< HEAD', '=======', '>>>>>>> rama', 'a <<<<<<< b', '========').map((f) => f.line)).toEqual([1, 2, 3]);
  });

  it('secretos frecuentes, enmascarados en el aviso', () => {
    const found = scan(
      '-----BEGIN RSA PRIVATE KEY-----',
      'const key = "AKIAABCDEFGHIJKLMNOP";',
      `token: ghp_${'a'.repeat(36)}`,
      'password = "hunter2hunter"',
      'password = process.env.PASSWORD',
      'password: "${PASSWORD}"',
      'const apiKey = "";',
    );
    expect(found.map((f) => f.line)).toEqual([1, 2, 3, 4]);
    expect(found.every((f) => f.kind === 'secret')).toBe(true);
    expect(found[1]!.text).not.toContain('AKIAABCDEFGHIJKLMNOP');
  });

  it('se pueden desactivar', () => {
    expect(scanAddedLines('r', 'a', [{ line: 1, text: 'TODO <<<<<<<' }], { todo: false, conflictMarkers: false, secrets: false })).toEqual([]);
  });
});

describe('addedLinesByFile', () => {
  it('líneas añadidas con su número en el archivo nuevo, por archivo', () => {
    const diff = [
      'diff --git a/a.js b/a.js',
      'index 1..2 100644',
      '--- a/a.js',
      '+++ b/a.js',
      '@@ -2 +2,2 @@ ctx',
      '-viejo',
      '+nuevo',
      '+otra',
      '@@ -10,0 +12 @@',
      '+final',
      'diff --git a/borrado.js b/borrado.js',
      '--- a/borrado.js',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-x',
      'diff --git "a/a\\303\\261o.js" "b/a\\303\\261o.js"',
      '--- "a/a\\303\\261o.js"',
      '+++ "b/a\\303\\261o.js"',
      '@@ -0,0 +1 @@',
      '+hola',
      '',
    ].join('\n');
    const map = addedLinesByFile(diff);
    expect([...map.keys()]).toEqual(['a.js', 'año.js']);
    expect(map.get('a.js')).toEqual([
      { line: 2, text: 'nuevo' },
      { line: 3, text: 'otra' },
      { line: 12, text: 'final' },
    ]);
    expect(map.get('año.js')).toEqual([{ line: 1, text: 'hola' }]);
  });

  it('allLines y formatSize', () => {
    expect(allLines('a\r\nb')).toEqual([
      { line: 1, text: 'a' },
      { line: 2, text: 'b' },
    ]);
    expect(formatSize(6 * 1024 * 1024)).toBe('6.0 MB');
    expect(formatSize(2048)).toBe('2 KB');
  });
});
