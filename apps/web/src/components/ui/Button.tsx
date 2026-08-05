import React from 'react';

/**
 * The button.
 *
 * There were 46 distinct class strings containing `bg-accent` in this codebase —
 * 46 hand-written versions of one control, across eight different vertical
 * paddings. No two screens agreed on how tall a button was, which is the kind of
 * inconsistency the eye registers long before the mind names it.
 *
 * Three decisions here are about the phone rather than about looks:
 *
 *   min-height 44px   the smallest reliable touch target. `sm` is 44, not
 *                     smaller — a compact button is still pressed by a thumb.
 *   active:scale-95   press feedback. There were 4 `active:` states in the
 *                     entire application, so almost nothing acknowledged being
 *                     touched. On a phone there is no hover, so the press *is*
 *                     the entire conversation, and an app that does not answer
 *                     it feels broken however fast it actually is.
 *   real hover        19 buttons carried `bg-accent hover:bg-accent` — a hover
 *                     state setting the colour it already was.
 *
 * `loading` renders in place rather than swapping the label for a spinner, so
 * the button does not change width mid-action and shift the row under a thumb
 * that is already moving toward it.
 */

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  fullWidth?: boolean;
  /** Escape hatch for layout only — never for colour, size or weight. */
  className?: string;
}

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-contrast hover:brightness-110 border border-transparent',
  secondary: 'bg-surface text-text border border-line hover:border-line-strong',
  danger: 'bg-danger text-white hover:brightness-110 border border-transparent',
  ghost: 'bg-transparent text-text-muted border border-transparent hover:text-text hover:bg-surface',
};

// Every size clears 44px. `sm` is compact in padding, not in touch area.
const SIZES: Record<Size, string> = {
  sm: 'min-h-[44px] px-3 text-sm',
  md: 'min-h-[48px] px-4 text-sm',
  lg: 'min-h-[52px] px-5 text-base',
};

export const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  size = 'md',
  loading = false,
  fullWidth = false,
  disabled,
  children,
  className = '',
  ...rest
}) => (
  <button
    disabled={disabled || loading}
    aria-busy={loading || undefined}
    className={[
      'inline-flex items-center justify-center gap-2 rounded-xl font-semibold',
      'transition-[transform,filter,background-color,border-color] duration-150 ease-out',
      'active:scale-95',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
      'disabled:opacity-50 disabled:pointer-events-none',
      'cursor-pointer select-none',
      VARIANTS[variant],
      SIZES[size],
      fullWidth ? 'w-full' : '',
      className,
    ]
      .filter(Boolean)
      .join(' ')}
    {...rest}
  >
    {loading && (
      <span
        aria-hidden="true"
        className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin shrink-0"
      />
    )}
    {children}
  </button>
);
