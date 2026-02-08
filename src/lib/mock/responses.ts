import { MOCK_COMPANIES } from "@/lib/mock/companies";
import type { MockAssistantResult } from "@/types/chat";

function toInlineSummary(text: string | null, fallback: string): string {
  if (!text) {
    return fallback;
  }

  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 130 ? `${clean.slice(0, 127)}...` : clean;
}

export const FIXED_ASSISTANT_RESULT: MockAssistantResult = {
  content:
    "I found 12 companies from your sampled dataset. I am showing fixed demo results for now, but you can inspect full company profiles from the references.",
  references: MOCK_COMPANIES.map((company) => ({
    companyId: company.id,
    companyName: company.company_name,
    reason: toInlineSummary(
      company.description ?? company.product_description,
      `${company.categories.slice(0, 2).join(" · ") || "General"} company`,
    ),
  })),
};
