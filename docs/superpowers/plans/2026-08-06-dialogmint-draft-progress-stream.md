# DialogMint Draft Progress Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compact the Inbox drafting composer and show real, accessible progress from each existing Cloudflare AI pipeline stage without changing the draft request payload or manual-send boundary.

**Architecture:** The browser opts into a backward-compatible Server-Sent Events response on the existing authenticated `POST /api/drafts`. The Worker executes the existing planner, writer, reviewer, and validator while emitting bounded stage frames; a focused client parser converts frames into typed transient UI state rendered by a small progress component.

**Tech Stack:** React 19 client components, TypeScript, native Fetch/ReadableStream, Cloudflare Workers Web Streams, Vitest, Testing Library, existing global CSS tokens.

## Global Constraints

- Keep the `/api/drafts` JSON request body and existing prompt/model/business logic unchanged.
- Preserve JSON responses for clients that do not request `text/event-stream`.
- Do not add dependencies; Framer Motion is not installed, so use CSS transitions and keyframes.
- Keep existing colors, typography scale, border radii, and privacy/manual-send boundaries.
- The progress panel remains available and collapsed by default; its icon-only chevron points right when collapsed and down when expanded.
- Support keyboard operation, `aria-expanded`, `aria-controls`, polite live announcements, reduced motion, and widths down to 320px.
- Stream only stage metadata and the existing final draft payload; never stream prompts, conversation text, credentials, provider errors, vault data, or recovery material.
- Deploy the verified result only to `testing-chathelp-private-cloud.project-mission-ai.workers.dev`; leave production unchanged.

---

### Task 1: Typed browser stream parser

**Files:**
- Create: `src/lib/draftProgress.ts`
- Modify: `src/lib/privateAi.ts:273-320`
- Test: `tests/cloudAi.test.ts`

**Interfaces:**
- Produces `DraftPipelineStage = "planning" | "drafting" | "reviewing" | "finalizing"`.
- Produces `DraftStageStatus = "pending" | "in-progress" | "done" | "error"`.
- Produces `DraftProgressUpdate = { kind: "message"; message: string } | { kind: "stage"; stage: DraftPipelineStage; status: Exclude<DraftStageStatus, "pending" | "error"> }`.
- Produces `readDraftEventStream(response, onProgress): Promise<unknown>` for `generateWithCloud`.
- `generateWithCloud` keeps its request body and `Promise<string[]>` return type, requests SSE, and retains JSON fallback.

- [ ] **Step 1: Write failing client stream tests**

Add literal SSE fixtures to `tests/cloudAi.test.ts` that prove:

```ts
const stream = [
  'event: stage\ndata: {"stage":"planning","status":"in-progress"}\n\n',
  'event: stage\ndata: {"stage":"planning","status":"done"}\n\n',
  'event: result\ndata: {"drafts":["Draft one","Draft two","Draft three"]}\n\n',
];
```

The test must feed those chunks through a real `ReadableStream`, assert three sanitized drafts, and assert the two literal typed progress objects. Separate tests must prove the request body still equals `buildCloudDraftRequest(input)`, `Accept` is `text/event-stream`, existing JSON success still works, an `event: error` becomes a safe error, and a truncated stream without `result` is rejected.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
& $node node_modules\vitest\vitest.mjs run tests\cloudAi.test.ts
```

Expected: FAIL because `draftProgress.ts`, typed stage callbacks, and SSE parsing do not exist and the request still asks for JSON.

- [ ] **Step 3: Implement the bounded SSE parser**

Create `src/lib/draftProgress.ts` with the public types above and these validation rules:

```ts
const MAX_DRAFT_STREAM_BYTES = 512_000;
const VALID_STAGES = new Set<DraftPipelineStage>(["planning", "drafting", "reviewing", "finalizing"]);
const VALID_LIVE_STATUSES = new Set(["in-progress", "done"] as const);

export async function readDraftEventStream(
  response: Response,
  onProgress?: (update: DraftProgressUpdate) => void,
): Promise<unknown> {
  if (!response.body) throw new Error("Cloudflare AI returned an incomplete response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  let result: unknown;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_DRAFT_STREAM_BYTES) throw new Error("Cloudflare AI returned an oversized response.");
    buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = frame.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
      const data = frame.split("\n").filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart()).join("\n");
      const payload = JSON.parse(data);
      if (event === "stage" && VALID_STAGES.has(payload.stage) && VALID_LIVE_STATUSES.has(payload.status)) {
        onProgress?.({ kind: "stage", stage: payload.stage, status: payload.status });
      } else if (event === "result" && result === undefined) {
        result = payload;
      } else if (event === "error") {
        throw new Error(typeof payload.error === "string" ? payload.error : "Cloudflare AI is temporarily unavailable.");
      } else {
        throw new Error("Cloudflare AI returned an invalid response.");
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.trim() || result === undefined) throw new Error("Cloudflare AI returned an incomplete response.");
  return result;
}
```

Do not use `response.text()` for SSE. Parse only `stage`, `result`, and `error`; reject invalid stage/status values and multiple result frames.

- [ ] **Step 4: Integrate streaming with JSON compatibility**

Change the progress callback type used by cloud generation to `DraftProgressUpdate`. Send:

```ts
headers: {
  Accept: "text/event-stream, application/json",
  "Content-Type": "application/json",
}
```

If the response content type contains `text/event-stream`, call `readDraftEventStream`. If it contains `application/json`, preserve the existing parsing and Access-safe error behavior. Pass the final payload through the existing `parseDrafts` sanitizer.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: all `cloudAi` tests pass.

- [ ] **Step 6: Commit the client protocol**

```powershell
git add src/lib/draftProgress.ts src/lib/privateAi.ts tests/cloudAi.test.ts
git commit -m "feat: parse live draft progress"
```

---

### Task 2: Real Cloudflare Worker stage events

**Files:**
- Modify: `cloudflare/worker/src/index.js:211-416`
- Test: `tests/cloudWorker.test.ts`

**Interfaces:**
- Consumes the four stage names defined by the client contract.
- Produces SSE frames `event: stage`, `event: result`, and `event: error`.
- Preserves the current JSON response when `Accept` does not include `text/event-stream`.

- [ ] **Step 1: Write failing Worker streaming tests**

Add a request with the existing complete JSON body and `Accept: text/event-stream`. Use the real response stream and assert the decoded events are exactly ordered:

```ts
[
  ["planning", "in-progress"], ["planning", "done"],
  ["drafting", "in-progress"], ["drafting", "done"],
  ["reviewing", "in-progress"], ["reviewing", "done"],
  ["finalizing", "in-progress"], ["finalizing", "done"],
]
```

Assert one final `result` event contains three drafts, headers are no-store/SSE, JSON clients still receive `application/json`, and a rejected model call emits one generic error event containing neither the provider error nor conversation text. Add a correction-loop fixture and prove `reviewing: done` occurs only after the final reviewer call.

- [ ] **Step 2: Run Worker tests and verify RED**

```powershell
& $node node_modules\vitest\vitest.mjs run tests\cloudWorker.test.ts
```

Expected: FAIL because the Worker currently buffers and returns only JSON.

- [ ] **Step 3: Extract one pipeline function without changing prompts**

Move the existing code from planner options through final deterministic validation into:

```js
async function runDraftPipeline(env, pipelineInput, emitStage = async () => undefined) {
  await emitStage("planning", "in-progress");
  const plan = await runStructuredStage(env, LLAMA_CANDIDATE_MODEL, plannerOptions, PLAN_RESPONSE_FORMAT, parseModelPlan);
  await emitStage("planning", "done");
  await emitStage("drafting", "in-progress");
  const writerDrafts = await runStructuredStage(env, GPT_REVIEW_MODEL, writerOptions, DRAFTS_RESPONSE_FORMAT, parseModelDraftObjects);
  await emitStage("drafting", "done");
  await emitStage("reviewing", "in-progress");
  let reviewedDrafts = await runReviewer(writerDrafts);
  for (let correctionAttempt = 0; correctionAttempt < 3; correctionAttempt += 1) {
    const texts = reviewedDrafts.map((draft) => draft.text);
    const repeated = draftsRepeatedFromContext(texts, conversationContext);
    const unsupportedPersonalHistory = draftsWithUnsupportedPersonalHistory(texts);
    const questionHeavy = tooManyDraftsAreQuestions(texts);
    if (!repeated.length && !unsupportedPersonalHistory.length && !questionHeavy) break;
    const corrections = [];
    if (repeated.length) corrections.push(`The previous review copied conversation text: ${JSON.stringify(repeated)}. Continue after the latest message without repeating it.`);
    if (questionHeavy) corrections.push(`The previous set overused follow-up questions: ${JSON.stringify(texts)}. At most one draft may contain a question; the others must be complete natural responses.`);
    if (unsupportedPersonalHistory.length) corrections.push(`These drafts invented unsupported personal history: ${JSON.stringify(unsupportedPersonalHistory)}. Replace those claims with evidence-supported present-tense wording.`);
    reviewedDrafts = await runReviewer(reviewedDrafts, `\n\n<quality_correction>\n${escapedBlockText(corrections.join("\n"))}\n</quality_correction>`);
  }
  await emitStage("reviewing", "done");
  await emitStage("finalizing", "in-progress");
  const drafts = reviewedDrafts.map((draft) => draft.text);
  if (draftsRepeatedFromContext(drafts, conversationContext).length || draftsWithUnsupportedPersonalHistory(drafts).length || tooManyDraftsAreQuestions(drafts)) {
    throw new Error("Draft quality validation failed");
  }
  await emitStage("finalizing", "done");
  return { drafts, model: WORKERS_AI_MODEL, models: [LLAMA_CANDIDATE_MODEL, GPT_REVIEW_MODEL], mode: PIPELINE_MODE };
}
```

The extraction must reuse the existing already-normalized conversation, playbook, objective, style directives, and full-rulebook block. Do not edit prompt strings, temperatures, token limits, retry count, or validation predicates.

- [ ] **Step 4: Add the streaming response adapter**

Use a request-scoped `ReadableStream` and `TextEncoder`:

```js
function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamDraftPipeline(env, pipelineInput) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const result = await runDraftPipeline(env, pipelineInput, async (stage, status) => {
          controller.enqueue(encoder.encode(sseFrame("stage", { stage, status })));
        });
        controller.enqueue(encoder.encode(sseFrame("result", result)));
      } catch {
        controller.enqueue(encoder.encode(sseFrame("error", { error: "Cloud AI could not produce three safe drafts. Please try again." })));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { ...RESPONSE_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" } });
}
```

Branch to this adapter only after authentication, rate limiting, content-type, size, JSON parsing, and request normalization succeed. JSON clients await the same `runDraftPipeline` and return the existing status/body.

- [ ] **Step 5: Run Worker tests and verify GREEN**

Run the command from Step 2. Expected: all Worker tests pass with real event ordering.

- [ ] **Step 6: Commit Worker streaming**

```powershell
git add cloudflare/worker/src/index.js tests/cloudWorker.test.ts
git commit -m "feat: stream real Cloudflare AI stages"
```

---

### Task 3: Accessible progress panel and stable loading button

**Files:**
- Create: `src/components/DraftProgressPanel.tsx`
- Modify: `src/components/ChatHelpApp.tsx:314-316,924-969,1305-1335`
- Modify: `src/app/globals.css:633-662,760-770`
- Test: `tests/interaction.test.tsx`

**Interfaces:**
- Consumes `DraftPipelineStage`, `DraftStageStatus`, and transient stage state.
- Produces an accessible collapsed/expanded panel with `aria-expanded`, `aria-controls`, and a polite status list.
- The parent owns `isGenerating`, panel visibility, expanded state, and stage-state transitions.

- [ ] **Step 1: Write failing interaction tests**

Add a deferred real `ReadableStream` response so the test controls stage arrival. Assert:

```ts
expect(screen.getByRole("button", { name: "Generate 3 Drafts" })).toBeEnabled();
await user.click(screen.getByRole("button", { name: "Generate 3 Drafts" }));
expect(screen.getByRole("button", { name: "Generating Drafts" })).toBeDisabled();
expect(screen.getByRole("button", { name: "Expand AI steps" })).toHaveAttribute("aria-expanded", "false");
```

Expand with keyboard activation, enqueue stage frames, and assert the current spinner/done markers update. After `result`, assert the normal button returns, the arrow control remains collapsed and available as `Expand how this was generated`, and the summary names the selected role and literal rule-character count. Add an error-stream test proving the normal button returns and the existing error notice remains visible.

- [ ] **Step 2: Run interaction tests and verify RED**

```powershell
& $node node_modules\vitest\vitest.mjs run tests\interaction.test.tsx
```

Expected: FAIL because the static label, loading state, and progress panel do not exist.

- [ ] **Step 3: Implement the focused progress component**

Create `DraftProgressPanel.tsx` with module-level stage metadata, not inline nested components:

```tsx
export interface DraftProgressPanelProps {
  visible: boolean;
  expanded: boolean;
  complete: boolean;
  role: MessagingRole;
  ruleCharacterCount: number;
  stages: Record<DraftPipelineStage, DraftStageStatus>;
  onToggle(): void;
}

const DRAFT_STAGE_COPY: Array<{ stage: DraftPipelineStage; label: string }> = [
  { stage: "planning", label: "Planning reply with Llama 3.1 8B" },
  { stage: "drafting", label: "Drafting 3 replies with GPT-OSS 120B" },
  { stage: "reviewing", label: "Reviewing drafts against the selected role rulebook" },
  { stage: "finalizing", label: "Finalizing drafts" },
];

export function DraftProgressPanel(props: DraftProgressPanelProps) {
  const panelId = "draft-ai-steps-panel";
  return <section className="ai-steps" aria-label="AI generation steps">
    <div className="ai-steps-heading">
      <strong>{props.complete ? "How this was generated" : "AI Steps"}</strong>
      <button type="button" className="ai-steps-toggle" aria-expanded={props.expanded} aria-controls={panelId} aria-label={props.expanded ? "Collapse AI steps" : props.complete ? "Expand how this was generated" : "Expand AI steps"} onClick={props.onToggle}>
        <span className="ai-steps-chevron" aria-hidden="true">›</span>
      </button>
    </div>
    <div id={panelId} className="ai-steps-reveal" data-expanded={props.expanded} aria-hidden={!props.expanded}>
      <div><ol aria-live="polite">{DRAFT_STAGE_COPY.map(({ stage, label }) => <li key={stage} data-status={props.stages[stage]}><span aria-hidden="true" className="ai-step-indicator" /><span>{stage === "reviewing" ? `${label} (${props.ruleCharacterCount.toLocaleString()} characters)` : label}</span></li>)}</ol>{props.complete && <p>Reviewed against the full {props.role} rulebook ({props.ruleCharacterCount.toLocaleString()} rule characters) in Cloudflare Workers AI. Nothing was sent to LinkedIn.</p>}</div>
    </div>
  </section>;
}
```

Use a real `button`, keep the collapsed contents out of the tab order, and do not move focus when events arrive.

- [ ] **Step 4: Integrate transient generation state**

In `ChatHelpApp`, add `isGenerating`, `showDraftProgress`, `draftProgressExpanded`, `draftProgressComplete`, and a four-stage record initialized to pending. At generation start: clear drafts/errors, set the new request state, collapse the panel, and set `isGenerating`. Map typed stage updates without storing them in `workspace`. In `finally`, set `isGenerating(false)`. Preserve role-switch result discard and clear obsolete transient progress.

Render the button with a stable spinner wrapper:

```tsx
<button className="primary generate-drafts-button" disabled={!conversationReady || !cloudReady || isGenerating} aria-busy={isGenerating} onClick={() => void generate()}>
  <span className="generate-button-content">
    {isGenerating && <span className="button-spinner" aria-hidden="true" />}
    <span>{isGenerating ? "Generating Drafts" : "Generate 3 Drafts"}</span>
  </span>
</button>
```

Keep the existing final `aiStatus` caption and error notice.

- [ ] **Step 5: Compact styling with existing tokens**

Adjust only composer-scoped spacing/sizing values: reduce `.composer-card` gap/padding, heading gaps, selector padding, context-summary padding, objective gap, textarea minimum height, and generate-row gaps. Add CSS-only spinner, button active scale, fixed content width, chevron rotation, grid-row reveal animation, and reduced-motion override. Use existing `var(--green)`, `var(--muted)`, `var(--line)`, and existing radii/colors; add no new palette values.

At the existing narrow breakpoint, set `.generate-row`, `.generate-drafts-button`, and `.ai-steps` to fit `min-width: 0; width: 100%`, allow the status caption to wrap, and keep the textarea resizable with no fixed height.

- [ ] **Step 6: Run interaction tests and verify GREEN**

Run the command from Step 2. Expected: all interaction tests pass.

- [ ] **Step 7: Commit the compact progress UI**

```powershell
git add src/components/DraftProgressPanel.tsx src/components/ChatHelpApp.tsx src/app/globals.css tests/interaction.test.tsx
git commit -m "feat: show compact live AI progress"
```

---

### Task 4: Regression verification and testing-only release

**Files:**
- Modify only if verification reveals a regression in the files already listed above.
- Update: `docs/superpowers/plans/2026-08-06-dialogmint-draft-progress-stream.md` checkboxes as tasks complete.

**Interfaces:**
- Consumes the completed client, Worker, and UI contracts.
- Produces a verified testing preview version and a draft GitHub PR; no production deployment.

- [ ] **Step 1: Run the complete automated suite**

```powershell
& $node node_modules\vitest\vitest.mjs run
& $node node_modules\eslint\bin\eslint.js .
```

Expected: all tests pass; ESLint has zero errors and only the existing `no-img-element` warning if still present.

- [ ] **Step 2: Run both builds and boundary checks**

Run the standard Next build, then the native/static build with `CHATHELP_NATIVE_BUILD=1`, inject CSP, verify static CSP, verify the extension boundary, and run `wrangler deploy --dry-run`. Expected: every command exits zero and the extension still has no cookies, network automation, or sending behavior.

- [ ] **Step 3: Review the final diff and React/Worker rules**

Confirm no new dependency, no request-body change, no prompt/model change, no module-level request state, no floating promise, no unbounded stream buffer, no secret handling, no `display:none` reveal, and no missing accessible name. Confirm `git diff --check` passes.

- [ ] **Step 4: Push and open a draft PR**

```powershell
git push -u origin codex/draft-progress-stream
gh pr create --draft --base codex/fix-neon-jsonb-order --head codex/draft-progress-stream --title "Add compact live AI draft progress"
```

Keep the PR based on the unmerged Neon hotfix so the testing build contains both verified changes without merging either to production.

- [ ] **Step 5: Wait for CI and publish only the testing alias**

After CI passes, verify Wrangler account `project.mission.ai@gmail.com` / `8c9e063cdf6a3f83f474a7535845cbb2`, upload a version with preview alias `testing`, and confirm the output URL is exactly `https://testing-chathelp-private-cloud.project-mission-ai.workers.dev`. Do not run `wrangler versions deploy`.

- [ ] **Step 6: User verification handoff**

Ask the user to hard-refresh testing and confirm compact spacing, static button copy, loading animation, real stage order, arrow direction, keyboard expansion, restored button after success/error, and unchanged draft quality/manual-send behavior.
