import {
  MESSAGING_ROLES,
  PLAYBOOK_GOAL_MAX_CHARS,
  PLAYBOOK_RULES_MAX_CHARS,
  PLAYBOOK_VOICE_MAX_CHARS,
  createDefaultMessagingGuidance,
  isMessagingRole,
  type MessagingGuidance,
  type MessagingRole,
} from "./workspaceTypes";

export const PLAYBOOK_BACKUP_FORMAT = "chathelp-messaging-playbooks";
export const PLAYBOOK_BACKUP_VERSION = 1;
export const PLAYBOOK_BACKUP_MAX_BYTES = 512 * 1024;

export interface PlaybookBackup {
  format: typeof PLAYBOOK_BACKUP_FORMAT;
  version: typeof PLAYBOOK_BACKUP_VERSION;
  exportedAt: string;
  selectedRole: MessagingRole;
  inboxRole: MessagingRole;
  voice: string;
  playbooks: MessagingGuidance["playbooks"];
}

export function createPlaybookBackup(guidance: MessagingGuidance, inboxRole: MessagingRole, exportedAt = new Date().toISOString()): PlaybookBackup {
  return {
    format: PLAYBOOK_BACKUP_FORMAT,
    version: PLAYBOOK_BACKUP_VERSION,
    exportedAt,
    selectedRole: guidance.selectedRole,
    inboxRole,
    voice: guidance.voice,
    playbooks: Object.fromEntries(MESSAGING_ROLES.map((role) => [role, { ...guidance.playbooks[role] }])) as MessagingGuidance["playbooks"],
  };
}

export function serializePlaybookBackup(guidance: MessagingGuidance, inboxRole: MessagingRole, exportedAt?: string): string {
  return JSON.stringify(createPlaybookBackup(guidance, inboxRole, exportedAt), null, 2);
}

function requiredText(value: unknown, label: string, maxCharacters: number): string {
  if (typeof value !== "string") throw new Error(`${label} is missing or invalid.`);
  return value.slice(0, maxCharacters);
}

export function parsePlaybookBackup(raw: string): { guidance: MessagingGuidance; inboxRole: MessagingRole } {
  if (new TextEncoder().encode(raw).byteLength > PLAYBOOK_BACKUP_MAX_BYTES) {
    throw new Error("Playbook settings files must be 512 KB or smaller.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("The selected file is not valid ChatHelp playbook JSON.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("The selected file is not a ChatHelp playbook backup.");
  const source = parsed as Record<string, unknown>;
  if (source.format !== PLAYBOOK_BACKUP_FORMAT || source.version !== PLAYBOOK_BACKUP_VERSION) {
    throw new Error("This file is not a supported ChatHelp messaging-playbook backup.");
  }
  if (!isMessagingRole(source.selectedRole) || !isMessagingRole(source.inboxRole)) {
    throw new Error("The playbook backup contains an unsupported role.");
  }
  if (!source.playbooks || typeof source.playbooks !== "object") throw new Error("The playbook backup does not contain role settings.");

  const rawPlaybooks = source.playbooks as Record<string, unknown>;
  const defaults = createDefaultMessagingGuidance();
  const playbooks = { ...defaults.playbooks };
  for (const role of MESSAGING_ROLES) {
    const rawPlaybook = rawPlaybooks[role];
    if (!rawPlaybook || typeof rawPlaybook !== "object") throw new Error(`The ${role} playbook is missing.`);
    const fields = rawPlaybook as Record<string, unknown>;
    playbooks[role] = {
      objective: requiredText(fields.objective, `${role} relationship goal`, PLAYBOOK_GOAL_MAX_CHARS),
      boundaries: requiredText(fields.boundaries, `${role} reply rules`, PLAYBOOK_RULES_MAX_CHARS),
    };
  }

  return {
    guidance: {
      selectedRole: source.selectedRole,
      voice: requiredText(source.voice, "Messaging voice", PLAYBOOK_VOICE_MAX_CHARS),
      playbooks,
    },
    inboxRole: source.inboxRole,
  };
}
