"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { FileText } from "lucide-react";

import { ChatComposer } from "@/components/chat/chat-composer";
import { ClarificationPrompt } from "@/components/chat/clarification-prompt";
import { MessageList } from "@/components/chat/message-list";
import { CompanySidePanel } from "@/components/company/company-side-panel";
import { useAgentChat, type UseAgentChatOptions } from "@/hooks/use-agent-chat";
import type { ChatMessage } from "@/types/chat";
import type { Company } from "@/types/company";

function useResumeContext(): UseAgentChatOptions | undefined {
  const loaded = useRef(false);
  const [options, setOptions] = useState<UseAgentChatOptions | undefined>(undefined);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;

    // Check if we're coming from resume match
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("from") !== "resume") return;

    const raw = sessionStorage.getItem("resumeContext");
    if (!raw) return;

    try {
      const ctx = JSON.parse(raw) as {
        profile: { summary: string; experienceAreas: Array<{ domain: string }> };
        groupedResults: { groups: Array<{ title: string; companyIds: string[] }>; feelingLucky: { companyIds: string[] } };
        companiesById: Record<string, Company>;
      };

      sessionStorage.removeItem("resumeContext");

      // Build seed messages
      const totalCompanies = ctx.groupedResults.groups.reduce((sum, g) => sum + g.companyIds.length, 0) + ctx.groupedResults.feelingLucky.companyIds.length;

      const groupSummary = ctx.groupedResults.groups
        .map((g) => `- ${g.title} (${g.companyIds.length} companies)`)
        .join("\n");

      const seedMessage: ChatMessage = {
        id: "resume-seed",
        role: "assistant",
        content: `Based on your resume, I found ${totalCompanies} matching startups across these areas:\n\n${groupSummary}\n\nI also found ${ctx.groupedResults.feelingLucky.companyIds.length} tangential matches in the "Feeling Lucky" section.\n\nYou can ask me to refine these results — for example, "tell me more about the lending ones" or "which of these are Series A?"`,
        createdAt: new Date().toISOString(),
      };

      setOptions({
        initialMessages: [seedMessage],
        initialCompaniesById: ctx.companiesById,
      });

      // Clean URL
      window.history.replaceState({}, "", "/");
    } catch {
      // Invalid context, ignore
    }
  }, []);

  return options;
}

export function ChatShell(): React.JSX.Element {
  const resumeContext = useResumeContext();
  const {
    messages,
    isLoading,
    activitySteps,
    sendMessage,
    companiesById,
    clarificationPending,
    handleClarificationResponse,
  } = useAgentChat(resumeContext);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const selectedCompany = useMemo(
    () => (selectedCompanyId ? companiesById[selectedCompanyId] ?? null : null),
    [companiesById, selectedCompanyId],
  );

  function openCompany(companyId: string): void {
    setSelectedCompanyId(companyId);
    setDetailsOpen(true);
  }

  function closeCompanyDetails(): void {
    setDetailsOpen(false);
    setSelectedCompanyId(null);
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border/60 px-7">
        <div className="flex items-center gap-3">
          <Image src="/logo.png" alt="Ceejay logo" width={32} height={32} className="rounded" />
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.6px] text-[var(--text-tertiary)]">Ceejay</p>
            <p className="text-sm text-[var(--text-secondary)]">Discover startups where you can work</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <Link
            href="/resume"
            className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.5px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
          >
            <FileText className="h-3.5 w-3.5" />
            Resume Match
          </Link>
          {detailsOpen ? (
            <button
              type="button"
              onClick={closeCompanyDetails}
              className="text-xs font-semibold uppercase tracking-[0.5px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            >
              Close details
            </button>
          ) : null}
        </div>
      </header>

      <div className={`min-h-0 flex-1 grid grid-cols-1 ${detailsOpen ? "lg:grid-cols-2" : ""}`}>
        <section className={`flex min-h-0 flex-col ${detailsOpen ? "border-b border-border/60 lg:border-b-0 lg:border-r" : ""}`}>
          <div className="min-h-0 flex-1">
            <MessageList
              messages={messages}
              activitySteps={activitySteps}
              isLoading={isLoading}
              onOpenReference={openCompany}
            />
          </div>

          {clarificationPending ? (
            <ClarificationPrompt
              question={clarificationPending.question}
              options={clarificationPending.options}
              onSelect={handleClarificationResponse}
              disabled={isLoading}
            />
          ) : null}

          <ChatComposer onSubmit={sendMessage} disabled={isLoading || clarificationPending !== null} />
        </section>

        {detailsOpen ? (
          <section className="min-h-0">
            <CompanySidePanel company={selectedCompany} onClose={closeCompanyDetails} />
          </section>
        ) : null}
      </div>
    </div>
  );
}
