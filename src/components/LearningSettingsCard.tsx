"use client";

import { useCallback, useMemo, useState } from "react";
import { LearningRecordsManager } from "@/components/LearningRecordsManager";
import { readCloudLearningRecords, type CloudLearningRecord, type CloudLearningRecordPage, type CloudLearningStatus } from "@/lib/cloudLearning";
import { buildCloudTrainingExports } from "@/lib/trainingExport";

export interface LearningSettingsCardProps {
  status: CloudLearningStatus | null;
  statusMessage: string;
  syncStatus: string;
  pendingCount: number;
  onRetrySync: () => Promise<void>;
  onDeleteRecord: (recordId: string, recordKind: CloudLearningRecord["recordKind"]) => Promise<boolean>;
  onDisableAndDelete: () => Promise<boolean>;
  onEnable: () => Promise<boolean>;
  loadRecords?: (cursor?: string) => Promise<CloudLearningRecordPage>;
}

function download(filename: string, value: unknown, type: string) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n";
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function jsonl(values: readonly unknown[]): string {
  return values.length ? values.map((value) => JSON.stringify(value)).join("\n") + "\n" : "";
}

export function LearningSettingsCard({
  status,
  statusMessage,
  syncStatus,
  pendingCount,
  onRetrySync,
  onDeleteRecord,
  onDisableAndDelete,
  onEnable,
  loadRecords = readCloudLearningRecords,
}: LearningSettingsCardProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [managedRecords, setManagedRecords] = useState<readonly CloudLearningRecord[]>([]);
  const exports = useMemo(() => buildCloudTrainingExports(managedRecords), [managedRecords]);
  const recordChange = useCallback((records: readonly CloudLearningRecord[]) => setManagedRecords(records), []);
  const evaluationCount = managedRecords.filter((record) => record.recordKind === "evaluation").length;
  const statusLabel = status
    ? `Cloud learning ${status.enabled ? "enabled" : "disabled"}`
    : statusMessage ? "Cloud learning status unavailable" : "Checking cloud learning";
  const stateClass = status ? (status.enabled ? "enabled" : "disabled") : "pending";
  const stateLabel = status ? (status.enabled ? "Automatic" : "Off") : "Checking";
  const visibleSyncStatus = syncStatus || (pendingCount > 0 ? "Cloud learning sync pending" : "");
  const syncIsError = /pending|unavailable|failed|could not/i.test(visibleSyncStatus);

  async function disableAndDelete() {
    const disabled = await onDisableAndDelete();
    if (!disabled) return;
    setAdvancedOpen(false);
    setManagedRecords([]);
  }

  function enable() {
    setAdvancedOpen(false);
    setManagedRecords([]);
    void onEnable();
  }

  function toggleAdvanced(open: boolean) {
    setAdvancedOpen(open);
    if (!open) setManagedRecords([]);
  }

  function downloadArtifact(kind: "manifest" | "classifier" | "generative") {
    if (kind === "manifest") {
      download("dialogmint-training-manifest.json", {
        schemaVersion: 1,
        source: "current-account cloud learning management list",
        loadedRecords: managedRecords.length,
        counts: { classifier: exports.classifier.length, evaluation: evaluationCount, generative: exports.generative.length },
        excludes: ["account identifiers", "raw conversations and goals", "provider or model data", "provider-assisted drafts", "reasons and outcomes", "secrets"],
      }, "application/json;charset=utf-8");
      return;
    }
    if (kind === "classifier") download("dialogmint-stage-classifier.jsonl", jsonl(exports.classifier), "application/x-ndjson;charset=utf-8");
    else download("dialogmint-user-authored-generative.jsonl", jsonl(exports.generative), "application/x-ndjson;charset=utf-8");
  }

  return <section className="panel-card learning-card cloud-learning-card" aria-labelledby="cloud-learning-heading">
    <div className="cloud-learning-header">
      <div>
        <p className="eyebrow">APPROVED CLOUD LEARNING</p>
        <h3 id="cloud-learning-heading">{statusLabel}</h3>
      </div>
      <span className={`learning-state ${stateClass}`}>{stateLabel}</span>
    </div>
    {status ? <div className="cloud-learning-summary">
      <strong>{status.counts.classifier} classifier / {status.counts.evaluation} evaluation / {status.counts.generative} authored examples</strong>
      <span>Approved de-identified records are server-readable in Neon for retrieval and future training preparation. They are stored for {status.retentionDays} days.</span>
    </div> : <p className={statusMessage ? "error" : "section-explainer"} role={statusMessage ? "alert" : "status"} aria-live={statusMessage ? "assertive" : "polite"}>{statusMessage || "Checking this signed-in account's cloud learning status..."}</p>}
    {statusMessage && status ? <p className="error" role="alert" aria-live="assertive">{statusMessage}</p> : null}
    {pendingCount > 0 ? <div className="cloud-learning-sync" role={syncIsError ? "alert" : "status"} aria-live={syncIsError ? "assertive" : "polite"}>
      <span>{visibleSyncStatus}</span>
      <button type="button" onClick={() => void onRetrySync()}>Retry cloud learning sync</button>
    </div> : syncStatus ? <p className={syncIsError ? "error" : "status"} role={syncIsError ? "alert" : "status"} aria-live={syncIsError ? "assertive" : "polite"}>{syncStatus}</p> : null}
    {status ? <><div className="cloud-learning-actions">
      {status?.enabled === false
        ? <button type="button" onClick={enable}>Enable cloud learning</button>
        : <button type="button" className="danger-link" onClick={() => void disableAndDelete()}>Disable and delete cloud learning</button>}
    </div>
    {status.enabled ? <details className="learning-advanced" open={advancedOpen} onToggle={(event) => toggleAdvanced(event.currentTarget.open)}>
      <summary>Advanced</summary>
      {advancedOpen ? <div className="learning-advanced-content">
        <p className="section-explainer">Manage bounded current-account pages and export only allowed classifier fields or sanitized independently authored targets. Downloads do not start training or upload data.</p>
        <LearningRecordsManager loadRecords={loadRecords} onDeleteRecord={onDeleteRecord} onRecordsChange={recordChange} />
        <section className="training-export-card" aria-labelledby="training-preview-heading">
          <h4 id="training-preview-heading">Dataset preview</h4>
          <div className="training-counts">
            <strong>{exports.classifier.length} exportable classifier records loaded</strong>
            <strong>{exports.generative.length} sanitized authored examples loaded</strong>
            <span>{evaluationCount} text-free evaluation records loaded</span>
          </div>
          <div className="playbook-actions">
            <button type="button" aria-label="Download manifest" onClick={() => downloadArtifact("manifest")}>Download manifest</button>
            <button type="button" aria-label="Download classifier JSONL" disabled={!exports.classifier.length} onClick={() => downloadArtifact("classifier")}>Download classifier JSONL</button>
            <button type="button" aria-label="Download user-authored JSONL" disabled={!exports.generative.length} onClick={() => downloadArtifact("generative")}>Download user-authored JSONL</button>
          </div>
        </section>
      </div> : null}
    </details> : null}</> : null}
  </section>;
}
