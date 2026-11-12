import { describe, expect, it } from 'vitest';
import { commonAncestorDirs, gitignoreIn, ignorePattern } from '../src/git/ignoreTargets';

describe('commonAncestorDirs', () => {
  it('lista las carpetas de un archivo, de la más cercana a la raíz', () => {
    expect(commonAncestorDirs(['apps/mf/src/A.jsx'])).toEqual(['apps/mf/src', 'apps/mf', 'apps', '']);
  });
  it('solo las comunes a todos los archivos', () => {
    expect(commonAncestorDirs(['apps/mf/src/A.jsx', 'apps/mf/test/B.js'])).toEqual(['apps/mf', 'apps', '']);
    expect(commonAncestorDirs(['a/x.js', 'b/y.js'])).toEqual(['']);
  });
  it('archivo en la raíz y carpetas sin versionar (`dir/`)', () => {
    expect(commonAncestorDirs(['x.js'])).toEqual(['']);
    expect(commonAncestorDirs(['apps/new/'])).toEqual(['apps', '']);
  });
});

describe('ignorePattern', () => {
  it('relativo a la carpeta del .gitignore y anclado', () => {
    expect(ignorePattern('apps/mf', 'apps/mf/src/A.jsx')).toBe('/src/A.jsx');
    expect(ignorePattern('', 'apps/mf/src/A.jsx')).toBe('/apps/mf/src/A.jsx');
    expect(ignorePattern('apps', 'apps/new/')).toBe('/new/');
  });
  it('gitignoreIn', () => {
    expect(gitignoreIn('')).toBe('.gitignore');
    expect(gitignoreIn('apps/mf')).toBe('apps/mf/.gitignore');
  });
});
