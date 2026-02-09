import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CompanySidePanel } from "@/components/company/company-side-panel";
import type { Company } from "@/types/company";

function buildCompany(overrides: Partial<Company> = {}): Company {
  return {
    id: "company-1",
    website_url: "https://example.com",
    status: "startup",
    company_name: "Example Company",
    tagline: null,
    description: null,
    product_description: null,
    target_customer: null,
    problem_solved: null,
    differentiator: null,
    logo_url: null,
    founded_year: null,
    headquarters: null,
    careers_page: null,
    ats_platform: null,
    ats_jobs_url: null,
    total_raised: null,
    total_raised_amount: null,
    total_raised_currency_code: null,
    funding_rounds: [],
    investors: [],
    team_size: null,
    founders: [],
    sectors: [],
    categories: [],
    niches: [],
    business_models: [],
    social_links: {},
    recent_news: [],
    issues: [],
    created_at: null,
    updated_at: null,
    scraped_at: null,
    niches_text: null,
    niches_search: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CompanySidePanel investors", () => {
  it("renders duplicate investor names once and avoids duplicate key warnings", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <CompanySidePanel
        company={buildCompany({ investors: ["Storm Ventures", "Storm Ventures"] })}
        onClose={() => {}}
      />,
    );

    const investorsSection = screen.getByText("Investors").closest("section");
    expect(investorsSection).not.toBeNull();
    expect(within(investorsSection as HTMLElement).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("Storm Ventures")).toBeInTheDocument();

    const duplicateKeyWarnings = consoleErrorSpy.mock.calls.filter((call) =>
      call.some((arg) => typeof arg === "string" && arg.includes("Encountered two children with the same key")),
    );
    expect(duplicateKeyWarnings).toHaveLength(0);
  });

  it("normalizes investors by trimming and deduplicating case-insensitively", () => {
    render(
      <CompanySidePanel
        company={buildCompany({ investors: [" Storm Ventures ", "storm ventures"] })}
        onClose={() => {}}
      />,
    );

    const investorsSection = screen.getByText("Investors").closest("section");
    expect(investorsSection).not.toBeNull();
    const items = within(investorsSection as HTMLElement).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("Storm Ventures");
  });

  it("keeps distinct investors", () => {
    render(
      <CompanySidePanel
        company={buildCompany({ investors: ["Storm Ventures", "Sequoia Capital"] })}
        onClose={() => {}}
      />,
    );

    const investorsSection = screen.getByText("Investors").closest("section");
    expect(investorsSection).not.toBeNull();
    const items = within(investorsSection as HTMLElement).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Storm Ventures");
    expect(items[1]).toHaveTextContent("Sequoia Capital");
  });
});
