// Búsqueda de repositorios en disco (alternativa a la API de vscode.git). Sin `vscode`.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** Carpetas que nunca contienen repos que nos interesen y pueden ser enormes. */
const SKIPPED_DIRS = new Set(['node_modules', 'bower_components', 'vendor', 'target', 'dist', 'out', 'build']);

async function hasDotGit(dir: string): Promise<boolean> {
  try {
    // `.git` puede ser carpeta (repo normal) o archivo (worktree / submódulo).
    await fs.stat(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Busca carpetas con `.git` a partir de `root`.
 * `maxDepth` 0 revisa solo `root`; 2 revisa `root`, sus hijos y sus nietos.
 * Sigue buscando dentro de un repo encontrado para detectar repos anidados.
 */
export async function scanForRepos(root: string, maxDepth: number): Promise<string[]> {
  const found: string[] = [];

  async function visit(dir: string, depth: number): Promise<void> {
    if (await hasDotGit(dir)) found.push(dir);
    if (depth >= maxDepth) return;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // sin permisos o borrada mientras escaneábamos
    }

    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIPPED_DIRS.has(e.name))
        .map((e) => visit(path.join(dir, e.name), depth + 1)),
    );
  }

  await visit(root, 0);
  return found.sort();
}

/** Clave para deduplicar rutas: resuelve symlinks y, en macOS/Windows, ignora mayúsculas. */
export async function canonicalPath(p: string): Promise<string> {
  let real = path.resolve(p);
  try {
    real = await fs.realpath(real);
  } catch {
    // si no existe, usamos la ruta resuelta tal cual
  }
  return process.platform === 'linux' ? real : real.toLowerCase();
}
