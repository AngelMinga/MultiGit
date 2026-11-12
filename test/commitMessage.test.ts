// Ticket de la rama, plantilla del mensaje e historial.
import { describe, expect, it } from 'vitest';
import {
  addToHistory,
  applyTemplate,
  commonTicket,
  DEFAULT_TICKET_PATTERN as P,
  isOnlyPrefix,
  templatePrefix,
  ticketFromBranch,
} from '../src/git/commitMessage';

describe('ticketFromBranch', () => {
  it('saca la clave del nombre de la rama', () => {
    expect(ticketFromBranch('feature/ABC-123-login', P)).toBe('ABC-123');
    expect(ticketFromBranch('PROJ2-7', P)).toBe('PROJ2-7');
  });

  it('distingue mayúsculas: release-1.2, hotfix-123 o dev-x no son tickets', () => {
    for (const b of ['release-1.2', 'hotfix-123', 'dev-x', 'develop', null, undefined]) expect(ticketFromBranch(b, P)).toBeUndefined();
  });

  it('con un grupo, el ticket es el grupo 1; patrón vacío o inválido = sin ticket', () => {
    expect(ticketFromBranch('feature/gh-42-fix', 'gh-(\\d+)')).toBe('42');
    expect(ticketFromBranch('ABC-1', '')).toBeUndefined();
    expect(ticketFromBranch('ABC-1', '[')).toBeUndefined();
  });
});

describe('commonTicket', () => {
  it('el mismo ticket en todas las ramas que tienen uno', () => {
    expect(commonTicket(['feature/ABC-1', 'feature/ABC-1-x', 'develop'], P)).toEqual({ ticket: 'ABC-1', branch: 'feature/ABC-1' });
  });

  it('tickets distintos o ninguno: undefined', () => {
    expect(commonTicket(['ABC-1', 'ABC-2'], P)).toBeUndefined();
    expect(commonTicket(['develop', null], P)).toBeUndefined();
  });
});

describe('plantilla', () => {
  it('prefijo: lo que va antes de {message}', () => {
    expect(templatePrefix('{ticket} {message}', 'ABC-1', 'b')).toBe('ABC-1 ');
    expect(templatePrefix('[{ticket}] {branch}: {message}', 'ABC-1', 'feature/ABC-1')).toBe('[ABC-1] feature/ABC-1: ');
    expect(templatePrefix('{message} [{ticket}]', 'ABC-1', 'b')).toBe('');
    expect(templatePrefix('{ticket}: ', 'ABC-1', 'b')).toBe('ABC-1: ');
    expect(templatePrefix('  ', 'ABC-1', 'b')).toBe('');
  });

  it('applyTemplate: solo en el asunto, y no si ya lleva el ticket', () => {
    expect(applyTemplate('feat: login\n\ncuerpo', '{ticket} {message}', 'ABC-1', 'b')).toBe('ABC-1 feat: login\n\ncuerpo');
    expect(applyTemplate('feat: login', '{message} [{ticket}]', 'ABC-1', 'b')).toBe('feat: login [ABC-1]');
    expect(applyTemplate('feat: login', '{ticket}: ', 'ABC-1', 'b')).toBe('ABC-1: feat: login');
    expect(applyTemplate('feat(abc-1): login', '{ticket} {message}', 'ABC-1', 'b')).toBe('feat(abc-1): login');
    expect(applyTemplate('feat: x', '', 'ABC-1', 'b')).toBe('feat: x');
  });

  it('isOnlyPrefix', () => {
    expect(isOnlyPrefix('', 'ABC-1 ')).toBe(true);
    expect(isOnlyPrefix('ABC-1 ', 'ABC-1 ')).toBe(true);
    expect(isOnlyPrefix('ABC-1 feat', 'ABC-1 ')).toBe(false);
    expect(isOnlyPrefix('x', '')).toBe(false);
  });
});

describe('addToHistory', () => {
  it('más reciente primero, sin repetidos ni vacíos, con límite', () => {
    expect(addToHistory(['b', 'a'], 'a')).toEqual(['a', 'b']);
    expect(addToHistory(['a'], '  ')).toEqual(['a']);
    expect(addToHistory(['c', 'b', 'a'], 'd', 3)).toEqual(['d', 'c', 'b']);
    expect(addToHistory([], '  feat: x \n')).toEqual(['feat: x']);
  });
});

describe('recentMessages (git real)', () => {
  it('mensajes completos del autor, sin los de otros ni merges', async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { GitService } = await import('../src/git/GitService');
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    const root = mkdtempSync(path.join(tmpdir(), 'multigit-msg-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'main', root]);
      const commit = (email: string, message: string) => {
        writeFileSync(path.join(root, 'f.txt'), message);
        execFileSync('git', ['add', '.'], { cwd: root });
        const env = { ...process.env, GIT_AUTHOR_NAME: 'X', GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: 'X', GIT_COMMITTER_EMAIL: email };
        execFileSync('git', ['commit', '-q', '-m', message], { cwd: root, env });
      };
      commit('yo+test@example.com', 'feat: uno\n\ncuerpo');
      commit('otro@example.com', 'fix: de otro');
      commit('yo+test@example.com', 'ABC-1 fix: dos');
      const git = new GitService(root);
      // El "+" y el "." del email no se interpretan como regex.
      expect(await git.recentMessages('yo+test@example.com', 10)).toEqual(['ABC-1 fix: dos', 'feat: uno\n\ncuerpo']);
      expect(await git.recentMessages('', 10)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
