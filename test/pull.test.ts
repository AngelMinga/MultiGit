import { describe, expect, it } from 'vitest';
import type { LocalBranch, RepoBranches } from '../src/git/branches';
import { commonUpstream, pullArgs, remoteBranchChoices, remotesOf } from '../src/git/pull';

function local(name: string, current: boolean, upstreamBranch: string | null, remote = 'origin'): LocalBranch {
  return {
    name,
    current,
    upstream: upstreamBranch ? `${remote}/${upstreamBranch}` : null,
    upstreamRemote: upstreamBranch ? remote : null,
    upstreamBranch,
    ahead: 0,
    behind: 0,
    gone: false,
  };
}

function branches(locals: LocalBranch[], remotes: string[]): RepoBranches {
  return {
    local: locals,
    remote: remotes.map((full) => {
      const i = full.indexOf('/');
      return { remote: full.slice(0, i), name: full.slice(i + 1), full };
    }),
    remotes: [...new Set(remotes.map((r) => r.slice(0, r.indexOf('/'))))],
  };
}

describe('pullArgs', () => {
  it('modos y destino', () => {
    expect(pullArgs('merge')).toEqual(['pull', '--no-rebase', '--no-edit']);
    expect(pullArgs('rebase', 'origin', 'develop')).toEqual(['pull', '--rebase', 'origin', 'develop']);
    expect(pullArgs('ff-only', 'origin')).toEqual(['pull', '--ff-only']);
  });
});

describe('ramas para el pull', () => {
  const repos = [
    { repo: 'mftheme', branches: branches([local('dev-x', true, 'dev-x')], ['origin/develop', 'origin/dev-x', 'origin/production-lt', 'backup/develop']) },
    { repo: 'shell', branches: branches([local('dev-x', true, 'dev-x')], ['origin/develop', 'origin/dev-x', 'origin/zeta']) },
    { repo: 'mflogin', branches: branches([local('develop', true, 'develop')], ['origin/develop', 'origin/production-lt']) },
  ];

  it('remotes con origin primero', () => {
    expect(remotesOf(repos)).toEqual(['origin', 'backup']);
  });

  it('unión de ramas: upstream de más repos primero, luego favoritas y alfabético', () => {
    const choices = remoteBranchChoices(repos, 'origin', ['develop', 'production-lt']);
    expect(choices.map((c) => c.name)).toEqual(['dev-x', 'develop', 'production-lt', 'zeta']);
    expect(choices[0]).toEqual({ name: 'dev-x', repos: ['mftheme', 'shell'], upstreamFor: ['mftheme', 'shell'] });
    expect(choices[1]!.upstreamFor).toEqual(['mflogin']);
    expect(choices[3]!.repos).toEqual(['shell']);
  });

  it('upstream común solo si todos siguen la misma rama', () => {
    expect(commonUpstream(repos, 'origin')).toBeNull();
    expect(commonUpstream(repos.slice(0, 2), 'origin')).toBe('dev-x');
    expect(commonUpstream(repos.slice(0, 2), 'backup')).toBeNull();
  });
});
