import { describe, expect, it } from 'vitest';
import { describeHead, parseLeftRightCount, parseStatusV2 } from '../src/git/parsers';

/** Arma una salida `-z` a partir de registros. */
const z = (...records: string[]) => records.map((r) => `${r}\0`).join('');

describe('parseStatusV2', () => {
  it('lee rama, upstream y ahead/behind', () => {
    const status = parseStatusV2(
      z(
        '# branch.oid 1234567890abcdef1234567890abcdef12345678',
        '# branch.head dev-afminga-push-notifications',
        '# branch.upstream origin/dev-afminga-push-notifications',
        '# branch.ab +2 -5',
      ),
    );
    expect(status).toEqual({
      branch: 'dev-afminga-push-notifications',
      oid: '1234567890abcdef1234567890abcdef12345678',
      upstream: 'origin/dev-afminga-push-notifications',
      ahead: 2,
      behind: 5,
      changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, total: 0 },
    });
  });

  it('rama sin upstream deja ahead/behind en null', () => {
    const status = parseStatusV2(z('# branch.oid abc', '# branch.head feature/x'));
    expect(status.branch).toBe('feature/x');
    expect(status.upstream).toBeNull();
    expect(status.ahead).toBeNull();
    expect(status.behind).toBeNull();
  });

  it('HEAD detached y repo sin commits', () => {
    expect(parseStatusV2(z('# branch.oid abcdef1234', '# branch.head (detached)')).branch).toBeNull();
    const empty = parseStatusV2(z('# branch.oid (initial)', '# branch.head main'));
    expect(empty.oid).toBeNull();
    expect(empty.branch).toBe('main');
  });

  it('cuenta cambios staged, unstaged, untracked y conflictos', () => {
    const status = parseStatusV2(
      z(
        '# branch.oid abc',
        '# branch.head develop',
        '1 M. N... 100644 100644 100644 aaa bbb src/staged.ts',
        '1 .M N... 100644 100644 100644 aaa bbb src/unstaged.ts',
        '1 MM N... 100644 100644 100644 aaa bbb src/both.ts',
        '2 R. N... 100644 100644 100644 aaa bbb R100 src/nuevo nombre.ts',
        'src/viejo nombre.ts',
        'u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflicto.ts',
        '? notas.txt',
        '! ignorado.log',
      ),
    );
    expect(status.changes).toEqual({ staged: 3, unstaged: 2, untracked: 1, conflicted: 1, total: 6 });
  });

  it('una ruta original que empieza con "1 " no se cuenta como otra entrada', () => {
    const status = parseStatusV2(
      z('# branch.head main', '2 R. N... 100644 100644 100644 aaa bbb R100 b.ts', '1 .M raro.ts'),
    );
    expect(status.changes.total).toBe(1);
  });

  it('salida vacía', () => {
    expect(parseStatusV2('').changes.total).toBe(0);
  });
});

describe('parseLeftRightCount', () => {
  it('izquierda = por bajar (@{u}), derecha = por subir (HEAD)', () => {
    expect(parseLeftRightCount('3\t7\n')).toEqual({ behind: 3, ahead: 7 });
    expect(parseLeftRightCount('0\t0')).toEqual({ behind: 0, ahead: 0 });
  });

  it('falla con salida inesperada', () => {
    expect(() => parseLeftRightCount('fatal: no upstream')).toThrow();
  });
});

describe('describeHead', () => {
  it('rama, detached y sin commits', () => {
    expect(describeHead({ branch: 'develop', oid: 'abc' })).toBe('develop');
    expect(describeHead({ branch: null, oid: '1234567890' })).toBe('(detached 1234567)');
    expect(describeHead({ branch: null, oid: null })).toBe('(no commits)');
  });
});
