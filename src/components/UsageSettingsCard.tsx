import { formatMicroUsd, type CloudUsageSummary, type UsageModelSummary, type UsageProviderSummary, type UsageTokenTotals } from "@/lib/cloudUsage";

const LLAMA_FP8_PROXY_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

function resetLabel(timestamp: string): string {
  const date = new Date(timestamp);
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
  return `Resets ${day} at ${time} UTC`;
}

function qualityLabel(quality: UsageProviderSummary["quality"]): string {
  if (quality === "exact") return "Exact recorded usage";
  if (quality === "estimated") return "Includes estimated usage";
  return "Recorded usage quality unavailable";
}

function modelQualityLabel(quality: UsageModelSummary["quality"]): string {
  if (quality === "exact") return "Exact recorded usage";
  if (quality === "estimated") return "Estimated recorded usage";
  return "Recorded usage unavailable";
}

function TokenTotals({ label, totals }: { label: string; totals: UsageTokenTotals }) {
  const tokenRows = [
    ["Input tokens", totals.uncachedInputTokens],
    ["Cache write tokens", totals.cacheWriteTokens],
    ["Cache read tokens", totals.cacheReadTokens],
    ["Output tokens", totals.outputTokens],
    ["Thinking tokens (included in output)", totals.thinkingTokens],
  ] as const;
  return <dl className="usage-token-totals" aria-label={`${label} token totals`}>
    {tokenRows.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value.toLocaleString("en-US")}</dd></div>)}
  </dl>;
}

function ModelUsage({ model }: { model: UsageModelSummary }) {
  return <li className="usage-model-row">
    <div className="usage-model-heading">
      <strong>{model.modelId}</strong>
      <span data-quality={model.quality}>{modelQualityLabel(model.quality)}</span>
    </div>
    <div className="usage-model-cost"><span>Estimated cost</span><strong>{formatMicroUsd(model.consumedMicroUsd)}</strong></div>
    <TokenTotals label={model.modelId} totals={model.totals} />
  </li>;
}

function ProviderAllowance({ summary }: { summary: UsageProviderSummary }) {
  const providerName = summary.provider === "anthropic" ? "Anthropic" : "Workers AI";
  const providerHeadingId = `usage-provider-${summary.provider}-title`;
  const usesLlamaProxy = summary.models.some((model) => model.modelId === LLAMA_FP8_PROXY_MODEL);
  const progressMax = Math.max(1, summary.allowanceMicroUsd);
  const progressValue = summary.allowanceMicroUsd === 0
    ? (summary.consumedMicroUsd > 0 ? 1 : 0)
    : Math.min(summary.consumedMicroUsd, summary.allowanceMicroUsd);
  return <article className="usage-provider-card" aria-labelledby={providerHeadingId}>
    <div className="usage-provider-heading">
      <h4 id={providerHeadingId}>{providerName}</h4>
      <span className="usage-quality" data-quality={summary.quality}>{qualityLabel(summary.quality)}</span>
    </div>
    <dl className="usage-allowance-values">
      <div><dt>Consumed</dt><dd>{formatMicroUsd(summary.consumedMicroUsd)}</dd></div>
      <div><dt>Monthly app allowance</dt><dd>{formatMicroUsd(summary.allowanceMicroUsd)}</dd></div>
      <div><dt>Estimated remaining app allowance</dt><dd>{formatMicroUsd(Math.max(0, summary.remainingMicroUsd))}</dd></div>
    </dl>
    <progress
      className="usage-allowance-progress"
      max={progressMax}
      value={progressValue}
      aria-label={`${providerName} monthly app allowance consumed`}
      aria-valuetext={`${formatMicroUsd(summary.consumedMicroUsd)} consumed of ${formatMicroUsd(summary.allowanceMicroUsd)} monthly app allowance`}
    />
    <TokenTotals label={providerName} totals={summary.totals} />
    {usesLlamaProxy && <p className="usage-proxy-note">Llama price uses published FP8-Fast proxy</p>}
    <details className="usage-advanced">
      <summary aria-label={`${providerName} Advanced`}>Advanced</summary>
      <div className="usage-advanced-content">
        <p>Model-level recorded tokens and estimated cost.</p>
        {summary.models.length ? <ul className="usage-model-list">
          {summary.models.map((model) => <ModelUsage key={model.modelId} model={model} />)}
        </ul> : <p>No completed model usage is available for this period.</p>}
      </div>
    </details>
  </article>;
}

export function UsageSettingsCard({ summary, statusMessage = "" }: { summary: CloudUsageSummary | null; statusMessage?: string }) {
  return <section className="panel-card usage-settings-card" aria-labelledby="usage-settings-title">
    <div className="usage-settings-header">
      <div>
        <p className="eyebrow">APP ALLOWANCES</p>
        <h3 id="usage-settings-title">This signed-in account</h3>
      </div>
      {summary && <p>{resetLabel(summary.nextResetAt)}</p>}
    </div>
    <p className="section-explainer">Configured monthly app allowances with consumed and estimated remaining amounts from DialogMint&apos;s recorded usage for this account.</p>
    {summary ? <div className="usage-provider-grid">
      <ProviderAllowance summary={summary.providers.anthropic} />
      <ProviderAllowance summary={summary.providers.workersAi} />
    </div> : <p className={statusMessage ? "usage-unavailable" : "usage-loading"} role="status" aria-live="polite">
      {statusMessage || "Loading current app allowances…"}
    </p>}
    {summary && statusMessage && <p className="usage-unavailable" role="status" aria-live="polite">{statusMessage} Showing the last recorded summary.</p>}
  </section>;
}
