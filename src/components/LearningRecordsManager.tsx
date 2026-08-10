"use client";

import { useEffect, useState } from "react";
import type { CloudLearningRecord, CloudLearningRecordPage } from "@/lib/cloudLearning";
import { RELATIONSHIP_STAGE_LABELS } from "@/lib/workspaceTypes";

const ROLE_LABELS = {
  human_resource: "Human Resource",
  network_marketing: "Network Marketing",
  job_seeker: "Job Seeker",
  socializing_networking: "Socializing / Networking",
} as const;

function kindLabel(kind: CloudLearningRecord["recordKind"]): string {
  return kind === "classifier" ? "Classifier" : kind === "evaluation" ? "Evaluation" : "Authored example";
}

function visibleDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

export interface LearningRecordsManagerProps {
  loadRecords: (cursor?: string) => Promise<CloudLearningRecordPage>;
  onDeleteRecord: (recordId: string, recordKind: CloudLearningRecord["recordKind"]) => Promise<boolean>;
  onRecordsChange?: (records: readonly CloudLearningRecord[]) => void;
}

export function LearningRecordsManager({ loadRecords, onDeleteRecord, onRecordsChange }: LearningRecordsManagerProps) {
  const [records, setRecords] = useState<CloudLearningRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    loadRecords().then((page) => {
      if (!active) return;
      setRecords(page.records);
      setNextCursor(page.nextCursor);
      setMessage("");
    }).catch(() => {
      if (active) setMessage("Cloud learning records are temporarily unavailable.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [loadRecords]);

  useEffect(() => {
    onRecordsChange?.(records);
  }, [onRecordsChange, records]);

  async function loadMore() {
    if (!nextCursor || loading) return;
    setLoading(true);
    try {
      const page = await loadRecords(nextCursor);
      setRecords((current) => {
        const merged = new Map(current.map((record) => [record.recordId, record]));
        for (const record of page.records) merged.set(record.recordId, record);
        return [...merged.values()];
      });
      setNextCursor(page.nextCursor);
      setMessage("");
    } catch {
      setMessage("Cloud learning records are temporarily unavailable.");
    } finally {
      setLoading(false);
    }
  }

  async function deleteRecord(record: CloudLearningRecord) {
    if (!window.confirm(`Delete this ${kindLabel(record.recordKind).toLowerCase()} learning record? This cannot be undone.`)) return;
    setDeletingId(record.recordId);
    setMessage("");
    try {
      const deleted = await onDeleteRecord(record.recordId, record.recordKind);
      if (!deleted) {
        setMessage("Cloud learning deletion pending");
        return;
      }
      setRecords((current) => current.filter((item) => item.recordId !== record.recordId));
      setMessage("Cloud learning record deleted");
    } catch {
      setMessage("Cloud learning deletion pending");
    } finally {
      setDeletingId("");
    }
  }

  return <section className="learning-records-manager" aria-labelledby="learning-records-heading">
    <div className="learning-records-heading">
      <div>
        <h4 id="learning-records-heading">Manage learning records</h4>
        <p>Only sanitized independently authored examples display stored text.</p>
      </div>
      <span>{records.length} loaded</span>
    </div>
    {loading && records.length === 0 ? <p role="status">Loading approved learning records...</p> : null}
    {!loading && records.length === 0 && !message ? <p className="section-explainer">No approved cloud learning records were found.</p> : null}
    {records.length > 0 ? <div className="learning-record-list">
      {records.map((record) => <article className="learning-record-row" key={record.recordId}>
        <div className="learning-record-main">
          <div className="learning-record-title">
            <strong>{kindLabel(record.recordKind)}</strong>
            <span className={record.enabled ? "record-enabled" : "record-disabled"}>{record.enabled ? "Enabled" : "Disabled"}</span>
          </div>
          <dl>
            <div><dt>Role</dt><dd>{ROLE_LABELS[record.roleId]}</dd></div>
            <div><dt>Stage</dt><dd>{RELATIONSHIP_STAGE_LABELS[record.relationshipStage]}</dd></div>
            <div><dt>Created</dt><dd>{visibleDate(record.createdAt)}</dd></div>
            <div><dt>Expires</dt><dd>{visibleDate(record.expiresAt)}</dd></div>
          </dl>
          {record.recordKind === "generative" ? <p className="learning-record-target">{record.target}</p> : null}
        </div>
        <button
          type="button"
          className="danger-link"
          aria-label={`Delete ${record.recordKind} learning record`}
          disabled={deletingId === record.recordId}
          onClick={() => void deleteRecord(record)}
        >{deletingId === record.recordId ? "Deleting..." : "Delete"}</button>
      </article>)}
    </div> : null}
    {nextCursor ? <button type="button" disabled={loading} onClick={() => void loadMore()}>{loading ? "Loading..." : "Load more learning records"}</button> : null}
    {message ? <p className={message.includes("deleted") ? "status" : "error"} role={message.includes("deleted") ? "status" : "alert"} aria-live="polite">{message}</p> : null}
  </section>;
}
