import { useEffect, useRef, useState } from 'react';
import { type Dialog, useDialogs } from '../dialogs.ts';
import { dismissToast, useToasts } from '../toast.ts';

function DialogView({ dialog }: { dialog: Dialog }) {
  const [value, setValue] = useState(dialog.initial ?? '');
  const input = useRef<HTMLInputElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (dialog.kind === 'prompt') {
      input.current?.focus();
      input.current?.select();
    } else {
      confirmButton.current?.focus();
    }
  }, [dialog.kind]);

  const submit = () => dialog.resolve(dialog.kind === 'prompt' ? value : 'ok');

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && dialog.resolve(null)}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={`dialog-${dialog.id}`} onKeyDown={(e) => e.key === 'Escape' && dialog.resolve(null)}>
        <h2 id={`dialog-${dialog.id}`}>{dialog.title}</h2>
        {dialog.message && <p className="dialog-message">{dialog.message}</p>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {dialog.kind === 'prompt' && (
            <input ref={input} className="text-input" value={value} placeholder={dialog.placeholder} onChange={(e) => setValue(e.target.value)} aria-label={dialog.title} />
          )}
          <div className="dialog-actions">
            <button type="button" onClick={() => dialog.resolve(null)}>
              Cancel
            </button>
            <button ref={confirmButton} type="submit" className={dialog.danger ? 'danger' : 'primary'} disabled={dialog.kind === 'prompt' && !value.trim()}>
              {dialog.confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Dialogs and toasts, drawn above everything else. */
export function Overlays() {
  const dialogs = useDialogs();
  const toasts = useToasts();
  return (
    <>
      {dialogs.map((d) => (
        <DialogView key={d.id} dialog={d} />
      ))}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <span>{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  t.action?.run();
                  dismissToast(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
