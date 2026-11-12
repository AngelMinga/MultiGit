// Reglas de preflight y resumen de operaciones multi-repo. Puro, sin `vscode`.
import { t } from '../i18n';
import type { RepoStatus } from './parsers';

export type OperationInProgress = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null;

/** "tiene un merge en curso…" (frase completa por operación: cada idioma tiene su gramática). */
function operationBlocker(op: Exclude<OperationInProgress, null>): string {
  switch (op) {
    case 'merge':
      return t('has a merge in progress; finish or abort it first');
    case 'rebase':
      return t('has a rebase in progress; finish or abort it first');
    case 'cherry-pick':
      return t('has a cherry-pick in progress; finish or abort it first');
    case 'revert':
      return t('has a revert in progress; finish or abort it first');
  }
}

export interface PreflightInput {
  status?: RepoStatus;
  operation: OperationInProgress;
  /** Error al leer el estado del repo. */
  error?: string;
}

/**
 * Motivo por el que un repo impide la operación, o `undefined` si puede continuar.
 * Siempre bloquean: estado ilegible, operación a medias y conflictos.
 * Con `requireClean`, también los cambios sin commit.
 */
export function basicBlocker(input: PreflightInput, requireClean: boolean): string | undefined {
  if (input.error || !input.status) return t('could not read the status ({0})', input.error ?? t('unknown'));
  if (input.operation) return operationBlocker(input.operation);
  const c = input.status.changes;
  if (c.conflicted > 0) return t('has {0} conflicted file(s)', c.conflicted);
  if (requireClean && c.total > 0) return t('has {0} uncommitted change(s); commit or stash them first', c.total);
  return undefined;
}

export type StepState = 'ok' | 'failed' | 'skipped' | 'pending';

export interface StepResult {
  repo: string;
  state: StepState;
  message?: string;
  /** Archivos en conflicto que dejó la operación (merge/rebase/pull fallidos). */
  conflicts?: string[];
}

/** Mensaje corto para un repo que quedó con conflictos. */
export function conflictMessage(files: readonly string[]): string {
  const shown = files.slice(0, 3).join(', ');
  const more = files.length > 3 ? t(' and {0} more', files.length - 3) : '';
  return t('conflicts in {0} file(s): {1}{2}', files.length, shown, more);
}

const ICON: Record<StepState, string> = { ok: '✅', failed: '❌', skipped: '⏭', pending: '⏭' };

/** Una línea por repo: ✅ ok / ❌ falló + motivo / ⏭ omitido u no ejecutado. */
export function formatSummary(results: readonly StepResult[]): string {
  return results
    .map((r) => {
      const detail = r.state === 'pending' ? t('not run') : r.message ? firstLine(r.message) : '';
      return `${ICON[r.state]} ${r.repo}${detail ? `: ${detail}` : ''}`;
    })
    .join('\n');
}

export function countByState(results: readonly StepResult[]): Record<StepState, number> {
  const counts: Record<StepState, number> = { ok: 0, failed: 0, skipped: 0, pending: 0 };
  for (const r of results) counts[r.state]++;
  return counts;
}

/** Primera línea útil de un mensaje de git (sin el prefijo "error:"/"fatal:"). */
export function firstLine(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? text;
  return line.replace(/^(error|fatal|hint): /, '');
}

/** El remote rechazó el push porque tiene commits que no están en local (o el lease no coincide). */
export function isRejection(stderr: string): boolean {
  return /\[rejected\]|non-fast-forward|fetch first|stale info/i.test(stderr);
}
