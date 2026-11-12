// Destinos de "Add to .gitignore", como el submenú de IntelliJ: los `.gitignore` que ya existen en
// las carpetas que contienen a los archivos (el más cercano primero) y `.git/info/exclude`. Puro.
import * as path from 'node:path';

/** Carpetas (relativas al repo, `''` = raíz) que contienen a TODOS los archivos, de la más profunda a la raíz. */
export function commonAncestorDirs(files: readonly string[]): string[] {
  const dirsOf = (f: string) => {
    const parts = f.replace(/\/+$/, '').split('/').slice(0, -1);
    return parts.map((_, i) => parts.slice(0, i + 1).join('/')).reverse().concat('');
  };
  const [first, ...rest] = files.map(dirsOf);
  if (!first) return [];
  return first.filter((d) => rest.every((dirs) => dirs.includes(d)));
}

/** Ruta del `.gitignore` de una carpeta del repo (`''` → `.gitignore`). */
export function gitignoreIn(dir: string): string {
  return dir ? `${dir}/.gitignore` : '.gitignore';
}

/** Patrón a escribir en el `.gitignore` de `dir` para ignorar `file` (anclado a esa carpeta). */
export function ignorePattern(dir: string, file: string): string {
  return `/${dir ? path.posix.relative(dir, file) : file}${file.endsWith('/') ? '/' : ''}`.replace(/\/\/$/, '/');
}
