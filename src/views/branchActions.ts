// Acciones del popup de ramas. Todas las que modifican varios repos pasan por runInRepos
// (preflight → progreso → resumen) y las destructivas piden confirmación modal.
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import * as vscode from 'vscode';
import { summarizeBranches } from '../git/branchSummary';
import { branchToFolderName, commonAncestor, type LocalBranch } from '../git/branches';
import { errorText, runInRepos } from '../git/MultiRepoRunner';
import type { Repo, RepoManager } from '../git/RepoManager';
import type { CompareView } from './compareView';
import { showPullDialog } from './pullDialog';

/** Repos sobre los que actúa una acción: todos, o uno elegido en "Repositorios". */
export interface Scope {
  repos: readonly Repo[];
  /** "todos los repositorios" o el nombre del repo. */
  label: string;
}

export type BranchRef =
  | { type: 'local'; name: string }
  | { type: 'remote'; remote: string; name: string; full: string };

export function refName(ref: BranchRef): string {
  return ref.type === 'local' ? ref.name : ref.full;
}

/** Nombre de la rama actual para los textos: la común, o "rama actual" si difieren. */
export function currentLabel(scope: Scope): string {
  const s = summarizeBranches(scope.repos);
  return s.kind === 'single' ? s.branch : 'rama actual';
}

export class BranchActions {
  constructor(
    private readonly manager: RepoManager,
    private readonly compareView: CompareView,
    private readonly openPush: (scope: Scope, branch?: string) => Promise<void>,
  ) {}

  // ------------------------------------------------------------------ acciones generales

  /** Update Project: fetch + pull (merge) del upstream en cada repo. */
  async updateProject(scope: Scope): Promise<void> {
    await runInRepos(this.manager, {
      title: 'Update Project',
      repos: scope.repos,
      check: (_repo, status) => {
        if (!status.branch) return { skip: 'HEAD detached' };
        if (!status.upstream) return { skip: 'la rama no tiene upstream' };
        if (status.ahead === null) return { skip: `el upstream ${status.upstream} ya no existe` };
        return undefined;
      },
      run: async (repo) => {
        await repo.git.fetchAll();
        const after = await repo.git.getStatus();
        if (!after.behind) return 'ya estaba al día';
        await repo.git.pull();
        return `actualizado (↓${after.behind})`;
      },
    });
  }

  /** Pull…: diálogo Repositorio → Remote → Rama → Modo (con el repo ya elegido si el alcance es uno). */
  async pull(scope: Scope): Promise<void> {
    await showPullDialog(this.manager, scope.repos.length === 1 ? scope.repos[0] : undefined);
  }

  /** Commit…: enfoca la caja de commit de MultiGit. */
  async commit(): Promise<void> {
    await vscode.commands.executeCommand('multigit.commitFocus');
  }

  /** New Branch… desde la rama actual (o desde `start`). */
  async newBranch(scope: Scope, start?: BranchRef): Promise<void> {
    const startRef = start ? refName(start) : 'HEAD';
    const name = await this.askBranchName(
      scope,
      start ? `Nueva rama desde '${startRef}' — ${scope.label}` : `Nueva rama desde '${currentLabel(scope)}' — ${scope.label}`,
    );
    if (!name) return;

    const mode = await vscode.window.showQuickPick(
      [
        { label: '$(check) Crear y hacer checkout', checkout: true },
        { label: '$(add) Solo crear', checkout: false },
      ],
      { title: `Nueva rama '${name}'`, placeHolder: '¿Hacer checkout de la nueva rama?' },
    );
    if (!mode) return;

    await runInRepos(this.manager, {
      title: `Nueva rama '${name}'${start ? ` desde '${startRef}'` : ''}`,
      repos: scope.repos,
      check: async (repo, status) => {
        const branches = await repo.git.getBranches();
        if (branches.local.some((b) => b.name === name)) return { block: `la rama '${name}' ya existe` };
        if (start && !(await repo.git.revisionExists(startRef))) return { block: `no existe '${startRef}'` };
        if (!status.oid) return { block: 'el repositorio no tiene commits' };
        return undefined;
      },
      run: async (repo) => {
        await repo.git.createBranch(name, startRef, mode.checkout);
      },
    });
  }

  /** Checkout Tag or Revision… (HEAD queda detached). */
  async checkoutRevision(scope: Scope): Promise<void> {
    const ref = (
      await vscode.window.showInputBox({
        title: `Checkout de tag o revisión — ${scope.label}`,
        prompt: 'Tag, hash de commit o cualquier revisión (p. ej. v1.4.0, a1b2c3d, HEAD~2)',
        validateInput: (v) => (!v.trim() ? 'Escribe una revisión' : v.trim().startsWith('-') ? 'Revisión no válida' : undefined),
      })
    )?.trim();
    if (!ref || !(await this.confirmDirty(scope, `Checkout de '${ref}'`))) return;

    await runInRepos(this.manager, {
      title: `Checkout de '${ref}'`,
      repos: scope.repos,
      check: async (repo) => ((await repo.git.revisionExists(ref)) ? undefined : { block: `no existe la revisión '${ref}'` }),
      run: async (repo) => {
        await repo.git.checkoutDetached(ref);
      },
    });
  }

  /** Push…: abre el diálogo Push Commits para la rama actual (o `branch`) de cada repo. */
  async push(scope: Scope, branch?: string): Promise<void> {
    await this.openPush(scope, branch);
  }

  // ------------------------------------------------------------------ acciones sobre una rama

  async checkout(scope: Scope, ref: BranchRef): Promise<void> {
    if (!(await this.confirmDirty(scope, `Checkout de '${refName(ref)}'`))) return;

    await runInRepos(this.manager, {
      title: `Checkout de '${refName(ref)}'`,
      repos: scope.repos,
      check: (_repo, status) =>
        ref.type === 'local' && status.branch === ref.name ? { skip: 'ya está en esa rama' } : undefined,
      run: async (repo) => {
        if (ref.type === 'local') {
          await repo.git.checkout(ref.name);
          return;
        }
        const branches = await repo.git.getBranches();
        if (branches.local.some((b) => b.name === ref.name)) {
          await repo.git.checkout(ref.name);
          return `usó la rama local '${ref.name}' existente`;
        }
        await repo.git.checkoutTracking(ref.name, ref.full);
        return `nueva rama local '${ref.name}' → ${ref.full}`;
      },
    });
  }

  /** Checkout and Rebase onto '<actual>': `git rebase <actual> <rama>`. */
  async checkoutAndRebase(scope: Scope, ref: BranchRef & { type: 'local' }): Promise<void> {
    const current = new Map<Repo, string>();
    await runInRepos(this.manager, {
      title: `Checkout de '${ref.name}' y rebase sobre '${currentLabel(scope)}'`,
      repos: scope.repos,
      requireClean: true,
      check: (repo, status) => {
        if (!status.branch) return { block: 'HEAD detached' };
        if (status.branch === ref.name) return { skip: 'ya está en esa rama' };
        current.set(repo, status.branch);
        return undefined;
      },
      run: async (repo) => {
        await repo.git.rebase(current.get(repo)!, ref.name);
      },
    });
  }

  /** Rebase '<actual>' onto '<rama>'. */
  async rebaseOnto(scope: Scope, ref: BranchRef): Promise<void> {
    const target = refName(ref);
    await runInRepos(this.manager, {
      title: `Rebase de '${currentLabel(scope)}' sobre '${target}'`,
      repos: scope.repos,
      requireClean: true,
      check: async (repo, status) => {
        if (!status.branch) return { block: 'HEAD detached' };
        if (status.branch === target) return { skip: 'es la rama actual' };
        if (!(await repo.git.revisionExists(target))) return { block: `no existe '${target}'` };
        return undefined;
      },
      run: async (repo) => {
        await repo.git.rebase(target);
      },
    });
  }

  /** Merge '<rama>' into '<actual>'. */
  async merge(scope: Scope, ref: BranchRef): Promise<void> {
    const source = refName(ref);
    await runInRepos(this.manager, {
      title: `Merge de '${source}' en '${currentLabel(scope)}'`,
      repos: scope.repos,
      requireClean: true,
      check: async (repo, status) => {
        if (!status.branch) return { block: 'HEAD detached' };
        if (status.branch === source) return { skip: 'es la rama actual' };
        if (!(await repo.git.revisionExists(source))) return { block: `no existe '${source}'` };
        return undefined;
      },
      run: async (repo) => {
        await repo.git.merge(source);
      },
    });
  }

  /** Compare with '<actual>': commits que tiene cada lado y el otro no, por repo. */
  async compare(scope: Scope, ref: BranchRef): Promise<void> {
    const other = refName(ref);
    const label = currentLabel(scope);
    const sections = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `MultiGit: comparando '${other}' con '${label}'…` },
      () =>
        Promise.all(
          scope.repos.map(async (repo) => {
            try {
              const status = await repo.git.getStatus();
              const cur = status.branch ?? 'HEAD';
              const [incoming, outgoing] = await Promise.all([
                repo.git.logOneline(`${cur}..${other}`),
                repo.git.logOneline(`${other}..${cur}`),
              ]);
              return { repo, cur, incoming, outgoing };
            } catch (error) {
              return { repo, cur: '?', error: errorText(error), incoming: [], outgoing: [] };
            }
          }),
        ),
    );

    const lines = [`# '${other}' vs '${label}'`, ''];
    const same: string[] = [];
    for (const s of sections) {
      if ('error' in s && s.error) {
        lines.push(`## ${s.repo.name}`, '', `❌ ${s.error}`, '');
        continue;
      }
      if (s.incoming.length === 0 && s.outgoing.length === 0) {
        same.push(s.repo.name);
        continue;
      }
      lines.push(`## ${s.repo.name}`, '');
      lines.push(`### En '${other}' y no en '${s.cur}' (${s.incoming.length})`, '');
      lines.push(...(s.incoming.length ? s.incoming.map((l) => `- ${l}`) : ['_ninguno_']), '');
      lines.push(`### En '${s.cur}' y no en '${other}' (${s.outgoing.length})`, '');
      lines.push(...(s.outgoing.length ? s.outgoing.map((l) => `- ${l}`) : ['_ninguno_']), '');
    }
    if (same.length) lines.push(`## Sin diferencias`, '', same.join(', '), '');
    await this.compareView.show(`compare ${other} vs ${label}`, lines.join('\n'));
  }

  /** New Worktree from '<rama>'…: un worktree por repo bajo una carpeta común. */
  async newWorktree(scope: Scope, ref: BranchRef): Promise<void> {
    const repos = scope.repos;
    const single = repos.length === 1;
    const ancestor = commonAncestor(repos.map((r) => r.root));
    const anchor = single ? repos[0]!.root : ancestor;
    const folder = branchToFolderName(ref.name);
    const base = await vscode.window.showInputBox({
      title: `Nuevo worktree de '${refName(ref)}' — ${scope.label}`,
      prompt: single
        ? 'Carpeta del worktree'
        : 'Carpeta base: cada repo irá en una subcarpeta con su ruta relativa (p. ej. <base>/mftheme)',
      value: `${anchor}-worktrees${path.sep}${folder}`,
      validateInput: (v) => (path.isAbsolute(v.trim()) ? undefined : 'Usa una ruta absoluta'),
    });
    if (!base) return;
    const dirOf = (repo: Repo) => (single ? base.trim() : path.join(base.trim(), path.relative(ancestor, repo.root)));

    const results = await runInRepos(this.manager, {
      title: `Nuevo worktree de '${refName(ref)}'`,
      repos,
      check: async (repo, status) => {
        if (await pathExists(dirOf(repo))) return { block: `ya existe ${dirOf(repo)}` };
        if (ref.type === 'local' && status.branch === ref.name) {
          return { block: `'${ref.name}' es la rama actual de este repo (un worktree no puede usarla)` };
        }
        return undefined;
      },
      run: async (repo) => {
        const dir = dirOf(repo);
        if (ref.type === 'local') {
          await repo.git.addWorktree(dir, ref.name);
        } else {
          const branches = await repo.git.getBranches();
          if (branches.local.some((b) => b.name === ref.name)) await repo.git.addWorktree(dir, ref.name);
          else await repo.git.addWorktreeTracking(dir, ref.name, ref.full);
        }
        return dir;
      },
    });

    if (results?.every((r) => r.state === 'ok' || r.state === 'skipped')) {
      const open = await vscode.window.showInformationMessage(`Worktree creado en ${base}`, 'Abrir en ventana nueva');
      if (open) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(base.trim()), { forceNewWindow: true });
    }
  }

  /** Update: pull de esa rama (o fetch si no es la actual / si es remota). */
  async update(scope: Scope, ref: BranchRef): Promise<void> {
    if (ref.type === 'remote') {
      await runInRepos(this.manager, {
        title: `Update de '${ref.full}'`,
        repos: scope.repos,
        run: async (repo) => {
          await repo.git.fetchBranch(ref.remote, ref.name);
        },
      });
      return;
    }

    const info = new Map<Repo, LocalBranch>();
    await runInRepos(this.manager, {
      title: `Update de '${ref.name}'`,
      repos: scope.repos,
      check: async (repo) => {
        const lb = (await repo.git.getBranches()).local.find((b) => b.name === ref.name);
        if (!lb) return { block: `no existe la rama '${ref.name}'` };
        if (!lb.upstreamRemote || !lb.upstreamBranch) return { skip: 'la rama no tiene upstream' };
        if (lb.gone) return { skip: `el upstream ${lb.upstream} ya no existe` };
        info.set(repo, lb);
        return undefined;
      },
      run: async (repo) => {
        const lb = info.get(repo)!;
        if (lb.current) await repo.git.pull();
        else await repo.git.fetchIntoBranch(lb.upstreamRemote!, lb.upstreamBranch!, lb.name);
      },
    });
  }

  /** Rename… (F2). */
  async rename(scope: Scope, ref: BranchRef & { type: 'local' }): Promise<void> {
    const newName = await this.askBranchName(scope, `Renombrar '${ref.name}' — ${scope.label}`, ref.name);
    if (!newName || newName === ref.name) return;

    await runInRepos(this.manager, {
      title: `Renombrar '${ref.name}' a '${newName}'`,
      repos: scope.repos,
      check: async (repo) => {
        const branches = await repo.git.getBranches();
        if (!branches.local.some((b) => b.name === ref.name)) return { skip: `no existe '${ref.name}'` };
        if (branches.local.some((b) => b.name === newName)) return { block: `la rama '${newName}' ya existe` };
        return undefined;
      },
      run: async (repo) => {
        await repo.git.renameBranch(ref.name, newName);
      },
    });
  }

  /** Delete de una rama local, con confirmación y `-D` opcional para las no mergeadas. */
  async deleteLocal(scope: Scope, ref: BranchRef & { type: 'local' }): Promise<void> {
    const name = ref.name;
    const unmerged = new Map<Repo, number>();
    const currentIn: string[] = [];
    const missing = new Set<Repo>();

    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'MultiGit: revisando ramas…' }, () =>
      Promise.all(
        scope.repos.map(async (repo) => {
          const lb = (await repo.git.getBranches()).local.find((b) => b.name === name);
          if (!lb) return void missing.add(repo);
          if (lb.current) return void currentIn.push(repo.name);
          const merged =
            (await repo.git.isAncestor(name, 'HEAD')) ||
            (!!lb.upstream && !lb.gone && (await repo.git.isAncestor(name, lb.upstream)));
          if (!merged) unmerged.set(repo, await repo.git.countCommits(`HEAD..${name}`));
        }),
      ),
    );

    if (currentIn.length) {
      void vscode.window.showErrorMessage(`MultiGit: no se puede eliminar '${name}'`, {
        modal: true,
        detail: `Es la rama actual en: ${currentIn.join(', ')}.\nHaz checkout de otra rama primero.\n\nNo se modificó ningún repositorio.`,
      });
      return;
    }

    const targets = scope.repos.filter((r) => !missing.has(r));
    const detailLines = [`Se eliminará la rama local '${name}' en:`, ...targets.map((r) => `  • ${r.name}`)];
    if (unmerged.size) {
      detailLines.push('', '⚠ No está mergeada (se perderán commits si se fuerza con -D):');
      for (const [repo, count] of unmerged) detailLines.push(`  • ${repo.name}: ${count} commit(s) que solo están en '${name}'`);
    }
    const FORCE = 'Eliminar y forzar (-D) las no mergeadas';
    const SAFE = unmerged.size ? 'Eliminar solo las mergeadas' : 'Eliminar';
    const choice = await vscode.window.showWarningMessage(
      `¿Eliminar la rama '${name}' en ${targets.length} repositorio(s)?`,
      { modal: true, detail: detailLines.join('\n') },
      ...(unmerged.size ? [SAFE, FORCE] : [SAFE]),
    );
    if (!choice) return;
    const force = choice === FORCE;

    await runInRepos(this.manager, {
      title: `Eliminar la rama '${name}'`,
      repos: targets,
      check: (repo) => (unmerged.has(repo) && !force ? { skip: 'no está mergeada (no se forzó)' } : undefined),
      run: async (repo) => {
        await repo.git.deleteBranch(name, unmerged.has(repo));
      },
    });
  }

  /** Delete de una rama remota (`git push <remote> --delete`), con confirmación. */
  async deleteRemote(scope: Scope, ref: BranchRef & { type: 'remote' }): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      `¿Eliminar la rama remota '${ref.full}' del servidor?`,
      {
        modal: true,
        detail: [
          `Se ejecutará "git push ${ref.remote} --delete ${ref.name}" en:`,
          ...scope.repos.map((r) => `  • ${r.name}`),
          '',
          'La rama desaparecerá del remote para todo el equipo. Los commits que solo estén en ella se perderán.',
        ].join('\n'),
      },
      'Eliminar del remote',
    );
    if (!choice) return;

    await runInRepos(this.manager, {
      title: `Eliminar '${ref.full}' del remote`,
      repos: scope.repos,
      run: async (repo) => {
        await repo.git.deleteRemoteBranch(ref.remote, ref.name);
      },
    });
  }

  // ------------------------------------------------------------------ helpers

  private async askBranchName(scope: Scope, title: string, value?: string): Promise<string | undefined> {
    const probe = scope.repos[0];
    if (!probe) return undefined;
    const name = await vscode.window.showInputBox({
      title,
      value,
      prompt: 'Nombre de la rama',
      validateInput: async (v) => {
        const n = v.trim();
        if (!n) return 'Escribe un nombre';
        return (await probe.git.isValidBranchName(n)) ? undefined : `"${n}" no es un nombre de rama válido`;
      },
    });
    return name?.trim() || undefined;
  }

  /** Si hay repos con cambios sin commit, avisa (git los conserva si no chocan). */
  private async confirmDirty(scope: Scope, title: string): Promise<boolean> {
    if (!vscode.workspace.getConfiguration('multigit').get<boolean>('confirmCheckoutWithChanges', true)) return true;
    const dirty = scope.repos.filter((r) => (r.status?.changes.total ?? 0) > 0);
    if (dirty.length === 0) return true;
    const choice = await vscode.window.showWarningMessage(
      `${title}: hay cambios sin commit`,
      {
        modal: true,
        detail: [
          ...dirty.map((r) => `  • ${r.name}: ${r.status!.changes.total} cambio(s)`),
          '',
          'Git intentará conservarlos. Si chocan con la otra rama, el checkout fallará en ese repo y la operación se detendrá.',
        ].join('\n'),
      },
      'Continuar',
    );
    return choice === 'Continuar';
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
