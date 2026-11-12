// Color estable por repositorio. Puro (sin `vscode`) para poder testearlo.
//
// Los colores reales viven en `contributes.colors` de package.json (multigit.repo0..N),
// con variantes para tema oscuro, claro y alto contraste. Aquí solo elegimos el índice.

/** Cantidad de colores definidos en `contributes.colors` (multigit.repo0 … multigit.repo11). */
export const REPO_PALETTE_SIZE = 12;

/** Id del color de tema para un índice de paleta (`multigit.repoN`). */
export function repoColorId(index: number): string {
  return `multigit.repo${index}`;
}

/** Variable CSS equivalente dentro de un webview (`var(--vscode-multigit-repoN)`). */
export function repoColorCssVar(index: number): string {
  return `var(--vscode-multigit-repo${index})`;
}

/** Hash FNV-1a de 32 bits: rápido, determinista y con buena dispersión para nombres cortos. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Índice de paleta preferido para un nombre de repo (hash del nombre → paleta). */
export function preferredColorIndex(name: string, paletteSize = REPO_PALETTE_SIZE): number {
  return fnv1a(name) % paletteSize;
}

/**
 * Asigna un color a cada repo intentando primero su color preferido (hash del nombre).
 * Si dos repos chocan, el segundo (en orden alfabético) toma el siguiente color libre.
 *
 * El resultado no depende del orden de entrada: el mismo conjunto de repos siempre
 * produce los mismos colores. Con más repos que colores, se repiten por hash.
 */
export function assignRepoColors(names: readonly string[], paletteSize = REPO_PALETTE_SIZE): Map<string, number> {
  const result = new Map<string, number>();
  const used = new Set<number>();
  const sorted = [...new Set(names)].sort((a, b) => a.localeCompare(b));

  for (const name of sorted) {
    const preferred = preferredColorIndex(name, paletteSize);
    let index = preferred;
    if (used.size < paletteSize) {
      while (used.has(index)) index = (index + 1) % paletteSize;
    }
    used.add(index);
    result.set(name, index);
  }
  return result;
}
