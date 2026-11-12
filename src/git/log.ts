// Log combinado de varios repos. Puro, sin `vscode`.

/** Formato de `git log` que entiende `parseLogPage` (campos por NUL, registros por 0x1E). */
export const LOG_PAGE_FORMAT = '%H%x00%h%x00%P%x00%an%x00%ae%x00%at%x00%ct%x00%D%x00%s%x1e';

export interface LogCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  email: string;
  /** Fecha de autor (ms). */
  authorTime: number;
  /** Fecha de commit (ms): ordena el log combinado. */
  commitTime: number;
  /** Decoraciones crudas de `%D`. */
  decorations: string;
  subject: string;
}

export function parseLogPage(output: string): LogCommit[] {
  const commits: LogCommit[] = [];
  for (const record of output.split('\x1e')) {
    const r = record.replace(/^\n+/, '');
    if (!r) continue;
    const [hash = '', shortHash = '', parents = '', author = '', email = '', at = '0', ct = '0', decorations = '', subject = ''] =
      r.split('\0');
    if (!hash) continue;
    commits.push({
      hash,
      shortHash,
      parents: parents ? parents.split(' ') : [],
      author,
      email,
      authorTime: Number(at) * 1000,
      commitTime: Number(ct) * 1000,
      decorations,
      subject,
    });
  }
  return commits;
}

// ------------------------------------------------------------------ etiquetas

export type RefKind = 'head' | 'local' | 'remote' | 'tag';

export interface RefLabel {
  name: string;
  kind: RefKind;
}

/**
 * `HEAD -> dev-x, origin/dev-x, origin/HEAD, tag: v1.0, develop` → etiquetas.
 * `head` = rama actual. Se omiten `origin/HEAD` y `HEAD` suelto (detached).
 */
export function parseDecorations(decorations: string, remotes: readonly string[]): RefLabel[] {
  const labels: RefLabel[] = [];
  for (const raw of decorations.split(', ')) {
    const d = raw.trim();
    if (!d || d === 'HEAD') continue;
    if (d.startsWith('HEAD -> ')) labels.push({ name: d.slice(8), kind: 'head' });
    else if (d.startsWith('tag: ')) labels.push({ name: d.slice(5), kind: 'tag' });
    else if (remotes.some((r) => d.startsWith(`${r}/`))) {
      if (!d.endsWith('/HEAD')) labels.push({ name: d, kind: 'remote' });
    } else labels.push({ name: d, kind: 'local' });
  }
  return labels;
}

// ------------------------------------------------------------------ filtros

export interface LogFilters {
  /** Texto del mensaje, o hash si parece uno. */
  text: string;
  regex: boolean;
  matchCase: boolean;
  /** `null` = todas las ramas; `HEAD` = rama actual de cada repo; nombre local o `remote/rama`. */
  branch: string | null;
  /** Autor (nombre o email). */
  user: string;
  /** Fecha `YYYY-MM-DD` desde / hasta (incluidas). */
  since: string | null;
  until: string | null;
  paths: string[];
  /** Repos a incluir (ids); vacío = todos. */
  repoIds: string[];
  /** Historial de UN archivo: seguir sus renombres (`--follow`). */
  follow?: boolean;
}

export const EMPTY_FILTERS: LogFilters = {
  text: '',
  regex: false,
  matchCase: false,
  branch: null,
  user: '',
  since: null,
  until: null,
  paths: [],
  repoIds: [],
};

/** Un texto de 4 a 40 caracteres hexadecimales se trata como hash. */
export function looksLikeHash(text: string): boolean {
  return /^[0-9a-f]{4,40}$/i.test(text.trim());
}

/** Refs a recorrer cuando no hay filtro de rama: todo menos stashes y notas. */
export const ALL_REFS = ['--branches', '--remotes', '--tags', 'HEAD'];

/**
 * Argumentos de `git log` para los filtros (sin `--skip`/`--max-count` ni pathspec).
 * `refs` son las refs ya resueltas para este repo. Un texto con forma de hash no se busca en el
 * mensaje, salvo con `hashAsText` (cuando ese hash no existe en ningún repo).
 */
export function logFilterArgs(
  filters: LogFilters,
  refs: readonly string[],
  options: { hashAsText?: boolean } = {},
): string[] {
  const args = ['--date-order'];
  const text = filters.text.trim();
  const grep = text && (options.hashAsText || !looksLikeHash(text));
  const hasPattern = grep || filters.user.trim();
  if (grep) args.push(`--grep=${text}`);
  if (filters.user.trim()) args.push(`--author=${filters.user.trim()}`);
  if (hasPattern) {
    if (!filters.matchCase) args.push('--regexp-ignore-case');
    args.push(filters.regex ? '--extended-regexp' : '--fixed-strings');
  }
  if (filters.follow && filters.paths.length === 1) args.push('--follow');
  if (filters.since) args.push(`--since=${filters.since} 00:00`);
  if (filters.until) args.push(`--until=${filters.until} 23:59:59`);
  args.push(...refs);
  return args;
}

/**
 * Refs de un repo para el filtro de rama, o `null` si el repo no tiene esa rama
 * (y queda fuera del log, como en IntelliJ).
 */
export function resolveBranchRefs(
  branch: string | null,
  local: readonly string[],
  remote: readonly string[],
): string[] | null {
  if (branch === null) return ALL_REFS;
  if (branch === 'HEAD') return ['HEAD'];
  if (local.includes(branch)) return [branch];
  if (remote.includes(branch)) return [branch];
  const tracking = remote.find((r) => r.endsWith(`/${branch}`));
  return tracking ? [tracking] : null;
}

// ------------------------------------------------------------------ paginador

export interface LogSource {
  id: string;
  /** Devuelve hasta `count` commits saltando `skip`, ya en orden de fecha de commit. */
  fetch(skip: number, count: number): Promise<LogCommit[]>;
}

export type MergedCommit = LogCommit & { repoId: string };

/**
 * Mezcla los logs de varios repos por fecha de commit (desc), pidiendo a cada repo páginas
 * de `pageSize` con `--skip` solo cuando su buffer se vacía.
 */
export class MergedLogPager {
  private readonly state = new Map<string, { items: LogCommit[]; skip: number; done: boolean }>();

  constructor(
    private readonly sources: readonly LogSource[],
    private readonly pageSize = 300,
  ) {
    for (const s of sources) this.state.set(s.id, { items: [], skip: 0, done: false });
  }

  get hasMore(): boolean {
    return [...this.state.values()].some((s) => s.items.length > 0 || !s.done);
  }

  /** Siguientes `n` commits del log combinado. */
  async next(n = this.pageSize): Promise<MergedCommit[]> {
    const out: MergedCommit[] = [];
    while (out.length < n) {
      // Todo repo no agotado necesita al menos un commit en buffer para comparar fechas.
      await Promise.all(this.sources.map((s) => this.fill(s)));
      let best: { id: string; commit: LogCommit } | undefined;
      for (const [id, s] of this.state) {
        const head = s.items[0];
        if (head && (!best || head.commitTime > best.commit.commitTime)) best = { id, commit: head };
      }
      if (!best) break;
      this.state.get(best.id)!.items.shift();
      out.push({ ...best.commit, repoId: best.id });
    }
    return out;
  }

  private async fill(source: LogSource): Promise<void> {
    const s = this.state.get(source.id)!;
    if (s.items.length > 0 || s.done) return;
    const page = await source.fetch(s.skip, this.pageSize);
    s.skip += page.length;
    if (page.length < this.pageSize) s.done = true;
    s.items.push(...page);
  }
}
