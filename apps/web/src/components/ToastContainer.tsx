import React from 'react';
import { ToastMessage } from '../types';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';

interface ToastContainerProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[60] flex flex-col gap-2 max-w-[calc(100vw-2rem)] sm:max-w-sm w-full pointer-events-none">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className="pointer-events-auto bg-surface border border-accent-2/50 text-text p-3.5 rounded-2xl shadow-2xl flex items-start gap-3 animate-slide-in backdrop-blur-md"
        >
          {toast.type === 'warning' ? (
            <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
          ) : toast.type === 'info' ? (
            <Info className="w-5 h-5 text-accent shrink-0 mt-0.5" />
          ) : (
            <CheckCircle2 className="w-5 h-5 text-accent-2 shrink-0 mt-0.5" />
          )}

          <div className="flex-1 min-w-0">
            <h4 className="text-xs font-medium text-accent-2 ">{toast.title}</h4>
            <p className="text-xs text-text font-medium leading-tight mt-0.5">{toast.message}</p>
          </div>

          <button
            onClick={() => onDismiss(toast.id)}
            className="text-text-muted hover:text-text p-1 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
};
