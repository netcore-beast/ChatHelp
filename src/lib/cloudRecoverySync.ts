import { createCloudSafeWorkspace, decryptCloudWorkspace, encryptCloudWorkspace, summarizeCloudBackup, type CloudEnvironment, type CloudBackupSummary } from "./cloudRecovery";
import { readCloudVault, writeCloudVault, CloudRecoveryTransportError } from "./cloudRecoveryClient";
import { mergeCloudWorkspaces } from "./cloudWorkspaceMerge";
import type { WorkspaceData } from "./workspaceTypes";

export type CloudSyncStatus = "off" | "preparing" | "pending" | "encrypting" | "syncing" | "synced" | "restoring" | "needs-attention" | "expired" | "deleted";

export interface CloudSyncState {
  status: CloudSyncStatus;
  contactCount: number;
  messageCount: number;
  revision: number;
  logicalDigest: string;
  message?: string;
}

export interface SynchronizeCloudWorkspaceInput {
  workspace: WorkspaceData;
  key: CryptoKey;
  environment: CloudEnvironment;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface SynchronizeCloudWorkspaceResult {
  workspace: WorkspaceData;
  state: CloudSyncState;
}

function state(status: CloudSyncStatus, summary?: CloudBackupSummary, revision = 0, message?: string): CloudSyncState {
  return {
    status,
    contactCount: summary?.contactCount ?? 0,
    messageCount: summary?.messageCount ?? 0,
    revision,
    logicalDigest: summary?.logicalDigest ?? "",
    ...(message ? { message } : {}),
  };
}

function confirmedWorkspace(workspace: WorkspaceData, summary: CloudBackupSummary, revision: number, ciphertextDigest: string, syncedAt: string): WorkspaceData {
  return {
    ...workspace,
    cloudRecovery: {
      enabled: true,
      revision,
      lastConfirmedDigest: summary.logicalDigest,
      lastConfirmedCiphertextDigest: ciphertextDigest,
      lastConfirmedContacts: summary.contactCount,
      lastConfirmedMessages: summary.messageCount,
      lastSyncedAt: syncedAt,
    },
  };
}

function confirmationMatches(workspace: WorkspaceData, summary: CloudBackupSummary): boolean {
  const recovery = workspace.cloudRecovery;
  return recovery.revision > 0 && recovery.lastConfirmedDigest === summary.logicalDigest &&
    recovery.lastConfirmedContacts === summary.contactCount && recovery.lastConfirmedMessages === summary.messageCount;
}

async function encryptedSnapshot(workspace: WorkspaceData, key: CryptoKey, environment: CloudEnvironment, now: Date) {
  const safe = createCloudSafeWorkspace(workspace, environment, now.getTime());
  const envelope = await encryptCloudWorkspace(safe, key, environment, now.toISOString());
  const summary = await summarizeCloudBackup(safe, envelope);
  return { safe, envelope, summary };
}

export async function synchronizeCloudWorkspace(input: SynchronizeCloudWorkspaceInput): Promise<SynchronizeCloudWorkspaceResult> {
  if (!input.workspace.cloudRecovery.enabled) return { workspace: input.workspace, state: state("off") };
  const now = input.now?.() ?? new Date();
  let localSnapshot;
  try {
    localSnapshot = await encryptedSnapshot(input.workspace, input.key, input.environment, now);
  } catch {
    return { workspace: input.workspace, state: state("needs-attention", undefined, input.workspace.cloudRecovery.revision, "The recovery file could not encrypt this workspace.") };
  }

  if (confirmationMatches(input.workspace, localSnapshot.summary)) {
    return { workspace: input.workspace, state: state("synced", localSnapshot.summary, input.workspace.cloudRecovery.revision) };
  }

  try {
    const confirmation = await writeCloudVault(localSnapshot.envelope, input.workspace.cloudRecovery.revision, input.fetchImpl);
    const workspace = confirmedWorkspace(input.workspace, localSnapshot.summary, confirmation.revision, confirmation.ciphertextDigest, now.toISOString());
    return { workspace, state: state("synced", localSnapshot.summary, confirmation.revision) };
  } catch (error) {
    if (!(error instanceof CloudRecoveryTransportError) || error.code !== "conflict") {
      return { workspace: input.workspace, state: state("needs-attention", localSnapshot.summary, input.workspace.cloudRecovery.revision, "Encrypted backup needs attention.") };
    }
  }

  let merged = input.workspace;
  let mergedSnapshot = localSnapshot;
  let remoteRevision = 0;
  try {
    const remote = await readCloudVault(input.fetchImpl);
    if (!remote) return { workspace: input.workspace, state: state("needs-attention", localSnapshot.summary, input.workspace.cloudRecovery.revision, "The conflicting encrypted backup was not found.") };
    const remoteWorkspace = await decryptCloudWorkspace(remote.envelope, input.key, input.environment);
    merged = await mergeCloudWorkspaces(input.workspace, remoteWorkspace);
    merged = { ...merged, cloudRecovery: { ...input.workspace.cloudRecovery, enabled: true } };
    mergedSnapshot = await encryptedSnapshot(merged, input.key, input.environment, now);
    remoteRevision = remote.revision;
  } catch {
    return { workspace: input.workspace, state: state("needs-attention", localSnapshot.summary, input.workspace.cloudRecovery.revision, "The encrypted backup could not be safely merged.") };
  }

  try {
    const confirmation = await writeCloudVault(mergedSnapshot.envelope, remoteRevision, input.fetchImpl);
    const workspace = confirmedWorkspace(merged, mergedSnapshot.summary, confirmation.revision, confirmation.ciphertextDigest, now.toISOString());
    return { workspace, state: state("synced", mergedSnapshot.summary, confirmation.revision) };
  } catch {
    return { workspace: merged, state: state("needs-attention", mergedSnapshot.summary, remoteRevision, "Encrypted backup changed again. Retry after other devices finish syncing.") };
  }
}
