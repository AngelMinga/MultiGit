// Diálogo de Pull: QuickPick encadenado Repositorio (o Todos) → Remote → Rama → Modo,
// con botón ← para volver al paso anterior.
import * as vscode from 'vscode';
import { formatAheadBehind } from '../git/branchSummary';
import type { RepoBranches } from '../git/branches';
import { errorText, runInRepos } from '../git/MultiRepoRunner';
import { describeHead } from '../git/parsers';
import {
  commonUpstream,
  PULL_MODE_LABEL,
  remoteBranchChoices,
  remotesOf,
  type PullMode,
  type PullRepoInput,
} from '../git/pull';
import type { Repo, RepoManager } from '../git/RepoManager';

const BACK = Symbol('back');
type Back = typeof BACK;

/** Destino: el upstream de cada repo, o una rama concreta de un remote. */
type Target = { kind: 'upstream' } | { kind: 'branch'; remote: string; branch: string };

interface Item<T> extends vscode.QuickPickItem {
  value?: T;
}

export async function showPullDialog(manager: RepoManager, initialRepo?: Repo): Promise<void> {
  const all = manager.all;
  if (all.length === 0) {
    void vscode.window.showInformationMessage('MultiGit: no hay repositorios detectados.');
    return;
  }

  // Estado del asistente
  let step = initialRepo ? 1 : 0;
  let repos: readonly Repo[] = initialRepo ? [initialRepo] : all;
  let data: Map<Repo, RepoBranches> | undefined;
  let remote: string | undefined;
  let target: Target | undefined;
  const totalSteps = 4;
  /** Pasos visitados (para ←). El paso de remote no se guarda si se saltó por haber uno solo. */
  const history: number[] = [];
  const forward = (next: number) => {
    history.push(step);
    step = next;
  };
  const back = () => {
    step = history.pop() ?? step;
  };

  for (;;) {
    const canGoBack = history.length > 0;
    if (step === 0) {
      // ------------------------------------------------ 1. repositorio
      const picked = await pick<readonly Repo[]>(
        [
          { label: '$(repo-clone) Todos los repositorios', description: `${all.length} repositorios`, value: all },
          { label: '', kind: vscode.QuickPickItemKind.Separator },
          ...all.map((r) => ({
            label: `$(repo) ${r.name}`,
            description: r.status
              ? `⎇ ${describeHead(r.status)}${r.status.upstream ? ` → ${r.status.upstream}` : ''}  ${formatAheadBehind(r.status)}`
              : '',
            value: [r] as readonly Repo[],
          })),
        ],
        { title: 'Pull: repositorio', step: 1, totalSteps, canGoBack },
      );
      if (!picked) return;
      if (picked === BACK) {
        back();
        continue;
      }
      repos = picked;
      data = undefined;
      forward(1);
    } else if (step === 1) {
      // ------------------------------------------------ 2. remote
      data ??= await loadBranches(repos);
      if (!data) return;
      const inputs = toInputs(repos, data);
      const remotes = remotesOf(inputs);
      if (remotes.length === 0) {
        void vscode.window.showWarningMessage('MultiGit: los repositorios elegidos no tienen remotes.');
        return;
      }
      if (remotes.length === 1) {
        remote = remotes[0];
        step = 2; // sin guardar en el historial: ← vuelve al paso anterior real
        continue;
      }
      const picked = await pick<string>(
        remotes.map((r) => ({
          label: `$(cloud) ${r}`,
          description: `${inputs.filter((i) => i.branches.remotes.includes(r)).length}/${inputs.length} repos`,
          value: r,
        })),
        { title: `Pull: remote — ${scopeLabel(repos)}`, step: 2, totalSteps, canGoBack },
      );
      if (!picked) return;
      if (picked === BACK) {
        back();
        continue;
      }
      remote = picked;
      forward(2);
    } else if (step === 2) {
      // ------------------------------------------------ 3. rama
      const inputs = toInputs(repos, data!);
      const choices = remoteBranchChoices(inputs, remote!, manager.favoriteBranches);
      const common = commonUpstream(inputs, remote!);
      const items: Item<Target>[] = [];
      if (repos.length > 1 && !common) {
        items.push({
          label: '$(arrow-down) Upstream de cada repositorio',
          description: 'cada repo hace pull de la rama que sigue',
          value: { kind: 'upstream' },
        });
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      }
      for (const c of choices) {
        const tags = [
          c.upstreamFor.length === inputs.length ? 'upstream' : c.upstreamFor.length ? `upstream de ${c.upstreamFor.length}` : '',
          c.repos.length < inputs.length ? `existe en ${c.repos.length}/${inputs.length}` : '',
        ].filter(Boolean);
        items.push({
          label: `${c.upstreamFor.length ? '$(arrow-down)' : '$(cloud)'} ${remote}/${c.name}`,
          description: tags.join(' · '),
          value: { kind: 'branch', remote: remote!, branch: c.name },
        });
      }
      const picked = await pick<Target>(items, {
        title: `Pull: rama de ${remote} — ${scopeLabel(repos)}`,
        placeholder: 'Buscar rama remota…',
        step: 3,
        totalSteps,
        canGoBack,
      });
      if (!picked) return;
      if (picked === BACK) {
        back();
        continue;
      }
      target = picked;
      forward(3);
    } else {
      // ------------------------------------------------ 4. modo
      const picked = await pick<PullMode>(
        [
          { label: '$(git-merge) Merge', description: 'por defecto: crea un commit de merge si hace falta', value: 'merge' },
          { label: '$(git-pull-request) Rebase', description: 'reaplica tus commits encima (requiere repo limpio)', value: 'rebase' },
          { label: '$(arrow-right) --ff-only', description: 'solo avanza si no hay commits locales divergentes', value: 'ff-only' },
        ],
        { title: `Pull: ${targetLabel(target!)} — modo`, step: 4, totalSteps, canGoBack },
      );
      if (!picked) return;
      if (picked === BACK) {
        back();
        continue;
      }
      await runPull(manager, repos, data!, target!, picked);
      return;
    }
  }
}

/** Ejecuta el pull en los repos elegidos (preflight → progreso → resumen). */
export async function runPull(
  manager: RepoManager,
  repos: readonly Repo[],
  data: Map<Repo, RepoBranches>,
  target: Target,
  mode: PullMode,
): Promise<void> {
  await runInRepos(manager, {
    title: `Pull ${targetLabel(target)} (${PULL_MODE_LABEL[mode]})`,
    repos,
    requireClean: mode === 'rebase',
    check: (repo, status) => {
      if (!status.branch) return { skip: 'HEAD detached' };
      if (target.kind === 'upstream') {
        if (!status.upstream) return { skip: 'la rama no tiene upstream' };
        if (status.ahead === null) return { skip: `el upstream ${status.upstream} ya no existe` };
      } else if (!data.get(repo)?.remote.some((b) => b.full === `${target.remote}/${target.branch}`)) {
        return { skip: `no existe ${target.remote}/${target.branch}` };
      }
      return undefined;
    },
    run: async (repo) => {
      const before = await repo.git.headSha();
      if (target.kind === 'upstream') await repo.git.pullWith(mode);
      else await repo.git.pullWith(mode, target.remote, target.branch);
      const after = await repo.git.headSha();
      if (!before || !after || before === after) return 'ya estaba al día';
      const count = await repo.git.countCommits(`${before}..${after}`);
      return count ? `actualizado (+${count} commit(s))` : 'actualizado';
    },
  });
}

// ------------------------------------------------------------------ helpers

async function loadBranches(repos: readonly Repo[]): Promise<Map<Repo, RepoBranches> | undefined> {
  try {
    const entries = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'MultiGit: leyendo ramas…' },
      () => Promise.all(repos.map(async (r) => [r, await r.git.getBranches()] as const)),
    );
    return new Map(entries);
  } catch (error) {
    void vscode.window.showErrorMessage(`MultiGit: ${errorText(error)}`);
    return undefined;
  }
}

function toInputs(repos: readonly Repo[], data: Map<Repo, RepoBranches>): PullRepoInput[] {
  return repos.flatMap((r) => {
    const branches = data.get(r);
    return branches ? [{ repo: r.name, branches }] : [];
  });
}

function scopeLabel(repos: readonly Repo[]): string {
  return repos.length === 1 ? repos[0]!.name : `${repos.length} repositorios`;
}

function targetLabel(target: Target): string {
  return target.kind === 'upstream' ? 'del upstream' : `de ${target.remote}/${target.branch}`;
}

/** QuickPick de un paso, con botón ← opcional. Devuelve el valor, BACK o undefined (cancelado). */
function pick<T>(
  items: Item<T>[],
  options: { title: string; placeholder?: string; step: number; totalSteps: number; canGoBack: boolean },
): Promise<T | Back | undefined> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<Item<T>>();
    qp.title = options.title;
    qp.placeholder = options.placeholder;
    qp.step = options.step;
    qp.totalSteps = options.totalSteps;
    qp.matchOnDescription = true;
    qp.items = items;
    if (options.canGoBack) qp.buttons = [vscode.QuickInputButtons.Back];
    let done = false;
    const finish = (value: T | Back | undefined) => {
      if (done) return;
      done = true;
      resolve(value);
      qp.hide();
    };
    qp.onDidTriggerButton((b) => {
      if (b === vscode.QuickInputButtons.Back) finish(BACK);
    });
    qp.onDidAccept(() => {
      const item = qp.selectedItems[0];
      if (item && item.value !== undefined) finish(item.value);
    });
    qp.onDidHide(() => {
      finish(undefined);
      qp.dispose();
    });
    qp.show();
  });
}
