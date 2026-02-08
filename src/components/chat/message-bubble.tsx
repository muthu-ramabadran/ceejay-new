import { ReferenceChip } from "@/components/company/reference-chip";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/types/chat";

interface MessageBubbleProps {
  message: ChatMessage;
  onOpenReference: (companyId: string) => void;
}

export function MessageBubble({ message, onOpenReference }: MessageBubbleProps): React.JSX.Element {
  const isUser = message.role === "user";

  return (
    <article className={cn("space-y-2 py-2", isUser ? "ml-auto max-w-2xl text-right" : "mr-auto max-w-3xl text-left")}>
      <p className={cn("text-xs font-semibold uppercase tracking-[0.5px] text-[var(--text-tertiary)]", isUser ? "text-right" : "text-left")}>
        {isUser ? "You" : "Ceejay"}
      </p>
      <p className="whitespace-pre-wrap text-[15px] leading-7 text-[var(--text-primary)]">{message.content}</p>

      {message.references?.length ? (
        <div className="space-y-2 pt-1 text-left">
          <p className="section-header">Matches</p>
          <ul className="space-y-2">
            {message.references.map((reference) => (
              <li key={reference.companyId} className="text-sm leading-6 text-[var(--text-secondary)]">
                <span>{reference.reason}</span>{" "}
                <ReferenceChip reference={reference} onOpen={onOpenReference} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  );
}
