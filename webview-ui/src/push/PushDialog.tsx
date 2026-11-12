// Diálogo Push Commits. El estado vive en el host; aquí solo hay selección y formularios.
import { useEffect, useMemo, useState } from 'react';
import type { PushFile, PushRepoView, PushState, PushTagsMode } from '../../../src/webview/protocol';
import { relativeDate } from '../format';
import { onHostMessage, post } from '../vscode';
import { t } from '../i18n';

const STATE_ICON: Record<string, string> = {
  running: '⏳',
  ok: '✅',
  failed: '❌',
  skipped: '⏭',
  pending: '⏭',
};

interface TargetEdit {
  repoIds: string[];
  remote: string;
  branch: string;
}

export function PushDialog() {
  const [state, setState] = useState<PushState>({ repos: [], busy: true, attempted: false });
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [files, setFiles] = useState<{ key: string; files: PushFile[] } | null>(null);
  const [tagsEnabled, setTagsEnabled] = useState(false);
  const [tagsMode, setTagsMode] = useState<Exclude<PushTagsMode, 'none'>>('follow');
  const [menuOpen, setMenuOpen] = useState(false);
  const [edit, setEdit] = useState<TargetEdit | null>(null);

  useEffect(
    () =>
      onHostMessage((m) => {
        if (m.type === 'push/state') setState(m.payload);
        if (m.type === 'push/files') setFiles({ key: `${m.payload.repoId}@${m.payload.hash}`, files: m.payload.files });
      }),
    [],
  );

  // Selecciona el primer repo con algo por subir cuando llegan los datos.
  useEffect(() => {
    if (selectedRepo && state.repos.some((r) => r.id === selectedRepo)) return;
    const first = state.repos.find((r) => r.checked) ?? state.repos[0];
    setSelectedRepo(first?.id ?? null);
  }, [state.repos, selectedRepo]);

  const repo = state.repos.find((r) => r.id === selectedRepo) ?? null;
  const checked = state.repos.filter((r) => r.checked && !r.skipReason);
  const allChecked = checked.length > 0 && checked.length === state.repos.filter((r) => !r.skipReason).length;
  const totalCommits = checked.reduce((n, r) => n + r.commits.length, 0);
  const rejected = state.repos.some((r) => r.rejected);
  const tags: PushTagsMode = tagsEnabled ? tagsMode : 'none';
  const allRemotes = useMemo(() => [...new Set(state.repos.flatMap((r) => r.remotes))], [state.repos]);

  const selectCommit = (hash: string) => {
    if (!repo) return;
    setSelectedCommit(hash);
    setFiles(null);
    post({ type: 'push/selectCommit', payload: { repoId: repo.id, hash } });
  };

  const runPush = (force: boolean) => {
    setMenuOpen(false);
    post({ type: 'push/run', payload: { repoIds: checked.map((r) => r.id), tags, force } });
  };

  const openEdit = (repos: PushRepoView[]) => {
    const first = repos[0];
    setEdit({
      repoIds: repos.map((r) => r.id),
      remote: first?.remote ?? allRemotes[0] ?? 'origin',
      branch: repos.length === 1 ? first?.remoteBranch ?? '' : '',
    });
  };

  const commitFiles = repo && selectedCommit && files?.key === `${repo.id}@${selectedCommit}` ? files.files : null;

  return (
    <div className="push">
      <div className="push-main">
        {/* ---------------------------------------------------- repos */}
        <section className="pane repos" aria-label={t('Repositories')}>
          <header className="pane-header">
            <label className="check">
              <input
                type="checkbox"
                checked={allChecked}
                disabled={state.busy}
                onChange={(e) =>
                  post({
                    type: 'push/toggle',
                    payload: { repoIds: state.repos.map((r) => r.id), checked: e.target.checked },
                  })
                }
              />
              <span>{t('Repositories')}</span>
            </label>
            <span className="muted">
              {checked.length}/{state.repos.length}
            </span>
          </header>
          <ul className="list">
            {state.repos.map((r) => (
              <li
                key={r.id}
                className={`row repo-row${r.id === selectedRepo ? ' selected' : ''}${r.skipReason ? ' disabled' : ''}`}
                onClick={() => {
                  setSelectedRepo(r.id);
                  setSelectedCommit(null);
                }}
              >
                <span className="swatch" style={{ background: `var(--vscode-multigit-repo${r.colorIndex})` }} />
                <input
                  type="checkbox"
                  checked={r.checked}
                  disabled={!!r.skipReason || state.busy}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => post({ type: 'push/toggle', payload: { repoIds: [r.id], checked: e.target.checked } })}
                  aria-label={t('Include {0}', r.name)}
                />
                <div className="repo-text">
                  <div className="repo-name">
                    {r.name}
                    {r.state !== 'idle' && (
                      <span className="state" title={r.message}>
                        {STATE_ICON[r.state]}
                      </span>
                    )}
                  </div>
                  {r.skipReason ? (
                    <div className="muted small">{r.skipReason}</div>
                  ) : (
                    <div className="target small">
                      <span>{r.branch}</span>
                      <span className="muted"> → </span>
                      <button
                        className="link"
                        title={t('Change target')}
                        disabled={state.busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          openEdit([r]);
                        }}
                      >
                        {r.remote} : {r.remoteBranch}
                      </button>
                      {r.isNew && <span className="badge new">New</span>}
                      {!r.isNew && r.commits.length > 0 && <span className="muted"> ↑{r.commits.length}</span>}
                    </div>
                  )}
                  {r.message && r.state !== 'idle' && r.state !== 'running' && (
                    <div className={`small ${r.state === 'failed' ? 'error-text' : 'muted'}`}>{firstLine(r.message)}</div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* ---------------------------------------------------- commits + archivos */}
        <section className="pane detail" aria-label="Commits">
          <header className="pane-header">
            <span>
              {repo ? `${repo.name}: ` : ''}
              {t('{0} commit(s) to push', repo?.commits.length ?? 0)}
              {repo?.truncated ? t(' (showing the first 500)') : ''}
            </span>
            {repo?.isNew && <span className="muted small">{t('new branch: commits that are not on {0}', repo.remote ?? '')}</span>}
          </header>
          <ul className="list commits">
            {repo?.commits.map((c) => (
              <li
                key={c.hash}
                className={`row commit-row${c.hash === selectedCommit ? ' selected' : ''}`}
                onClick={() => selectCommit(c.hash)}
                title={c.hash}
              >
                <span className="hash">{c.shortHash}</span>
                <span className="subject">{c.subject}</span>
                <span className="muted author">{c.author}</span>
                <span className="muted date">{relativeDate(c.date)}</span>
              </li>
            ))}
            {repo && repo.commits.length === 0 && !repo.skipReason && (
              <li className="muted pad">{repo.isNew ? t('No new commits: only the branch will be created on the remote.') : t('Nothing to push.')}</li>
            )}
          </ul>
          <div className="files">
            <header className="pane-header small">
              {selectedCommit ? t('Commit files (double-click to see the diff)') : t('Choose a commit to see its files')}
            </header>
            <ul className="list">
              {selectedCommit && !commitFiles && <li className="muted pad">{t('Loading…')}</li>}
              {commitFiles?.map((f) => (
                <li
                  key={`${f.status}:${f.oldPath ?? ''}:${f.path}`}
                  className="row file-row"
                  onDoubleClick={() =>
                    repo && selectedCommit && post({ type: 'push/openDiff', payload: { repoId: repo.id, hash: selectedCommit, file: f } })
                  }
                  title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                >
                  <span className={`status status-${f.status}`}>{f.status}</span>
                  <span className="file-name">{baseName(f.path)}</span>
                  <span className="muted small">{dirName(f.path)}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>

      {/* ---------------------------------------------------- pie */}
      <footer className="push-footer">
        <label className="check">
          <input type="checkbox" checked={tagsEnabled} onChange={(e) => setTagsEnabled(e.target.checked)} />
          <span>Push tags</span>
        </label>
        <select value={tagsMode} disabled={!tagsEnabled} onChange={(e) => setTagsMode(e.target.value as 'all' | 'follow')}>
          <option value="follow">Current Branch</option>
          <option value="all">All</option>
        </select>
        <button className="secondary" disabled={state.busy || state.repos.length === 0} onClick={() => openEdit(state.repos.filter((r) => !r.skipReason))}>
          Edit all targets
        </button>
        <span className="spacer" />
        {state.busy && <span className="muted">{t('Working…')}</span>}
        {rejected && !state.busy && (
          <button className="secondary" onClick={() => post({ type: 'push/pullAndRetry', payload: { tags } })}>
            {t('Pull and Retry')}
          </button>
        )}
        <button className="secondary" onClick={() => post({ type: 'push/close', payload: {} })}>
          {t('Cancel')}
        </button>
        <div className="split">
          <button className="primary" disabled={state.busy || checked.length === 0} onClick={() => runPush(false)}>
            Push{totalCommits ? ` (${totalCommits})` : ''}
          </button>
          <button
            className="primary caret"
            disabled={state.busy || checked.length === 0}
            aria-label={t('More push options')}
            onClick={() => setMenuOpen((o) => !o)}
          >
            ▾
          </button>
          {menuOpen && (
            <div className="menu" role="menu">
              <button role="menuitem" onClick={() => runPush(true)}>
                Force push (with lease)
              </button>
            </div>
          )}
        </div>
      </footer>

      {edit && (
        <EditTargets
          edit={edit}
          remotes={allRemotes}
          single={edit.repoIds.length === 1}
          onCancel={() => setEdit(null)}
          onApply={(e) => {
            post({
              type: 'push/setTarget',
              payload: { repoIds: e.repoIds, remote: e.remote || undefined, branch: e.branch.trim() || undefined },
            });
            setEdit(null);
          }}
        />
      )}
    </div>
  );
}

function EditTargets(props: {
  edit: TargetEdit;
  remotes: string[];
  single: boolean;
  onCancel: () => void;
  onApply: (edit: TargetEdit) => void;
}) {
  const [value, setValue] = useState(props.edit);
  return (
    <div className="overlay" onClick={props.onCancel}>
      <form
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          props.onApply(value);
        }}
      >
        <h2>{props.single ? t('Push target') : t('Target of {0} repositories', props.edit.repoIds.length)}</h2>
        <label>
          Remote
          <select value={value.remote} onChange={(e) => setValue({ ...value, remote: e.target.value })}>
            {props.remotes.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('Remote branch')}
          <input
            autoFocus
            value={value.branch}
            placeholder={props.single ? '' : t('empty = each repository\'s')}
            onChange={(e) => setValue({ ...value, branch: e.target.value })}
          />
        </label>
        <div className="dialog-buttons">
          <button type="button" className="secondary" onClick={props.onCancel}>
            {t('Cancel')}
          </button>
          <button type="submit" className="primary">
            {t('Apply')}
          </button>
        </div>
      </form>
    </div>
  );
}

function firstLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).find(Boolean) ?? text;
}

function baseName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

function dirName(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}
