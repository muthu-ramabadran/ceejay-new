"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { FIXED_ASSISTANT_RESULT } from "@/lib/mock/responses";
import type { AgentActivityStep, ChatMessage } from "@/types/chat";

const STEP_BLUEPRINT: Array<Pick<AgentActivityStep, "id" | "label" | "detail">> = [
  { id: "planning", label: "Planning", detail: "Interpreting request and outlining search actions." },
  { id: "searching", label: "Running searches", detail: "Executing semantic and keyword lookups over company profiles." },
  { id: "filtering", label: "Filtering", detail: "Narrowing candidates based on query intent and company metadata." },
  { id: "preparing", label: "Preparing results", detail: "Ranking matches and formatting references." },
];

const STEP_DELAY_MS = [550, 700, 600, 500] as const;

function makeMessage(role: "user" | "assistant", content: string, references?: ChatMessage["references"]): ChatMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    references,
    createdAt: new Date().toISOString(),
  };
}

function initialSteps(): AgentActivityStep[] {
  return STEP_BLUEPRINT.map((step) => ({ ...step, status: "pending" }));
}

export interface UseMockAgentChatResult {
  messages: ChatMessage[];
  isLoading: boolean;
  activitySteps: AgentActivityStep[];
  sendMessage: (value: string) => Promise<void>;
}

export function useMockAgentChat(): UseMockAgentChatResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activitySteps, setActivitySteps] = useState<AgentActivityStep[]>([]);
  const isMounted = useRef(true);

  useEffect(() => {
    return () => {
      isMounted.current = false;
    };
  }, []);

  const sleep = useCallback((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)), []);

  const runTimeline = useCallback(async () => {
    setActivitySteps(initialSteps());

    for (let index = 0; index < STEP_BLUEPRINT.length; index += 1) {
      if (!isMounted.current) {
        return;
      }

      setActivitySteps((previous) =>
        previous.map((step, stepIndex) => {
          if (stepIndex < index) {
            return { ...step, status: "completed" };
          }
          if (stepIndex === index) {
            return { ...step, status: "running" };
          }
          return { ...step, status: "pending" };
        }),
      );

      await sleep(STEP_DELAY_MS[index]);
    }

    if (!isMounted.current) {
      return;
    }

    setActivitySteps((previous) => previous.map((step) => ({ ...step, status: "completed" })));
  }, [sleep]);

  const sendMessage = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed || isLoading) {
        return;
      }

      setMessages((previous) => [...previous, makeMessage("user", trimmed)]);
      setIsLoading(true);

      await runTimeline();

      if (!isMounted.current) {
        return;
      }

      setMessages((previous) => [
        ...previous,
        makeMessage("assistant", FIXED_ASSISTANT_RESULT.content, FIXED_ASSISTANT_RESULT.references),
      ]);
      await sleep(200);
      setActivitySteps([]);
      setIsLoading(false);
    },
    [isLoading, runTimeline, sleep],
  );

  return useMemo(
    () => ({
      messages,
      isLoading,
      activitySteps,
      sendMessage,
    }),
    [activitySteps, isLoading, messages, sendMessage],
  );
}
