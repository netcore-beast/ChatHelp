# DialogMint Stage-Aware Single-Draft and Personal Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one exceptionally precise, stage-aware reply through Claude Opus 4.6 Thinking, preserve the existing Llama 3.1 8B plus GPT-OSS 120B pipeline as a permanent compatible fallback, add opt-in encrypted retrieval learning, and provide a local stage-classifier/training-export path without Claude-output distillation.

**Architecture:** Keep the browser vault and authenticated same-origin Worker as the trust boundary. Version the encrypted workspace for manual relationship stages, 2,000-character personal guidelines, richer feedback, and human-confirmed classifier records. Build one bounded client request contract. In the Worker, route that contract through three isolated structured calls (`analyze -> draft one -> review/rewrite`) with Anthropic first and the current two-model Workers AI path on eligible provider failures. Keep all hidden analysis server-side. Add deterministic local example retrieval, a small offline classifier, and export/LoRA validators that never upload anything.

**Tech Stack:** Next.js 16.2, React 19, TypeScript, Vitest/Testing Library, Web Crypto + IndexedDB, Cloudflare Workers, Workers AI, Anthropic Messages API over `fetch`, Wrangler 4, PowerShell.

## Global Constraints

- The approved design is `docs/superpowers/specs/2026-08-08-dialogmint-single-draft-personal-learning-design.md`; if plan and design differ, the design wins.
- Write the failing test first for each behavior, run it and observe the expected failure, then implement the minimum code and rerun it.
- Generate and display exactly one final draft. Never persist or return plans, rubric scores, reasoning, rejected candidates, or provider error bodies.
- Claude Opus 4.6 is primary. `@cf/meta/llama-3.1-8b-instruct-fast` must always remain the fallback planner and `@cf/openai/gpt-oss-120b` the fallback writer/reviewer. Do not invoke fallback on a successful Claude request.
- Do not fall back for invalid requests, authentication/origin failures, deterministic policy failures, or a final rubric failure. Eligible fallback causes are missing Anthropic configuration, network/capacity failure, bounded timeout, HTTP 429, or HTTP 5xx. Treat Anthropic 401/403 as a generic configuration failure without retrying or leaking details.
- The code may reference the binding name `ANTHROPIC_API_KEY` and `env.ANTHROPIC_API_KEY`; no test, command, source file, output, health response, or log may contain or inspect its value.
- Keep Access, encrypted Neon recovery, extension permissions, central-conversation-only sync, no automated LinkedIn actions, and manual copy/send unchanged.
- Personal learning is disabled by default, stored only in the encrypted workspace, and retrieval-based. Claude/provider-assisted text is never a competing generative-model training target.
- Phase 3 creates no Cloudflare fine-tune, uploads no dataset or adapter, and makes no training network request.
- Before modifying the Next.js UI, read the relevant App Router/client-component guidance under `node_modules/next/dist/docs/` as required by the repository instructions.
- Deploy only with the existing `testing` preview alias in Project Mission account `8c9e063cdf6a3f83f474a7535845cbb2`. Do not deploy production, merge, create another Worker, change production data, or use the netcore account.

---

## Phase 1 — Stage-aware one-draft generation

### Task 1: Version the encrypted workspace for stages and personal guidance

**Files:**
- Modify: `src/lib/workspaceTypes.ts`
- Modify: `src/lib/secureVault.ts`
- Modify: `tests/secureVault.test.ts`
- Create: `tests/relationshipStages.test.ts`

**Interfaces:**
- Produces `RELATIONSHIP_STAGES`, `RelationshipStage`, `RELATIONSHIP_STAGE_LABELS`, and `nextRelationshipStage(stage)`.
- Produces `normalizePersonalGuidelines(value)` capped at 2,000 NFC-normalized Unicode code points.
- Adds `Contact.relationshipStage`, `Contact.conversationGoal`, `WorkspaceData.personalGuidelines`, and metadata on `DraftHistoryEntry`.
- Migrates workspace version 10 to version 11 without losing contacts, feedback, recovery settings, or playbooks.

- [ ] **Step 1: Add failing schema, Unicode-boundary, default, and migration tests**

Use literal expectations such as:

```ts
expect(RELATIONSHIP_STAGES).toEqual([
  "new_connection", "genuine_rapport", "learn_interests", "identify_need",
  "ask_permission", "introduce_value", "answer_without_pressure", "voluntary_next_step",
]);
expect(normalizePersonalGuidelines("e\u0301".repeat(2_100))).toHaveLength(2_000);
expect(normalizeWorkspace({ version: 10, contacts: [{ id: "c1", name: "Alex" }] }).contacts[0])
  .toMatchObject({ relationshipStage: "new_connection", conversationGoal: "" });
expect(normalizeWorkspace({ version: 10 }).personalGuidelines).toBe("");
expect(normalizeWorkspace({ version: 10 }).version).toBe(11);
```

Add an encrypted save/open round trip proving the new fields are restored from ciphertext and not visible in the stored envelope.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
pnpm vitest run tests/relationshipStages.test.ts tests/secureVault.test.ts
```

Expected: FAIL because the stage helpers and version-11 fields do not exist.

- [ ] **Step 3: Implement the minimal schema and normalization**

Add:

```ts
export const RELATIONSHIP_STAGES = [/* ordered eight stages */] as const;
export type RelationshipStage = (typeof RELATIONSHIP_STAGES)[number];
export const PERSONAL_GUIDELINES_MAX_CHARS = 2_000;
export const CONVERSATION_GOAL_MAX_CHARS = 5_000;

export function normalizePersonalGuidelines(value: unknown): string {
  const normalized = typeof value === "string" ? value.normalize("NFC").trim() : "";
  return Array.from(normalized).slice(0, PERSONAL_GUIDELINES_MAX_CHARS).join("");
}
```

Add optional `provider` and `modelId` fields to `DraftHistoryEntry` so legacy arrays remain valid. Add `normalizeRelationshipStage`; use safe defaults in `createEmptyWorkspace` and `normalizeWorkspace`. Preserve the existing `drafts: string[]` shape for migration, but later writes contain one item.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/workspaceTypes.ts src/lib/secureVault.ts tests/relationshipStages.test.ts tests/secureVault.test.ts
git commit -m "feat: persist conversation stages and guidance"
```

### Task 2: Build the bounded one-draft client contract

**Files:**
- Modify: `src/lib/privateAi.ts`
- Modify: `src/lib/draftProgress.ts`
- Modify: `tests/cloudAi.test.ts`
- Modify: `tests/privacyLogic.test.ts`

**Interfaces:**
- Replaces the three-string cloud result with `CloudDraftResult { draft, provider, model, mode }`.
- Produces a request with `conversationContext`, `latestMeaningfulIncoming`, `playbook`, `personalGuidelines`, `conversationGoal`, `relationshipStage`, `knownFacts`, `unansweredQuestions`, `learningExamples`, and `replyObjective`.
- Renames progress stage `planning` to `analyzing`.
- Keeps the existing local CPU/WebGPU code compilable, but normalizes any local result to one draft if used.

- [ ] **Step 1: Change client tests to the approved contract and verify they fail**

Assert the dedicated latest-message copy and exact one-draft parsing:

```ts
const body = buildCloudDraftRequest(input());
expect(Object.keys(body)).toEqual([
  "conversationContext", "latestMeaningfulIncoming", "playbook", "personalGuidelines",
  "conversationGoal", "relationshipStage", "knownFacts", "unansweredQuestions",
  "learningExamples", "replyObjective",
]);
expect(body.latestMeaningfulIncoming).toMatchObject({ sender: "CONTACT", text: "Could you share the role details?" });
expect(body.personalGuidelines).toBe("Prefer plain language and one useful question.");
expect(body.relationshipStage).toBe("learn_interests");
```

Return `{ draft: "Reviewed reply", provider: "anthropic", model: "claude-opus-4-6", mode: "stage-aware-single-draft-v1" }` from JSON and SSE fixtures. Assert arrays with zero or two drafts, duplicate results, hidden `analysis`, `scores`, or `reasoning` fields, and malformed stages fail closed.

Add privacy assertions that another contact, cookies, Access values, recovery keys, screenshots, extension state, and personal guideline text beyond 2,000 Unicode characters do not enter the request.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
pnpm vitest run tests/cloudAi.test.ts tests/privacyLogic.test.ts
```

Expected: FAIL because the current contract returns three drafts and lacks stage/guideline fields.

- [ ] **Step 3: Implement the request/result types and safe serialization**

Extend `PrivateAiInput` with the workspace fields and at most three already-selected learning examples. Reuse `selectPromptContext` and serialize the latest meaningful incoming message twice: once inside the untrusted conversation object and once as a dedicated bounded object. Use explicit `USER`/`CONTACT` labels and escape `<`/`>` in all JSON blocks.

Derive only literal local facts (for example, non-empty headline/company fields with labels); leave unsupported facts/questions empty for the Worker planner. Never infer a need locally.

Replace `parseDrafts` at the cloud boundary with strict `parseCloudDraftResult`. Keep a compatibility-only `parseLocalDraft` that takes the first sanitized local string. Rename `generatePrivateDrafts` to `generatePrivateDraft` and return the provider/model metadata needed by history and feedback.

- [ ] **Step 4: Update streaming validation**

Change:

```ts
export type DraftPipelineStage = "analyzing" | "drafting" | "reviewing" | "finalizing";
```

Continue enforcing one result, 512 KB maximum, CRLF normalization, no unknown stage/status, and generic safe errors.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: all focused tests pass.

- [ ] **Step 6: Commit**

```powershell
git add src/lib/privateAi.ts src/lib/draftProgress.ts tests/cloudAi.test.ts tests/privacyLogic.test.ts
git commit -m "feat: send bounded single-draft context"
```

### Task 3: Add pure stage gates and the 100-point rubric contract

**Files:**
- Create: `cloudflare/worker/src/draftPolicy.js`
- Create: `tests/draftPolicy.test.ts`

**Interfaces:**
- Produces strict JSON schemas/parsers for analysis, one candidate, and final review.
- Produces `effectiveStage(stored, observed, evidence)`, `canIntroduceValue(stage, context)`, and `validateFinalReview(review, context)`.
- Enforces total `>= 90`, exact weights totaling 100, and zero critical failures.

- [ ] **Step 1: Write failing policy tests**

Cover all eight stages and these invariants:

```ts
expect(effectiveStage("new_connection", "introduce_value", [])).toBe("genuine_rapport");
expect(canIntroduceValue("learn_interests", { explicitRequest: false, needEstablished: false, permissionGranted: false })).toBe(false);
expect(validateFinalReview(validReview({ total: 89 }))).toEqual({ ok: false, reason: "rubric" });
expect(validateFinalReview(validReview({ total: 96, criticalFailures: ["premature_pitch"] }))).toEqual({ ok: false, reason: "critical" });
```

Assert score keys and maxima are exactly 25/20/15/15/10/5/5/5, `total` equals their sum, output has one non-empty `finalDraft`, and unsupported personal-history/copy/pitch patterns fail deterministic validation.

- [ ] **Step 2: Run the new test and verify RED**

```powershell
pnpm vitest run tests/draftPolicy.test.ts
```

Expected: FAIL because `draftPolicy.js` does not exist.

- [ ] **Step 3: Implement schemas, parsers, and deterministic gates**

The analysis schema includes only:

```js
{
  storedStage, observedStage, effectiveStage, nextAllowedStage,
  latestIncomingIntent, knownFacts, unansweredQuestions, goalForThisReply,
  toneDirectives, prohibitedMoves, replyPlan, evidence,
  needEstablished, permissionGranted, explicitRequest
}
```

The writer schema is `{ draft: { text, stage, goal } }`. The reviewer schema is:

```js
{
  scores: {
    conversationGrounding, latestMessageRelevance, personalGuidelineCompliance,
    goalStageAlignment, humanTone, curiosityNeedDiscovery,
    technicalFactualAccuracy, ethicalSellingBoundaries
  },
  total,
  criticalFailures: [],
  rewritten: boolean,
  finalDraft: string
}
```

Do not export chain-of-thought fields. Clamp lists/text and reject rather than coerce invalid stages, score ranges, totals, or missing evidence.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add cloudflare/worker/src/draftPolicy.js tests/draftPolicy.test.ts
git commit -m "feat: enforce stage and precision rubric"
```

### Task 4: Implement the three-call Claude Opus 4.6 pipeline

**Files:**
- Create: `cloudflare/worker/src/anthropicDraftPipeline.js`
- Modify: `tests/cloudWorker.test.ts`

**Interfaces:**
- Produces `runAnthropicDraftPipeline(context, options)` with exactly three normal Messages API calls.
- Uses `claude-opus-4-6`, thinking display omitted, `output_config.format` JSON schema, and per-call timeouts.
- Returns only `{ draft, provider: "anthropic", model: "claude-opus-4-6", mode }`.

- [ ] **Step 1: Add failing mocked Anthropic tests**

Inject a synthetic `anthropicFetch` and assert:

- exactly three calls in analysis/writer/reviewer order;
- each request uses `POST https://api.anthropic.com/v1/messages`, `model: "claude-opus-4-6"`, `thinking.display: "omitted"`, and a strict JSON schema;
- the planner cannot return final prose;
- writer and reviewer receive the same current conversation, full rulebook, guidelines, and effective-stage gate;
- the reviewer sees the candidate but only `finalDraft` reaches the route result;
- no request body contains the synthetic Access assertion;
- no response exposes thinking blocks, scores, rejected candidate, or provider response text;
- a low score or critical failure returns a policy-quality error and never calls Workers AI.

- [ ] **Step 2: Run focused Worker tests and verify RED**

```powershell
pnpm vitest run tests/cloudWorker.test.ts -t "Claude|rubric|critical|three isolated"
```

Expected: FAIL because no Anthropic pipeline exists.

- [ ] **Step 3: Implement the fetch adapter without an SDK**

Post with runtime-only headers:

```js
headers: {
  "content-type": "application/json",
  "anthropic-version": "2023-06-01",
  "x-api-key": apiKey,
}
```

Use `thinking: { type: "enabled", budget_tokens, display: "omitted" }` with `max_tokens` greater than the thinking budget and `output_config: { effort: "high", format: { type: "json_schema", schema } }`. Omit temperature/top-p. Parse only `content` blocks with `type === "text"`; never retain or log thinking blocks. Use a fresh bounded abort controller for every call and propagate a client abort.

Classify failures into `provider_unavailable`, `provider_configuration`, `provider_rate_limited`, `provider_timeout`, `provider_server`, `quality`, or `policy`. Preserve no raw response/body/message in the thrown public error.

- [ ] **Step 4: Implement isolated prompts**

Keep static identity, stage order, rubric, and ethics in system text. Put every user-controlled field in escaped untrusted JSON blocks. Analysis may not produce reply prose. Writer produces one candidate. Reviewer must independently score the final text, rewrite at most once inside its single call, and output one final schema object.

Run `validateFinalReview` after the reviewer. A second failure is terminal; do not add an agent loop or a fourth paid correction call.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add cloudflare/worker/src/anthropicDraftPipeline.js tests/cloudWorker.test.ts
git commit -m "feat: add Claude precision pipeline"
```

### Task 5: Adapt and permanently test the two-model Cloudflare fallback

**Files:**
- Create: `cloudflare/worker/src/workersAiDraftPipeline.js`
- Modify: `tests/cloudWorker.test.ts`

**Interfaces:**
- Produces the same analysis/candidate/review contract as Task 4.
- Call order remains Llama planner, GPT-OSS writer, GPT-OSS independent reviewer.
- Returns exactly one final draft with provider `cloudflare`.

- [ ] **Step 1: Replace old three-draft fixtures with failing one-draft fallback tests**

Assert normal fallback calls:

```ts
expect(env.AI.run.mock.calls.map(([model]) => model)).toEqual([
  LLAMA_CANDIDATE_MODEL, GPT_REVIEW_MODEL, GPT_REVIEW_MODEL,
]);
expect(result).toMatchObject({ draft: "Reviewed reply", provider: "cloudflare" });
```

Assert the fallback uses the same stage fields, personal guidelines, latest-message repeat, full reviewer rubric, score threshold, and deterministic policy validator. Preserve one bounded no-`response_format` retry per Workers AI stage for runtime schema incompatibility.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
pnpm vitest run tests/cloudWorker.test.ts -t "Cloudflare fallback|Llama|GPT-OSS"
```

Expected: FAIL because the current Worker returns three drafts and has no shared stage/rubric contract.

- [ ] **Step 3: Extract and implement the fallback pipeline**

Move current Workers AI calling/parsing out of `index.js`. The Llama planner receives the digest plus stage/guideline summary, while writer and reviewer receive the full selected rulebook. Both writer/reviewer output one object. Reuse `draftPolicy.js`; do not maintain a weaker fallback validator.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add cloudflare/worker/src/workersAiDraftPipeline.js tests/cloudWorker.test.ts
git commit -m "feat: preserve precise Workers AI fallback"
```

### Task 6: Route providers safely and stream one final result

**Files:**
- Modify: `cloudflare/worker/src/index.js`
- Modify: `tests/cloudWorker.test.ts`
- Modify: `wrangler.jsonc`

**Interfaces:**
- Keeps authentication, same-origin, body size, content type, and rate limiting before inference.
- Routes Claude primary to Cloudflare fallback only for approved provider categories.
- Reports safe health booleans and permanent model IDs without exposing configuration values.

- [ ] **Step 1: Add failing route, fallback-matrix, health, and SSE tests**

Cover:

- Claude success means zero `env.AI.run` calls;
- missing configuration, network failure, timeout, 429, and 5xx call fallback once;
- 400/401/403, invalid request, rubric failure, critical policy failure, and parse/schema quality failure do not fall back;
- SSE order is `analyzing`, `drafting`, `reviewing`, `finalizing`, then one `result`;
- SSE/JSON contain no prompt excerpts, scores, reasoning, candidate, raw status text, secret value, or internal error;
- `/health` includes `anthropicConfigured: true|false`, primary model, fallback model IDs, mode, and existing safe storage/Access booleans only.

- [ ] **Step 2: Run the Worker suite and verify RED**

```powershell
pnpm vitest run tests/cloudWorker.test.ts
```

Expected: FAIL on routing, health, stages, and response shape.

- [ ] **Step 3: Replace the inline pipeline with a route orchestrator**

Validate and bound every new request field before calling either provider. Call Claude with `env.ANTHROPIC_API_KEY` only inside the Worker. Do not include the value in closures used for diagnostics, thrown messages, health output, or tests. Add the binding name to `secrets.required` in `wrangler.jsonc` only if Wrangler accepts dashboard-managed required-secret validation without materializing a value; otherwise document the dashboard binding and leave the value-managed config unchanged.

Use dependency-injected `options.anthropicFetch`, clocks/timeouts, and `options.providerOverride` only for synthetic tests. Do not accept a public client payload field that can force a provider.

- [ ] **Step 4: Run Worker and client tests and verify GREEN**

```powershell
pnpm vitest run tests/cloudWorker.test.ts tests/cloudAi.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add cloudflare/worker/src/index.js cloudflare/worker/src/draftPolicy.js cloudflare/worker/src/anthropicDraftPipeline.js cloudflare/worker/src/workersAiDraftPipeline.js tests/cloudWorker.test.ts wrangler.jsonc
git commit -m "feat: route Claude with safe Cloudflare fallback"
```

### Task 7: Convert the UI to one precise draft and stage controls

**Files:**
- Modify: `src/components/ChatHelpApp.tsx`
- Modify: `src/app/globals.css`
- Modify: `tests/interaction.test.tsx`

**Interfaces:**
- Adds manual relationship-stage selector, conversation-goal field, and 2,000-character personal-guidelines setting.
- Changes the action to `Generate Precise Draft` and renders one editable card.
- Saves final provider/model metadata in draft history and usage, never hidden analysis.

- [ ] **Step 1: Read relevant local Next.js docs**

Read the client-component/forms/state sections under `node_modules/next/dist/docs/` before editing `ChatHelpApp.tsx`. Record no code change in this step.

- [ ] **Step 2: Update interaction tests and verify RED**

Change the generation fixture to the one-draft contract. Assert:

- stage and conversation goal default/persist per contact;
- planner suggestions never silently change the stored selector;
- personal guidelines persist, normalize, show `0 / 2,000`, and are included in the request;
- the button and accessible label say `Generate Precise Draft`;
- exactly one editable card appears after success;
- copy, manual-send, edit, dismiss, stop, retry, and role playbooks still work;
- history has one item plus provider/model metadata;
- consent explicitly says Anthropic primary and two Cloudflare-hosted fallback models, plaintext inference, encrypted-at-rest vault, and no automatic sending.

- [ ] **Step 3: Run focused interaction tests and verify RED**

```powershell
pnpm vitest run tests/interaction.test.tsx -t "precise|relationship stage|personal guidelines|progress|stop"
```

Expected: FAIL on the old three-draft UI and missing fields.

- [ ] **Step 4: Implement minimal controls and generation state**

Pass the active contact stage/goal and workspace guidance into `createDraftInput`. Store the returned text as `[result.draft]` for legacy history compatibility and render a single card labeled `DRAFT`. Update status text from returned safe provider/model labels. Keep all LinkedIn send behavior manual.

Place stage/goal controls near the reply objective and personal guidelines in Settings. Use existing state-update/save patterns and bounds. Do not persist an inferred stage; only a user `onChange` updates it.

- [ ] **Step 5: Update consent and privacy copy accurately**

State that relevant plaintext is processed by Anthropic or fallback only on Generate; encrypted vault/recovery remain ciphertext at rest; API keys, Access credentials, cookies, screenshots, unrelated contacts, and recovery keys are excluded. Remove wording that claims only Cloudflare-hosted models process requests.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the Step 3 command, then:

```powershell
pnpm vitest run tests/interaction.test.tsx tests/cloudAi.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/components/ChatHelpApp.tsx src/app/globals.css tests/interaction.test.tsx
git commit -m "feat: present one stage-aware precise draft"
```

---

## Phase 2 — Opt-in encrypted retrieval learning

### Task 8: Store safe feedback and retrieve only approved examples

**Files:**
- Modify: `src/lib/workspaceTypes.ts`
- Modify: `src/lib/secureVault.ts`
- Create: `src/lib/personalLearning.ts`
- Create: `tests/personalLearning.test.ts`
- Modify: `tests/secureVault.test.ts`

**Interfaces:**
- Adds `PersonalLearningSettings { enabled }`, expanded feedback actions/provenance, and default-false retrieval eligibility.
- Produces `selectLearningExamples(records, query, limit = 3)` with stable deterministic ordering.
- Rejects provider-assisted text as generative-training data even when it remains ordinary history.

- [ ] **Step 1: Write failing defaults, migration, retrieval, and provenance tests**

Cover disabled/default-false behavior, corrupt-record rejection, same-role/stage scoring, stable timestamp/ID tie breaking, maximum three, deletion/disable exclusion, and no current-contact fact leakage across conversations.

```ts
expect(createEmptyWorkspace().personalLearning.enabled).toBe(false);
expect(normalizeFeedback(legacyUseful).eligibleForRetrieval).toBe(false);
expect(selectLearningExamples(records, query)).toHaveLength(3);
expect(isGenerativeTrainingEligible(providerAssisted)).toBe(false);
```

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
pnpm vitest run tests/personalLearning.test.ts tests/secureVault.test.ts
```

Expected: FAIL because the learning schema/module does not exist.

- [ ] **Step 3: Implement schema normalization and pure retrieval**

Store action (`accepted|edited|rejected`), stage/goal snapshots, provider/model, optional preferred response/outcome/reason, origin, enabled flag, retrieval eligibility, and timestamps. Legacy useful/not-useful records migrate to accepted/rejected workflow records but remain ineligible.

Tokenize only normalized role/stage/goal terms and bounded metadata. Examples may influence tone/structure but are serialized as untrusted data. A cross-contact example contains no contact name, company, URL, message quote, or private fact; same-contact examples may use the already-in-scope preferred response only.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/workspaceTypes.ts src/lib/secureVault.ts src/lib/personalLearning.ts tests/personalLearning.test.ts tests/secureVault.test.ts
git commit -m "feat: add encrypted retrieval learning"
```

### Task 9: Add learning controls and feed selected examples into generation

**Files:**
- Modify: `src/components/ChatHelpApp.tsx`
- Modify: `src/lib/privateAi.ts`
- Modify: `tests/interaction.test.tsx`
- Modify: `tests/cloudAi.test.ts`

**Interfaces:**
- Feedback collection remains off until explicitly enabled.
- Users can accept, edit, reject, record a reason/outcome, attest independent authorship, enable/disable retrieval, edit, and delete examples.
- Generation sends at most three locally selected examples.

- [ ] **Step 1: Write failing UI/request tests**

Assert an unchecked opt-in, no examples before opt-in, provider-assisted origin by default, an independently authored attestation required before retrieval eligibility, editable/deletable records, and at most three safe examples in the next request. Assert no example can override the latest message, stage, rulebook, or personal guidelines in the prompt contract.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
pnpm vitest run tests/interaction.test.tsx tests/cloudAi.test.ts -t "learning|example|feedback"
```

Expected: FAIL because existing useful/not-useful buttons do not implement the approved flow.

- [ ] **Step 3: Implement the feedback editor and local selection**

Reuse the encrypted `updateWorkspace` path. Keep records in the vault only. Replace or augment useful/not-useful controls with accepted/edited/rejected actions and a compact details editor. An eligibility checkbox remains unchecked and disabled until the user attests independently authored/licensed provenance.

Call `selectLearningExamples` before `generatePrivateDraft`; serialize selected examples in a separate untrusted block. On empty/corrupt data, send an empty list and continue Phase 1 normally.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/components/ChatHelpApp.tsx src/lib/privateAi.ts tests/interaction.test.tsx tests/cloudAi.test.ts
git commit -m "feat: learn from approved local examples"
```

---

## Phase 3 — Local classifier, safe exports, and LoRA readiness

### Task 10: Train and evaluate a narrow local relationship-stage classifier

**Files:**
- Create: `src/lib/relationshipStageClassifier.ts`
- Create: `tests/relationshipStageClassifier.test.ts`
- Modify: `src/lib/workspaceTypes.ts`
- Modify: `src/lib/secureVault.ts`
- Modify: `src/components/ChatHelpApp.tsx`
- Modify: `tests/interaction.test.tsx`

**Interfaces:**
- Stores human-confirmed, bounded/redacted stage feature records in the encrypted vault.
- Produces `trainStageClassifier`, `predictRelationshipStage`, and `evaluateStageClassifier` with no network or text generation.
- Below the confidence threshold, returns the stored manual stage and never mutates it.

- [ ] **Step 1: Write failing classifier and UI tests**

Use synthetic fixtures only. Prove deterministic training/prediction, all eight labels, human-confirmed-only filtering, confidence fallback, no raw conversation requirement, no generated text/API surface, and no automatic stage state transition.

```ts
const prediction = predictRelationshipStage(model, features, "learn_interests", 0.70);
expect(prediction.stage).toBe("learn_interests");
expect(prediction.usedFallback).toBe(true);
```

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
pnpm vitest run tests/relationshipStageClassifier.test.ts tests/interaction.test.tsx -t "stage classifier|stage suggestion"
```

Expected: FAIL because no classifier/training records exist.

- [ ] **Step 3: Implement a small deterministic offline classifier**

Use bounded token/metadata features and a simple centroid or multinomial Naive Bayes model with Laplace smoothing. Version the feature schema and label order in the artifact. Provide leave-one-out evaluation metrics only when enough records exist. The module must not import `fetch`, Worker clients, WebLLM, or generation code.

Create a human-confirmed record only when the user changes/confirms the manual stage while learning is enabled. Show a non-authoritative suggestion/confidence; applying it requires a separate user action that also becomes a confirmation.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/relationshipStageClassifier.ts src/lib/workspaceTypes.ts src/lib/secureVault.ts src/components/ChatHelpApp.tsx tests/relationshipStageClassifier.test.ts tests/interaction.test.tsx
git commit -m "feat: add local relationship stage classifier"
```

### Task 11: Export only approved data and validate LoRA compatibility offline

**Files:**
- Create: `src/lib/trainingExport.ts`
- Create: `tests/trainingExport.test.ts`
- Modify: `src/components/ChatHelpApp.tsx`
- Modify: `tests/interaction.test.tsx`
- Create: `docs/TRAINING_AND_LORA.md`

**Interfaces:**
- Produces versioned classifier JSONL, separately labeled generative JSONL, and a manifest/count report.
- Produces `validateCloudflareLoraManifest` as an offline check only.
- Never uploads, creates a fine-tune, or accepts Claude/provider-assisted targets in generative export.

- [ ] **Step 1: Write failing export and validator tests**

Assert deterministic line order and exclusion of contact IDs, names, URLs, secrets, recovery values, raw messages, provider reasoning, Claude drafts, provider-assisted edits, disabled/unapproved records, and unrelated notes. Assert the preview count is grouped by stage/origin.

Validate current documented Cloudflare constraints conservatively: non-quantized compatible base; `model_type` in `mistral|gemma|llama`; rank `1..32`; total adapter files below 300 MB; exact names `adapter_config.json` and `adapter_model.safetensors`; causal-LM task; explicit provenance/license; and every user approval gate. Reject current fallback model IDs as assumed LoRA bases unless they appear in a reviewed supported-base allowlist.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
pnpm vitest run tests/trainingExport.test.ts tests/interaction.test.tsx -t "training export|LoRA"
```

Expected: FAIL because the export/validator and Settings controls do not exist.

- [ ] **Step 3: Implement pure builders and fail-closed validation**

Return strings; do not write files automatically:

```ts
export interface TrainingExportBundle {
  manifest: TrainingExportManifest;
  classifierJsonl: string;
  userAuthoredGenerativeJsonl: string;
}
```

Classifier lines contain only versioned bounded features plus human-confirmed stage. Generative lines contain independently authored/licensed prompt/response examples only. The LoRA report is informational and `uploadAllowed` remains `false` in this release regardless of compatibility, because no upload path is implemented.

- [ ] **Step 4: Add explicit preview and download controls**

Settings first shows counts by stage/origin and exclusions. Provide separate user-clicked downloads for manifest JSON, classifier JSONL, and independently authored generative JSONL. Never upload after download. Revoke object URLs after use.

- [ ] **Step 5: Document the legal/product boundary**

Document that Claude outputs/reviewer rewrites/provider-assisted text are excluded from competing open-ended generator training; only the human-confirmed classifier trains in-app; local/open-weight LoRA training is external and user-controlled; and any Cloudflare adapter upload needs a separate approved dataset/base/license/cost/account action.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/lib/trainingExport.ts src/components/ChatHelpApp.tsx tests/trainingExport.test.ts tests/interaction.test.tsx docs/TRAINING_AND_LORA.md
git commit -m "feat: export approved learning data safely"
```

---

## Release verification and testing-only deployment

### Task 12: Verify security, build artifacts, and the complete three-phase release

**Files:**
- Modify if required by changed behavior: `README.md`
- Modify if required by changed behavior: `docs/CLOUD_LLM_ROADMAP.md`
- Modify only for directly related defects: files already listed above

**Interfaces:**
- Produces a complete command/result report with exact test counts, warnings, build artifacts, and secret-scan method.
- Produces no secret values and no production changes.

- [ ] **Step 1: Update public documentation and static assertions**

Replace three-draft/Cloudflare-only text with one precise draft, Claude primary, permanent two-model Cloudflare fallback, opt-in retrieval learning, classifier/export boundaries, and manual send. Update tests that intentionally assert product copy.

- [ ] **Step 2: Run targeted phase gates**

```powershell
pnpm vitest run tests/relationshipStages.test.ts tests/secureVault.test.ts tests/cloudAi.test.ts tests/draftPolicy.test.ts tests/cloudWorker.test.ts
pnpm vitest run tests/personalLearning.test.ts tests/interaction.test.tsx
pnpm vitest run tests/relationshipStageClassifier.test.ts tests/trainingExport.test.ts
```

Expected: every phase gate exits zero.

- [ ] **Step 3: Run the full automated suite**

```powershell
pnpm test
pnpm lint
pnpm build
pnpm verify:extension
```

Run the repository's native/static sequence using `CHATHELP_NATIVE_BUILD=1`, then `inject:csp`, `verify:static-csp`, `verify:cloudflare`, and the existing Wrangler dry run. Expected: all commands exit zero; record any non-blocking warnings exactly.

- [ ] **Step 4: Run source/config secret and boundary scans**

Search tracked source and build output for credential-shaped assignments and prohibited logging without printing matching values. Permit only the literal binding name `ANTHROPIC_API_KEY` and runtime access expression. Verify no `console.*` statement logs request bodies, response bodies, prompts, drafts, headers, or errors from either provider.

Re-run extension/security tests proving no cookie access, inbox crawling, typing/clicking/sending, broadened host permissions, or new external endpoint from the browser.

- [ ] **Step 5: Review the final diff and commit release docs**

```powershell
git status --short
git diff --check
git diff --stat origin/main...HEAD
git add README.md docs/CLOUD_LLM_ROADMAP.md
git commit -m "docs: explain precise drafting and learning"
```

Skip the commit if neither documentation file changed. Do not stage `.wrangler-production-dry-run/` or unrelated user files.

### Task 13: Push and upload only the verified testing preview

**Files:**
- No production source changes.

**Interfaces:**
- Produces a pushed feature branch and new version on the existing `testing` preview alias.
- Leaves the production URL/version untouched.

- [ ] **Step 1: Verify Git and Cloudflare targets without inspecting credentials**

Run `git status`, `git log --oneline`, and `wrangler whoami`. Require account email `project.mission.ai@gmail.com`, account ID `8c9e063cdf6a3f83f474a7535845cbb2`, Worker name `chathelp-private-cloud`, and target alias `testing`. Stop if account/target differs.

Confirm only the name `ANTHROPIC_API_KEY` is configured through safe Wrangler/dashboard metadata if the CLI can do so without returning values. Never request, list, reveal, validate, or echo its value.

- [ ] **Step 2: Push the current feature branch and wait for CI**

```powershell
git push -u origin codex/draft-progress-stream
```

Wait for the repository CI workflow and record the run URL/status. Do not merge.

- [ ] **Step 3: Upload the verified build only to the stable testing alias**

```powershell
wrangler versions upload --preview-alias testing --keep-vars
```

Do not run `wrangler deploy` or `wrangler versions deploy`. Record the version ID and require the returned URL to be exactly:

`https://testing-chathelp-private-cloud.project-mission-ai.workers.dev/`

- [ ] **Step 4: Verify safe live boundaries**

Check `/health` and the static app. Health must show the one-draft mode, Claude configured boolean, Claude model ID, both fallback model IDs, Access/storage booleans, no-store, and no value-bearing fields. Verify an unauthenticated synthetic `/api/drafts` request is rejected before rate limiting/inference and reveals no provider detail.

If an authenticated synthetic generation requires the user's Cloudflare Access session, stop before credentials are exposed and ask the user to perform that one trusted-interface smoke step. Do not use real conversation text; provide a harmless synthetic exchange and expected one-draft result/stage sequence.

- [ ] **Step 5: Confirm production was untouched and report**

Compare the pre/post production deployment identifier through safe metadata, confirm it is unchanged, and report:

- branch and focused commits;
- targeted/full test counts and all verification commands;
- CI URL/status;
- testing preview version ID and URL;
- health and unauthenticated-boundary results;
- whether the user-assisted authenticated smoke remains;
- explicit statement that production, production data, netcore resources, and Cloudflare fine-tunes were not changed.

## References locked for implementation

- Anthropic Messages API: `POST /v1/messages`, model `claude-opus-4-6`, extended thinking with `display: "omitted"`, and `output_config.format` JSON schema. Recheck the official Anthropic API reference immediately before implementation if the installed date differs from this plan.
- Cloudflare Workers AI LoRA limits as of 2026-08-08: non-quantized compatible models; rank up to 32; adapter under 300 MB; exact adapter filenames; `model_type` of Mistral, Gemma, or Llama. The validator is informational and no upload is authorized.

## Completion criteria

The plan is complete only when all three phase gates pass, the full suite/build/security checks pass, the permanent Cloudflare fallback remains directly tested, a testing preview version is uploaded to the exact approved alias, and production remains unchanged. A missing user-assisted authenticated smoke does not permit claiming end-to-end live provider success; report it explicitly as the only remaining manual check.
