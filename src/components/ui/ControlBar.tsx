"use client";

/**
 * Camera and environment controls.
 *
 * A horizontally scrolling strip of segmented buttons. On a phone the strips
 * scroll rather than wrapping, which keeps the globe's vertical space intact.
 */
import type { ReactNode } from "react";

type Option<T extends string> = {
  id: T;
  label: string;
  description: string;
};

type Props<T extends string> = {
  legend: string;
  options: ReadonlyArray<Option<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Rendered before the options; used for the environment strip's label. */
  children?: ReactNode;
};

export function ControlBar<T extends string>({
  legend,
  options,
  value,
  onChange,
  children,
}: Props<T>) {
  return (
    <fieldset className="pointer-events-auto min-w-0">
      <legend className="sr-only">{legend}</legend>
      {children}

      <div
        className="flex gap-1 overflow-x-auto rounded-xl border border-hairline bg-abyss/85 p-1 backdrop-blur-xl [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="radiogroup"
        aria-label={legend}
      >
        {options.map((option) => {
          const active = option.id === value;

          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={active}
              title={option.description}
              onClick={() => onChange(option.id)}
              className={`shrink-0 rounded-lg px-3 py-1.5 text-[13px] whitespace-nowrap transition-colors ${
                active
                  ? "bg-signal text-void font-medium"
                  : "text-ink-muted hover:bg-surface hover:text-ink"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
