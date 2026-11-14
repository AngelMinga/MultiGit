// Changelists (como IntelliJ): listas con nombre dentro de Changes. Cada archivo con cambios está en una;
// los que aparecen nuevos van a la lista activa. Puro, sin `vscode`: el estado se guarda por workspace.

export const DEFAULT_LIST = 'default';

export interface Changelist {
  id: string;
  name: string;
  /** Descripción (IntelliJ la usa como mensaje de commit propuesto). */
  comment?: string;
}

export interface ChangelistState {
  lists: Changelist[];
  /** Lista activa: ahí van los cambios nuevos y sus archivos entran marcados en el commit. */
  active: string;
  /** Archivo (`raíz\0ruta`) → id de su lista. */
  assign: Record<string, string>;
}

export function initialState(defaultName = 'Changes'): ChangelistState {
  return { lists: [{ id: DEFAULT_LIST, name: defaultName }], active: DEFAULT_LIST, assign: {} };
}

/** Estado leído del almacenamiento, reparado si le falta algo (lista por defecto, activa que no existe…). */
export function normalize(raw: Partial<ChangelistState> | undefined, defaultName = 'Changes'): ChangelistState {
  const lists = Array.isArray(raw?.lists) ? raw.lists.filter((l) => l && typeof l.id === 'string' && typeof l.name === 'string') : [];
  if (!lists.some((l) => l.id === DEFAULT_LIST)) lists.unshift({ id: DEFAULT_LIST, name: defaultName });
  const ids = new Set(lists.map((l) => l.id));
  const active = raw?.active && ids.has(raw.active) ? raw.active : DEFAULT_LIST;
  const assign: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw?.assign ?? {})) if (ids.has(v)) assign[k] = v;
  return { lists, active, assign };
}

/** Lista de un archivo (la activa si todavía no tiene). */
export function listOf(state: ChangelistState, key: string): string {
  return state.assign[key] ?? state.active;
}

/**
 * Tras leer los cambios: los archivos nuevos quedan en la lista activa y se olvidan los que ya no tienen
 * cambios. Devuelve el mismo objeto si no cambió nada.
 */
export function sync(state: ChangelistState, keys: readonly string[]): ChangelistState {
  const alive = new Set(keys);
  let changed = false;
  const assign: Record<string, string> = {};
  for (const [k, v] of Object.entries(state.assign)) {
    if (alive.has(k)) assign[k] = v;
    else changed = true;
  }
  for (const k of keys) {
    if (!(k in assign)) {
      assign[k] = state.active;
      changed = true;
    }
  }
  return changed ? { ...state, assign } : state;
}

/** Motivo por el que el nombre no vale ('empty' | 'duplicate'), o undefined. */
export function validateName(state: ChangelistState, name: string, exceptId?: string): 'empty' | 'duplicate' | undefined {
  const n = name.trim();
  if (!n) return 'empty';
  if (state.lists.some((l) => l.id !== exceptId && l.name.trim().toLowerCase() === n.toLowerCase())) return 'duplicate';
  return undefined;
}

export function addList(state: ChangelistState, id: string, name: string, comment?: string): ChangelistState {
  return { ...state, lists: [...state.lists, { id, name: name.trim(), ...(comment?.trim() ? { comment: comment.trim() } : {}) }] };
}

export function editList(state: ChangelistState, id: string, name: string, comment?: string): ChangelistState {
  return {
    ...state,
    lists: state.lists.map((l) => (l.id === id ? { id, name: name.trim(), ...(comment?.trim() ? { comment: comment.trim() } : {}) } : l)),
  };
}

/** Borra una lista (no la de por defecto): sus archivos pasan a la de por defecto. */
export function removeList(state: ChangelistState, id: string): ChangelistState {
  if (id === DEFAULT_LIST) return state;
  const assign: Record<string, string> = {};
  for (const [k, v] of Object.entries(state.assign)) assign[k] = v === id ? DEFAULT_LIST : v;
  return { lists: state.lists.filter((l) => l.id !== id), active: state.active === id ? DEFAULT_LIST : state.active, assign };
}

export function setActive(state: ChangelistState, id: string): ChangelistState {
  return state.lists.some((l) => l.id === id) ? { ...state, active: id } : state;
}

export function moveTo(state: ChangelistState, keys: readonly string[], id: string): ChangelistState {
  if (!state.lists.some((l) => l.id === id)) return state;
  const assign = { ...state.assign };
  for (const k of keys) assign[k] = id;
  return { ...state, assign };
}

/** Listas en el orden del árbol: la de por defecto primero y luego por nombre (como IntelliJ). */
export function orderedLists(state: ChangelistState): Changelist[] {
  return [...state.lists].sort((a, b) => (a.id === DEFAULT_LIST ? -1 : b.id === DEFAULT_LIST ? 1 : a.name.localeCompare(b.name)));
}
