"use client";

import { useEffect, useState } from "react";

export type DraftLearningUiStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; acknowledgementId: string }
  | { kind: "pending" | "failed"; onRetry: () => void };

interface DraftLearningStatusProps {
  status: DraftLearningUiStatus;
}

function SavedLearningStatus() {
  return <span className="draft-learning-status" data-kind="saved" role="status" aria-live="polite">Learning saved</span>;
}

export function DraftLearningStatus({ status }: DraftLearningStatusProps) {
  const [expiredAcknowledgementId, setExpiredAcknowledgementId] = useState<string | null>(null);
  const savedAcknowledgementId = status.kind === "saved" ? status.acknowledgementId : null;

  useEffect(() => {
    if (!savedAcknowledgementId) return;
    const timeout = window.setTimeout(() => setExpiredAcknowledgementId(savedAcknowledgementId), 3_000);
    return () => window.clearTimeout(timeout);
  }, [savedAcknowledgementId]);

  if (status.kind === "saving") {
    return <span className="draft-learning-status" data-kind="saving" role="status" aria-live="polite">Saving learning…</span>;
  }
  if (status.kind === "saved" && expiredAcknowledgementId !== status.acknowledgementId) {
    return <SavedLearningStatus key={status.acknowledgementId} />;
  }
  if (status.kind === "pending" || status.kind === "failed") {
    return <span className="draft-learning-status" data-kind={status.kind} role="alert"><button className="draft-learning-retry" type="button" aria-label="Retry learning sync" onClick={status.onRetry}>Learning sync pending — Retry</button></span>;
  }
  return <span className="draft-learning-status" data-kind="idle" aria-live="polite" />;
}
