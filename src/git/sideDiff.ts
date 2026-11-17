// Diff lado a lado (como el de IntelliJ): bloques sin cambios y bloques de cambio a partir del archivo
// de HEAD y de los hunks de `git diff -U0` (src/git/hunks.ts). Puro, sin `vscode`.
import type { DiffBlockView } from '../webview/protocol';
import { type Hunk, splitLines } from './hunks';

export type SideBlock = DiffBlockView;

/** Bloques de un archivo modificado: `oldText` es el de HEAD y `hunks` los de `git diff -U0 HEAD`. */
export function sideBlocks(oldText: string, hunks: readonly Hunk[]): SideBlock[] {
  const old = splitLines(oldText);
  const blocks: SideBlock[] = [];
  let cursor = 0; // siguiente línea vieja sin mostrar
  let offset = 0; // líneas nuevas − viejas de los bloques anteriores
  for (const hunk of [...hunks].sort((a, b) => a.oldStart - b.oldStart)) {
    // Con un lado vacío (count 0), start es la línea DESPUÉS de la cual va el cambio.
    const oldIndex = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    const newIndex = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
    if (oldIndex > cursor) blocks.push({ type: 'stable', oldIndex: cursor, newIndex: cursor + offset, lines: old.slice(cursor, oldIndex) });
    blocks.push({
      type: 'change',
      oldIndex,
      newIndex,
      old: hunk.lines.filter((l) => l.kind === 'del').map((l) => l.text),
      new: hunk.lines.filter((l) => l.kind === 'add').map((l) => l.text),
      ids: hunk.lines.map((l) => l.id),
    });
    cursor = oldIndex + hunk.oldCount;
    offset += hunk.newCount - hunk.oldCount;
  }
  if (cursor < old.length) blocks.push({ type: 'stable', oldIndex: cursor, newIndex: cursor + offset, lines: old.slice(cursor) });
  return blocks;
}

/** Un solo bloque con todo el archivo: añadido (`oldText` vacío) o borrado (`newText` vacío). */
export function wholeFileBlocks(oldText: string, newText: string): SideBlock[] {
  const old = splitLines(oldText);
  const now = splitLines(newText);
  if (!old.length && !now.length) return [];
  return [{ type: 'change', oldIndex: 0, newIndex: 0, old, new: now, ids: [] }];
}
