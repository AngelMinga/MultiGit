import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  branchToFolderName,
  commonAncestor,
  commonLocalBranches,
  commonRemoteBranches,
  parseRefs,
  parseTrack,
  type RepoBranches,
} from '../src/git/branches';

const line = (...fields: string[]) => fields.join('\0');

describe('parseRefs', () => {
  const output = [
    line('refs/heads/develop', ' ', 'origin/develop', 'origin', 'refs/heads/develop', 'behind 3'),
    line('refs/heads/dev-afminga-push-notifications', '*', 'origin/dev-afminga-push-notifications', 'origin', 'refs/heads/dev-afminga-push-notifications', 'ahead 2, behind 1'),
    line('refs/heads/local-only', ' ', '', '', '', ''),
    line('refs/heads/borrada', ' ', 'origin/borrada', 'origin', 'refs/heads/borrada', 'gone'),
    line('refs/remotes/origin/HEAD', ' ', '', '', '', ''),
    line('refs/remotes/origin/develop', ' ', '', '', '', ''),
    line('refs/remotes/origin/feature/x', ' ', '', '', '', ''),
    line('refs/remotes/upstream/fork/main', ' ', '', '', '', ''),
  ].join('\n');

  const parsed = parseRefs(output, ['origin', 'upstream/fork']);

  it('ramas locales con upstream, ↑/↓, actual y gone', () => {
    expect(parsed.local.map((b) => b.name)).toEqual(['develop', 'dev-afminga-push-notifications', 'local-only', 'borrada']);
    expect(parsed.local[1]).toEqual({
      name: 'dev-afminga-push-notifications',
      current: true,
      upstream: 'origin/dev-afminga-push-notifications',
      upstreamRemote: 'origin',
      upstreamBranch: 'dev-afminga-push-notifications',
      ahead: 2,
      behind: 1,
      gone: false,
    });
    expect(parsed.local[2]).toMatchObject({ upstream: null, upstreamRemote: null, upstreamBranch: null, ahead: 0, behind: 0 });
    expect(parsed.local[3]).toMatchObject({ gone: true });
  });

  it('ramas remotas: omite HEAD y respeta remotes con "/"', () => {
    expect(parsed.remote).toEqual([
      { remote: 'origin', name: 'develop', full: 'origin/develop' },
      { remote: 'origin', name: 'feature/x', full: 'origin/feature/x' },
      { remote: 'upstream/fork', name: 'main', full: 'upstream/fork/main' },
    ]);
  });
});

describe('parseTrack', () => {
  it('formatos de %(upstream:track,nobracket)', () => {
    expect(parseTrack('')).toEqual({ ahead: 0, behind: 0, gone: false });
    expect(parseTrack('ahead 4')).toEqual({ ahead: 4, behind: 0, gone: false });
    expect(parseTrack('behind 7')).toEqual({ ahead: 0, behind: 7, gone: false });
    expect(parseTrack('gone')).toEqual({ ahead: 0, behind: 0, gone: true });
  });
});

function repo(name: string, locals: string[], current: string, remotes: string[] = []) {
  const branches: RepoBranches = {
    local: locals.map((n) => ({
      name: n,
      current: n === current,
      upstream: null,
      upstreamRemote: null,
      upstreamBranch: null,
      ahead: 0,
      behind: 0,
      gone: false,
    })),
    remote: remotes.map((full) => {
      const [remote, ...rest] = full.split('/');
      return { remote: remote!, name: rest.join('/'), full };
    }),
    remotes: [...new Set(remotes.map((r) => r.split('/')[0]!))],
  };
  return { repo: name, branches };
}

describe('commonLocalBranches', () => {
  const repos = [
    repo('mftheme', ['develop', 'production-lt', 'dev-a', 'zeta', 'solo-theme'], 'dev-a'),
    repo('shell', ['zeta', 'dev-a', 'production-lt', 'develop'], 'dev-a'),
    repo('mflogin', ['develop', 'dev-a', 'zeta', 'production-lt'], 'develop'),
  ];

  it('intersección, favoritas primero en su orden y luego alfabético', () => {
    const result = commonLocalBranches(repos, ['develop', 'production-lt']);
    expect(result.map((b) => b.name)).toEqual(['develop', 'production-lt', 'dev-a', 'zeta']);
    expect(result.map((b) => b.favorite)).toEqual([true, true, false, false]);
  });

  it('marca en qué repos es la rama actual', () => {
    const result = commonLocalBranches(repos, []);
    expect(result.find((b) => b.name === 'dev-a')!.currentIn).toEqual(['mftheme', 'shell']);
    expect(result.find((b) => b.name === 'develop')!.currentIn).toEqual(['mflogin']);
  });

  it('sin repos o sin ramas comunes', () => {
    expect(commonLocalBranches([], ['develop'])).toEqual([]);
    expect(commonLocalBranches([repo('a', ['x'], 'x'), repo('b', ['y'], 'y')], [])).toEqual([]);
  });

  it('un solo repo: todas sus ramas', () => {
    expect(commonLocalBranches([repo('a', ['b', 'a'], 'a')], []).map((b) => b.name)).toEqual(['a', 'b']);
  });
});

describe('commonRemoteBranches', () => {
  it('intersección agrupada por remote, origin primero y favoritas arriba', () => {
    const result = commonRemoteBranches(
      [
        repo('a', [], '', ['origin/develop', 'origin/feature', 'origin/production-lt', 'backup/develop']),
        repo('b', [], '', ['origin/production-lt', 'origin/feature', 'origin/develop', 'backup/develop', 'origin/solo-b']),
      ],
      ['develop', 'production-lt'],
    );
    expect([...result.keys()]).toEqual(['origin', 'backup']);
    expect(result.get('origin')!.map((b) => b.name)).toEqual(['origin/develop', 'origin/production-lt', 'origin/feature']);
    expect(result.get('origin')!.map((b) => b.favorite)).toEqual([true, true, false]);
    expect(result.get('backup')!.map((b) => b.name)).toEqual(['backup/develop']);
  });
});

describe('commonAncestor / branchToFolderName', () => {
  it('directorio común de los repos', () => {
    const p = path.posix;
    expect(commonAncestor(['/w/banca/apps/mftheme', '/w/banca/apps/mflogin', '/w/banca/shell'], p)).toBe('/w/banca');
    expect(commonAncestor(['/w/banca/apps/mftheme'], p)).toBe('/w/banca/apps');
    expect(commonAncestor(['/a/x', '/b/y'], p)).toBe('/');
  });

  it('nombre de carpeta a partir de la rama', () => {
    expect(branchToFolderName('feature/push notifications')).toBe('feature-push-notifications');
    expect(branchToFolderName('develop')).toBe('develop');
  });
});
