// Acciones del Git Log que reescriben la historia de la rama actual (como IntelliJ): Undo Commit, Edit
// Commit Message, Drop Commit, Fixup / Squash Into. Puro, sin `vscode`.
import type { RebaseCommit, RebaseEntry } from './rebase';

/** Lo que se sabe del commit elegido respecto a la rama actual. */
export interface HistoryInfo {
  /** Rama actual (null = HEAD detached). */
  branch: string | null;
  /** El commit está en la rama actual (es HEAD o un antecesor). */
  inBranch: boolean;
  /** Es HEAD. */
  isHead: boolean;
  /** El commit tiene más de un padre. */
  isMerge: boolean;
  /** No tiene padre. */
  isRoot: boolean;
  /** Merges entre el commit y HEAD (un rebase los aplanaría). */
  mergesAfter: number;
}

export type HistoryAction = 'undo' | 'reword' | 'drop' | 'fixup' | 'squash' | 'pushUpTo';

/** Por qué la acción no se puede hacer sobre ese commit (código), o undefined. */
export function historyBlocker(action: HistoryAction, info: HistoryInfo): 'detached' | 'not-in-branch' | 'merge' | 'root' | 'merges-after' | undefined {
  if (!info.branch) return 'detached';
  if (!info.inBranch) return 'not-in-branch';
  if (action === 'pushUpTo') return undefined;
  if (info.isMerge) return 'merge';
  if ((action === 'undo' || action === 'drop') && info.isRoot) return 'root';
  // Cambiar el mensaje de HEAD es un amend; el resto rehace los commits posteriores con un rebase.
  if (action === 'reword' && info.isHead) return undefined;
  if (action === 'undo') return undefined;
  if (info.mergesAfter > 0) return 'merges-after';
  return undefined;
}

/** Todo del rebase que hace Edit Commit Message / Drop sobre `hash` (el resto queda como está). */
export function editPlan(commits: readonly RebaseCommit[], hash: string, change: { action: 'drop' } | { action: 'reword'; message: string }): RebaseEntry[] {
  return commits.map((c) =>
    c.hash !== hash ? { hash: c.hash, action: 'pick' } : change.action === 'drop' ? { hash: c.hash, action: 'drop' } : { hash: c.hash, action: 'reword', message: change.message },
  );
}

/** Mensaje del commit que se integrará en `subject` con autosquash (como "Fixup…" / "Squash Into…" de IntelliJ). */
export function autosquashMessage(kind: 'fixup' | 'squash', subject: string): string {
  return `${kind}! ${subject}`;
}

/** ¿El mensaje es de un commit `fixup!`/`squash!`? Devuelve el tipo y el asunto al que apunta. */
export function parseAutosquash(message: string): { kind: 'fixup' | 'squash'; subject: string } | undefined {
  const m = /^(fixup|squash)! (.+)$/.exec(message.split('\n')[0]?.trim() ?? '');
  return m ? { kind: m[1] as 'fixup' | 'squash', subject: m[2]!.trim() } : undefined;
}
