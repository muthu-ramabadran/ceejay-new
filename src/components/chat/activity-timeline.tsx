import { CheckCircle2, LoaderCircle, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import type { AgentActivityStep } from "@/types/chat";

interface ActivityTimelineProps {
  steps: AgentActivityStep[];
}

export function ActivityTimeline({ steps }: ActivityTimelineProps): React.JSX.Element {
  if (!steps.length) {
    return <></>;
  }

  return (
    <section aria-live="polite" aria-label="Agent activity timeline" className="border-t border-border/60 pt-4">
      <p className="section-header mb-3">Agent Activity</p>
      <ul className="space-y-2">
        {steps.map((step) => {
          const icon =
            step.status === "completed" ? (
              <CheckCircle2 className="h-4 w-4 text-green-400" aria-hidden="true" />
            ) : step.status === "running" ? (
              <LoaderCircle className="h-4 w-4 animate-spin text-accent" aria-hidden="true" />
            ) : (
              <Search className="h-4 w-4 text-[var(--text-tertiary)]" aria-hidden="true" />
            );

          return (
            <li key={step.id} className="py-1">
              <div className="flex items-center gap-2">
                {icon}
                <span
                  className={cn(
                    "text-sm font-medium",
                    step.status === "running" ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]",
                  )}
                >
                  {step.label}
                </span>
              </div>
              <p className="mt-0.5 pl-6 text-xs text-[var(--text-tertiary)]">{step.detail}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
