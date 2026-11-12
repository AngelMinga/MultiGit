// Merge / rebase / cherry-pick / revert a medias: textos y detección de marcas de conflicto. Puro.
import type { OperationInProgress } from './preflight';

export type Operation = Exclude<OperationInProgress, null>;

export const OPERATION_LABEL: Record<Operation, string> = {
  merge: 'MERGE',
  rebase: 'REBASE',
  'cherry-pick': 'CHERRY-PICK',
  revert: 'REVERT',
};

/** Operaciones que admiten `--skip` (saltar el commit actual). */
export function canSkip(op: Operation): boolean {
  return op === 'rebase' || op === 'cherry-pick';
}

/** ¿El texto todavía tiene marcas de conflicto de git? */
export function hasConflictMarkers(text: string): boolean {
  return /^<{7}( |$)/m.test(text) && /^>{7}( |$)/m.test(text);
}
