// Botones de proyecto y rama al estilo de la barra superior de IntelliJ.
import { useEffect, useState } from 'react';
import type { ToolbarAction, ToolbarState } from '../../../src/webview/protocol';
import { onHostMessage, post } from '../vscode';

export function Toolbar() {
  const [state, setState] = useState<ToolbarState | null>(null);

  useEffect(
    () =>
      onHostMessage((m) => {
        if (m.type === 'toolbar/state') setState(m.payload);
      }),
    [],
  );

  const run = (action: ToolbarAction) => post({ type: 'toolbar/action', payload: { action } });
  if (!state) return <div className="toolbar muted small">Cargando…</div>;

  return (
    <div className="toolbar">
      <div className="toolbar-buttons">
        <button className="widget" title="Abrir proyecto reciente" onClick={() => run('project')}>
          <span className="project-badge" style={{ background: `var(--vscode-multigit-repo${state.projectColor})` }}>
            {state.project.charAt(0).toUpperCase()}
          </span>
          <span className="widget-text">{state.project}</span>
          <span className="chevron">⌄</span>
        </button>
        <button
          className="widget"
          title={state.mixed ? 'Los repos están en ramas distintas: ver ramas' : 'Ramas de todos los repositorios'}
          onClick={() => run('branches')}
        >
          <span className={`branch-glyph${state.mixed ? ' mixed' : ''}`}>⎇</span>
          <span className="widget-text">{state.branch}</span>
          <span className="chevron">⌄</span>
        </button>
      </div>
      <button className="toolbar-summary small" title="Abrir Git Log" onClick={() => run('log')}>
        {state.repos} repos
        {state.ahead > 0 && <> · ↑{state.ahead}</>}
        {state.behind > 0 && <> · ↓{state.behind}</>}
        {' · '}
        {state.changes ? `${state.changes} cambio(s)` : 'sin cambios'}
      </button>
    </div>
  );
}
