// Diálogo "Edit Commit Message": un área de texto de varias líneas con Aceptar / Cancelar.
import { useEffect, useRef, useState } from 'react';
import type { MessageEditState } from '../../../src/webview/protocol';
import { onHostMessage, post } from '../vscode';
import { t } from '../i18n';

export function MessageDialog() {
  const [state, setState] = useState<MessageEditState | null>(null);
  const [text, setText] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(
    () =>
      onHostMessage((m) => {
        if (m.type === 'message/state') {
          setState(m.payload);
          setText(m.payload.message);
          setTimeout(() => area.current?.focus(), 0);
        }
      }),
    [],
  );

  const ok = () => {
    if (text.trim()) post({ type: 'message/ok', payload: { message: text } });
  };

  if (!state) return <p className="muted pad">{t('Loading…')}</p>;
  return (
    <form
      className="msgedit"
      onSubmit={(e) => {
        e.preventDefault();
        ok();
      }}
    >
      {state.note && <div className="banner warning small">{state.note}</div>}
      <textarea
        ref={area}
        className="msgedit-text"
        value={text}
        spellCheck
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // ⌘/Ctrl+Enter acepta, Escape cancela (como IntelliJ).
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            ok();
          } else if (e.key === 'Escape') {
            post({ type: 'message/cancel', payload: {} });
          }
        }}
        aria-label={t('Commit message')}
      />
      <div className="push-footer">
        <span className="muted small">{t('⌘/Ctrl+Enter to accept')}</span>
        <span className="spacer" />
        <button type="button" className="secondary" onClick={() => post({ type: 'message/cancel', payload: {} })}>
          {t('Cancel')}
        </button>
        <button type="submit" className="primary" disabled={!text.trim() || text.trim() === state.message.trim()}>
          {state.okLabel}
        </button>
      </div>
    </form>
  );
}
