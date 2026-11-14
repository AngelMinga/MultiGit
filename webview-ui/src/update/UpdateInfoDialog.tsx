// Ventana "Update Info" (como IntelliJ tras Update Project): repos con los commits que llegaron a la
// izquierda; a la derecha, los archivos de todo lo que llegó al repo o del commit elegido.
import { useEffect, useState } from 'react';
import type { PushFile, UpdateInfoState, UpdateRepoView } from '../../../src/webview/protocol';
import { relativeDate } from '../format';
import { onHostMessage, post } from '../vscode';
import { t } from '../i18n';
import { FileTree } from '../log/FileTree';
import { MessageBody } from '../MessageBody';

type Details = { body: string; author: string; email: string; date: string };

export function UpdateInfoDialog() {
  const [state, setState] = useState<UpdateInfoState | null>(null);
  const [sel, setSel] = useState<{ repoId: string; hash: string } | null>(null);
  const [files, setFiles] = useState<{ key: string; files: PushFile[]; details?: Details } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(
    () =>
      onHostMessage((m) => {
        if (m.type === 'update/state') {
          setState(m.payload);
          setSel(null);
        }
        if (m.type === 'update/files') setFiles({ key: `${m.payload.repoId}@${m.payload.hash}`, files: m.payload.files, details: m.payload.details });
      }),
    [],
  );

  const select = (r: UpdateRepoView, hash: string) => {
    setSel({ repoId: r.id, hash });
    setFiles(null);
    post({ type: 'update/select', payload: { repoId: r.id, hash } });
  };

  // Al llegar los datos, elegir el primer repo (todo lo que le llegó).
  useEffect(() => {
    const first = state?.repos[0];
    if (first && !sel) select(first, '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (!state) return <p className="muted pad">{t('Loading…')}</p>;
  const repo = state.repos.find((r) => r.id === sel?.repoId) ?? null;
  const commit = repo && sel?.hash ? repo.commits.find((c) => c.hash === sel.hash) : undefined;
  const shown = sel && files?.key === `${sel.repoId}@${sel.hash}` ? files : null;
  const total = state.repos.reduce((n, r) => n + r.commits.length, 0);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="push">
      <div className="push-main">
        <section className="pane repos" aria-label={t('Repositories')}>
          <header className="pane-header">
            <span>{t('{0} commit(s) in {1} repositories', total, state.repos.length)}</span>
            <span className="muted small">{relativeDate(new Date(state.time).toISOString())}</span>
          </header>
          <ul className="list push-tree">
            {state.repos.length === 0 && <li className="muted pad">{t('Nothing new arrived.')}</li>}
            {state.repos.flatMap((r) => {
              const open = !collapsed.has(r.id);
              const rows = [
                <li key={r.id} className={`row push-repo${r.id === sel?.repoId && !sel.hash ? ' selected' : ''}`} onClick={() => select(r, '')}>
                  <span
                    className="twisty"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(r.id);
                    }}
                  >
                    {open ? '▾' : '▸'}
                  </span>
                  <span className="swatch" style={{ background: `var(--vscode-multigit-repo${r.colorIndex})` }} />
                  <span className="push-repo-name">{r.name}</span>
                  <span className="small push-target">{r.branch}</span>
                  <span className="small push-count">
                    ↓{r.commits.length}
                    {r.truncated ? '+' : ''}
                  </span>
                </li>,
              ];
              if (open) {
                for (const c of r.commits) {
                  rows.push(
                    <li
                      key={`${r.id}:${c.hash}`}
                      className={`row push-commit${r.id === sel?.repoId && c.hash === sel.hash ? ' selected' : ''}`}
                      onClick={() => select(r, c.hash)}
                      onDoubleClick={() => post({ type: 'update/showInLog', payload: { repoId: r.id, hash: c.hash } })}
                      title={`${c.shortHash} · ${c.author} · ${relativeDate(c.date)}`}
                    >
                      <span className="subject">{c.subject}</span>
                      <span className="muted small date">
                        {c.author} · {relativeDate(c.date)}
                      </span>
                    </li>,
                  );
                }
              }
              return rows;
            })}
          </ul>
        </section>

        <section className="pane detail" aria-label={t('Files')}>
          <header className="pane-header">
            <span className="push-files-title">
              {!repo ? t('Choose a repository or a commit') : commit ? `${repo.name} · ${commit.shortHash} ${commit.subject}` : t('{0}: everything that arrived ({1} commit(s))', repo.name, repo.commits.length)}
            </span>
            {shown && shown.files.length > 0 && <span className="muted small">{t('{0} file(s)', shown.files.length)}</span>}
          </header>
          <ul className="list push-files">
            {repo && !shown && <li className="muted pad">{t('Loading…')}</li>}
            {repo && shown && shown.files.length === 0 && <li className="muted pad">{t('No file changes.')}</li>}
            {repo && shown && shown.files.length > 0 && (
              <>
                <li className="row file-row ft-group">
                  <span className="swatch" style={{ background: `var(--vscode-multigit-repo${repo.colorIndex})` }} />
                  <span className="file-name">{repo.name}</span>
                  <span className="muted small">{t('{0} file(s)', shown.files.length)}</span>
                </li>
                <FileTree
                  key={`${repo.id}@${sel?.hash ?? ''}`}
                  files={shown.files}
                  depth={1}
                  onOpen={(f) => post({ type: 'update/openDiff', payload: { repoId: repo.id, hash: sel?.hash ?? '', file: f } })}
                />
              </>
            )}
          </ul>
          {commit && shown?.details && (
            <div className="push-commit-details">
              <MessageBody text={shown.details.body} />
              <div className="small muted push-commit-meta">
                {commit.shortHash} {shown.details.author} &lt;{shown.details.email}&gt; · {relativeDate(shown.details.date)}
              </div>
            </div>
          )}
          {shown && shown.files.length > 0 && <div className="muted small pad">{t('Double-click a file to see the diff; double-click a commit to see it in the Git Log.')}</div>}
        </section>
      </div>
      <footer className="push-footer">
        <span className="spacer" />
        <button className="secondary" onClick={() => post({ type: 'update/close', payload: {} })}>
          {t('Close')}
        </button>
      </footer>
    </div>
  );
}
