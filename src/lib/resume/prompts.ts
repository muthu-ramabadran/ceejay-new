export const resumeExtractionPrompt = `You are analyzing a resume to extract the candidate's domain expertise and professional experience areas.

IMPORTANT: Focus on WHAT problems they solved and WHAT domains they worked in — NOT their tech stack or job titles.

Extract:
- experienceAreas: Each distinct domain they've worked in with context and approximate years. Be specific about the business domain (e.g. "SMB lending products" not just "fintech"). Include context about what they actually built or did.
- industriesWorked: High-level industries (e.g. "Fintech", "Healthcare", "Enterprise SaaS")
- problemSpaces: Specific problems they've tackled (e.g. "fraud detection", "real-time data pipelines", "developer experience")
- productTypes: Types of products they've built (e.g. "API platforms", "B2B SaaS", "marketplace", "mobile apps")
- customerSegments: Who they've built for (e.g. "SMBs", "enterprise", "developers", "consumers")
- totalYearsExperience: Total professional experience in years
- summary: 2-3 sentence summary focused on domain expertise and problem-solving experience

Do NOT include:
- Programming languages or frameworks
- Specific tools or technologies
- Job titles or seniority levels
- Education details`;

export function buildSearchPlanPrompt(profileSummary: string, totalYears: number): string {
  const baseSearchCount = Math.max(8, Math.min(20, Math.round(totalYears * 1.2)));

  return `You are planning targeted startup searches based on a candidate's professional profile.

## Candidate Profile
${profileSummary}

## Instructions

Generate ${baseSearchCount}-${baseSearchCount + 5} specific search queries to find startups that match this person's domain expertise.

### Core Searches (${Math.round(baseSearchCount * 0.7)}-${baseSearchCount} queries)
- Each query should be 4-5 words, targeting a SPECIFIC niche or problem space
- Use the candidate's actual experience domains — not generic terms
- Mix search types:
  - "semantic" for natural language concept searches (most queries)
  - "keyword" for specific industry terms or exact phrases
  - "taxonomy" for broad sector/category filters (include sectors/categories arrays)

### Adjacent/Feeling Lucky Searches (3-5 queries)
- Target domains the candidate HASN'T worked in but are tangentially related
- Think about adjacent industries, upstream/downstream in the value chain, or analogous problems in different verticals
- These should surface unexpected but potentially interesting companies

### Query Quality Guidelines
- BAD: "fintech companies" (too generic)
- BAD: "machine learning startup" (too generic)
- GOOD: "SMB lending underwriting platform" (specific domain + problem)
- GOOD: "real-time payment fraud detection" (specific problem space)
- GOOD: "developer tools for financial services" (specific intersection)
- GOOD: "embedded finance API infrastructure" (specific product type + domain)

For taxonomy searches, use exact sector/category names from this list:
- Fintech: Payments, Lending, Embedded Finance, Banking Infrastructure, Wealth Management, Insurance Tech, Accounting & Expense, Capital Markets, Crypto & Digital Assets, Financial Planning, Credit & Risk, Corporate Cards
- Healthcare: Digital Health, Telehealth, Clinical Software, Healthcare Analytics, Mental Health, Drug Discovery, Medical Devices, Health Insurance, Patient Engagement, Electronic Health Records, Diagnostics, Genomics
- Developer Tools: Engineering Tools, DevOps & CI/CD, Code Collaboration, Testing & QA, API Development, Monitoring & Observability, Database Tools, Version Control, Low-Code / No-Code, AI Development Tools, Documentation, Developer Experience
- Enterprise Software: Project Management, Collaboration, Productivity, CRM, ERP, HR & People Ops, Customer Support, Communication, Business Intelligence, Workflow Automation, Knowledge Management, Contract Management
- Data & Analytics: Business Intelligence, Data Infrastructure, Data Integration, Machine Learning Platform, Data Governance, Customer Analytics, Product Analytics, Marketing Analytics, Predictive Analytics, Data Visualization, ETL & Data Pipelines, AI/ML Infrastructure
- Security: Identity & Access, Endpoint Security, Cloud Security, Application Security, Network Security, Threat Detection, Compliance & GRC, Fraud Prevention, Privacy & Data Protection, Security Operations, Vulnerability Management, Authentication
- Infrastructure: Cloud Infrastructure, Compute, Storage, Networking, Edge Computing, Serverless, Container Orchestration, Infrastructure as Code, CDN & Performance, Messaging & Queues, API Infrastructure, Platform Engineering
- Climate & Energy: Clean Energy, Carbon Management, Energy Storage, Electric Vehicles, Sustainable Materials, Climate Analytics, Energy Efficiency, Renewable Energy, Grid Technology, Water Tech, Waste Management, AgTech
- Commerce: E-commerce Platform, Retail Tech, Marketplace, Inventory & Fulfillment, Supply Chain, Wholesale & Distribution, Point of Sale, Subscription Commerce, Social Commerce, B2B Commerce, Logistics, Last-Mile Delivery
- Consumer: Social, Dating, Fitness & Wellness, Personal Finance, Food & Delivery, Travel, Entertainment, Gaming, Music, News & Media, Photography, Lifestyle
- Industrials: Manufacturing, Robotics, Construction Tech, Supply Chain, Fleet Management, Asset Management, Facilities Management, Industrial IoT, Quality Control, Procurement, Field Service, 3D Printing
- Media & Entertainment: Streaming, Gaming, Content Creation, Advertising Tech, Influencer Marketing, Podcasting, Video Production, Publishing, Live Events, Sports Tech, AR/VR, Music Tech
- Education: EdTech, Learning Management, Online Learning, Corporate Training, Tutoring, Test Prep, Early Childhood, Higher Education, Skills Development, Credentialing, Education Analytics, Student Success
- Real Estate: Property Tech, Property Management, Real Estate Marketplace, Mortgage Tech, Commercial Real Estate, Construction Tech, Smart Buildings, Rental Tech, Real Estate Analytics, Title & Escrow, Home Services, Co-living / Co-working
- Legal: Legal Practice Management, Contract Management, E-Discovery, Legal Research, Compliance, IP Management, Legal Marketplace, Document Automation, Litigation Support, Regulatory Tech, Legal Analytics, Court Tech`;
}

export function buildGroupingPrompt(
  profileSummary: string,
  companies: Array<{ id: string; name: string; description: string | null; sectors: string[]; categories: string[] }>,
  adjacentCompanyIds: Set<string>
): string {
  const companyList = companies
    .map(
      (c) =>
        `- ${c.id}: ${c.name} — ${c.description?.slice(0, 150) ?? "No description"} [${c.sectors.join(", ")}]`
    )
    .join("\n");

  const adjacentList = Array.from(adjacentCompanyIds).join(", ");

  return `You are grouping startup search results into themed sections for a candidate.

## Candidate Profile
${profileSummary}

## Companies to Group (${companies.length} total)
${companyList}

## Companies from Adjacent/Tangential Searches
IDs: ${adjacentList || "none"}

## Instructions

1. Create 3-8 themed groups based on the candidate's experience areas. Each group should have a clear theme tied to their expertise.
   - title: Short label like "Lending & Credit Platforms" or "Developer Infrastructure"
   - description: 1 sentence explaining why this group matches the candidate
   - companyIds: Array of company IDs that belong in this group
   - companyReasons: Array of {companyId, reason} with a short (10-15 word) reason why each company matches

2. Create a "Feeling Lucky" section with companies from adjacent domains or unexpected matches.
   - Prioritize companies from the adjacent search IDs list
   - Also include any core search results that are interesting but don't fit neatly into the main groups
   - description: Explain why these tangential matches might be interesting

Rules:
- Every company must appear in exactly ONE group (or Feeling Lucky)
- Groups should have at least 3 companies each. Merge small groups.
- Order groups by relevance to the candidate's strongest experience areas
- The Feeling Lucky section should have 3-8 companies`;
}
