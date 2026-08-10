import { useId, useState } from "react";
import type { CloudDraftResult } from "@/lib/privateAi";

type DraftProvider = CloudDraftResult["provider"] | "local";

export interface CompletedDraftCardProps {
  draft: string;
  provider?: DraftProvider;
  model?: string;
  usageAccounting?: CloudDraftResult["usageAccounting"];
  fallbackReason?: CloudDraftResult["fallbackReason"];
  learningEnabled: boolean;
  onDraftChange: (value: string) => void;
  onDraftBlur: () => void;
  onCopy: () => void;
  onMarkSent: () => void;
  onSaveImprovement: () => void;
  onDismiss: () => void;
  onAccept: () => void;
  onSaveEdit: () => void;
  onReject: () => void;
}

function providerLabel(provider: DraftProvider | undefined, fallbackReason: CloudDraftResult["fallbackReason"] | undefined): string {
  if (provider === "anthropic") return "Claude Opus 4.6 Thinking";
  if (provider === "cloudflare") return fallbackReason && fallbackReason !== "provider-override" ? "Workers AI fallback" : "Workers AI";
  if (provider === "local") return "Local model";
  return "Provider not retained";
}

function fallbackLabel(reason: CloudDraftResult["fallbackReason"] | undefined): string | null {
  if (reason === undefined) return null;
  if (reason === null) return "Primary provider";
  if (reason === "anthropic-allowance-exhausted") return "Claude allowance exhausted";
  if (reason === "anthropic-accounting-unavailable") return "Claude accounting unavailable";
  if (reason === "anthropic-pipeline-failed") return "Claude pipeline failed";
  return "Provider override";
}

export function CompletedDraftCard({
  draft,
  provider,
  model,
  usageAccounting,
  fallbackReason,
  learningEnabled,
  onDraftChange,
  onDraftBlur,
  onCopy,
  onMarkSent,
  onSaveImprovement,
  onDismiss,
  onAccept,
  onSaveEdit,
  onReject,
}: CompletedDraftCardProps) {
  const titleId = useId();
  const fallback = fallbackLabel(fallbackReason);
  const [moreOpen, setMoreOpen] = useState(false);

  return (
    <article className="draft-card completed-draft-card" aria-labelledby={titleId}>
      <header className="completed-draft-header">
        <div>
          <span className="draft-kicker">READY TO REVIEW</span>
          <h3 id={titleId}>Completed draft</h3>
        </div>
        <div className="draft-primary-actions">
          <button type="button" onClick={onCopy}>Copy</button>
          <button type="button" onClick={onMarkSent}>Mark sent</button>
          <button type="button" onClick={onSaveImprovement}>Save improvement</button>
        </div>
      </header>

      <dl className="draft-provider-metadata">
        <div><dt>Provider</dt><dd>{providerLabel(provider, fallbackReason)}</dd></div>
        {model && <div><dt>Model</dt><dd>{model}</dd></div>}
        {fallback && <div><dt>Routing</dt><dd>{fallback}</dd></div>}
        {usageAccounting && <div><dt>Usage</dt><dd>Usage accounting {usageAccounting}</dd></div>}
      </dl>

      <textarea
        aria-label="Edit draft 1"
        maxLength={5_000}
        value={draft}
        onChange={(event) => onDraftChange(event.target.value.slice(0, 5_000))}
        onBlur={onDraftBlur}
      />

      <details className="draft-more-actions">
        <summary onClick={() => setMoreOpen((current) => !current)}>More</summary>
        <div hidden={!moreOpen}>
          <button type="button" aria-label="Dismiss draft 1" onClick={onDismiss}>Dismiss</button>
          {learningEnabled ? <>
            <button type="button" aria-label="Accept draft 1 as feedback" onClick={onAccept}>Accept</button>
            <button type="button" aria-label="Save edited draft 1 as feedback" onClick={onSaveEdit}>Save edit</button>
            <button type="button" aria-label="Reject draft 1 as feedback" onClick={onReject}>Reject</button>
          </> : <small title="Enable encrypted personal learning in Settings">Learning off</small>}
        </div>
      </details>
    </article>
  );
}
