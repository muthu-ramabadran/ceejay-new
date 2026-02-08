"use client";

import { useMemo, useState } from "react";

import { ChatComposer } from "@/components/chat/chat-composer";
import { MessageList } from "@/components/chat/message-list";
import { CompanySidePanel } from "@/components/company/company-side-panel";
import { useAgentChat } from "@/hooks/use-agent-chat";

export function ChatShell(): React.JSX.Element {
  const { messages, isLoading, activitySteps, sendMessage, companiesById } = useAgentChat();
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
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.6px] text-[var(--text-tertiary)]">Ceejay</p>
          <p className="text-sm text-[var(--text-secondary)]">Company search UI scaffold</p>
        </div>
        {detailsOpen ? (
          <button
            type="button"
            onClick={closeCompanyDetails}
            className="text-xs font-semibold uppercase tracking-[0.5px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
          >
            Close details
          </button>
        ) : null}
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
          <ChatComposer onSubmit={sendMessage} disabled={isLoading} />
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
