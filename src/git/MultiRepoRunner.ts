// Ejecutor de operaciones en varios repos (regla 5 del plan):
//  1. Preflight en todos: si alguno impide la operación, se muestra cuál y por qué y NO se toca ninguno.
//  2. Ejecución repo por repo con progreso ("3/9 mftheme…").
//  3. Si uno falla, se detiene y muestra el resumen ✅ / ❌ / ⏭.
import * as vscode from 'vscode';
import { GitError } from './GitService';
import type { RepoStatus } from './parsers';
import { basicBlocker, countByState, formatSummary, type StepResult } from './preflight';
import type { Repo, RepoManager } from './RepoManager';

/** Resultado del chequeo propio de una operación para un repo. */
export type Verdict = { block: string } | { skip: string } | undefined;

export interface MultiRepoOperation {
  /** Título visible, p. ej. "Checkout de 'develop'". */
  title: string;
  repos: readonly Repo[];
  /** Si es true, los repos con cambios sin commit bloquean la operación. */
  requireClean?: boolean;
  /** Chequeo propio de la operación (se ejecuta después del básico). */
  check?: (repo: Repo, status: RepoStatus) => Promise<Verdict> | Verdict;
  /** Ejecuta la operación en un repo. Puede devolver un mensaje para el resumen. */
  run: (repo: Repo) => Promise<string | void>;
  /** No mostrar los mensajes finales (el llamador muestra el resumen; los bloqueos sí se muestran). */
  silent?: boolean;
  /** Se llama justo antes de ejecutar en cada repo. */
  onStart?: (repo: Repo) => void;
  /** Se llama con el resultado de cada repo (también los omitidos y los no ejecutados). */
  onStep?: (repo: Repo, result: StepResult) => void;
}

export async function runInRepos(manager: RepoManager, op: MultiRepoOperation): Promise<StepResult[] | undefined> {
  const repos = op.repos;
  if (repos.length === 0) {
    void vscode.window.showInformationMessage(`MultiGit: ${op.title}: no hay repositorios.`);
    return undefined;
  }

  const outcome = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `MultiGit: ${op.title}`, cancellable: true },
    async (progress, token) => {
      // 1. Preflight
      progress.report({ message: `comprobando ${repos.length} repositorio(s)…` });
      const verdicts = await Promise.all(repos.map((repo) => preflight(repo, op)));
      const blockers = repos.flatMap((repo, i) => {
        const v = verdicts[i];
        return v && 'block' in v ? [{ repo, reason: v.block }] : [];
      });
      if (blockers.length > 0) return { kind: 'blocked', blockers } as const;

      // 2. Ejecución repo por repo
      const results: StepResult[] = repos.map((repo, i) => {
        const v = verdicts[i];
        return v && 'skip' in v ? { repo: repo.name, state: 'skipped', message: v.skip } : { repo: repo.name, state: 'pending' };
      });
      const toRun = results.filter((r) => r.state === 'pending').length;
      let done = 0;
      for (let i = 0; i < repos.length; i++) {
        const result = results[i]!;
        if (result.state !== 'pending') continue;
        if (token.isCancellationRequested) break;
        const repo = repos[i]!;
        progress.report({ message: `${++done}/${toRun} ${repo.name}…`, increment: 100 / toRun });
        op.onStart?.(repo);
        try {
          const message = await op.run(repo);
          result.state = 'ok';
          if (message) result.message = message;
        } catch (error) {
          result.state = 'failed';
          result.message = errorText(error);
        }
        op.onStep?.(repo, result);
        if (result.state === 'failed') break; // 3. se detiene al primer fallo
      }
      results.forEach((r, i) => {
        if (r.state === 'skipped' || r.state === 'pending') op.onStep?.(repos[i]!, r);
      });
      return { kind: 'done', results } as const;
    },
  );

  await manager.refreshStatusesNow(repos);

  if (outcome.kind === 'blocked') {
    const detail = [
      ...outcome.blockers.map((b) => `❌ ${b.repo.name}: ${b.reason}`),
      '',
      'No se modificó ningún repositorio.',
    ].join('\n');
    void vscode.window.showErrorMessage(`MultiGit: no se puede ejecutar "${op.title}"`, { modal: true, detail });
    return undefined;
  }

  const { results } = outcome;
  if (op.silent) return results;
  const counts = countByState(results);
  const summary = formatSummary(results);
  if (counts.failed > 0 || counts.pending > 0) {
    const failed = results.find((r) => r.state === 'failed');
    const head = failed
      ? `MultiGit: "${op.title}" falló en ${failed.repo}`
      : `MultiGit: "${op.title}" cancelado`;
    const actions = failed && /conflict/i.test(failed.message ?? '') ? ['Abrir Source Control'] : [];
    void vscode.window.showErrorMessage(head, { modal: true, detail: summary }, ...actions).then((choice) => {
      if (choice) void vscode.commands.executeCommand('workbench.view.scm');
    });
  } else if (counts.skipped > 0) {
    void vscode.window.showInformationMessage(
      `MultiGit: "${op.title}" — ${counts.ok} ok, ${counts.skipped} omitido(s)`,
      'Ver detalle',
    ).then((choice) => {
      if (choice) void vscode.window.showInformationMessage(op.title, { modal: true, detail: summary });
    });
  } else {
    void vscode.window.showInformationMessage(`✅ MultiGit: "${op.title}" en ${counts.ok} repositorio(s)`);
  }
  return results;
}

async function preflight(repo: Repo, op: MultiRepoOperation): Promise<Verdict> {
  try {
    const [status, operation] = await Promise.all([repo.git.getStatus(), repo.git.getOperationInProgress()]);
    const reason = basicBlocker({ status, operation }, op.requireClean ?? false);
    if (reason) return { block: reason };
    return (await op.check?.(repo, status)) ?? undefined;
  } catch (error) {
    return { block: basicBlocker({ operation: null, error: errorText(error) }, false)! };
  }
}

/** Texto de error para el usuario: stderr de git si lo hay. */
export function errorText(error: unknown): string {
  if (error instanceof GitError) return error.stderr.trim() || error.message;
  return error instanceof Error ? error.message : String(error);
}
