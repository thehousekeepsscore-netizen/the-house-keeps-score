import React, { useCallback, useState } from 'react';
import { Sheet } from './Sheet';
import { Button } from './Button';

/**
 * Confirmation for destructive actions, replacing window.confirm().
 *
 * `confirm()` was guarding the app's most serious actions — removing a member,
 * deleting a club. That is the moment a product most needs to feel careful, and
 * it was handing the user a grey OS dialog with the domain name in it: unstyled,
 * unbrandable, blocking the main thread, impossible to dismiss by tapping away,
 * and on iOS visually indistinguishable from a Safari security prompt.
 *
 * Three things this does that confirm() cannot:
 *
 *   names the target   "Remove Priya from Friday Night?" rather than a generic
 *                      question, so the user confirms the specific thing
 *   survives the wait  the action is usually a network call; confirm() returns
 *                      instantly and leaves the caller to invent its own
 *                      pending state, which is why some of these paths had none
 *   reads as ours      same sheet, same motion, same buttons as the rest of the
 *                      app, from the thumb end of the screen
 *
 * The confirm button is `danger` and is deliberately NOT the default focus. A
 * destructive action should cost a deliberate movement, not an accidental
 * Return.
 */

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  /** Label for the destructive action. Say the verb: "Remove", not "OK". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** May be async; the dialog shows a pending state until it settles. */
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}) => {
  const [pending, setPending] = useState(false);

  const handleConfirm = useCallback(async () => {
    setPending(true);
    try {
      await onConfirm();
    } finally {
      // Reset even on failure: the sheet may stay open to show an error, and a
      // permanently spinning button would strand the user with no way forward.
      setPending(false);
    }
  }, [onConfirm]);

  return (
    <Sheet
      open={open}
      // A destructive confirmation should not be dismissible by accident while
      // its action is in flight.
      onClose={pending ? () => {} : onCancel}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" size="lg" fullWidth onClick={onCancel} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button variant="danger" size="lg" fullWidth onClick={handleConfirm} loading={pending}>
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
};

/**
 * Hook form, so a caller replaces `if (confirm(...)) { ... }` with something of
 * comparable weight rather than hand-rolling open/close state at every site.
 *
 *   const confirm = useConfirm();
 *   ...
 *   confirm({ title: `Remove ${name}?`, confirmLabel: 'Remove', onConfirm: () => api.remove(id) });
 *   ...
 *   {confirm.dialog}
 */
export interface ConfirmRequest {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
}

export function useConfirm() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);

  const ask = useCallback((next: ConfirmRequest) => setRequest(next), []);
  const close = useCallback(() => setRequest(null), []);

  const dialog = (
    <ConfirmDialog
      open={request !== null}
      title={request?.title ?? ''}
      description={request?.description}
      confirmLabel={request?.confirmLabel}
      cancelLabel={request?.cancelLabel}
      onCancel={close}
      onConfirm={async () => {
        await request?.onConfirm();
        close();
      }}
    />
  );

  return Object.assign(ask, { dialog });
}
