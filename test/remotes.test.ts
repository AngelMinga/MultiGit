// Manage Remotes: parseo de `git remote -v`, nombres válidos y plantilla de URL.
import { describe, expect, it } from 'vitest';
import { fromTemplate, isValidRemoteName, parseRemotes, urlTemplate } from '../src/git/remotes';

describe('remotes', () => {
  it('parseRemotes: URL de fetch y, si difiere, la de push', () => {
    const out = [
      'origin\thttps://git.tikee.tech/frontend/microfrontend/mftheme.git (fetch)',
      'origin\thttps://git.tikee.tech/frontend/microfrontend/mftheme.git (push)',
      'fork\tgit@github.com:yo/mftheme.git (fetch)',
      'fork\tgit@github.com:yo/mftheme-push.git (push)',
      '',
    ].join('\n');
    expect(parseRemotes(out)).toEqual([
      { name: 'origin', url: 'https://git.tikee.tech/frontend/microfrontend/mftheme.git' },
      { name: 'fork', url: 'git@github.com:yo/mftheme.git', pushUrl: 'git@github.com:yo/mftheme-push.git' },
    ]);
  });

  it('isValidRemoteName', () => {
    expect(['origin', 'upstream', 'my-fork', 'a.b_c'].every(isValidRemoteName)).toBe(true);
    expect(['', '-x', 'con espacio', 'a..b', 'x.lock', 'a/b'].some(isValidRemoteName)).toBe(false);
  });

  it('plantilla de URL con {repo}', () => {
    const t = urlTemplate('https://git.tikee.tech/frontend/microfrontend/mftheme.git', 'mftheme')!;
    expect(t).toBe('https://git.tikee.tech/frontend/microfrontend/{repo}.git');
    expect(fromTemplate(t, 'shell')).toBe('https://git.tikee.tech/frontend/microfrontend/shell.git');
    expect(urlTemplate('https://git/otro.git', 'mftheme')).toBeUndefined();
  });
});

describe('remotes con git real', () => {
  it('añadir, renombrar, cambiar URL y quitar', async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { GitService } = await import('../src/git/GitService');
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    const root = mkdtempSync(path.join(tmpdir(), 'multigit-remotes-'));
    try {
      execFileSync('git', ['init', '-q', root]);
      const git = new GitService(root);
      await git.addRemote('origin', 'https://git.example.com/front/mftheme.git');
      await git.addRemote('fork', 'git@github.com:yo/mftheme.git');
      await git.renameRemote('fork', 'mio');
      await git.setRemoteUrl('mio', 'git@github.com:yo/otro.git');
      expect(await git.listRemotes()).toEqual([
        { name: 'mio', url: 'git@github.com:yo/otro.git' },
        { name: 'origin', url: 'https://git.example.com/front/mftheme.git' },
      ]);
      await git.removeRemote('mio');
      expect((await git.listRemotes()).map((r) => r.name)).toEqual(['origin']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
