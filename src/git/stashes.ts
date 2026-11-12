// Stashes: lectura de `git stash list` y agrupación entre repos. Puro, sin `vscode`.

/** Prefijo de los stashes que crea Shelve (Changes). */
export const SHELF_PREFIX = 'MultiGit: ';

/** `git stash list --format=…`: ref, hash, fecha (s) y asunto, separados por NUL. */
export const STASH_FORMAT = '%gd%x00%H%x00%ct%x00%gs';

export interface StashEntry {
  /** `stash@{0}` (cambia al borrar o aplicar otros stashes; para operar se busca por `hash`). */
  ref: string;
  hash: string;
  /** Fecha del stash en milisegundos. */
  time: number;
  /** Rama en la que se creó (vacío si HEAD estaba suelto o no se pudo leer). */
  branch: string;
  /** Mensaje sin el prefijo "On <rama>: " / "WIP on <rama>: ". */
  message: string;
}

/** Parsea `git stash list --format=STASH_FORMAT`. */
export function parseStashList(output: string): StashEntry[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref = '', hash = '', time = '0', subject = ''] = line.split('\0');
      const match = /^(?:WIP on|On) ([^:]+): /.exec(subject);
      const branch = match && match[1] !== '(no branch)' ? match[1]! : '';
      return { ref, hash, time: Number(time) * 1000, branch, message: match ? subject.slice(match[0].length) : subject };
    });
}

/** ¿Es un stash creado con Shelve? Devuelve el nombre del shelf. */
export function shelfName(message: string): string | undefined {
  return message.startsWith(SHELF_PREFIX) ? message.slice(SHELF_PREFIX.length) : undefined;
}

export interface StashGroup<R> {
  /** Clave estable mientras no cambien los stashes. */
  key: string;
  message: string;
  /** Un stash por repo, en el orden de los repos. */
  entries: Array<{ repo: R; stash: StashEntry }>;
  /** Fecha del más reciente. */
  time: number;
}

/** Diferencia máxima entre stashes del mismo grupo (se crean juntos con Stash Changes). */
const GROUP_WINDOW_MS = 10 * 60 * 1000;

/**
 * Junta en un grupo los stashes con el mismo mensaje en distintos repos, creados con pocos minutos de
 * diferencia (lo que hace Stash Changes en varios repos a la vez). Más recientes primero.
 */
export function groupStashes<R>(perRepo: ReadonlyArray<{ repo: R; stashes: readonly StashEntry[] }>): Array<StashGroup<R>> {
  const groups: Array<StashGroup<R>> = [];
  const all = perRepo
    .flatMap(({ repo, stashes }, order) => stashes.map((stash) => ({ repo, order, stash })))
    .sort((a, b) => b.stash.time - a.stash.time || a.order - b.order);
  for (const { repo, stash } of all) {
    const group = groups.find(
      (g) =>
        g.message === stash.message &&
        !g.entries.some((e) => e.repo === repo) &&
        g.entries.every((e) => Math.abs(e.stash.time - stash.time) <= GROUP_WINDOW_MS),
    );
    if (group) group.entries.push({ repo, stash });
    else groups.push({ key: stash.hash, message: stash.message, entries: [{ repo, stash }], time: stash.time });
  }
  const order = new Map(perRepo.map(({ repo }, i) => [repo, i]));
  for (const g of groups) g.entries.sort((a, b) => order.get(a.repo)! - order.get(b.repo)!);
  return groups;
}
