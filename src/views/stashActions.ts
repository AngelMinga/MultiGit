// Acciones de la vista Stashes: Stash Changes en varios repos, Apply, Pop, Drop, Clear y
// Unstash as Branch. Cada una pasa por runInRepos (preflight, progreso y resumen ✅/❌/⏭).
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitContentProvider } from '../git/GitContentProvider';
import { runInRepos } from '../git/MultiRepoRunner';
import type { Repo, RepoManager } from '../git/RepoManager';
import { StashesTree, type StashNode, type StashTarget } from './StashesTree';
import { t } from '../i18n';

export class StashActions {
  constructor(
    private readonly manager: RepoManager,
    private readonly tree: StashesTree,
  ) {}

  /** Stash Changes: guarda los cambios de los repos elegidos con un mismo mensaje. */
  async create(): Promise<void> {
    const dirty = this.manager.all.filter((r) => (r.status?.changes.total ?? 0) > 0);
    if (dirty.length === 0) {
      void vscode.window.showInformationMessage(t('MultiGit: there are no changes to stash.'));
      return;
    }
    type Item = vscode.QuickPickItem & { repo?: Repo; option?: 'untracked' | 'keepIndex' };
    const repoItems: Item[] = dirty.map((repo) => ({
      label: `$(repo) ${repo.name}`,
      description: repo.status?.branch ? `⎇ ${repo.status.branch}` : '',
      detail: t('{0} file(s)', repo.status!.changes.total),
      picked: true,
      repo,
    }));
    const options: Item[] = [
      { label: t('Include untracked files'), description: '--include-untracked', option: 'untracked' },
      { label: t('Keep index'), description: '--keep-index', option: 'keepIndex' },
    ];
    const picked = await vscode.window.showQuickPick<Item>(
      [...repoItems, { label: t('Options'), kind: vscode.QuickPickItemKind.Separator }, ...options],
      {
        title: t('Stash Changes'),
        placeHolder: t('Repositories to stash (and options)'),
        canPickMany: true,
        ignoreFocusOut: true,
      },
    );
    if (!picked) return;
    const repos = picked.flatMap((i) => (i.repo ? [i.repo] : []));
    if (repos.length === 0) {
      void vscode.window.showWarningMessage(t('MultiGit: check at least one repository to stash.'));
      return;
    }
    const untracked = picked.some((i) => i.option === 'untracked');
    const keepIndex = picked.some((i) => i.option === 'keepIndex');

    const branches = [...new Set(repos.map((r) => r.status?.branch).filter(Boolean))];
    const message = (
      await vscode.window.showInputBox({
        title: t('Stash Changes'),
        prompt: t('Stash message ({0})', repos.map((r) => r.name).join(', ')),
        value: branches.length === 1 ? t('WIP on {0}', branches[0]) : 'WIP',
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? undefined : t('Type a message')),
      })
    )?.trim();
    if (!message) return;

    await runInRepos(this.manager, {
      title: t("Stash '{0}'", message),
      repos,
      check: (_repo, status) => (status.changes.total === 0 ? { skip: t('no changes') } : undefined),
      run: async (repo) => {
        await repo.git.stashAll(message, { untracked, keepIndex });
      },
    });
    this.tree.refresh();
  }

  /** Apply (o Pop, que además lo borra) en cada repo del stash. */
  async apply(targets: readonly StashTarget[], pop: boolean): Promise<void> {
    if (targets.length === 0) return;
    const [first] = targets;
    const name = StashesTree.title(first!.stash.message);
    const hashes = new Map(targets.map((x) => [x.repo, x.stash.hash]));
    await runInRepos(this.manager, {
      title: pop ? t("Pop stash '{0}'", name) : t("Apply stash '{0}'", name),
      repos: targets.map((x) => x.repo),
      run: async (repo) => {
        const ref = await this.resolve(repo, hashes.get(repo)!);
        if (pop) await repo.git.stashPop(ref);
        else await repo.git.stashApply(ref);
      },
    });
    this.tree.refresh();
  }

  /** Drop: borra el stash (pide confirmación). */
  async drop(targets: readonly StashTarget[]): Promise<void> {
    if (targets.length === 0) return;
    const name = StashesTree.title(targets[0]!.stash.message);
    const DROP = t('Drop');
    const choice = await vscode.window.showWarningMessage(
      t("Drop stash '{0}'?", name),
      {
        modal: true,
        detail: [
          t('The stash will be deleted in:'),
          ...targets.map((x) => `  • ${x.repo.name} (${x.stash.ref})`),
          '',
          t('This cannot be undone.'),
        ].join('\n'),
      },
      DROP,
    );
    if (choice !== DROP) return;
    const hashes = new Map(targets.map((x) => [x.repo, x.stash.hash]));
    await runInRepos(this.manager, {
      title: t("Drop stash '{0}'", name),
      repos: targets.map((x) => x.repo),
      check: () => undefined,
      run: async (repo) => {
        await repo.git.stashDrop(await this.resolve(repo, hashes.get(repo)!));
      },
    });
    this.tree.refresh();
  }

  /** Clear: borra todos los stashes de todos los repos (pide confirmación). */
  async clear(): Promise<void> {
    const groups = await this.tree.load();
    const counts = new Map<Repo, number>();
    for (const g of groups) for (const e of g.entries) counts.set(e.repo, (counts.get(e.repo) ?? 0) + 1);
    if (counts.size === 0) {
      void vscode.window.showInformationMessage(t('MultiGit: there are no stashes.'));
      return;
    }
    const CLEAR = t('Clear');
    const choice = await vscode.window.showWarningMessage(
      t('Delete ALL stashes?'),
      {
        modal: true,
        detail: [...[...counts].map(([repo, n]) => `  • ${repo.name}: ${n}`), '', t('This cannot be undone.')].join('\n'),
      },
      CLEAR,
    );
    if (choice !== CLEAR) return;
    await runInRepos(this.manager, {
      title: t('Clear stashes'),
      repos: this.manager.all.filter((r) => counts.has(r)),
      check: () => undefined,
      run: async (repo) => {
        await repo.git.stashClear();
      },
    });
    this.tree.refresh();
  }

  /** Unstash as Branch: rama nueva desde la base del stash, con los cambios aplicados (y el stash borrado). */
  async branch(targets: readonly StashTarget[]): Promise<void> {
    if (targets.length === 0) return;
    const [first] = targets;
    const name = (
      await vscode.window.showInputBox({
        title: t('Unstash as Branch'),
        prompt: t('New branch name ({0})', targets.map((x) => x.repo.name).join(', ')),
        value: first!.stash.branch ? `${first!.stash.branch}-stash` : '',
        ignoreFocusOut: true,
        validateInput: async (v) => (await first!.repo.git.isValidBranchName(v.trim()) ? undefined : t('Invalid branch name')),
      })
    )?.trim();
    if (!name) return;
    const hashes = new Map(targets.map((x) => [x.repo, x.stash.hash]));
    await runInRepos(this.manager, {
      title: t("Unstash as branch '{0}'", name),
      repos: targets.map((x) => x.repo),
      requireClean: true,
      check: async (repo) => ((await repo.git.revisionExists(`refs/heads/${name}`)) ? { block: t("branch '{0}' already exists", name) } : undefined),
      run: async (repo) => {
        await repo.git.stashBranch(name, await this.resolve(repo, hashes.get(repo)!));
      },
    });
    this.tree.refresh();
  }

  /** Diff de un archivo del stash: base del stash ↔ stash. */
  async openDiff(node: StashNode): Promise<void> {
    if (node.kind !== 'file') return;
    const { repo, stash, file } = node;
    const short = stash.hash.slice(0, 7);
    // Los sin versionar van en el tercer padre del stash; el resto, base (^1) ↔ stash.
    const right = file.untracked ? `${stash.hash}^3` : file.status === 'D' ? '' : stash.hash;
    const left = file.untracked || file.status === 'A' ? '' : `${stash.hash}^1`;
    await vscode.commands.executeCommand(
      'vscode.diff',
      GitContentProvider.uri(repo.root, left, file.oldPath ?? file.path),
      GitContentProvider.uri(repo.root, right, file.path),
      `${path.posix.basename(file.path)} (${stash.ref} · ${short})`,
      { preview: true },
    );
  }

  /** `stash@{n}` actual del stash con ese hash (los índices cambian al borrar otros). */
  private async resolve(repo: Repo, hash: string): Promise<string> {
    const entry = (await repo.git.listStashes()).find((s) => s.hash === hash);
    if (!entry) throw new Error(t('the stash no longer exists'));
    return entry.ref;
  }
}
