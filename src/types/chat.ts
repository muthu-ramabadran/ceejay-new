import type { CompanyReference } from "@/types/company";

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  references?: CompanyReference[];
  createdAt: string;
}

export type AgentStepStatus = "pending" | "running" | "completed";

export interface AgentActivityStep {
  id: string;
  label: string;
  detail: string;
  status: AgentStepStatus;
}

export interface MockAssistantResult {
  content: string;
  references: CompanyReference[];
}
