export const SECTORS = [
  "Fintech",
  "Healthcare",
  "Developer Tools",
  "Enterprise Software",
  "Consumer",
  "Commerce",
  "Data & Analytics",
  "Security",
  "Infrastructure",
  "Climate & Energy",
  "Industrials",
  "Media & Entertainment",
  "Education",
  "Real Estate",
  "Legal"
] as const;

export const CATEGORIES_BY_SECTOR = {
  "Fintech": [
    "Payments",
    "Lending",
    "Embedded Finance",
    "Banking Infrastructure",
    "Wealth Management",
    "Insurance Tech",
    "Accounting & Expense",
    "Capital Markets",
    "Crypto & Digital Assets",
    "Financial Planning",
    "Credit & Risk",
    "Corporate Cards"
  ],
  "Healthcare": [
    "Digital Health",
    "Telehealth",
    "Clinical Software",
    "Healthcare Analytics",
    "Mental Health",
    "Drug Discovery",
    "Medical Devices",
    "Health Insurance",
    "Patient Engagement",
    "Electronic Health Records",
    "Diagnostics",
    "Genomics"
  ],
  "Developer Tools": [
    "Engineering Tools",
    "DevOps & CI/CD",
    "Code Collaboration",
    "Testing & QA",
    "API Development",
    "Monitoring & Observability",
    "Database Tools",
    "Version Control",
    "Low-Code / No-Code",
    "AI Development Tools",
    "Documentation",
    "Developer Experience"
  ],
  "Enterprise Software": [
    "Project Management",
    "Collaboration",
    "Productivity",
    "CRM",
    "ERP",
    "HR & People Ops",
    "Customer Support",
    "Communication",
    "Business Intelligence",
    "Workflow Automation",
    "Knowledge Management",
    "Contract Management"
  ],
  "Consumer": [
    "Social",
    "Dating",
    "Fitness & Wellness",
    "Personal Finance",
    "Food & Delivery",
    "Travel",
    "Entertainment",
    "Gaming",
    "Music",
    "News & Media",
    "Photography",
    "Lifestyle"
  ],
  "Commerce": [
    "E-commerce Platform",
    "Retail Tech",
    "Marketplace",
    "Inventory & Fulfillment",
    "Supply Chain",
    "Wholesale & Distribution",
    "Point of Sale",
    "Subscription Commerce",
    "Social Commerce",
    "B2B Commerce",
    "Logistics",
    "Last-Mile Delivery"
  ],
  "Data & Analytics": [
    "Business Intelligence",
    "Data Infrastructure",
    "Data Integration",
    "Machine Learning Platform",
    "Data Governance",
    "Customer Analytics",
    "Product Analytics",
    "Marketing Analytics",
    "Predictive Analytics",
    "Data Visualization",
    "ETL & Data Pipelines",
    "AI/ML Infrastructure"
  ],
  "Security": [
    "Identity & Access",
    "Endpoint Security",
    "Cloud Security",
    "Application Security",
    "Network Security",
    "Threat Detection",
    "Compliance & GRC",
    "Fraud Prevention",
    "Privacy & Data Protection",
    "Security Operations",
    "Vulnerability Management",
    "Authentication"
  ],
  "Infrastructure": [
    "Cloud Infrastructure",
    "Compute",
    "Storage",
    "Networking",
    "Edge Computing",
    "Serverless",
    "Container Orchestration",
    "Infrastructure as Code",
    "CDN & Performance",
    "Messaging & Queues",
    "API Infrastructure",
    "Platform Engineering"
  ],
  "Climate & Energy": [
    "Clean Energy",
    "Carbon Management",
    "Energy Storage",
    "Electric Vehicles",
    "Sustainable Materials",
    "Climate Analytics",
    "Energy Efficiency",
    "Renewable Energy",
    "Grid Technology",
    "Water Tech",
    "Waste Management",
    "AgTech"
  ],
  "Industrials": [
    "Manufacturing",
    "Robotics",
    "Construction Tech",
    "Supply Chain",
    "Fleet Management",
    "Asset Management",
    "Facilities Management",
    "Industrial IoT",
    "Quality Control",
    "Procurement",
    "Field Service",
    "3D Printing"
  ],
  "Media & Entertainment": [
    "Streaming",
    "Gaming",
    "Content Creation",
    "Advertising Tech",
    "Influencer Marketing",
    "Podcasting",
    "Video Production",
    "Publishing",
    "Live Events",
    "Sports Tech",
    "AR/VR",
    "Music Tech"
  ],
  "Education": [
    "EdTech",
    "Learning Management",
    "Online Learning",
    "Corporate Training",
    "Tutoring",
    "Test Prep",
    "Early Childhood",
    "Higher Education",
    "Skills Development",
    "Credentialing",
    "Education Analytics",
    "Student Success"
  ],
  "Real Estate": [
    "Property Tech",
    "Property Management",
    "Real Estate Marketplace",
    "Mortgage Tech",
    "Commercial Real Estate",
    "Construction Tech",
    "Smart Buildings",
    "Rental Tech",
    "Real Estate Analytics",
    "Title & Escrow",
    "Home Services",
    "Co-living / Co-working"
  ],
  "Legal": [
    "Legal Practice Management",
    "Contract Management",
    "E-Discovery",
    "Legal Research",
    "Compliance",
    "IP Management",
    "Legal Marketplace",
    "Document Automation",
    "Litigation Support",
    "Regulatory Tech",
    "Legal Analytics",
    "Court Tech"
  ]
} as const;

export const BUSINESS_MODELS = [
  "SaaS",
  "Marketplace",
  "Platform",
  "API-First",
  "Infrastructure",
  "Consumer App",
  "Hardware",
  "Services",
  "Open Source",
  "Freemium",
  "B2B",
  "B2C",
  "B2B2C",
  "Enterprise",
  "SMB",
  "Usage-Based",
  "Subscription",
  "Transactional"
] as const;

export function getTaxonomyPrompt(): string {
  const lines: string[] = [];
  lines.push("Sectors and Categories:");
  for (const sector of SECTORS) {
    lines.push(`- ${sector}`);
    const categories = CATEGORIES_BY_SECTOR[sector] ?? [];
    for (const category of categories) lines.push(`  - ${category}`);
  }
  lines.push("Business Models:");
  lines.push(BUSINESS_MODELS.join(", "));
  return lines.join("\n");
}
