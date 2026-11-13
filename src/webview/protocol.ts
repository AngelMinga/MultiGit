// Mensajes tipados entre el extension host y los webviews (type + payload).
// Este archivo lo importan ambos lados (`import type` desde webview-ui), así que no debe
// importar `vscode` ni módulos de Node (solo tipos de módulos puros).
import type { LogFilters, RefLabel } from '../git/log';

export type { LogFilters, RefLabel };

/** Paneles webview que existen (el log llega en la Fase 6). */
export type WebviewKind = 'push' | 'commit' | 'log' | 'toolbar' | 'rollback' | 'hunks' | 'rebase' | 'pull' | 'conflicts' | 'merge' | 'remotes';

// ------------------------------------------------------------------ Push

export type PushTagsMode = 'none' | 'all' | 'follow';

export interface PushCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  /** ISO 8601. */
  date: string;
  refs: string[];
}

export interface PushFile {
  status: string;
  path: string;
  oldPath?: string;
}

export type PushRowState = 'idle' | 'running' | 'ok' | 'failed' | 'skipped' | 'pending';

export interface PushRepoView {
  /** Ruta raíz del repo (identificador estable). */
  id: string;
  name: string;
  colorIndex: number;
  /** Rama local a subir; `null` si HEAD está detached. */
  branch: string | null;
  remote: string | null;
  remoteBranch: string | null;
  remotes: string[];
  /** La rama destino no existe en el remote. */
  isNew: boolean;
  commits: PushCommit[];
  /** Hay más commits de los que se listan. */
  truncated: boolean;
  checked: boolean;
  /** Motivo por el que no se puede subir (detached, sin remotes…). */
  skipReason?: string;
  state: PushRowState;
  message?: string;
  /** El remote rechazó el push (no fast-forward): se puede ofrecer "Pull y reintentar". */
  rejected?: boolean;
}

export interface PushState {
  repos: PushRepoView[];
  busy: boolean;
  /** Ya se intentó un push en esta sesión del diálogo. */
  attempted: boolean;
}

// ------------------------------------------------------------------ Commit parcial (hunks)

export interface HunkRowView {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  /** Solo las líneas cambiadas (las que se pueden elegir). */
  id?: string;
  oldNo?: number;
  newNo?: number;
}

export interface HunksState {
  repo: string;
  colorIndex: number;
  path: string;
  /** Un array de filas por hunk. */
  hunks: HunkRowView[][];
  selected: string[];
  /** Aviso (p. ej. la selección anterior ya no valía porque el archivo cambió). */
  notice?: string;
}

// ------------------------------------------------------------------ Conflictos

export type ConflictSide = 'modified' | 'added' | 'deleted';

export interface ConflictFileView {
  path: string;
  yours: ConflictSide;
  theirs: ConflictSide;
  /** Bloques `<<<<<<<` que quedan en el archivo (0 si es binario o ya no tiene marcas). */
  blocks: number;
}

export interface ConflictRepoView {
  id: string;
  name: string;
  colorIndex: number;
  /** "Merging branch X into branch Y", "Rebasing…"… */
  title: string;
  yours: string;
  theirs: string;
  /** Hay un merge/rebase/cherry-pick/revert a medias (Finish lo continúa). */
  operation: string | null;
  files: ConflictFileView[];
  /** Archivos que estaban en conflicto y ya se resolvieron (como "Resolved" de IntelliJ); `blocks` = los que tenía. */
  resolved: Array<{ path: string; blocks: number }>;
}

export interface ConflictsState {
  repos: ConflictRepoView[];
  busy: boolean;
}

// ------------------------------------------------------------------ Ventana de merge propia

export type MergeBlockView =
  | { type: 'stable'; lines: string[] }
  | { type: 'change'; kind: 'ours' | 'theirs' | 'same' | 'conflict'; base: string[]; ours: string[]; theirs: string[] };

export interface MergeState {
  repo: string;
  colorIndex: number;
  path: string;
  /** Nombres de las columnas: tu rama y la que entra. */
  yours: string;
  theirs: string;
  blocks: MergeBlockView[];
  busy: boolean;
}

// ------------------------------------------------------------------ Manage Remotes

export interface RemotesState {
  repos: Array<{ id: string; name: string; colorIndex: number; remotes: Array<{ name: string; url: string; pushUrl?: string }> }>;
  busy: boolean;
}

// ------------------------------------------------------------------ Pull

export interface PullBranchView {
  /** Rama en el remote, sin el remote: `develop`. */
  name: string;
  /** Repos donde existe. */
  exists: number;
  /** Repos cuya rama actual la tiene de upstream. */
  upstream: number;
}

export interface PullScopeView {
  /** `*` = todos los repos; si no, la raíz del repo. */
  id: string;
  label: string;
  /** Repos del alcance. */
  total: number;
  /** Rama actual (la común, o null si difieren). */
  branch: string | null;
  remotes: Array<{ name: string; branches: PullBranchView[]; /** Upstream común de todos, si lo hay. */ common: string | null }>;
}

export interface PullState {
  scopes: PullScopeView[];
  initialScope: string;
  busy: boolean;
}

export type PullModeName = 'merge' | 'rebase' | 'ff-only';

// ------------------------------------------------------------------ Rebase interactivo

export interface RebaseState {
  repo: string;
  colorIndex: number;
  branch: string;
  /** Del más viejo al más nuevo (el orden del todo de git). */
  commits: Array<{ hash: string; short: string; subject: string; message: string; author: string; time: number }>;
  busy: boolean;
}

export type RebaseActionName = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop';

// ------------------------------------------------------------------ Rollback

export interface RollbackFile {
  path: string;
  /** M, A, D, R, C, T… (columna de `git status`). */
  status: string;
  origPath?: string;
}

export interface RollbackRepo {
  id: string;
  name: string;
  colorIndex: number;
  files: RollbackFile[];
}

export interface RollbackState {
  repos: RollbackRepo[];
  /** Claves `${repoId}\0${path}` marcadas al abrir. */
  selected: string[];
  busy: boolean;
}

// ------------------------------------------------------------------ Commit

export interface CommitState {
  /** Archivos marcados en la vista Changes, por repo. */
  repos: Array<{ name: string; colorIndex: number; count: number }>;
  total: number;
  /** "3 modificado(s), 1 añadido(s)" de los archivos marcados. */
  summary: string;
  busy: boolean;
  /** Claude está generando el mensaje. */
  generating: boolean;
  /** Texto con el que se rellena la caja vacía (ticket de la rama según la plantilla), o ''. */
  prefix: string;
}

// ------------------------------------------------------------------ Log

export interface LogRepoInfo {
  id: string;
  name: string;
  colorIndex: number;
  /** Rama actual (o null si HEAD está detached). */
  current: string | null;
  /** SHA de HEAD (para atenuar los commits que no están en la rama actual). */
  head: string | null;
  local: string[];
  /** Commits por subir/bajar de las ramas locales con upstream (solo las que tienen alguno). */
  track: Record<string, { ahead: number; behind: number }>;
  /** Ramas remotas completas (`origin/develop`). */
  remote: string[];
  tags: string[];
}

export interface LogRow {
  repoId: string;
  hash: string;
  shortHash: string;
  parents: string[];
  subject: string;
  author: string;
  email: string;
  /** Fecha de autor (ms). */
  date: number;
  refs: RefLabel[];
}

/** Archivos del detalle de un commit contra una base (en un merge, uno por padre, como IntelliJ). */
export interface LogFileGroup {
  /** Vacío = grupo único (commit normal). */
  title: string;
  /** Revisión contra la que se compara (null = commit raíz). */
  base: string | null;
  files: PushFile[];
}

export interface LogDetails {
  repoId: string;
  hash: string;
  body: string;
  committer: string;
  commitTime: number;
  files: PushFile[];
  groups: LogFileGroup[];
  /** Ramas locales que contienen el commit. */
  branches: string[];
  /** El commit es alcanzable desde HEAD. */
  inHead: boolean;
}

/** Acciones del menú contextual de una rama en el árbol del Git Log (las mismas que la vista Ramas). */
export type LogBranchAction =
  | 'checkout'
  | 'newBranch'
  | 'checkoutAndRebase'
  | 'compare'
  | 'compareFiles'
  | 'diffWorkingTree'
  | 'rebaseOnto'
  | 'merge'
  | 'newWorktree'
  | 'update'
  | 'push'
  | 'pullRequests'
  | 'rename'
  | 'delete'
  | 'navigate';

export type LogAction = 'copyHash' | 'checkout' | 'cherryPick' | 'revert' | 'reset' | 'newBranch' | 'newTag' | 'interactiveRebase';

// ------------------------------------------------------------------ Toolbar (Proyecto)

export interface ToolbarState {
  project: string;
  /** Color del cuadrado del proyecto (índice de la paleta de repos). */
  projectColor: number;
  /** Texto del botón de rama: la rama común o "3 ramas". */
  branch: string;
  mixed: boolean;
  repos: number;
  ahead: number;
  behind: number;
  changes: number;
}

export type ToolbarAction = 'project' | 'branches' | 'log' | 'changes';

// ------------------------------------------------------------------ mensajes

/** Host → webview. */
export type HostMessage =
  | { type: 'init'; payload: { kind: WebviewKind } }
  | { type: 'error'; payload: { message: string } }
  | { type: 'push/state'; payload: PushState }
  | {
      type: 'push/files';
      payload: {
        repoId: string;
        hash: string;
        files: PushFile[];
        /** Detalle del commit elegido (mensaje completo, autor con email y fecha), como IntelliJ. */
        details?: { body: string; author: string; email: string; date: string };
      };
    }
  | { type: 'rollback/state'; payload: RollbackState }
  | { type: 'hunks/state'; payload: HunksState }
  | { type: 'rebase/state'; payload: RebaseState }
  | { type: 'pull/state'; payload: PullState }
  | { type: 'conflicts/state'; payload: ConflictsState }
  | { type: 'merge/state'; payload: MergeState }
  | { type: 'remotes/state'; payload: RemotesState }
  | { type: 'commit/state'; payload: CommitState }
  | { type: 'commit/setMessage'; payload: { message: string } }
  | { type: 'commit/done'; payload: Record<string, never> }
  | { type: 'commit/partial'; payload: { text: string } }
  | { type: 'commit/replaceMessage'; payload: { message: string } }
  | { type: 'commit/requestHistory'; payload: Record<string, never> }
  | {
      type: 'log/init';
      payload: { repos: LogRepoInfo[]; me: { name: string; email: string }; filters: LogFilters; favorites: string[] };
    }
  | { type: 'log/filters'; payload: LogFilters }
  | { type: 'log/rows'; payload: { generation: number; reset: boolean; rows: LogRow[]; hasMore: boolean } }
  | { type: 'log/loading'; payload: { generation: number; loading: boolean } }
  | { type: 'log/details'; payload: LogDetails }
  | { type: 'log/reveal'; payload: { repoId: string; hash: string } }
  | { type: 'toolbar/state'; payload: ToolbarState };

/** Webview → host. */
export type WebviewMessage =
  | { type: 'ready'; payload: Record<string, never> }
  | { type: 'log'; payload: { level: 'info' | 'warn' | 'error'; message: string } }
  | { type: 'push/toggle'; payload: { repoIds: string[]; checked: boolean } }
  | { type: 'push/setTarget'; payload: { repoIds: string[]; remote?: string; branch?: string } }
  | { type: 'push/selectCommit'; payload: { repoId: string; hash: string } }
  | { type: 'push/selectRepo'; payload: { repoId: string } }
  | { type: 'push/openDiff'; payload: { repoId: string; hash: string; file: PushFile; /** Diff del rango base..hash (archivos del repo entero). */ base?: string } }
  | { type: 'push/run'; payload: { repoIds: string[]; tags: PushTagsMode; force: boolean } }
  | { type: 'push/pullAndRetry'; payload: { tags: PushTagsMode } }
  | { type: 'push/close'; payload: Record<string, never> }
  | { type: 'rollback/run'; payload: { keys: string[]; deleteAdded: boolean } }
  | { type: 'rollback/openDiff'; payload: { repoId: string; path: string } }
  | { type: 'rollback/close'; payload: Record<string, never> }
  | { type: 'hunks/save'; payload: { selected: string[] } }
  | { type: 'hunks/openDiff'; payload: Record<string, never> }
  | { type: 'hunks/close'; payload: Record<string, never> }
  | { type: 'rebase/start'; payload: { entries: Array<{ hash: string; action: RebaseActionName; message?: string }> } }
  | { type: 'rebase/close'; payload: Record<string, never> }
  | { type: 'pull/run'; payload: { scopeId: string; remote: string; /** null = el upstream de cada repo. */ branch: string | null; mode: PullModeName } }
  | { type: 'pull/close'; payload: Record<string, never> }
  | { type: 'conflicts/accept'; payload: { repoId: string; paths: string[]; side: 'ours' | 'theirs' } }
  | { type: 'conflicts/open'; payload: { repoId: string; path: string } }
  | { type: 'conflicts/finish'; payload: Record<string, never> }
  | { type: 'conflicts/close'; payload: Record<string, never> }
  | { type: 'merge/save'; payload: { content: string; /** Marcar el archivo como resuelto (git add). */ resolve: boolean } }
  | { type: 'merge/acceptSide'; payload: { side: 'ours' | 'theirs' } }
  | { type: 'merge/close'; payload: Record<string, never> }
  | { type: 'remotes/add'; payload: { repoId?: string } }
  | { type: 'remotes/addAll'; payload: Record<string, never> }
  | { type: 'remotes/edit'; payload: { repoId: string; name: string } }
  | { type: 'remotes/remove'; payload: { repoId: string; name: string } }
  | { type: 'remotes/close'; payload: Record<string, never> }
  | { type: 'commit/run'; payload: { message: string; amend: boolean; push: boolean } }
  | { type: 'commit/requestLastMessage'; payload: Record<string, never> }
  | { type: 'commit/generate'; payload: { current: string } }
  | { type: 'commit/cancelGenerate'; payload: Record<string, never> }
  | { type: 'commit/history'; payload: { current: string } }
  | { type: 'log/setFilters'; payload: LogFilters }
  | { type: 'log/loadMore'; payload: { generation: number } }
  | { type: 'log/select'; payload: { repoId: string; hash: string } }
  | { type: 'log/openDiff'; payload: { repoId: string; hash: string; file: PushFile; /** Comparar contra esta revisión (otro padre de un merge). */ base?: string | null } }
  | { type: 'log/action'; payload: { action: LogAction; repoId: string; hash: string } }
  | { type: 'log/branchAction'; payload: { action: LogBranchAction; branch: string; repoIds: string[] } }
  | { type: 'log/refresh'; payload: Record<string, never> }
  | { type: 'log/resolveRef'; payload: { ref: string; repoIds: string[] } }
  | { type: 'toolbar/action'; payload: { action: ToolbarAction } };
