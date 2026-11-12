// Caja de commit: mensaje, Amend last commit, Commit y Commit and Push….
import { useEffect, useRef, useState } from 'react';
import type { CommitState } from '../../../src/webview/protocol';
import { onHostMessage, post } from '../vscode';

const DRAFT_KEY = 'multigit.commitDraft';

export function CommitBox() {
  const [state, setState] = useState<CommitState>({ repos: [], total: 0, summary: '', busy: false });
  const [message, setMessage] = useState(() => readDraft());
  const [amend, setAmend] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(
    () =>
      onHostMessage((m) => {
        if (m.type === 'commit/state') setState(m.payload);
        if (m.type === 'commit/setMessage') setMessage((current) => current.trim() ? current : m.payload.message);
        if (m.type === 'commit/done') {
          setMessage('');
          setAmend(false);
        }
      }),
    [],
  );

  useEffect(() => writeDraft(message), [message]);

  const canCommit = !state.busy && state.total > 0 && message.trim().length > 0;
  const run = (push: boolean) => {
    if (canCommit) post({ type: 'commit/run', payload: { message, amend, push } });
  };

  return (
    <div className="commit">
      <textarea
        ref={textarea}
        className="commit-message"
        placeholder="Mensaje del commit (⌘Enter para commit)"
        value={message}
        disabled={state.busy}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            run(e.shiftKey);
          }
        }}
      />
      <div className="commit-options">
      <label className="check">
        <input
          type="checkbox"
          checked={amend}
          disabled={state.busy}
          onChange={(e) => {
            setAmend(e.target.checked);
            if (e.target.checked) post({ type: 'commit/requestLastMessage', payload: {} });
          }}
        />
        <span>Amend last commit</span>
      </label>
        {state.total > 0 && <span className="small commit-counter">{state.summary}</span>}
      </div>
      <div className="commit-summary small muted">
        {state.total === 0
          ? 'Marca archivos en la vista Changes.'
          : state.repos.map((r) => (
              <span key={r.name} className="commit-repo">
                <span className="dot" style={{ background: `var(--vscode-multigit-repo${r.colorIndex})` }} />
                {r.name} ({r.count})
              </span>
            ))}
      </div>
      <div className="commit-buttons">
        <button className="primary" disabled={!canCommit} onClick={() => run(false)}>
          {state.busy ? 'Commit…' : amend ? 'Amend' : 'Commit'}
          {state.total ? ` (${state.total})` : ''}
        </button>
        <button className="secondary" disabled={!canCommit} onClick={() => run(true)} title="⌘⇧Enter">
          Commit and Push…
        </button>
      </div>
    </div>
  );
}

function readDraft(): string {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(text: string): void {
  try {
    localStorage.setItem(DRAFT_KEY, text);
  } catch {
    // sin almacenamiento: el borrador solo vive mientras la vista esté abierta
  }
}
