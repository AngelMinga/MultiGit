// Archivos con cambios, plan de commit/rollback y stashes. Puro, sin `vscode`.

/** Letra de estado como en IntelliJ / VS Code. */
export type FileStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';

export interface StatusFile {
  /** Ruta relativa a la raíz del repo (con `/`). */
  path: string;
  /** Ruta original en renombrados/copias. */
  origPath?: string;
  /** Columnas X (índice) e Y (working tree) de `git status`. */
  index: string;
  worktree: string;
  kind: 'tracked' | 'untracked' | 'conflict';
  status: FileStatus;
}

export const STATUS_LABEL: Record<FileStatus, string> = {
  M: 'Modificado',
  A: 'Añadido',
  D: 'Eliminado',
  R: 'Renombrado',
  C: 'Copiado',
  T: 'Cambio de tipo',
  U: 'En conflicto',
  '?': 'Sin versionar',
};

/**
 * Parsea `git status --porcelain=v2 -z` (con o sin `--branch`) a una lista de archivos.
 * Campos antes de la ruta: tipo 1 → 8, tipo 2 → 9 (+ ruta original en el registro siguiente),
 * tipo u → 10. Las rutas pueden tener espacios, por eso se corta por posición.
 */
export function parseStatusFiles(output: string): StatusFile[] {
  const records = output.split('\0');
  const files: StatusFile[] = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!r) continue;
    const type = r[0];
    if (type === '?') {
      files.push({ path: r.slice(2), index: '?', worktree: '?', kind: 'untracked', status: '?' });
      continue;
    }
    if (type !== '1' && type !== '2' && type !== 'u') continue; // '#' cabeceras, '!' ignorados
    const x = r[2] ?? '.';
    const y = r[3] ?? '.';
    const fieldsBeforePath = type === '1' ? 8 : type === '2' ? 9 : 10;
    const filePath = afterNthSpace(r, fieldsBeforePath);

    if (type === 'u') {
      files.push({ path: filePath, index: x, worktree: y, kind: 'conflict', status: 'U' });
      continue;
    }
    const file: StatusFile = { path: filePath, index: x, worktree: y, kind: 'tracked', status: deriveStatus(type, x, y) };
    if (type === '2') file.origPath = records[++i] ?? '';
    files.push(file);
  }
  return files;
}

function afterNthSpace(text: string, n: number): string {
  let pos = -1;
  for (let k = 0; k < n; k++) {
    pos = text.indexOf(' ', pos + 1);
    if (pos < 0) return '';
  }
  return text.slice(pos + 1);
}

function deriveStatus(type: string, x: string, y: string): FileStatus {
  if (type === '2') return x === 'C' || y === 'C' ? 'C' : 'R';
  if (x === 'A' || y === 'A') return 'A';
  if (x === 'D' || y === 'D') return 'D';
  if (x === 'T' || y === 'T') return 'T';
  return 'M';
}

// ------------------------------------------------------------------ commit

export interface CommitPlan {
  /** Archivos sin versionar que hay que `git add` antes del commit. */
  add: string[];
  /** Pathspec del commit (incluye la ruta original de los renombrados). */
  paths: string[];
}

/** Qué hay que agregar y qué paths pasar a `git commit -- <paths>` para commitear solo `files`. */
export function planCommit(files: readonly StatusFile[]): CommitPlan {
  const add: string[] = [];
  const paths = new Set<string>();
  for (const f of files) {
    if (f.kind === 'untracked') add.push(f.path);
    paths.add(f.path);
    if (f.origPath) paths.add(f.origPath);
  }
  return { add, paths: [...paths] };
}

// ------------------------------------------------------------------ rollback

export interface RollbackPlan {
  /** `git restore --source=HEAD --staged --worktree -- <restore>` (modificados, borrados, origen de renombrados). */
  restore: string[];
  /** `git rm --cached -- <unstage>` (añadidos y destino de renombrados/copias): vuelven a "sin versionar". */
  unstage: string[];
  /** Archivos que dejarían de estar versionados; se borran del disco solo si el usuario lo pide. */
  added: string[];
}

/** Clasifica los archivos a revertir. Los sin versionar y en conflicto no se revierten. */
export function planRollback(files: readonly StatusFile[]): RollbackPlan {
  const plan: RollbackPlan = { restore: [], unstage: [], added: [] };
  for (const f of files) {
    if (f.kind !== 'tracked') continue;
    if (f.status === 'A' || f.status === 'R' || f.status === 'C') {
      plan.unstage.push(f.path);
      plan.added.push(f.path);
      if (f.status === 'R' && f.origPath) plan.restore.push(f.origPath);
    } else {
      plan.restore.push(f.path);
    }
  }
  return plan;
}

/** "3 modified, 1 added, 1 deleted" en español. */
export function describeCounts(files: readonly StatusFile[]): string {
  const count = (pred: (f: StatusFile) => boolean) => files.filter(pred).length;
  const parts = [
    [count((f) => f.status === 'M' || f.status === 'T'), 'modificado(s)'],
    [count((f) => f.status === 'A' || f.status === 'C'), 'añadido(s)'],
    [count((f) => f.status === 'D'), 'eliminado(s)'],
    [count((f) => f.status === 'R'), 'renombrado(s)'],
    [count((f) => f.status === '?'), 'sin versionar'],
  ] as const;
  const text = parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
  return text.length ? text.join(', ') : 'sin archivos';
}

// ------------------------------------------------------------------ shelf (stash)

export const SHELF_PREFIX = 'MultiGit: ';

export interface StashEntry {
  /** `stash@{0}` */
  ref: string;
  /** Mensaje sin el prefijo "On <rama>: ". */
  message: string;
}

/** Parsea `git stash list --format=%gd%x00%gs`. */
export function parseStashList(output: string): StashEntry[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref = '', subject = ''] = line.split('\0');
      return { ref, message: subject.replace(/^(On|WIP on) [^:]+: /, '') };
    });
}
