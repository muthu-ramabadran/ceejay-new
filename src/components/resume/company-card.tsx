"use client";

import { Badge } from "@/components/ui/badge";
import type { Company } from "@/types/company";

interface CompanyCardProps {
  company: Company;
  matchReason?: string;
  onClick: (companyId: string) => void;
}

function formatFundingStage(company: Company): string | null {
  if (!company.funding_rounds.length) return null;
  const latest = company.funding_rounds[company.funding_rounds.length - 1];
  return latest.type ?? null;
}

export function CompanyCard({ company, matchReason, onClick }: CompanyCardProps): React.JSX.Element {
  const fundingStage = formatFundingStage(company);
  const primarySector = company.sectors[0] ?? null;

  return (
    <button
      type="button"
      onClick={() => onClick(company.id)}
      className="flex w-full flex-col gap-2 rounded-lg border border-border/60 bg-[var(--bg-secondary)] p-4 text-left transition-all duration-150 hover:border-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)]"
    >
      <div className="flex items-start gap-3">
        {company.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={company.logo_url}
            alt=""
            className="mt-0.5 h-8 w-8 shrink-0 rounded-md border border-border/60 object-contain bg-white/5"
            loading="lazy"
          />
        ) : (
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-[var(--bg-tertiary)] text-xs font-semibold text-[var(--text-tertiary)]">
            {company.company_name.charAt(0)}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[var(--text-primary)]">{company.company_name}</p>
          {company.tagline ? (
            <p className="mt-0.5 truncate text-xs text-[var(--text-secondary)]">{company.tagline}</p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {fundingStage ? <Badge className="text-[10px] px-2 py-0.5">{fundingStage}</Badge> : null}
        {primarySector ? <Badge className="text-[10px] px-2 py-0.5">{primarySector}</Badge> : null}
      </div>

      {matchReason ? (
        <p className="line-clamp-2 text-xs leading-relaxed text-[var(--text-tertiary)]">{matchReason}</p>
      ) : null}
    </button>
  );
}
