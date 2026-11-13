// Rebase interactivo: lista de commits con su acción (pick, reword, squash, fixup, drop) y el
// "todo" que recibe `git rebase -i`. Puro, sin `vscode`.

export type RebaseAction = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop';

export interface RebaseEntry {
  hash: string;
  action: RebaseAction;
  /** Mensaje nuevo (reword). */
  message?: string;
}

export interface RebaseCommit {
  hash: string;
  short: string;
  subject: string;
  /** Mensaje completo. */
  message: string;
  author: string;
  /** Fecha en ms. */
  time: number;
}

/** `git log --format=REBASE_LOG_FORMAT`: hash, hash corto, autor, fecha (s) y mensaje; registros con \x1e. */
export const REBASE_LOG_FORMAT = '%H%x00%h%x00%an%x00%at%x00%B%x1e';

export function parseRebaseLog(output: string): RebaseCommit[] {
  return output
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r.trim())
    .map((record) => {
      const [hash = '', short = '', author = '', at = '0', message = ''] = record.split('\0');
      const text = message.trim();
      return { hash, short, author, time: Number(at) * 1000, message: text, subject: text.split('\n')[0] ?? '' };
    });
}

/** Motivo por el que el plan no se puede ejecutar, o undefined. */
export function validatePlan(entries: readonly RebaseEntry[]): string | undefined {
  const kept = entries.filter((e) => e.action !== 'drop');
  if (kept.length === 0) return 'all-dropped';
  if (kept[0]!.action === 'squash' || kept[0]!.action === 'fixup') return 'first-squash';
  if (entries.some((e) => e.action === 'reword' && !e.message?.trim())) return 'empty-message';
  return undefined;
}

/**
 * Líneas del todo. `reword` se hace con `pick` + `exec git commit --amend -F <archivo>` (así no hace
 * falta un editor); `messageFile(hash)` da la ruta del archivo con el mensaje nuevo.
 */
export function buildTodo(entries: readonly RebaseEntry[], messageFile: (hash: string) => string): string {
  const lines: string[] = [];
  for (const e of entries) {
    if (e.action === 'reword') {
      lines.push(`pick ${e.hash}`);
      lines.push(`exec git commit --amend --allow-empty --no-verify --quiet -F "${messageFile(e.hash).replace(/\\/g, '/')}"`);
    } else {
      lines.push(`${e.action} ${e.hash}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** ¿El plan cambia algo respecto a la historia actual? */
export function isNoop(entries: readonly RebaseEntry[], original: readonly string[]): boolean {
  return entries.length === original.length && entries.every((e, i) => e.action === 'pick' && e.hash === original[i]);
}
