"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";

import { ResumeUploadZone } from "@/components/resume/resume-upload-zone";
import { ResumeResults } from "@/components/resume/resume-results";
import { CompanySidePanel } from "@/components/company/company-side-panel";
import { Badge } from "@/components/ui/badge";
import { useResumeMatch, type ActivityStep } from "@/hooks/use-resume-match";

function ActivityTimeline({ steps, searchProgress }: { steps: ActivityStep[]; searchProgress: { completed: number; total: number; currentQuery: string; recentQueries: string[] } | null }): React.JSX.Element {
  return (
    <div className="mx-auto max-w-md space-y-2">
      {steps.map((step) => (
        <div key={step.id} className="flex items-center gap-3">
          {step.status === "running" ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />
          ) : (
            <div className="h-4 w-4 shrink-0 rounded-full border-2 border-accent bg-accent/20" />
          )}
          <div className="min-w-0">
            <p className="text-sm text-[var(--text-primary)]">{step.label}</p>
            <p className="truncate text-xs text-[var(--text-tertiary)]">{step.detail}</p>
          </div>
        </div>
      ))}
      {searchProgress ? (
        <div className="ml-7">
          <div className="h-1 w-48 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
            <div
              className="h-full rounded-full bg-accent transition-all duration-300"
              style={{ width: `${Math.round((searchProgress.completed / searchProgress.total) * 100)}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-[var(--text-tertiary)]">
            {searchProgress.completed}/{searchProgress.total} searches
          </p>
          {searchProgress.recentQueries.length > 0 ? (
            <div className="mt-2 space-y-1">
              <p className="text-[10px] font-semibold uppercase tracking-[0.5px] text-[var(--text-tertiary)]">
                Recent Queries
              </p>
              {searchProgress.recentQueries.map((query) => (
                <p key={query} className="truncate text-xs text-[var(--text-secondary)]">
                  {query}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ResumeShell(): React.JSX.Element {
  const router = useRouter();
  const {
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
  } = useResumeMatch();

  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const selectedCompany = useMemo(
    () => (selectedCompanyId ? companiesById[selectedCompanyId] ?? null : null),
    [companiesById, selectedCompanyId]
  );

  const openCompany = useCallback((companyId: string) => {
    setSelectedCompanyId(companyId);
    setDetailsOpen(true);
  }, []);

  const closeCompanyDetails = useCallback(() => {
    setDetailsOpen(false);
    setSelectedCompanyId(null);
  }, []);

  const handleContinueInChat = useCallback(() => {
    // Store resume context in sessionStorage for the chat to pick up
    if (profile && groupedResults) {
      const context = {
        profile,
        groupedResults,
        companyIds: [
          ...groupedResults.groups.flatMap((g) => g.companyIds),
          ...groupedResults.feelingLucky.companyIds,
        ],
        companiesById,
      };
      sessionStorage.setItem("resumeContext", JSON.stringify(context));
      router.push("/?from=resume");
    }
  }, [profile, groupedResults, companiesById, router]);

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border/60 px-7">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => router.push("/")}
            className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.5px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Chat Search
          </button>
          <div className="h-5 w-px bg-border/60" />
          <Image src="/logo.png" alt="Ceejay logo" width={24} height={24} className="rounded" />
          <p className="text-sm font-semibold text-[var(--text-primary)]">Resume Match</p>
        </div>

        <div className="flex items-center gap-3">
          {phase === "results" ? (
            <>
              <button
                type="button"
                onClick={reset}
                className="text-xs font-semibold uppercase tracking-[0.5px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
              >
                New Upload
              </button>
              <button
                type="button"
                onClick={handleContinueInChat}
                className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-[var(--bg-primary)] hover:bg-[var(--accent-hover)] transition-colors"
              >
                Continue in Chat
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </>
          ) : null}
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

      {/* Content */}
      <div className={`min-h-0 flex-1 grid grid-cols-1 ${detailsOpen ? "lg:grid-cols-2" : ""}`}>
        <section className={`min-h-0 overflow-y-auto ${detailsOpen ? "border-b border-border/60 lg:border-b-0 lg:border-r" : ""}`}>
          {/* Upload Phase */}
          {phase === "upload" ? (
            <div className="flex h-full flex-col items-center justify-center gap-6 px-6">
              <div className="text-center">
                <h1 className="text-2xl font-semibold text-[var(--text-primary)]">Find startups that match your experience</h1>
                <p className="mt-2 text-sm text-[var(--text-secondary)]">
                  Upload your resume and we&apos;ll search across hundreds of startups to find companies in your domain.
                </p>
              </div>
              <ResumeUploadZone onFileSelected={uploadResume} disabled={isProcessing} />
              {error ? (
                <p className="text-sm text-red-400">{error}</p>
              ) : null}
            </div>
          ) : null}

          {/* Processing Phase */}
          {phase === "processing" ? (
            <div className="flex h-full flex-col items-center justify-center gap-8 px-6">
              <div className="text-center">
                <h2 className="text-lg font-semibold text-[var(--text-primary)]">Analyzing your resume</h2>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">This may take a minute...</p>
              </div>

              <ActivityTimeline steps={activitySteps} searchProgress={searchProgress} />

              {profile ? (
                <div className="mx-auto max-w-lg space-y-3">
                  <p className="text-center text-xs font-semibold uppercase tracking-[0.5px] text-[var(--text-tertiary)]">
                    Your Profile
                  </p>
                  <p className="text-center text-sm text-[var(--text-secondary)]">{profile.summary}</p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {profile.industriesWorked.map((ind) => (
                      <Badge key={ind} variant="accent">{ind}</Badge>
                    ))}
                    {profile.problemSpaces.slice(0, 5).map((ps) => (
                      <Badge key={ps}>{ps}</Badge>
                    ))}
                  </div>
                </div>
              ) : null}

              {error ? (
                <p className="text-sm text-red-400">{error}</p>
              ) : null}
            </div>
          ) : null}

          {/* Results Phase */}
          {phase === "results" && groupedResults ? (
            <div className="px-6 py-6 lg:px-8">
              {/* Profile summary bar */}
              {profile ? (
                <div className="mb-6 flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold uppercase tracking-[0.5px] text-[var(--text-tertiary)]">
                    Matched for:
                  </span>
                  {profile.experienceAreas.slice(0, 4).map((area) => (
                    <Badge key={area.domain} variant="accent">{area.domain}</Badge>
                  ))}
                  {profile.experienceAreas.length > 4 ? (
                    <span className="text-xs text-[var(--text-tertiary)]">
                      +{profile.experienceAreas.length - 4} more
                    </span>
                  ) : null}
                </div>
              ) : null}

              <ResumeResults
                grouped={groupedResults}
                companiesById={companiesById}
                onCompanyClick={openCompany}
              />
            </div>
          ) : null}
        </section>

        {/* Side Panel */}
        {detailsOpen ? (
          <section className="min-h-0">
            <CompanySidePanel company={selectedCompany} onClose={closeCompanyDetails} />
          </section>
        ) : null}
      </div>
    </div>
  );
}
