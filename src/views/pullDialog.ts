// Pull: ejecución en los repos elegidos (el diálogo está en src/webview/PullPanel.ts).
import type { RepoBranches } from '../git/branches';
import { runInRepos } from '../git/MultiRepoRunner';
import { PULL_MODE_LABEL, type PullMode } from '../git/pull';
import type { Repo, RepoManager } from '../git/RepoManager';
import { t } from '../i18n';

/** Destino: el upstream de cada repo, o una rama concreta de un remote. */
export type Target = { kind: 'upstream' } | { kind: 'branch'; remote: string; branch: string };

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
    continueAfterConflict: true,
    check: (repo, status) => {
      if (!status.branch) return { skip: 'HEAD detached' };
      if (target.kind === 'upstream') {
        if (!status.upstream) return { skip: t('the branch has no upstream') };
        if (status.ahead === null) return { skip: t('upstream {0} no longer exists', status.upstream) };
      } else if (!data.get(repo)?.remote.some((b) => b.full === `${target.remote}/${target.branch}`)) {
        return { skip: t("'{0}' does not exist", `${target.remote}/${target.branch}`) };
      }
      return undefined;
    },
    run: async (repo) => {
      const before = await repo.git.headSha();
      if (target.kind === 'upstream') await repo.git.pullWith(mode);
      else await repo.git.pullWith(mode, target.remote, target.branch);
      const after = await repo.git.headSha();
      if (!before || !after || before === after) return t('already up to date');
      const count = await repo.git.countCommits(`${before}..${after}`);
      return count ? t('updated (+{0} commit(s))', count) : t('updated');
    },
  });
}

function targetLabel(target: Target): string {
  return target.kind === 'upstream' ? t('from upstream') : t('from {0}', `${target.remote}/${target.branch}`);
}
