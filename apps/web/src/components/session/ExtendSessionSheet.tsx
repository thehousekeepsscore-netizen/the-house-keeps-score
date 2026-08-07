import React from 'react';
import { Sheet } from '../ui/Sheet';
import { Button } from '../ui/Button';

/**
 * More time on the clock.
 *
 * The scheduled duration was a plan, and this is the host saying the plan
 * changed — which at a poker table it always does. Additive and unlimited: a
 * cap on extensions would be the app deciding when somebody else's evening
 * ends, which is the one thing this whole design refuses to do.
 *
 * Three amounts and no custom field. Standing at a table at midnight, "another
 * half hour" is a thing you say, not a number you type.
 */

export interface ExtendSessionSheetProps {
  open: boolean;
  onClose: () => void;
  onExtend: (minutes: number) => void;
  busy?: boolean;
}

const OPTIONS = [
  { label: '30 minutes', minutes: 30 },
  { label: '1 hour', minutes: 60 },
  { label: '2 hours', minutes: 120 },
];

export const ExtendSessionSheet: React.FC<ExtendSessionSheetProps> = ({
  open,
  onClose,
  onExtend,
  busy = false,
}) => (
  <Sheet
    open={open}
    onClose={onClose}
    title="Extend session"
    description="Added to whatever is left. You can do this as often as you like."
  >
    <div className="space-y-2">
      {OPTIONS.map((o) => (
        <Button
          key={o.minutes}
          variant="secondary"
          size="lg"
          fullWidth
          disabled={busy}
          onClick={() => onExtend(o.minutes)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  </Sheet>
);
