// Diálogo de conflictos (como el de IntelliJ): estado de cada lado y nombres de las columnas
// Yours / Theirs según la operación a medias. Puro, sin `vscode`.
import type { OperationInProgress } from './preflight';

export type SideState = 'modified' | 'added' | 'deleted';

/** Columnas X (nosotros) e Y (ellos) de un conflicto en `git status`: D, A o U (modificado). */
export function sidesOf(index: string, worktree: string): { yours: SideState; theirs: SideState } {
  const side = (c: string): SideState => (c === 'D' ? 'deleted' : c === 'A' ? 'added' : 'modified');
  return { yours: side(index), theirs: side(worktree) };
}

/** Bloques de conflicto que quedan en el texto (`<<<<<<<` al principio de una línea). */
export function countConflictBlocks(text: string): number {
  return (text.match(/^<{7}(?: |$)/gm) ?? []).length;
}

/** Rama de un mensaje de merge: "Merge branch 'x' of url into y" / "Merge remote-tracking branch 'origin/x'". */
export function branchFromMergeMessage(message: string): string | undefined {
  return /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(message)?.[1];
}

export interface ConflictLabels {
  operation: OperationInProgress | 'stash';
  /** Lo que se está integrando (rama, commit o stash). */
  incoming: string;
  /** Rama o commit sobre el que se integra. */
  current: string;
}

/**
 * Nombres de las columnas. En git, "ours" (Yours) es siempre la etapa 2 y "theirs" la 3; en un rebase
 * ours es la rama sobre la que se rebasea y theirs tu commit, así que se nombran así.
 */
export function columnNames(labels: ConflictLabels): { yours: string; theirs: string } {
  return { yours: labels.current, theirs: labels.incoming };
}
