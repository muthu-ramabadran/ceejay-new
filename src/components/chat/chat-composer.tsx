"use client";

import { useState } from "react";
import { SendHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ChatComposerProps {
  disabled?: boolean;
  placeholder?: string;
  onSubmit: (value: string) => Promise<void>;
}

export function ChatComposer({
  disabled = false,
  placeholder = "Ask for startups by niche, for example: companies focused on AI healthcare",
  onSubmit,
}: ChatComposerProps): React.JSX.Element {
  const [value, setValue] = useState("");

  async function handleSubmit(): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed || disabled) {
      return;
    }

    setValue("");
    await onSubmit(trimmed);
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
      className="border-t border-border/60 px-7 py-4"
      aria-label="Chat input form"
    >
      <textarea
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void handleSubmit();
          }
        }}
        placeholder={placeholder}
        className={cn(
          "min-h-[86px] w-full resize-none bg-transparent text-[15px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none",
          disabled ? "cursor-not-allowed opacity-70" : "",
        )}
      />

      <div className="mt-2 flex items-center justify-between">
        <p className="text-xs text-[var(--text-tertiary)]">Enter to send, Shift+Enter for newline</p>
        <Button type="submit" disabled={disabled || value.trim().length === 0} className="gap-2">
          Send
          <SendHorizontal className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </form>
  );
}
