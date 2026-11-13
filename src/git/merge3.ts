// Merge a tres bandas para la ventana de merge propia (como "Merge Revisions" de IntelliJ). Puro, sin
// `vscode`. Los cambios de cada lado (base → tuyos, base → otros) vienen de `git diff -U0` (ver
// hunks.ts); aquí se agrupan en bloques: sin cambios, cambio de un solo lado, mismo cambio en los dos o
// conflicto.
import { splitLines, type Hunk } from './hunks';

export type BlockKind = 'ours' | 'theirs' | 'same' | 'conflict';

export type MergeBlock =
  | { type: 'stable'; lines: string[] }
  | { type: 'change'; kind: BlockKind; base: string[]; ours: string[]; theirs: string[] };

interface Side {
  side: 0 | 1;
  /** Rango de la base [start, end), en índices de línea (0…). */
  start: number;
  end: number;
  hunk: Hunk;
}

/** Rango de la base que cubre un hunk de `-U0`. */
function baseRange(h: Hunk): [number, number] {
  const start = h.oldCount === 0 ? h.oldStart : h.oldStart - 1;
  return [start, start + h.oldCount];
}

/** Aplica sobre base[from, to) los hunks de un lado que caen dentro. */
function applySide(base: readonly string[], from: number, to: number, hunks: readonly Side[]): string[] {
  const out: string[] = [];
  let cursor = from;
  for (const h of hunks) {
    out.push(...base.slice(cursor, h.start));
    out.push(...h.hunk.lines.filter((l) => l.kind === 'add').map((l) => l.text));
    cursor = h.end;
  }
  out.push(...base.slice(cursor, to));
  return out;
}

/**
 * Bloques del merge. Los cambios de los dos lados que se solapan o se tocan en la base forman un
 * conflicto (como git); si los dos dejan lo mismo, es un cambio igual en ambos.
 */
export function merge3(baseText: string, oursHunks: readonly Hunk[], theirsHunks: readonly Hunk[]): MergeBlock[] {
  const base = splitLines(baseText);
  const all: Side[] = [
    ...oursHunks.map((hunk) => ({ side: 0 as const, hunk, start: baseRange(hunk)[0], end: baseRange(hunk)[1] })),
    ...theirsHunks.map((hunk) => ({ side: 1 as const, hunk, start: baseRange(hunk)[0], end: baseRange(hunk)[1] })),
  ].sort((a, b) => a.start - b.start || a.end - b.end || a.side - b.side);

  const blocks: MergeBlock[] = [];
  let cursor = 0;
  let i = 0;
  while (i < all.length) {
    // Grupo: hunks que se solapan (o se tocan, si son de lados distintos).
    const group = [all[i]!];
    let end = all[i]!.end;
    i++;
    while (i < all.length) {
      const next = all[i]!;
      const touches = next.start < end || (next.start === end && group.some((g) => g.side !== next.side));
      if (!touches) break;
      group.push(next);
      end = Math.max(end, next.end);
      i++;
    }
    const start = group[0]!.start;
    if (start > cursor) blocks.push({ type: 'stable', lines: base.slice(cursor, start) });
    const mine = group.filter((g) => g.side === 0);
    const other = group.filter((g) => g.side === 1);
    const ours = applySide(base, start, end, mine);
    const theirs = applySide(base, start, end, other);
    const baseLines = base.slice(start, end);
    const kind: BlockKind = !other.length ? 'ours' : !mine.length ? 'theirs' : ours.join('') === theirs.join('') ? 'same' : 'conflict';
    blocks.push({ type: 'change', kind, base: baseLines, ours, theirs });
    cursor = end;
  }
  if (cursor < base.length) blocks.push({ type: 'stable', lines: base.slice(cursor) });
  return blocks;
}

/** Resultado de aplicar todos los cambios sin conflicto (los conflictos quedan como en la base). */
export function autoMerge(blocks: readonly MergeBlock[]): { text: string; conflicts: number } {
  let conflicts = 0;
  const text = blocks
    .map((b) => {
      if (b.type === 'stable') return b.lines.join('');
      if (b.kind === 'conflict') {
        conflicts++;
        return b.base.join('');
      }
      return (b.kind === 'theirs' ? b.theirs : b.ours).join('');
    })
    .join('');
  return { text, conflicts };
}
