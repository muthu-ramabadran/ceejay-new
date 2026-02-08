import { ExternalLink, X } from "lucide-react";

import { PropertyGrid } from "@/components/company/property-grid";
import { TagPill } from "@/components/ui/tag-pill";
import type { Company } from "@/types/company";

interface CompanySidePanelProps {
  company: Company | null;
  onClose: () => void;
}

interface PropertyRow {
  label: string;
  value: React.ReactNode;
}

function LinkAnchor({ url, label }: { url: string; label: string }): React.JSX.Element {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-sm text-accent hover:text-[var(--accent-hover)]"
    >
      {label}
      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
    </a>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="section-header mb-2">{children}</p>;
}

function hasValue(value: string | number | null | undefined): boolean {
  return value !== null && value !== undefined && String(value).trim().length > 0;
}

function TextSection({ title, value }: { title: string; value: string | null }): React.JSX.Element | null {
  if (!hasValue(value)) {
    return null;
  }

  return (
    <section>
      <SectionTitle>{title}</SectionTitle>
      <p className="text-sm leading-6 text-[var(--text-secondary)]">{value}</p>
    </section>
  );
}

export function CompanySidePanel({ company, onClose }: CompanySidePanelProps): React.JSX.Element {
  if (!company) {
    return (
      <aside className="flex h-full items-center justify-center px-8 py-6">
        <p className="text-sm text-[var(--text-secondary)]">Select a company reference to view full profile details.</p>
      </aside>
    );
  }

  const coreRows: PropertyRow[] = [];
  if (hasValue(company.status)) coreRows.push({ label: "Status", value: company.status });
  if (company.founded_year !== null) coreRows.push({ label: "Founded", value: String(company.founded_year) });
  if (hasValue(company.headquarters)) coreRows.push({ label: "Headquarters", value: company.headquarters });
  if (hasValue(company.team_size)) coreRows.push({ label: "Team Size", value: company.team_size });
  if (hasValue(company.total_raised)) coreRows.push({ label: "Total Raised", value: company.total_raised });
  if (hasValue(company.ats_platform)) coreRows.push({ label: "ATS Platform", value: company.ats_platform });

  const linksRows: PropertyRow[] = [];
  if (hasValue(company.careers_page) && company.careers_page) {
    linksRows.push({ label: "Careers", value: <LinkAnchor url={company.careers_page} label="Open careers page" /> });
  }
  if (hasValue(company.ats_jobs_url) && company.ats_jobs_url) {
    linksRows.push({ label: "ATS Jobs", value: <LinkAnchor url={company.ats_jobs_url} label="Open jobs URL" /> });
  }

  const foundersRows = company.founders.filter((founder) => hasValue(founder.name));
  const fundingRows = company.funding_rounds;
  const socialEntries = Object.entries(company.social_links).filter((entry) => hasValue(entry[1]));
  const tagsExist =
    company.sectors.length > 0 ||
    company.categories.length > 0 ||
    company.niches.length > 0 ||
    company.business_models.length > 0;

  return (
    <aside role="complementary" aria-label="Company details panel" className="h-full overflow-y-auto px-8 py-6">
      <header className="pb-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <p className="section-header">Company Details</p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm p-1 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
            aria-label="Close company details"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <div className="flex items-start gap-3">
          {company.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={company.logo_url}
              alt={`${company.company_name} logo`}
              className="mt-1 h-10 w-10 rounded-md border border-border/60 object-contain bg-white/5"
              loading="lazy"
            />
          ) : null}
          <div>
            <h2 className="text-2xl font-semibold text-[var(--text-primary)]">{company.company_name}</h2>
            {company.tagline ? <p className="mt-1 text-base text-[var(--text-secondary)]">{company.tagline}</p> : null}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          {company.website_url ? <LinkAnchor url={company.website_url} label="Website" /> : null}
          {socialEntries.map(([name, url]) => (
            <LinkAnchor key={name} url={url} label={name} />
          ))}
        </div>
      </header>

      <div className="space-y-8 border-t border-border/60 pt-5">
        {coreRows.length ? (
          <section>
            <SectionTitle>Core</SectionTitle>
            <PropertyGrid rows={coreRows} />
          </section>
        ) : null}

        {linksRows.length ? (
          <section>
            <SectionTitle>Links</SectionTitle>
            <PropertyGrid rows={linksRows} />
          </section>
        ) : null}

        <TextSection title="Description" value={company.description} />
        <TextSection title="Product Description" value={company.product_description} />
        <TextSection title="Target Customer" value={company.target_customer} />
        <TextSection title="Problem Solved" value={company.problem_solved} />
        <TextSection title="Differentiator" value={company.differentiator} />

        {foundersRows.length ? (
          <section>
            <SectionTitle>Founders</SectionTitle>
            <ul className="space-y-2 text-sm text-[var(--text-secondary)]">
              {foundersRows.map((founder) => (
                <li key={`${founder.name}-${founder.role}`} className="leading-6">
                  <span className="text-[var(--text-primary)]">{founder.name}</span>
                  {founder.role ? ` · ${founder.role}` : ""}
                  {founder.linkedin ? (
                    <>
                      {" · "}
                      <a
                        href={founder.linkedin}
                        target="_blank"
                        rel="noreferrer"
                        className="text-accent hover:text-[var(--accent-hover)]"
                      >
                        LinkedIn
                      </a>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {fundingRows.length ? (
          <section>
            <SectionTitle>Funding Rounds</SectionTitle>
            <ul className="space-y-2 text-sm text-[var(--text-secondary)]">
              {fundingRows.map((round, index) => (
                <li key={`${round.date ?? "unknown"}-${index}`} className="leading-6">
                  {[round.type, round.amount, round.date].filter(Boolean).join(" · ") || "Funding round"}
                  {round.investors.length ? ` · Investors: ${round.investors.join(", ")}` : ""}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {company.investors.length ? (
          <section>
            <SectionTitle>Investors</SectionTitle>
            <ul className="space-y-1.5 text-sm text-[var(--text-secondary)]">
              {company.investors.map((investor) => (
                <li key={investor} className="leading-6">
                  {investor}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {tagsExist ? (
          <section>
            <SectionTitle>Tags</SectionTitle>
            <div className="space-y-3">
              {company.sectors.length ? (
                <div className="flex flex-wrap gap-2">
                  {company.sectors.map((tag) => (
                    <TagPill key={`sector-${tag}`} label={tag} />
                  ))}
                </div>
              ) : null}
              {company.categories.length ? (
                <div className="flex flex-wrap gap-2">
                  {company.categories.map((tag) => (
                    <TagPill key={`category-${tag}`} label={tag} />
                  ))}
                </div>
              ) : null}
              {company.niches.length ? (
                <div className="flex flex-wrap gap-2">
                  {company.niches.map((tag) => (
                    <TagPill key={`niche-${tag}`} label={tag} />
                  ))}
                </div>
              ) : null}
              {company.business_models.length ? (
                <div className="flex flex-wrap gap-2">
                  {company.business_models.map((tag) => (
                    <TagPill key={`model-${tag}`} label={tag} />
                  ))}
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {company.recent_news.length ? (
          <section>
            <SectionTitle>Recent News</SectionTitle>
            <ul className="space-y-1.5 text-sm text-[var(--text-secondary)]">
              {company.recent_news.map((item) => (
                <li key={item} className="leading-6">
                  {item}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </aside>
  );
}
