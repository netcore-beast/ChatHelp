import type { DraftPipelineStage, DraftStageStatus } from "@/lib/draftProgress";

const STAGES: Array<{ id: DraftPipelineStage; label: (role: string, ruleCharacters: number) => string }> = [
  { id: "planning", label: () => "Planning reply with Llama 3.1 8B" },
  { id: "drafting", label: () => "Drafting 3 replies with GPT-OSS 120B" },
  { id: "reviewing", label: (role, count) => `Reviewing drafts against ${role} rulebook (${count.toLocaleString()} characters)` },
  { id: "finalizing", label: () => "Finalizing drafts" },
];

interface DraftProgressPanelProps {
  expanded: boolean;
  onToggle: () => void;
  role: string;
  ruleCharacters: number;
  statuses: Record<DraftPipelineStage, DraftStageStatus>;
}

export function DraftProgressPanel({ expanded, onToggle, role, ruleCharacters, statuses }: DraftProgressPanelProps) {
  return (
    <section className="draft-progress-panel" aria-label="AI generation steps">
      <button
        type="button"
        className="draft-progress-toggle"
        aria-expanded={expanded}
        aria-controls="draft-progress-content"
        aria-label={expanded ? "Hide AI steps" : "Show AI steps"}
        onClick={onToggle}
      >
        <span>AI steps</span>
        <span className="draft-progress-arrow" aria-hidden="true">›</span>
      </button>
      <div className="draft-progress-collapse" data-expanded={expanded}>
        <div id="draft-progress-content" className="draft-progress-content">
          <ol aria-live="polite">
            {STAGES.map((stage) => <li key={stage.id} data-status={statuses[stage.id]}>
              <span className="draft-step-icon" aria-hidden="true" />
              <span>{stage.label(role, ruleCharacters)}</span>
              <span className="sr-only">{statuses[stage.id]}</span>
            </li>)}
          </ol>
        </div>
      </div>
    </section>
  );
}
