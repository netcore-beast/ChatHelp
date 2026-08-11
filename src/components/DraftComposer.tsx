import { useId, useState, type ReactNode, type Ref } from "react";

export interface DraftComposerProps {
  contactName: string;
  roleLabel: string;
  stageLabel: string;
  providerLabel: string;
  objective: string;
  objectiveRef?: Ref<HTMLTextAreaElement>;
  onObjectiveChange: (value: string) => void;
  onGenerate: () => void;
  isGenerating: boolean;
  generateDisabled: boolean;
  status?: string;
  advancedControls: ReactNode;
  notices?: ReactNode;
  progress?: ReactNode;
}

export function DraftComposer({
  contactName,
  roleLabel,
  stageLabel,
  providerLabel,
  objective,
  objectiveRef,
  onObjectiveChange,
  onGenerate,
  isGenerating,
  generateDisabled,
  status,
  advancedControls,
  notices,
  progress,
}: DraftComposerProps) {
  const titleId = useId();
  const instructionId = useId();
  const instructionDescriptionId = useId();
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <section className="composer-card draft-composer" aria-labelledby={titleId}>
      <header className="composer-heading draft-composer-header">
        <div>
          <p className="eyebrow">PRIVATE DRAFTING</p>
          <h2 id={titleId}>Reply to {contactName}</h2>
        </div>
        <span>Review and send manually</span>
      </header>

      <p className="draft-summary" aria-label="Current drafting setup">
        {roleLabel} / {stageLabel} / {providerLabel}
      </p>

      <div className="objective-field compact-objective-field">
        <label className="sr-only" htmlFor={instructionId}>Optional instruction</label>
        <span className="sr-only" id={instructionDescriptionId}>
          Leave blank to reply from the visible conversation, relationship context, and selected playbook.
        </span>
        <div className="prompt-composer">
          <textarea
            id={instructionId}
            ref={objectiveRef}
            aria-label="Optional instruction"
            aria-describedby={instructionDescriptionId}
            maxLength={5_000}
            rows={2}
            value={objective}
            onChange={(event) => onObjectiveChange(event.target.value.slice(0, 5_000))}
            placeholder="Optional instruction for this reply"
          />
          <div className="prompt-composer-actions">
            {status && <span className="status" aria-live="polite">{status}</span>}
            <button
              type="button"
              className={`primary draft-generate-button${isGenerating ? " is-loading" : ""}`}
              disabled={generateDisabled}
              aria-label={isGenerating ? "Stop generating draft" : "Generate Precise Draft"}
              title={isGenerating ? "Stop generating draft" : undefined}
              aria-busy={isGenerating}
              onClick={onGenerate}
            >
              {isGenerating
                ? <span className="draft-processing-symbols" aria-hidden="true"><span className="draft-button-spinner" /><span className="draft-stop-symbol">■</span></span>
                : <span>Generate Precise Draft</span>}
            </button>
          </div>
        </div>
      </div>

      <details className="composer-advanced">
        <summary onClick={() => setAdvancedOpen((current) => !current)}>Advanced</summary>
        <div className="composer-advanced-content" hidden={!advancedOpen}>{advancedControls}</div>
      </details>

      {notices}
      {progress}
    </section>
  );
}
