// Mensajes tipados entre el extension host y los webviews (type + payload).
// Este archivo lo importan ambos lados (`import type` desde webview-ui), así que no debe
// importar `vscode` ni módulos de Node (solo tipos de módulos puros).
import type { LogFilters, RefLabel } from '../git/log';

export type { LogFilters, RefLabel };

/** Paneles webview que existen (el log llega en la Fase 6). */
export type WebviewKind = 'push' | 'commit' | 'log' | 'toolbar' | 'rollback';

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

export interface LogDetails {
  repoId: string;
  hash: string;
  body: string;
  committer: string;
  commitTime: number;
  files: PushFile[];
}

export type LogAction = 'copyHash' | 'checkout' | 'cherryPick' | 'revert' | 'reset' | 'newBranch' | 'newTag';

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
  | { type: 'push/files'; payload: { repoId: string; hash: string; files: PushFile[] } }
  | { type: 'rollback/state'; payload: RollbackState }
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
  | { type: 'push/openDiff'; payload: { repoId: string; hash: string; file: PushFile } }
  | { type: 'push/run'; payload: { repoIds: string[]; tags: PushTagsMode; force: boolean } }
  | { type: 'push/pullAndRetry'; payload: { tags: PushTagsMode } }
  | { type: 'push/close'; payload: Record<string, never> }
  | { type: 'rollback/run'; payload: { keys: string[]; deleteAdded: boolean } }
  | { type: 'rollback/openDiff'; payload: { repoId: string; path: string } }
  | { type: 'rollback/close'; payload: Record<string, never> }
  | { type: 'commit/run'; payload: { message: string; amend: boolean; push: boolean } }
  | { type: 'commit/requestLastMessage'; payload: Record<string, never> }
  | { type: 'commit/generate'; payload: { current: string } }
  | { type: 'commit/cancelGenerate'; payload: Record<string, never> }
  | { type: 'commit/history'; payload: { current: string } }
  | { type: 'log/setFilters'; payload: LogFilters }
  | { type: 'log/loadMore'; payload: { generation: number } }
  | { type: 'log/select'; payload: { repoId: string; hash: string } }
  | { type: 'log/openDiff'; payload: { repoId: string; hash: string; file: PushFile } }
  | { type: 'log/action'; payload: { action: LogAction; repoId: string; hash: string } }
  | { type: 'log/refresh'; payload: Record<string, never> }
  | { type: 'log/resolveRef'; payload: { ref: string; repoIds: string[] } }
  | { type: 'toolbar/action'; payload: { action: ToolbarAction } };
