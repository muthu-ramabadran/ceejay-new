"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AgentActivityStep, AgentStreamEvent, ChatMessage, ClarificationRequestData } from "@/types/chat";
import type { Company, CompanyReference } from "@/types/company";

function createMessage(role: "user" | "assistant", content: string, references?: CompanyReference[]): ChatMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    role,
    content,
    references,
    createdAt: new Date().toISOString(),
  };
}

function normalizeActivity(previous: AgentActivityStep[], incoming: AgentActivityStep): AgentActivityStep[] {
  const exists = previous.some((step) => step.id === incoming.id);
  if (!exists) {
    return [...previous, incoming];
  }

  return previous.map((step) => (step.id === incoming.id ? incoming : step));
}

export interface UseAgentChatOptions {
  initialMessages?: ChatMessage[];
  initialCompaniesById?: Record<string, Company>;
}

export interface UseAgentChatResult {
  messages: ChatMessage[];
  isLoading: boolean;
  activitySteps: AgentActivityStep[];
  companiesById: Record<string, Company>;
  clarificationPending: ClarificationRequestData | null;
  sendMessage: (value: string) => Promise<void>;
  handleClarificationResponse: (selection: string) => Promise<void>;
}

export function useAgentChat(options?: UseAgentChatOptions): UseAgentChatResult {
  const [messages, setMessages] = useState<ChatMessage[]>(options?.initialMessages ?? []);
  const [isLoading, setIsLoading] = useState(false);
  const [activitySteps, setActivitySteps] = useState<AgentActivityStep[]>([]);
  const [companiesById, setCompaniesById] = useState<Record<string, Company>>(options?.initialCompaniesById ?? {});
  const [clarificationPending, setClarificationPending] = useState<ClarificationRequestData | null>(null);

  const sessionIdRef = useRef<string>(crypto.randomUUID());
  const previousCandidateIdsRef = useRef<string[]>([]);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const processStream = useCallback(
    async (response: Response) => {
      if (!response.ok || !response.body) {
        throw new Error(`Chat API request failed with status ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let partialAssistantText = "";

      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const raw = line.trim();
          if (!raw) {
            continue;
          }

          const event = JSON.parse(raw) as AgentStreamEvent;

          if (event.type === "activity") {
            setActivitySteps((previous) => normalizeActivity(previous, event.data));
          }

          if (event.type === "partial_text") {
            partialAssistantText = `${partialAssistantText}${event.data.text}`.trim();
          }

          if (event.type === "clarification_request") {
            setClarificationPending(event.data);
            setIsLoading(false);
            return; // Stop processing, wait for user
          }

          if (event.type === "final_answer") {
            const content = event.data.content || partialAssistantText || "I found matching companies.";
            setMessages((previous) => [
              ...previous,
              createMessage("assistant", content, event.data.references),
            ]);
            if (event.data.companiesById) {
              setCompaniesById((previous) => ({ ...previous, ...event.data.companiesById }));
            }
            previousCandidateIdsRef.current = event.data.references.map((reference) => reference.companyId);
            setActivitySteps([]);
          }

          if (event.type === "error") {
            throw new Error(event.data.message);
          }
        }
      }
    },
    []
  );

  const sendMessage = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed || isLoading) {
        return;
      }

      const userMessage = createMessage("user", trimmed);
      const nextMessages = [...messages, userMessage];
      setMessages(nextMessages);
      setIsLoading(true);
      setActivitySteps([]);
      setClarificationPending(null);

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: sessionIdRef.current,
            messages: nextMessages,
            clientContext: {
              previousCandidateIds: previousCandidateIdsRef.current,
            },
          }),
        });

        await processStream(response);
      } catch (error) {
        if (mountedRef.current) {
          const message = error instanceof Error ? error.message : "Search failed";
          setMessages((previous) => [
            ...previous,
            createMessage("assistant", `Search failed: ${message}`),
          ]);
          setActivitySteps([]);
        }
      } finally {
        if (mountedRef.current) {
          setIsLoading(false);
        }
      }
    },
    [isLoading, messages, processStream, clarificationPending]
  );

  const handleClarificationResponse = useCallback(
    async (selection: string) => {
      if (!clarificationPending) {
        return;
      }

      setClarificationPending(null);
      setIsLoading(true);

      // Add the clarification selection as a user message for context
      const clarificationMessage = createMessage(
        "user",
        `I want: ${selection}`
      );
      setMessages((previous) => [...previous, clarificationMessage]);

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "clarification_response",
            sessionId: sessionIdRef.current,
            selection,
          }),
        });

        await processStream(response);
      } catch (error) {
        if (mountedRef.current) {
          const message = error instanceof Error ? error.message : "Search failed";
          setMessages((previous) => [
            ...previous,
            createMessage("assistant", `Search failed: ${message}`),
          ]);
          setActivitySteps([]);
        }
      } finally {
        if (mountedRef.current) {
          setIsLoading(false);
        }
      }
    },
    [clarificationPending, processStream]
  );

  return useMemo(
    () => ({
      messages,
      isLoading,
      activitySteps,
      companiesById,
      clarificationPending,
      sendMessage,
      handleClarificationResponse,
    }),
    [activitySteps, companiesById, isLoading, messages, clarificationPending, sendMessage, handleClarificationResponse]
  );
}
