"use client";

import { useEffect, useRef } from "react";

import { ActivityTimeline } from "@/components/chat/activity-timeline";
import { MessageBubble } from "@/components/chat/message-bubble";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState, LoadingState } from "@/components/ui/states";
import type { AgentActivityStep, ChatMessage } from "@/types/chat";

interface MessageListProps {
  messages: ChatMessage[];
  activitySteps: AgentActivityStep[];
  isLoading: boolean;
  onOpenReference: (companyId: string) => void;
}

export function MessageList({ messages, activitySteps, isLoading, onOpenReference }: MessageListProps): React.JSX.Element {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activitySteps, isLoading, messages]);

  const hasMessages = messages.length > 0;

  return (
    <ScrollArea className="h-full px-7 py-5">
      <div className="mx-auto flex max-w-4xl flex-col gap-3 pb-4">
        {!hasMessages && !isLoading ? <EmptyState /> : null}

        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} onOpenReference={onOpenReference} />
        ))}

        {activitySteps.length > 0 ? <ActivityTimeline steps={activitySteps} /> : null}
        {isLoading && !activitySteps.length ? <LoadingState /> : null}

        <div ref={endRef} />
      </div>
    </ScrollArea>
  );
}
