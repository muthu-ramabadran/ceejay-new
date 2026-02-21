"use client";

import type { ClarificationOption } from "@/types/chat";

interface ClarificationPromptProps {
  question: string;
  options: ClarificationOption[];
  onSelect: (selection: string) => void;
  disabled?: boolean;
}

export function ClarificationPrompt({
  question,
  options,
  onSelect,
  disabled = false,
}: ClarificationPromptProps): React.JSX.Element {
  return (
    <div className="mx-4 mb-4 rounded-lg border border-border/60 bg-[var(--surface-secondary)] p-4">
      <p className="mb-3 text-sm font-medium text-[var(--text-primary)]">{question}</p>
      <div className="flex flex-col gap-2">
        {options.map((option) => (
          <button
            key={`${option.label}-${option.selection}`}
            type="button"
            onClick={() => onSelect(option.selection)}
            disabled={disabled}
            className="group text-left rounded-md border border-border/60 bg-[var(--surface-primary)] p-3 transition-colors hover:border-[var(--accent-primary)] hover:bg-[var(--surface-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <div className="text-sm font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-primary)]">
              {option.label}
            </div>
            <div className="mt-0.5 text-xs text-[var(--text-tertiary)]">
              {option.description}
            </div>
          </button>
        ))}
      </div>
      <p className="mt-3 text-xs text-[var(--text-tertiary)]">
        You can also type custom criteria in the chat box below.
      </p>
    </div>
  );
}
