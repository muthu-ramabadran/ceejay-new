import type { Company, CompanyReference } from "@/types/company";

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

export interface ChatClientContext {
  previousCandidateIds: string[];
}

export interface AgentActivityEventPayload {
  id: string;
  label: string;
  detail: string;
  status: AgentStepStatus;
}

export interface ClarificationOption {
  label: string;
  description: string;
}

export interface ClarificationRequestData {
  question: string;
  options: ClarificationOption[];
}

export type AgentStreamEvent =
  | { type: "activity"; data: AgentActivityEventPayload }
  | { type: "partial_text"; data: { text: string } }
  | { type: "final_answer"; data: { content: string; references: CompanyReference[]; companiesById?: Record<string, Company> } }
  | { type: "clarification_request"; data: ClarificationRequestData }
  | { type: "error"; data: { message: string } };
