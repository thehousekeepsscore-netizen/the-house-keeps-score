import React from 'react';
import { ToastMessage } from '../types';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';

interface ToastContainerProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

/**
 * Border and title colour per tone. Every toast used to wear the emerald
 * border and title whatever it said, so "Sign-in failed" and "Could not
 * settle" arrived looking like good news — and in a money app, green means
 * fine. The icon already followed the type; now the rest of the card does.
 */
const TOAST_TONE: Record<NonNullable<ToastMessage['type']>, { border: string; title: string }> = {
  success: { border: 'border-accent-2/50', title: 'text-accent-2' },
  info: { border: 'border-accent/50', title: 'text-accent' },
  warning: { border: 'border-warning/60', title: 'text-warning' },
};

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    // A live region, so a failed sign-in or a settled night is announced and
    // not only painted. Polite at the container; each warning is its own
    // alert, which is the assertive one.
    <div
      role="status"
      aria-live="polite"
      className="fixed top-4 right-4 z-[60] flex flex-col gap-2 max-w-[calc(100vw-2rem)] sm:max-w-sm w-full pointer-events-none"
    >
      {toasts.map(toast => (
        <div
          key={toast.id}
          role={toast.type === 'warning' ? 'alert' : undefined}
          data-toast-type={toast.type ?? 'success'}
          className={`pointer-events-auto bg-surface border text-text p-3.5 rounded-2xl shadow-2xl flex items-start gap-3 animate-[fade-in_160ms_ease-out] backdrop-blur-md ${TOAST_TONE[toast.type ?? 'success'].border}`}
        >
          {toast.type === 'warning' ? (
            <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
          ) : toast.type === 'info' ? (
            <Info className="w-5 h-5 text-accent shrink-0 mt-0.5" />
          ) : (
            <CheckCircle2 className="w-5 h-5 text-accent-2 shrink-0 mt-0.5" />
          )}

          <div className="flex-1 min-w-0">
            <h4 className={`text-xs font-medium ${TOAST_TONE[toast.type ?? 'success'].title}`}>{toast.title}</h4>
            <p className="text-xs text-text font-medium leading-tight mt-0.5">{toast.message}</p>
          </div>

          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            aria-label="Dismiss"
            className="tap-44 text-text-muted hover:text-text p-1 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
};
