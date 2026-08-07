import React, { useState } from 'react';
import { Sheet } from '../ui/Sheet';
import { Button } from '../ui/Button';

/**
 * Opening the table, which is not the same as starting the game.
 *
 * Two verbs, two moments, and the whole reason this sheet exists:
 *
 *   Open table    the room is ready — people can arrive, sit down and buy in
 *   Start playing the first hand is about to be dealt
 *
 * Before this, one tap did both, and the app claimed a poker night was under
 * way before anybody had joined, bought chips, or agreed to begin.
 *
 * It asks one question. A length is optional and almost always skipped, so "No
 * time limit" leads and is what the sheet opens on.
 */

export interface OpenTableSheetProps {
  open: boolean;
  onClose: () => void;
  /** Duration in minutes, or undefined for a night with no end. */
  onOpenTable: (options: { durationMinutes?: number; remindAtEnd: boolean }) => void;
  busy?: boolean;
}

const PRESETS = [
  { label: '30 min', minutes: 30 },
  { label: '1 hour', minutes: 60 },
  { label: '2 hours', minutes: 120 },
  { label: '4 hours', minutes: 240 },
];

export const OpenTableSheet: React.FC<OpenTableSheetProps> = ({
  open,
  onClose,
  onOpenTable,
  busy = false,
}) => {
  const [timed, setTimed] = useState(false);
  const [minutes, setMinutes] = useState<number>(120);
  const [remind, setRemind] = useState(true);

  const choice = (selected: boolean) =>
    `w-full min-h-[52px] px-4 flex items-center gap-3 rounded-[var(--radius-sm)] border text-left transition-colors duration-[var(--motion-fast)] ${
      selected ? 'border-accent bg-accent/10' : 'border-line bg-bg'
    }`;

  const dot = (selected: boolean) =>
    `w-4 h-4 rounded-full border-2 shrink-0 ${selected ? 'border-accent bg-accent' : 'border-line-strong'}`;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Tonight's session"
      description="Opening the table lets people arrive and buy in. You start the game yourself."
      footer={
        <Button
          variant="primary"
          size="lg"
          fullWidth
          loading={busy}
          onClick={() =>
            onOpenTable({
              durationMinutes: timed ? minutes : undefined,
              remindAtEnd: timed && remind,
            })
          }
        >
          Open table
        </Button>
      }
    >
      <div className="space-y-2">
        <div role="radiogroup" aria-label="Session length" className="space-y-2">
          <button
            type="button"
            role="radio"
            aria-checked={!timed}
            onClick={() => setTimed(false)}
            className={choice(!timed)}
          >
            <span aria-hidden="true" className={dot(!timed)} />
            <span className="text-base text-text">No time limit</span>
          </button>

          <button
            type="button"
            role="radio"
            aria-checked={timed}
            onClick={() => setTimed(true)}
            className={choice(timed)}
          >
            <span aria-hidden="true" className={dot(timed)} />
            <span className="text-base text-text">Timed game</span>
          </button>
        </div>

        {timed && (
          <div className="pt-2 space-y-2">
            <p className="text-sm text-text text-center">How long?</p>
            <div className="grid grid-cols-2 gap-2">
              {PRESETS.map((p) => (
                <Button
                  key={p.minutes}
                  variant={minutes === p.minutes ? 'primary' : 'secondary'}
                  size="md"
                  onClick={() => setMinutes(p.minutes)}
                >
                  {p.label}
                </Button>
              ))}
            </div>

            {/*
              Not "auto-end". The clock never ends a night — poker nights run
              over, and a timer that settled the game would be dictating the
              evening. All this decides is whether anybody is told.
            */}
            <button
              type="button"
              role="checkbox"
              aria-checked={remind}
              onClick={() => setRemind((r) => !r)}
              className="w-full min-h-[48px] px-4 flex items-center gap-3 rounded-[var(--radius-sm)] border border-line bg-bg text-left"
            >
              <span
                aria-hidden="true"
                className={`w-4 h-4 rounded-[4px] border-2 shrink-0 ${
                  remind ? 'border-accent bg-accent' : 'border-line-strong'
                }`}
              />
              <span className="text-sm text-text">Tell me when time is up</span>
            </button>
            <p className="text-xs text-text-faint text-center leading-relaxed">
              The clock never ends the night. You decide whether to carry on.
            </p>
          </div>
        )}
      </div>
    </Sheet>
  );
};
