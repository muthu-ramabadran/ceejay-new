"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ResumeProfile, GroupedResults, ResumeStreamEvent } from "@/lib/resume/schemas";
import type { Company } from "@/types/company";

export type ResumeMatchPhase = "upload" | "processing" | "results";

export interface ActivityStep {
  id: string;
  label: string;
  detail: string;
  status: "running" | "completed";
}

export interface SearchProgress {
  completed: number;
  total: number;
  currentQuery: string;
  recentQueries: string[];
}

export interface UseResumeMatchResult {
  phase: ResumeMatchPhase;
  isProcessing: boolean;
  error: string | null;
  activitySteps: ActivityStep[];
  searchProgress: SearchProgress | null;
  profile: ResumeProfile | null;
  groupedResults: GroupedResults | null;
  companiesById: Record<string, Company>;
  uploadResume: (file: File) => Promise<void>;
  reset: () => void;
}

export function useResumeMatch(): UseResumeMatchResult {
  const RESPONSE_START_TIMEOUT_MS = 120_000;
  const STREAM_IDLE_TIMEOUT_MS = 600_000;

  const [phase, setPhase] = useState<ResumeMatchPhase>("upload");
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activitySteps, setActivitySteps] = useState<ActivityStep[]>([]);
  const [searchProgress, setSearchProgress] = useState<SearchProgress | null>(null);
  const [profile, setProfile] = useState<ResumeProfile | null>(null);
  const [groupedResults, setGroupedResults] = useState<GroupedResults | null>(null);
  const [companiesById, setCompaniesById] = useState<Record<string, Company>>({});

  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const updateActivity = useCallback((step: ActivityStep) => {
    setActivitySteps((prev) => {
      const exists = prev.some((s) => s.id === step.id);
      if (!exists) return [...prev, step];
      return prev.map((s) => (s.id === step.id ? step : s));
    });
  }, []);

  const parseEventLine = useCallback((line: string): ResumeStreamEvent | null => {
    const raw = line.trim();
    if (!raw) return null;

    const payload = raw.startsWith("data:")
      ? raw.slice(5).trim()
      : raw;
    if (!payload) return null;

    try {
      return JSON.parse(payload) as ResumeStreamEvent;
    } catch {
      return null;
    }
  }, []);

  const withTimeout = useCallback(async <T,>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(message));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }, []);

  const uploadResume = useCallback(async (file: File) => {
    setPhase("processing");
    setIsProcessing(true);
    setError(null);
    setActivitySteps([{
      id: "upload",
      label: "Uploading resume",
      detail: file.name,
      status: "running",
    }]);
    setSearchProgress(null);
    setProfile(null);
    setGroupedResults(null);
    setCompaniesById({});
    const abortController = new AbortController();

    try {
      const formData = new FormData();
      formData.append("resume", file);
      const response = await withTimeout(
        fetch("/api/resume", {
          method: "POST",
          body: formData,
          signal: abortController.signal,
        }),
        RESPONSE_START_TIMEOUT_MS,
        `Upload timed out waiting for server response after ${Math.round(RESPONSE_START_TIMEOUT_MS / 1000)}s.`
      );

      if (!response.ok || !response.body) {
        const errBody = await response.json().catch(() => ({ error: "Upload failed" }));
        throw new Error(errBody.error ?? `Upload failed (${response.status})`);
      }
      updateActivity({
        id: "upload",
        label: "Uploading resume",
        detail: file.name,
        status: "completed",
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let receivedEvent = false;
      let receivedFinalResults = false;

      const processLine = (line: string) => {
        const event = parseEventLine(line);
        if (!event) return;
        receivedEvent = true;

        if (!mountedRef.current) return;

        if (event.type === "activity") {
          updateActivity(event.data);
        }

        if (event.type === "resume_profile") {
          setProfile(event.data);
        }

        if (event.type === "search_progress") {
          setSearchProgress((prev) => {
            const query = typeof event.data.currentQuery === "string"
              ? event.data.currentQuery.trim()
              : "";
            const recent = query
              ? [query, ...(prev?.recentQueries ?? []).filter((q) => q !== query)].slice(0, 6)
              : (prev?.recentQueries ?? []);

            return {
              ...event.data,
              recentQueries: recent,
            };
          });
        }

        if (event.type === "final_results") {
          receivedFinalResults = true;
          setGroupedResults(event.data.groups);
          setCompaniesById(event.data.companiesById as Record<string, Company>);
          setPhase("results");
        }

        if (event.type === "error") {
          throw new Error(event.data.message);
        }
      };

      while (true) {
        const { done, value: chunk } = await withTimeout(
          reader.read(),
          STREAM_IDLE_TIMEOUT_MS,
          "Resume processing timed out due to no progress updates."
        );
        if (done) {
          break;
        }

        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          processLine(line);
        }
      }
      const trailing = buffer.trim();
      if (trailing) {
        processLine(trailing);
      }

      if (!receivedFinalResults) {
        throw new Error(
          receivedEvent
            ? "Resume processing stream ended before final results reached the browser. Please retry."
            : "No progress events were received from the server. Please retry."
        );
      }
    } catch (err) {
      abortController.abort();
      if (mountedRef.current) {
        const message =
          err instanceof Error
            ? err.message
            : "Resume processing failed";
        setError(message);
        setPhase("upload");
      }
    } finally {
      if (mountedRef.current) {
        setIsProcessing(false);
      }
    }
  }, [parseEventLine, updateActivity, withTimeout]);

  const reset = useCallback(() => {
    setPhase("upload");
    setIsProcessing(false);
    setError(null);
    setActivitySteps([]);
    setSearchProgress(null);
    setProfile(null);
    setGroupedResults(null);
    setCompaniesById({});
  }, []);

  return {
    phase,
    isProcessing,
    error,
    activitySteps,
    searchProgress,
    profile,
    groupedResults,
    companiesById,
    uploadResume,
    reset,
  };
}
