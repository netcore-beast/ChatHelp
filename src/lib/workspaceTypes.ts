import { buildRulebookDigest } from "./rulebookDigest";

export type MessageRole = "me" | "them";
export type ConversationPlatform = "linkedin" | "gmail" | "outlook" | "other";
export type PipelineStage = "inbox" | "hot" | "warm" | "cold" | "follow-up" | "replied" | "snoozed" | "done";
export type ContactSource = "manual" | "linkedin-extension";
export const MESSAGING_ROLES = ["Human Resource", "Network Marketing", "Job Seeker", "Socializing/Networking"] as const;
export type MessagingRole = (typeof MESSAGING_ROLES)[number];
export const DEFAULT_MESSAGING_ROLE: MessagingRole = "Socializing/Networking";
export const PLAYBOOK_GOAL_MAX_CHARS = 20_000;
export const PLAYBOOK_RULES_MAX_CHARS = 50_000;
export const PLAYBOOK_VOICE_MAX_CHARS = 4_000;

export interface ConversationAttachment {
  id: string;
  label: string;
  kind: "file" | "image" | "link" | "unknown";
}

export interface Message {
  id: string;
  role: MessageRole;
  body: string;
  createdAt: string;
  speaker?: string;
  attachments?: ConversationAttachment[];
}

export interface DraftHistoryEntry {
  id: string;
  agenda: string;
  drafts: string[];
  createdAt: string;
  role?: MessagingRole;
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

export interface ContactSyncDiagnostic {
  action: "created" | "updated" | "no-change";
  visibleMessages: number;
  importedMessages: number;
  duplicateMessages: number;
  restoredFromArchive: boolean;
  snapshotFingerprint: string;
  synchronizedAt: string;
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
  profileUrl?: string;
  avatarUrl?: string;
  company?: string;
  conversationUrl?: string;
  source?: ContactSource;
  labels?: string[];
  pipelineStage?: PipelineStage;
  notes?: string;
  snoozedUntil?: string;
  followUpAt?: string;
  archivedAt?: string;
  firstSyncedAt?: string;
  lastSyncedAt?: string;
  lastSyncMessageCount?: number;
  pinned?: boolean;
  readLater?: boolean;
  lastSyncDiagnostic?: ContactSyncDiagnostic;
  draftHistory?: DraftHistoryEntry[];
}

export interface Guidance {
  role: MessagingRole;
  objective: string;
  voice: string;
  boundaries: string;
  rulebookDigest: string;
}

export interface RolePlaybook {
  objective: string;
  boundaries: string;
  rulebookDigest: string;
}

export type RolePlaybooks = Record<MessagingRole, RolePlaybook>;

export interface MessagingGuidance {
  selectedRole: MessagingRole;
  voice: string;
  playbooks: RolePlaybooks;
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
  rememberAccessToken: boolean;
}

export interface AiUsageEntry {
  id: string;
  contactId: string;
  modelId: string;
  promptCharacters: number;
  variants: number;
  estimatedCostUsd: number;
  createdAt: string;
}

export interface WorkspaceData {
  version: 8;
  modelId: string;
  cloudInference: CloudInferenceSettings;
  contacts: Contact[];
  guidance: MessagingGuidance;
  inboxRole: MessagingRole;
  feedback: Feedback[];
  aiUsage: AiUsageEntry[];
}

export const CLOUDFLARE_MODEL_ID = "cloud:cloudflare:auto-llama-3.1-8b-gpt-oss-120b";
export const DEFAULT_MODEL_ID = CLOUDFLARE_MODEL_ID;

export function normalizeWorkspaceModelId(): string {
  // The hosted ChatHelp experience is cloud-only. Older vaults may contain a
  // retired browser-model ID, which made the select element look like cloud
  // mode while generation still followed the local-model branch.
  return CLOUDFLARE_MODEL_ID;
}

export function newId(prefix = "item"): string {
  return prefix + "-" + crypto.randomUUID();
}

export function isMessagingRole(value: unknown): value is MessagingRole {
  return typeof value === "string" && MESSAGING_ROLES.includes(value as MessagingRole);
}

export function normalizeMessagingRole(value: unknown): MessagingRole {
  if (isMessagingRole(value)) return value;
  const legacy = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (/human resource|\bhr\b|recruit|talent|people team/.test(legacy)) return "Human Resource";
  if (/network marketing|\bmlm\b|direct sell/.test(legacy)) return "Network Marketing";
  if (/job seek|candidate|career search|looking for (?:a )?(?:job|role)/.test(legacy)) return "Job Seeker";
  return DEFAULT_MESSAGING_ROLE;
}

export function createDefaultMessagingGuidance(): MessagingGuidance {
  return {
    selectedRole: DEFAULT_MESSAGING_ROLE,
    voice: "Warm, concise, curious, and never pushy",
    playbooks: {
      "Human Resource": {
        objective: "Build a respectful professional relationship and communicate clearly about people, roles, and workplace topics",
        boundaries: "Do not invent role details, make promises, pressure the person, or use discriminatory or invasive language.",
        rulebookDigest: buildRulebookDigest("Do not invent role details, make promises, pressure the person, or use discriminatory or invasive language."),
      },
      "Network Marketing": {
        objective: "Build genuine trust and explore mutual value without leading with a pitch",
        boundaries: "Do not make income claims, create false urgency, pressure the person, or imply a relationship that does not exist.",
        rulebookDigest: buildRulebookDigest("Do not make income claims, create false urgency, pressure the person, or imply a relationship that does not exist."),
      },
      "Job Seeker": {
        objective: "Build a credible professional connection and learn about relevant opportunities",
        boundaries: "Do not invent experience, claim a referral or relationship that does not exist, demand help, or send a generic sales-style pitch.",
        rulebookDigest: buildRulebookDigest("Do not invent experience, claim a referral or relationship that does not exist, demand help, or send a generic sales-style pitch."),
      },
      "Socializing/Networking": {
        objective: "Build a genuine relationship and explore mutual business value",
        boundaries: "Do not invent facts, pressure the person, or imply a relationship that does not exist.",
        rulebookDigest: buildRulebookDigest("Do not invent facts, pressure the person, or imply a relationship that does not exist."),
      },
    },
  };
}

export function resolveRoleGuidance(guidance: MessagingGuidance, role: MessagingRole): Guidance {
  const playbook = guidance.playbooks[role];
  return { role, objective: playbook.objective, voice: guidance.voice, boundaries: playbook.boundaries, rulebookDigest: playbook.rulebookDigest || buildRulebookDigest(playbook.boundaries) };
}

export function updateRolePlaybookRules(playbook: RolePlaybook, boundaries: string): RolePlaybook {
  const normalizedBoundaries = boundaries.slice(0, PLAYBOOK_RULES_MAX_CHARS);
  return {
    ...playbook,
    boundaries: normalizedBoundaries,
    rulebookDigest: buildRulebookDigest(normalizedBoundaries),
  };
}

export function createEmptyWorkspace(): WorkspaceData {
  const guidance = createDefaultMessagingGuidance();
  return {
    version: 8,
    modelId: DEFAULT_MODEL_ID,
    cloudInference: {
      accessToken: "",
      consentedAt: "",
      rememberAccessToken: false,
    },
    contacts: [],
    guidance,
    inboxRole: guidance.selectedRole,
    feedback: [],
    aiUsage: [],
  };
}
