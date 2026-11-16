// Annotate (como IntelliJ): `git blame --line-porcelain` → autor, fecha y commit de cada línea, y la
// antigüedad de cada cambio para colorear. Puro, sin `vscode`.

/** Hash de las líneas que todavía no tienen commit. */
export const UNCOMMITTED = '0000000000000000000000000000000000000000';

export interface BlameLine {
  hash: string;
  author: string;
  email: string;
  /** Fecha de autor en ms. */
  time: number;
  summary: string;
  /** Ruta del archivo en ese commit (cambia con los renombres). */
  path: string;
  /** Commit anterior que tocó esa línea y su ruta (para "Annotate Previous Revision"). */
  previous?: { hash: string; path: string };
}

/** Parsea `git blame --line-porcelain`: una entrada por línea del archivo, en orden. */
export function parseBlame(output: string): BlameLine[] {
  const lines: BlameLine[] = [];
  let current: Partial<BlameLine> & { hash?: string } = {};
  for (const raw of output.split('\n')) {
    if (raw.startsWith('\t')) {
      lines.push({
        hash: current.hash ?? UNCOMMITTED,
        author: current.author ?? '',
        email: current.email ?? '',
        time: current.time ?? 0,
        summary: current.summary ?? '',
        path: current.path ?? '',
        ...(current.previous ? { previous: current.previous } : {}),
      });
      current = {};
      continue;
    }
    const header = /^([0-9a-f]{40}) \d+ \d+/.exec(raw);
    if (header && current.hash === undefined) {
      current.hash = header[1]!;
      continue;
    }
    const space = raw.indexOf(' ');
    const key = space < 0 ? raw : raw.slice(0, space);
    const value = space < 0 ? '' : raw.slice(space + 1);
    switch (key) {
      case 'author':
        current.author = value;
        break;
      case 'author-mail':
        current.email = value.replace(/^<|>$/g, '');
        break;
      case 'author-time':
        current.time = Number(value) * 1000;
        break;
      case 'summary':
        current.summary = value;
        break;
      case 'filename':
        current.path = value;
        break;
      case 'previous': {
        const cut = value.indexOf(' ');
        if (cut > 0) current.previous = { hash: value.slice(0, cut), path: value.slice(cut + 1) };
        break;
      }
    }
  }
  return lines;
}

/**
 * Antigüedad de cada commit en `buckets` niveles (0 = el más reciente), por su posición entre los
 * commits del archivo (como los colores de Annotate de IntelliJ). Las líneas sin commit no cuentan.
 */
export function ageLevels(lines: readonly BlameLine[], buckets = 5): Map<string, number> {
  const times = new Map<string, number>();
  for (const l of lines) if (l.hash !== UNCOMMITTED) times.set(l.hash, l.time);
  const ordered = [...times.entries()].sort((a, b) => b[1] - a[1]);
  const levels = new Map<string, number>();
  ordered.forEach(([hash], i) => levels.set(hash, ordered.length <= 1 ? 0 : Math.min(buckets - 1, Math.floor((i * buckets) / ordered.length))));
  return levels;
}

/** Nombre corto para la columna: "Angel Minga" → "Angel Minga"; muy largo → recortado con "…". */
export function shortAuthor(name: string, max = 16): string {
  const n = name.trim();
  return n.length <= max ? n : `${n.slice(0, max - 1)}…`;
}
