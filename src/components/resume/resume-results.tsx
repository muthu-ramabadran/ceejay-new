"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Dice5 } from "lucide-react";

import { CompanyCard } from "@/components/resume/company-card";
import { reasonsToMap, type GroupedResults } from "@/lib/resume/schemas";
import type { Company } from "@/types/company";

interface ResumeResultsProps {
  grouped: GroupedResults;
  companiesById: Record<string, Company>;
  onCompanyClick: (companyId: string) => void;
}

function GroupSection({
  title,
  description,
  companyIds,
  matchReasons,
  companiesById,
  onCompanyClick,
  icon,
  defaultOpen,
}: {
  title: string;
  description: string;
  companyIds: string[];
  matchReasons: Record<string, string>;
  companiesById: Record<string, Company>;
  onCompanyClick: (companyId: string) => void;
  icon?: React.ReactNode;
  defaultOpen?: boolean;
}): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(defaultOpen ?? true);
  const validCompanies = companyIds.filter((id) => companiesById[id]);

  if (!validCompanies.length) return <></>;

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="group flex w-full items-center gap-2 text-left"
      >
        {isOpen ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]" />
        )}
        {icon}
        <h3 className="text-sm font-semibold text-[var(--text-primary)] group-hover:text-accent transition-colors">
          {title}
        </h3>
        <span className="text-xs text-[var(--text-tertiary)]">({validCompanies.length})</span>
      </button>

      {isOpen ? (
        <>
          <p className="ml-6 text-xs text-[var(--text-secondary)]">{description}</p>
          <div className="ml-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {validCompanies.map((id) => {
              const company = companiesById[id];
              if (!company) return null;
              return (
                <CompanyCard
                  key={id}
                  company={company}
                  matchReason={matchReasons[id]}
                  onClick={onCompanyClick}
                />
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function ResumeResults({ grouped, companiesById, onCompanyClick }: ResumeResultsProps): React.JSX.Element {
  const totalCompanies =
    grouped.groups.reduce((sum, g) => sum + g.companyIds.length, 0) + grouped.feelingLucky.companyIds.length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--text-tertiary)]">
          {totalCompanies} companies across {grouped.groups.length} categories
        </p>
      </div>

      {grouped.groups.map((group, index) => (
        <GroupSection
          key={group.title}
          title={group.title}
          description={group.description}
          companyIds={group.companyIds}
          matchReasons={reasonsToMap(group.companyReasons)}
          companiesById={companiesById}
          onCompanyClick={onCompanyClick}
          defaultOpen={index < 3}
        />
      ))}

      {grouped.feelingLucky.companyIds.length > 0 ? (
        <div className="border-t border-border/60 pt-6">
          <GroupSection
            title={grouped.feelingLucky.title}
            description={grouped.feelingLucky.description}
            companyIds={grouped.feelingLucky.companyIds}
            matchReasons={reasonsToMap(grouped.feelingLucky.companyReasons)}
            companiesById={companiesById}
            onCompanyClick={onCompanyClick}
            icon={<Dice5 className="h-4 w-4 text-accent" />}
            defaultOpen
          />
        </div>
      ) : null}
    </div>
  );
}
