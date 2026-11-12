// Caja de commit: mensaje, Amend last commit, Commit y Commit and Push….
import { useEffect, useRef, useState } from 'react';
import type { CommitState } from '../../../src/webview/protocol';
import { onHostMessage, post } from '../vscode';
import { t } from '../i18n';

const DRAFT_KEY = 'multigit.commitDraft';

export function CommitBox() {
  const [state, setState] = useState<CommitState>({ repos: [], total: 0, summary: '', busy: false, generating: false });
  const [message, setMessage] = useState(() => readDraft());
  const [amend, setAmend] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  /** El usuario escribió mientras Claude generaba: no pisar su texto con el streaming. */
  const typedWhileGenerating = useRef(false);

  useEffect(
    () =>
      onHostMessage((m) => {
        if (m.type === 'commit/state') setState(m.payload);
        if (m.type === 'commit/setMessage') setMessage((current) => current.trim() ? current : m.payload.message);
        if (m.type === 'commit/partial' && !typedWhileGenerating.current) setMessage(m.payload.text);
        if (m.type === 'commit/replaceMessage') {
          if (!typedWhileGenerating.current) setMessage(m.payload.message);
          typedWhileGenerating.current = false;
        }
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

  const generate = () => {
    typedWhileGenerating.current = false;
    post({ type: 'commit/generate', payload: { current: message } });
  };

  return (
    <div className="commit">
      <div className="commit-toolbar">
        {state.generating ? (
          <button
            className="claude-btn running"
            title={t('Cancel generation')}
            onClick={() => post({ type: 'commit/cancelGenerate', payload: {} })}
          >
            <span className="spinner" /> {t('Generating…')} <span className="muted">{t('Cancel')}</span>
          </button>
        ) : (
          <button
            className="claude-btn"
            title={t('Write the message with Claude from the checked files (⌘G). Click again for another proposal.')}
            disabled={state.busy || state.total === 0}
            onClick={generate}
          >
            <ClaudeIcon /> {t('Generate with Claude')}
          </button>
        )}
      </div>
      <textarea
        ref={textarea}
        className="commit-message"
        placeholder={t('Commit message (⌘Enter to commit)')}
        value={message}
        disabled={state.busy}
        onChange={(e) => {
          if (state.generating) typedWhileGenerating.current = true;
          setMessage(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key.toLowerCase() === 'g' && (e.metaKey || e.ctrlKey) && !state.generating) {
            e.preventDefault();
            generate();
            return;
          }
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
          ? t('Check files in the Changes view.')
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

/** Ícono de Claude Commit (el mismo de la extensión Commit Messages for Claude Code). */
function ClaudeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="0" y="7.25" width="2.5" height="1.5" rx="0.75" fill="currentColor" />
      <rect x="13.5" y="7.25" width="2.5" height="1.5" rx="0.75" fill="currentColor" />
      <circle cx="8" cy="8" r="5.25" fill="none" stroke="#D97757" strokeWidth="1.5" />
      <g fill="#D97757">
        <rect x="7.4" y="5" width="1.2" height="6" rx="0.6" />
        <rect x="7.4" y="5" width="1.2" height="6" rx="0.6" transform="rotate(45 8 8)" />
        <rect x="7.4" y="5" width="1.2" height="6" rx="0.6" transform="rotate(90 8 8)" />
        <rect x="7.4" y="5" width="1.2" height="6" rx="0.6" transform="rotate(-45 8 8)" />
      </g>
    </svg>
  );
}
