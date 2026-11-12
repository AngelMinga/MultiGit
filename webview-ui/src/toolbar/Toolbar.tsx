// Botones de proyecto y rama al estilo de la barra superior de IntelliJ.
import { useEffect, useState } from 'react';
import type { ToolbarAction, ToolbarState } from '../../../src/webview/protocol';
import { onHostMessage, post } from '../vscode';
import { t } from '../i18n';

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
  if (!state) return <div className="toolbar muted small">{t('Loading…')}</div>;

  return (
    <div className="toolbar">
      <div className="toolbar-buttons">
        <button className="widget" title={t('Open a recent project')} onClick={() => run('project')}>
          <span className="project-badge" style={{ background: `var(--vscode-multigit-repo${state.projectColor})` }}>
            {state.project.charAt(0).toUpperCase()}
          </span>
          <span className="widget-text">{state.project}</span>
          <span className="chevron">⌄</span>
        </button>
        <button
          className="widget"
          title={state.mixed ? t('The repos are on different branches: see branches') : t('Branches of all repositories')}
          onClick={() => run('branches')}
        >
          <span className={`branch-glyph${state.mixed ? ' mixed' : ''}`}>⎇</span>
          <span className="widget-text">{state.branch}</span>
          <span className="chevron">⌄</span>
        </button>
      </div>
      <button className="toolbar-summary small" title={t('Open Git Log')} onClick={() => run('log')}>
        {state.repos} repos
        {state.ahead > 0 && <> · ↑{state.ahead}</>}
        {state.behind > 0 && <> · ↓{state.behind}</>}
        {' · '}
        {state.changes ? t('{0} change(s)', state.changes) : t('no changes')}
      </button>
    </div>
  );
}
