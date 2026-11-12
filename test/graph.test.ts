import { describe, expect, it } from 'vitest';
import { computeGraph, type GraphInput, type GraphRow } from '../src/git/graph';

/** Historia compacta: "M:B,X" = commit M con padres B y X. Todos en el mismo grupo salvo "g/". */
function history(...specs: string[]): GraphInput[] {
  return specs.map((spec) => {
    const [id = '', parents = ''] = spec.split(':');
    const group = id.includes('/') ? id.split('/')[0]! : 'repo';
    return { id, parents: parents ? parents.split(',') : [], group };
  });
}

/** Representación legible de una fila: nodo y tramos `x1from>x2to`. */
function shape(row: GraphRow): string {
  const lines = row.lines
    .map((l) => `${l.x1}${l.from === 'top' ? 't' : 'm'}>${l.x2}${l.to === 'mid' ? 'm' : 'b'}${l.stub ? '*' : ''}`)
    .sort()
    .join(' ');
  return `n${row.node}${row.merge ? 'M' : ''} ${lines}`.trim();
}

describe('computeGraph', () => {
  it('historia lineal: un solo carril', () => {
    const g = computeGraph(history('C:B', 'B:A', 'A'));
    expect(g.rows.map(shape)).toEqual(['n0 0m>0b', 'n0 0m>0b 0t>0m', 'n0 0t>0m']);
    expect(g.maxLanes).toBe(1);
  });

  it('rama y merge: el padre del merge abre un carril y converge en el ancestro común', () => {
    // M = merge de X en B; ambos salen de A.
    const g = computeGraph(history('M:B,X', 'X:A', 'B:A', 'A'));
    expect(g.rows.map(shape)).toEqual([
      'n0M 0m>0b 0m>1b', // M: sigue en 0 (B) y abre 1 (X)
      'n1 0t>0b 1m>1b 1t>1m', // X en el carril 1, va a A
      'n0 0m>0b 0t>0m 1t>1b', // B en 0, va a A; el carril 1 (A) pasa
      'n0 0t>0m 1t>0m', // A: los dos carriles convergen
    ]);
    expect(g.rows[0]!.lines.find((l) => l.x2 === 1)!.color).not.toBe(g.rows[0]!.color);
    expect(g.maxLanes).toBe(2);
  });

  it('ramas paralelas: cada punta en su carril hasta el ancestro común', () => {
    const g = computeGraph(history('T1:A', 'T2:A', 'A'));
    expect(g.rows.map(shape)).toEqual(['n0 0m>0b', 'n1 0t>0b 1m>1b', 'n0 0t>0m 1t>0m']);
    // Distintas ramas, distintos colores.
    expect(g.rows[0]!.color).not.toBe(g.rows[1]!.color);
  });

  it('octopus merge: un carril por cada padre extra', () => {
    const g = computeGraph(history('O:P1,P2,P3', 'P3:R', 'P2:R', 'P1:R', 'R'));
    expect(shape(g.rows[0]!)).toBe('n0M 0m>0b 0m>1b 0m>2b');
    expect(g.rows[0]!.merge).toBe(true);
    expect(g.maxLanes).toBe(3);
    // R recibe los tres carriles.
    expect(shape(g.rows[4]!)).toBe('n0 0t>0m 1t>0m 2t>0m');
  });

  it('compactación: al cerrarse un carril, los de la derecha se corren a la izquierda', () => {
    // Tres puntas; la del medio termina primero (su padre es una raíz sin más).
    const g = computeGraph(history('A:a0', 'B:b0', 'C:c0', 'b0', 'a0', 'c0'));
    // En b0 (carril 1) termina esa rama: el carril 2 (c0) pasa a 1.
    expect(shape(g.rows[3]!)).toBe('n1 0t>0b 1t>1m 2t>1b');
    expect(shape(g.rows[5]!)).toBe('n0 0t>0m');
  });

  it('merge hacia un carril que ya espera a ese padre', () => {
    // M une Y, que ya está en otro carril porque T lo tiene como primer padre.
    const g = computeGraph(history('T:Y', 'M:B,Y', 'Y:B', 'B'));
    expect(shape(g.rows[1]!)).toBe('n1M 0t>0b 1m>0b 1m>1b');
  });

  it('dos repos intercalados no comparten carriles', () => {
    const g = computeGraph(history('r1/c:r1/b', 'r2/z:r2/y', 'r1/b:r1/a', 'r2/y', 'r1/a'));
    expect(g.rows.map((r) => r.node)).toEqual([0, 1, 0, 1, 0]);
    expect(shape(g.rows[3]!)).toBe('n1 0t>0b 1t>1m');
  });

  it('padres no cargados: tramo corto y sin carril colgando', () => {
    const g = computeGraph(history('C:B', 'B:A')); // A está en la página siguiente
    expect(shape(g.rows[1]!)).toBe('n0 0m>0b* 0t>0m');
    expect(g.maxLanes).toBe(1);
    // Log filtrado: commits sueltos, cada uno con su tramo.
    const filtered = computeGraph(history('X:W', 'Y:V'));
    expect(filtered.rows.map(shape)).toEqual(['n0 0m>0b*', 'n0 0m>0b*']);
  });

  it('5 000 commits con ramas y merges en poco tiempo', () => {
    const rows: GraphInput[] = [];
    // Cada 10 commits, un merge de una rama corta.
    for (let i = 0; i < 5000; i++) {
      const parents = i + 1 < 5000 ? [`c${i + 1}`] : [];
      if (i % 10 === 0 && i + 5 < 5000) parents.push(`f${i}`);
      rows.push({ id: `c${i}`, parents, group: 'repo' });
      if (i % 10 === 0 && i + 5 < 5000) rows.push({ id: `f${i}`, parents: [`c${i + 5}`], group: 'repo' });
    }
    const start = performance.now();
    const g = computeGraph(rows);
    expect(performance.now() - start).toBeLessThan(500);
    expect(g.rows).toHaveLength(rows.length);
    expect(g.maxLanes).toBeLessThanOrEqual(3);
  });
});
