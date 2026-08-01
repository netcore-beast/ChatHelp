export type MessageRole = "me" | "them";
export type ConversationPlatform = "linkedin" | "gmail" | "outlook" | "other";

export interface Message {
  id: string;
  role: MessageRole;
  body: string;
  createdAt: string;
}

export interface ContextDocument {
  id: string;
  name: string;
  text: string;
  createdAt: string;
}

export interface Outcome {
  id: string;
  result: "positive" | "neutral" | "negative";
  note: string;
  createdAt: string;
}

export interface Contact {
  id: string;
  name: string;
  headline: string;
  profileNotes: string;
  platform: ConversationPlatform;
  platformUrl: string;
  chat: Message[];
  documents: ContextDocument[];
  outcomes: Outcome[];
  retentionDays: 0 | 30 | 90 | 365;
}

export interface Guidance {
  role: string;
  objective: string;
  voice: string;
  boundaries: string;
}

export interface Feedback {
  id: string;
  contactId: string;
  draft: string;
  rating: "useful" | "not-useful";
  note: string;
  createdAt: string;
}

export interface CloudInferenceSettings {
  accessToken: string;
  consentedAt: string;
}

export interface WorkspaceData {
  version: 4;
  modelId: string;
  cloudInference: CloudInferenceSettings;
  contacts: Contact[];
  guidance: Guidance;
  feedback: Feedback[];
}

export const CLOUDFLARE_MODEL_ID = "cloud:cloudflare:llama-3.1-8b-instruct-fast";
export const DEFAULT_MODEL_ID = CLOUDFLARE_MODEL_ID;

export function newId(prefix = "item"): string {
  return prefix + "-" + crypto.randomUUID();
}

export function createEmptyWorkspace(): WorkspaceData {
  return {
    version: 4,
    modelId: DEFAULT_MODEL_ID,
    cloudInference: {
      accessToken: "",
      consentedAt: "",
    },
    contacts: [],
    guidance: {
      role: "Business professional",
      objective: "Build a genuine relationship and explore mutual business value",
      voice: "Warm, concise, curious, and never pushy",
      boundaries: "Do not invent facts, pressure the person, or imply a relationship that does not exist.",
    },
    feedback: [],
  };
}
