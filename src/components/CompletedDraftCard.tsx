import { useId } from "react";
import type { CloudDraftResult } from "@/lib/privateAi";
import type { DraftLearningDecision } from "@/lib/workspaceTypes";
import { DraftLearningStatus, type DraftLearningUiStatus } from "@/components/DraftLearningStatus";

type DraftProvider = CloudDraftResult["provider"] | "local";

export interface CompletedDraftCardProps {
  draft: string;
  provider?: DraftProvider;
  model?: string;
  usageAccounting?: CloudDraftResult["usageAccounting"];
  fallbackReason?: CloudDraftResult["fallbackReason"];
  learningDecision?: DraftLearningDecision;
  learningStatus: DraftLearningUiStatus;
  onDraftChange(value: string): void;
  onDraftBlur(): void;
  onCopy(): void;
  onUseful(): void;
  onNotUseful(): void;
  onAddOwnVersion(): void;
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
  learningDecision,
  learningStatus = { kind: "idle" },
  onDraftChange,
  onDraftBlur,
  onCopy,
  onUseful = () => undefined,
  onNotUseful = () => undefined,
  onAddOwnVersion = () => undefined,
}: CompletedDraftCardProps) {
  const titleId = useId();
  const fallback = fallbackLabel(fallbackReason);
  const usefulSelected = learningDecision?.state === "useful" || learningDecision?.state === "authored";
  const notUsefulSelected = learningDecision?.state === "not_useful";
  const learningBusy = learningStatus.kind === "saving";

  return (
    <article className="draft-card completed-draft-card" aria-labelledby={titleId}>
      <header className="completed-draft-header">
        <div>
          <span className="draft-kicker">READY TO REVIEW</span>
          <h3 id={titleId}>Completed draft</h3>
        </div>
        <DraftLearningStatus status={learningStatus} />
        <div className="draft-primary-actions">
          <button type="button" onClick={onCopy}>Copy</button>
          <button type="button" className={`draft-learning-action useful${usefulSelected ? " is-selected" : ""}`} aria-pressed={usefulSelected} disabled={learningBusy} onClick={onUseful}>Useful</button>
          <button type="button" className={`draft-learning-action not-useful${notUsefulSelected ? " is-selected" : ""}`} aria-pressed={notUsefulSelected} disabled={learningBusy || learningDecision?.state === "authored"} onClick={onNotUseful}>Not useful</button>
          {notUsefulSelected && <button type="button" className="draft-learning-add-own" disabled={learningBusy} onClick={onAddOwnVersion}>Add my own version</button>}
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
    </article>
  );
}
