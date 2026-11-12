import { describe, expect, it } from 'vitest';
import { assignRepoColors, preferredColorIndex, REPO_PALETTE_SIZE, repoColorCssVar, repoColorId } from '../src/git/repoColor';

const REPOS = [
  'mfbankingservice',
  'mfcomponents',
  'mfconsolidatedposition',
  'mflogin',
  'mfmassivetransferspeople',
  'mfservicepay',
  'mftheme',
  'mftransfer',
  'shell',
];

describe('repoColor', () => {
  it('el color preferido es estable y está dentro de la paleta', () => {
    for (const name of REPOS) {
      const index = preferredColorIndex(name);
      expect(index).toBe(preferredColorIndex(name));
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(REPO_PALETTE_SIZE);
    }
  });

  it('asigna colores distintos a los 9 repos del proyecto', () => {
    const colors = assignRepoColors(REPOS);
    expect(colors.size).toBe(REPOS.length);
    expect(new Set(colors.values()).size).toBe(REPOS.length);
  });

  it('no depende del orden de entrada', () => {
    const a = assignRepoColors(REPOS);
    const b = assignRepoColors([...REPOS].reverse());
    expect([...b.entries()].sort()).toEqual([...a.entries()].sort());
  });

  it('con más repos que colores, repite pero no se cuelga', () => {
    const many = Array.from({ length: REPO_PALETTE_SIZE + 5 }, (_, i) => `repo-${i}`);
    const colors = assignRepoColors(many);
    expect(colors.size).toBe(many.length);
    expect(new Set(colors.values()).size).toBe(REPO_PALETTE_SIZE);
  });

  it('ids de tema y variables CSS', () => {
    expect(repoColorId(3)).toBe('multigit.repo3');
    expect(repoColorCssVar(3)).toBe('var(--vscode-multigit-repo3)');
  });
});
