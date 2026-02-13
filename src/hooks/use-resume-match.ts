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

  const uploadResume = useCallback(async (file: File) => {
    setPhase("processing");
    setIsProcessing(true);
    setError(null);
    setActivitySteps([]);
    setSearchProgress(null);
    setProfile(null);
    setGroupedResults(null);
    setCompaniesById({});

    try {
      const formData = new FormData();
      formData.append("resume", file);

      const response = await fetch("/api/resume", {
        method: "POST",
        body: formData,
      });

      if (!response.ok || !response.body) {
        const errBody = await response.json().catch(() => ({ error: "Upload failed" }));
        throw new Error(errBody.error ?? `Upload failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;

        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const raw = line.trim();
          if (!raw) continue;

          const event = JSON.parse(raw) as ResumeStreamEvent;

          if (!mountedRef.current) return;

          if (event.type === "activity") {
            updateActivity(event.data);
          }

          if (event.type === "resume_profile") {
            setProfile(event.data);
          }

          if (event.type === "search_progress") {
            setSearchProgress(event.data);
          }

          if (event.type === "final_results") {
            setGroupedResults(event.data.groups);
            setCompaniesById(event.data.companiesById as Record<string, Company>);
            setPhase("results");
          }

          if (event.type === "error") {
            throw new Error(event.data.message);
          }
        }
      }
    } catch (err) {
      if (mountedRef.current) {
        const message = err instanceof Error ? err.message : "Resume processing failed";
        setError(message);
        setPhase("upload");
      }
    } finally {
      if (mountedRef.current) {
        setIsProcessing(false);
      }
    }
  }, [updateActivity]);

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
