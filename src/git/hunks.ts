// Commit parcial (por hunks o líneas): parseo de `git diff -U0` y contenido del archivo con solo las
// líneas elegidas. Puro, sin `vscode`.
//
// El contenido nuevo se arma con el archivo de HEAD (`git show HEAD:<ruta>`) y las líneas `+` del
// diff, las dos ya "limpias" (filtros, fin de línea) como las guarda git; por eso se escribe en el
// índice con `hash-object --no-filters`.
import { createHash } from 'node:crypto';

export interface DiffLine {
  kind: 'del' | 'add';
  /** Contenido con su fin de línea (sin `\n` si es la última línea y el archivo no termina en `\n`). */
  text: string;
  /** Identificador estable para la selección: `d<línea vieja>` o `a<línea nueva>`. */
  id: string;
}

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parsea la salida de `git diff -U0` de un solo archivo. `undefined` si es binario. */
export function parseHunks(diff: string): Hunk[] | undefined {
  if (/^Binary files .* differ$/m.test(diff) || /^GIT binary patch$/m.test(diff)) return undefined;
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  const rows = diff.split('\n');
  // split deja un "" final si la salida termina en \n.
  if (rows[rows.length - 1] === '') rows.pop();
  for (const row of rows) {
    const header = HEADER.exec(row);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      oldNo = current.oldStart;
      newNo = current.newStart;
      hunks.push(current);
      continue;
    }
    if (!current) continue; // cabecera del diff (diff --git, index, ---, +++)
    if (row.startsWith('-')) current.lines.push({ kind: 'del', text: `${row.slice(1)}\n`, id: `d${oldNo++}` });
    else if (row.startsWith('+')) current.lines.push({ kind: 'add', text: `${row.slice(1)}\n`, id: `a${newNo++}` });
    else if (row.startsWith('\\')) {
      // "\ No newline at end of file": la línea anterior no lleva \n.
      const last = current.lines[current.lines.length - 1];
      if (last) last.text = last.text.slice(0, -1);
    }
  }
  return hunks;
}

/** Líneas de un texto, cada una con su `\n` (la última puede no tenerlo). */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Todos los identificadores de líneas cambiadas. */
export function allLineIds(hunks: readonly Hunk[]): string[] {
  return hunks.flatMap((h) => h.lines.map((l) => l.id));
}

/**
 * Contenido del archivo aplicando sobre `oldText` solo las líneas elegidas: una línea `-` elegida se
 * borra (si no, se queda) y una `+` elegida se añade (si no, no). Con todo elegido da el archivo nuevo.
 */
export function buildPartial(oldText: string, hunks: readonly Hunk[], selected: ReadonlySet<string>): string {
  const old = splitLines(oldText);
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of [...hunks].sort((a, b) => a.oldStart - b.oldStart)) {
    // Con oldCount 0 (solo añadidos), oldStart es la línea DESPUÉS de la cual se inserta.
    const start = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    out.push(...old.slice(cursor, start));
    let i = start;
    for (const line of hunk.lines) {
      if (line.kind !== 'del') continue;
      if (!selected.has(line.id)) out.push(old[i] ?? line.text);
      i++;
    }
    for (const line of hunk.lines) if (line.kind === 'add' && selected.has(line.id)) out.push(line.text);
    cursor = start + hunk.oldCount;
  }
  out.push(...old.slice(cursor));
  // Una línea sin \n (la última del original) que queda en medio necesita su \n.
  return out.map((l, i) => (i < out.length - 1 && !l.endsWith('\n') ? `${l}\n` : l)).join('');
}

/** Huella del diff: si el archivo cambia después de elegir las líneas, la selección ya no vale. */
export function diffFingerprint(diff: string): string {
  return createHash('sha1').update(diff).digest('hex');
}

/** Filas para mostrar un hunk: hasta `context` líneas sin cambios antes y después. */
export interface HunkRow {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  id?: string;
  oldNo?: number;
  newNo?: number;
}

export function hunkRows(oldText: string, hunks: readonly Hunk[], context = 3): HunkRow[][] {
  const old = splitLines(oldText);
  const sorted = [...hunks].sort((a, b) => a.oldStart - b.oldStart);
  const startOf = (h: Hunk) => (h.oldCount === 0 ? h.oldStart : h.oldStart - 1);
  let prevEnd = 0; // primera línea vieja (índice 0) que no se mostró todavía
  let offset = 0; // líneas nuevas − viejas de los hunks anteriores
  return sorted.map((hunk, h) => {
    const start = startOf(hunk);
    const end = start + hunk.oldCount;
    const next = sorted[h + 1];
    const rows: HunkRow[] = [];
    for (let i = Math.max(prevEnd, start - context); i < start; i++) rows.push({ kind: 'ctx', text: old[i]!, oldNo: i + 1, newNo: i + 1 + offset });
    for (const line of hunk.lines) {
      const no = Number(line.id.slice(1));
      rows.push({ kind: line.kind, text: line.text, id: line.id, ...(line.kind === 'del' ? { oldNo: no } : { newNo: no }) });
    }
    offset += hunk.newCount - hunk.oldCount;
    const after = Math.min(end + context, next ? startOf(next) : old.length, old.length);
    for (let i = end; i < after; i++) rows.push({ kind: 'ctx', text: old[i]!, oldNo: i + 1, newNo: i + 1 + offset });
    prevEnd = after;
    return rows;
  });
}
