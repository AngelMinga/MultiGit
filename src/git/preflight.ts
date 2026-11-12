// Reglas de preflight y resumen de operaciones multi-repo. Puro, sin `vscode`.
import type { RepoStatus } from './parsers';

export type OperationInProgress = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null;

const OPERATION_LABEL: Record<Exclude<OperationInProgress, null>, string> = {
  merge: 'un merge',
  rebase: 'un rebase',
  'cherry-pick': 'un cherry-pick',
  revert: 'un revert',
};

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
  if (input.error || !input.status) return `no se pudo leer el estado (${input.error ?? 'desconocido'})`;
  if (input.operation) return `tiene ${OPERATION_LABEL[input.operation]} en curso; termínalo o abórtalo primero`;
  const c = input.status.changes;
  if (c.conflicted > 0) return `tiene ${c.conflicted} archivo(s) en conflicto`;
  if (requireClean && c.total > 0) return `tiene ${c.total} cambio(s) sin commit; haz commit o stash primero`;
  return undefined;
}

export type StepState = 'ok' | 'failed' | 'skipped' | 'pending';

export interface StepResult {
  repo: string;
  state: StepState;
  message?: string;
}

const ICON: Record<StepState, string> = { ok: '✅', failed: '❌', skipped: '⏭', pending: '⏭' };

/** Una línea por repo: ✅ ok / ❌ falló + motivo / ⏭ omitido u no ejecutado. */
export function formatSummary(results: readonly StepResult[]): string {
  return results
    .map((r) => {
      const detail = r.state === 'pending' ? 'no ejecutado' : r.message ? firstLine(r.message) : '';
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
