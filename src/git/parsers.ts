import { t } from '../i18n';
// Parsers puros de salidas de git. No importan `vscode` para poder testearlos con vitest.

/** Contadores de cambios sin commit, derivados de `git status --porcelain=v2`. */
export interface ChangeCounts {
  /** Entradas con cambios en el índice (columna X distinta de '.'). */
  staged: number;
  /** Entradas con cambios en el working tree (columna Y distinta de '.'). */
  unstaged: number;
  untracked: number;
  conflicted: number;
  /** Total de archivos con algún cambio (cada archivo se cuenta una vez). */
  total: number;
}

/** Estado de rama y cambios de un repo, a partir de `git status --porcelain=v2 --branch -z`. */
export interface RepoStatus {
  /** Nombre de la rama actual, o `null` si HEAD está detached. */
  branch: string | null;
  /** SHA de HEAD, o `null` si el repo no tiene commits todavía. */
  oid: string | null;
  /** Upstream configurado (p. ej. `origin/develop`), si existe. */
  upstream: string | null;
  /** Commits locales por subir. `null` si no hay upstream o este ya no existe. */
  ahead: number | null;
  /** Commits del upstream por bajar. `null` si no hay upstream o este ya no existe. */
  behind: number | null;
  changes: ChangeCounts;
}

/**
 * Parsea `git status --porcelain=v2 --branch -z`.
 *
 * Con `-z` cada registro termina en NUL y las entradas de tipo `2` (renombrado/copiado)
 * llevan la ruta original en el registro siguiente, que hay que saltar.
 */
export function parseStatusV2(output: string): RepoStatus {
  const result: RepoStatus = {
    branch: null,
    oid: null,
    upstream: null,
    ahead: null,
    behind: null,
    changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, total: 0 },
  };

  const records = output.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;

    if (record.startsWith('# ')) {
      parseHeader(record.slice(2), result);
      continue;
    }

    switch (record[0]) {
      case '1':
      case '2': {
        // "1 XY ..." / "2 XY ... <path>" + registro siguiente con la ruta original.
        const x = record[2];
        const y = record[3];
        if (x !== undefined && x !== '.') result.changes.staged++;
        if (y !== undefined && y !== '.') result.changes.unstaged++;
        result.changes.total++;
        if (record[0] === '2') i++;
        break;
      }
      case 'u':
        result.changes.conflicted++;
        result.changes.total++;
        break;
      case '?':
        result.changes.untracked++;
        result.changes.total++;
        break;
      default:
        // '!' (ignorados) u otros: no cuentan.
        break;
    }
  }

  return result;
}

function parseHeader(header: string, out: Omit<RepoStatus, 'changes'>): void {
  const space = header.indexOf(' ');
  if (space < 0) return;
  const key = header.slice(0, space);
  const value = header.slice(space + 1);

  switch (key) {
    case 'branch.oid':
      out.oid = value === '(initial)' ? null : value;
      break;
    case 'branch.head':
      out.branch = value === '(detached)' ? null : value;
      break;
    case 'branch.upstream':
      out.upstream = value;
      break;
    case 'branch.ab': {
      const match = /^\+(\d+) -(\d+)$/.exec(value);
      if (match) {
        out.ahead = Number(match[1]);
        out.behind = Number(match[2]);
      }
      break;
    }
  }
}

/** Resultado de `git rev-list --left-right --count @{u}...HEAD`. */
export interface AheadBehind {
  /** Lado derecho (HEAD): commits por subir. */
  ahead: number;
  /** Lado izquierdo (@{u}): commits por bajar. */
  behind: number;
}

/** Parsea la salida `"<izquierda>\t<derecha>"` de `rev-list --left-right --count @{u}...HEAD`. */
export function parseLeftRightCount(output: string): AheadBehind {
  const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(output);
  if (!match) {
    throw new Error(t('Unexpected rev-list --left-right --count output: {0}', JSON.stringify(output)));
  }
  return { behind: Number(match[1]), ahead: Number(match[2]) };
}

/** Texto corto de la rama para la UI: nombre o `(detached abc1234)`. */
export function describeHead(status: Pick<RepoStatus, 'branch' | 'oid'>): string {
  if (status.branch) return status.branch;
  if (status.oid) return `(detached ${status.oid.slice(0, 7)})`;
  return t('(no commits)');
}

// ------------------------------------------------------------------ log y archivos de commit

/** Formato de `git log` que entiende `parseLog`: campos separados por NUL, registros por 0x1E. */
export const LOG_FORMAT = '%H%x00%h%x00%s%x00%an%x00%aI%x00%D%x1e';

export interface CommitInfo {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  /** Fecha de autor en ISO 8601. */
  date: string;
  /** Decoraciones (`HEAD -> develop`, `origin/develop`, `tag: v1.0`). */
  refs: string[];
}

export function parseLog(output: string): CommitInfo[] {
  const commits: CommitInfo[] = [];
  for (const record of output.split('\x1e')) {
    const trimmed = record.replace(/^\n+/, '');
    if (!trimmed) continue;
    const [hash = '', shortHash = '', subject = '', author = '', date = '', refs = ''] = trimmed.split('\0');
    if (!hash) continue;
    commits.push({
      hash,
      shortHash,
      subject,
      author,
      date,
      refs: refs ? refs.split(', ').map((r) => r.trim()).filter(Boolean) : [],
    });
  }
  return commits;
}

export interface ChangedFile {
  /** Letra de estado de git: A, M, D, R, C, T, U… */
  status: string;
  path: string;
  /** Ruta anterior en renombrados/copias. */
  oldPath?: string;
}

/** Parsea `--name-status -z`: estado, ruta (y ruta nueva en R/C), todo separado por NUL. */
export function parseNameStatusZ(output: string): ChangedFile[] {
  const tokens = output.split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    if (!raw) continue;
    const status = raw[0]!;
    if (status === 'R' || status === 'C') {
      const oldPath = tokens[++i] ?? '';
      const newPath = tokens[++i] ?? '';
      files.push({ status, path: newPath, oldPath });
    } else {
      files.push({ status, path: tokens[++i] ?? '' });
    }
  }
  return files;
}
