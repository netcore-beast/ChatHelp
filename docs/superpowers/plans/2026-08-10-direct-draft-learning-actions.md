# Direct Draft Learning Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the completed draft's indirect feedback controls with `Copy`, `Useful`, and `Not useful`, persist exactly one mutable Neon learning decision per generated draft, and atomically replace a negative decision with a separately authored approved response.

**Architecture:** The encrypted browser workspace advances to v15 and stores only a bounded stable decision ID, current state, sync state, and the latest sanitized pending mutation beside the existing draft-history entry. A strict same-origin client calls a new authenticated Worker decision endpoint; the Worker derives account and environment from Cloudflare Access, validates and sanitizes the request, and inserts or mutates one account-scoped Neon row in a single PostgreSQL transaction. Focused React components render the three direct actions, an authored-only dialog, and an accessible transient learning status inside the existing `READY TO REVIEW` header.

**Tech Stack:** Next.js 16, React 19, TypeScript, Vitest, Testing Library, Cloudflare Workers, Cloudflare Access JWT, Neon PostgreSQL through Hyperdrive, Wrangler 4.114.0.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-10-direct-draft-learning-actions-design.md` exactly.
- Preserve visible-conversation-only LinkedIn synchronization and manual review/copy/send; never add automated navigation, clicking, typing, scrolling, pasting, or sending.
- `Copy` may stage Useful only after `navigator.clipboard.writeText` resolves; clipboard failure creates no learning mutation.
- Useful and Not useful are text-free. They never upload draft text, edited text, prompt text, conversation text, provider output, provider reasoning, contact identifiers, or known identifiers.
- Only the blank independent-author path may upload a sanitized target, and only after rights and exact-preview privacy attestations.
- Authenticate Cloudflare Access, resolve the exact environment, apply the rate limit, and reject browser account headers before parsing the decision body or touching Neon.
- Derive the opaque account ID only on the server. Never accept or return an email, account ID, audience, environment selector, timestamp, digest, or attestation timestamp from the browser.
- Use one stable record ID per generated draft. Repeated actions, retries, reloads, and concurrent requests must not create a second row.
- Keep the generic classifier/approved-record upload API unchanged. Decision-endpoint digests use a separate `draft-decision-v1` namespace including the stable record ID.
- Keep current testing and production Neon bindings, Access audiences, data, and deployment histories isolated.
- No new Neon migration is permitted for this revision.
- Keep Claude Opus 4.6 Thinking primary and retain both Workers AI fallbacks without changing provider routing.
- Do not handle secret values. The user performs any trusted-service secret or production-database step personally.
- Use the bundled Node runtime for local Vitest: `$node = 'C:\Users\anshj\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'` and `& $node node_modules/vitest/vitest.mjs run <files>`.
- Use strict red-green TDD and an independent code/privacy plus UX/accessibility review before the final implementation commit is accepted.

---

## File Structure

### New files

- `cloudflare/worker/src/draftLearningDecision.js` — strict decision validation, namespaced digest, transition matrix, and single-client transaction.
- `src/lib/draftLearningDecision.ts` — stable decision identity plus pure stage/acknowledge/fail/clear/retry reconciliation.
- `src/components/DraftLearningStatus.tsx` — saving, transient saved, and persistent retry status inside the completed-card header.
- `src/components/AddOwnVersionDialog.tsx` — blank authored-only sanitizer, preview, attestation, focus, and submission dialog.
- `tests/draftLearningDecision.test.ts` — pure v15 mutation, late-response, retry, and recovery-safe state tests.
- `tests/draftLearningDecisionWorker.test.ts` — focused Worker transition, transaction, validation, and privacy tests.

### Deleted file

- `src/components/SaveImprovementDialog.tsx` — superseded chooser/rating workflow.

### Modified files

- `src/lib/workspaceTypes.ts` — v15 decision types and discriminated pending-learning union.
- `src/lib/secureVault.ts` — v14-to-v15 normalization and bounded exact decision persistence.
- `src/lib/cloudWorkspaceMerge.ts` — latest-decision merge and tombstone precedence.
- `src/lib/retention.ts` — retain decision mutations only for the existing 365-day learning window.
- `src/lib/cloudLearning.ts` — strict decision HTTP client, response parser, and split legacy/decision retry dispatch.
- `cloudflare/worker/src/neonLearning.js` — route the authenticated decision request after existing boundary checks.
- `src/components/CompletedDraftCard.tsx` — direct actions, pressed states, authored lock, and integrated status.
- `src/components/ChatHelpApp.tsx` — action orchestration, clipboard ordering, stable active-history identity, durable retry, and Settings cleanup.
- `src/app/globals.css` — direct-action layout, selected states, badge animation, themes, narrow layouts, focus, and reduced motion.
- `PRIVACY.md`, `SECURITY.md`, `docs/cloud-learning-usage-release.md` — direct-action and atomic-replacement disclosure.
- `tests/secureVault.test.ts`, `tests/cloudWorkspaceMerge.test.ts`, `tests/cloudRecovery.test.ts`, `tests/cloudRecoverySync.test.ts`.
- `tests/cloudLearning.test.ts`, `tests/neonLearningWorker.test.ts`, `tests/cloudWorker.test.ts`.
- `tests/compactDraftingUi.test.tsx`, `tests/cloudLearningUi.test.tsx`, `tests/interaction.test.tsx`, `tests/workspaceLayout.test.ts`.
- `tests/securityBoundary.test.ts`, `tests/nativeBoundary.test.ts`.

---

### Task 1: Advance the encrypted workspace to v15 with durable draft decisions

**Files:**
- Create: `src/lib/draftLearningDecision.ts`
- Create: `tests/draftLearningDecision.test.ts`
- Modify: `src/lib/workspaceTypes.ts`
- Modify: `src/lib/secureVault.ts`
- Modify: `src/lib/cloudWorkspaceMerge.ts`
- Modify: `src/lib/retention.ts`
- Test: `tests/secureVault.test.ts`
- Test: `tests/cloudWorkspaceMerge.test.ts`
- Test: `tests/cloudRecovery.test.ts`
- Test: `tests/cloudRecoverySync.test.ts`

**Interfaces:**
- Consumes: existing `DraftHistoryEntry.id`, the record-ID contract `/^[a-z0-9-]{1,64}$/`, existing 365-day learning retention, and cloud-learning deletion markers.
- Produces: `DraftLearningDecision`, `PendingDraftLearningDecisionMutation`, `draftLearningDecisionRecordId`, and pure stage/acknowledge/fail/clear helpers used by Tasks 3 and 5.

- [ ] **Step 1: Write failing v15 normalization, round-trip, merge, and tombstone tests**

Add exact tests proving that v14 becomes v15 without manufacturing decisions, valid metadata survives vault and recovery round trips, malformed metadata is discarded, a newer mutation replaces an older mutation for the same record ID, authored wins a timestamp tie, and disable/delete tombstones suppress stale recovery data:

```ts
it("migrates v14 to v15 without inventing draft decisions", () => {
  const migrated = normalizeWorkspace({
    ...createEmptyWorkspace(),
    version: 14,
    contacts: [{ ...contactFixture(), draftHistory: [{ id: "draft-set-00000000-0000-4000-8000-000000000001", agenda: "", drafts: ["Draft"], createdAt: NOW }] }],
  });
  expect(migrated.version).toBe(15);
  expect(migrated.contacts[0].draftHistory?.[0].learningDecision).toBeUndefined();
});

it("keeps only the newest pending mutation for one draft decision", () => {
  const stagedUseful = stageDraftLearningDecision(workspaceWithDraft(), "contact-1", DRAFT_ID, evaluationMutation("useful"), new Date("2026-08-10T10:00:00.000Z"));
  const stagedNegative = stageDraftLearningDecision(stagedUseful, "contact-1", DRAFT_ID, evaluationMutation("not_useful"), new Date("2026-08-10T10:01:00.000Z"));
  expect(stagedNegative.pendingLearningRecords.filter((item) => item.recordId === RECORD_ID)).toHaveLength(1);
  expect(stagedNegative.contacts[0].draftHistory?.[0].learningDecision?.state).toBe("not_useful");
});
```

- [ ] **Step 2: Run the focused tests and verify red**

Run:

```powershell
& $node node_modules/vitest/vitest.mjs run tests/draftLearningDecision.test.ts tests/secureVault.test.ts tests/cloudWorkspaceMerge.test.ts tests/cloudRecovery.test.ts tests/cloudRecoverySync.test.ts
```

Expected: FAIL because v15 types, normalization, and draft-decision merge helpers do not exist.

- [ ] **Step 3: Add the exact v15 types and discriminated pending union**

Add these declarations in `workspaceTypes.ts`, extend `DraftHistoryEntry`, extend deletion-marker source collections, change `WorkspaceData.version` to `15`, and return `version: 15` from `createEmptyWorkspace()`:

```ts
export type DraftLearningDecisionState = "useful" | "not_useful" | "authored";
export type DraftLearningDecisionSyncStatus = "pending" | "synced" | "failed";

export interface DraftLearningDecision {
  recordId: string;
  state: DraftLearningDecisionState;
  syncStatus: DraftLearningDecisionSyncStatus;
  updatedAt: string;
}

export type CloudLearningRoleId = "human_resource" | "network_marketing" | "job_seeker" | "socializing_networking";
export type CloudLearningGoalCategory = "connect" | "build_rapport" | "discover_interests" | "identify_need" | "request_permission" | "present_value" | "answer_questions" | "agree_next_step";

export interface PendingLearningUploadRecord {
  mutationKind: "record_upload";
  recordId: string;
  recordKind: "classifier" | "evaluation" | "generative";
  sanitizedPayload: Record<string, unknown>;
  sourceCollection: "feedback" | "stageTrainingRecords";
  sourceLocalId: string;
  createdAt: string;
  expiresAt: string;
}

export type DraftLearningDecisionPayload =
  | { kind: "evaluation"; roleId: CloudLearningRoleId; relationshipStage: RelationshipStage; goalCategory: CloudLearningGoalCategory; action: "useful" | "not_useful" }
  | { kind: "generative"; roleId: CloudLearningRoleId; relationshipStage: RelationshipStage; goalCategory: CloudLearningGoalCategory; provenance: "independently_user_authored"; target: string; rightsAttested: true; privacyAttested: true };

export interface PendingDraftLearningDecisionMutation {
  mutationKind: "draft_decision";
  recordId: string;
  decision: DraftLearningDecisionPayload;
  sourceCollection: "draftHistory";
  sourceLocalId: string;
  createdAt: string;
  expiresAt: string;
}

export type PendingLearningRecord = PendingLearningUploadRecord | PendingDraftLearningDecisionMutation;
```

Every existing producer of a generic classifier/evaluation/generative upload must set `mutationKind: "record_upload"`. The v14 normalizer assigns this discriminator to valid legacy pending records.

- [ ] **Step 4: Implement stable identity and pure immutable state helpers**

Create `draftLearningDecision.ts` with exact exports. Do not import browser APIs:

```ts
export const DRAFT_DECISION_RECORD_ID = /^[a-z0-9-]{1,64}$/u;

export function draftLearningDecisionRecordId(draftHistoryId: string): string {
  const recordId = `learning-decision-${draftHistoryId}`;
  if (!DRAFT_DECISION_RECORD_ID.test(recordId)) throw new Error("Draft history ID cannot form a learning decision ID.");
  return recordId;
}

export function decisionStateForPayload(decision: DraftLearningDecisionPayload): DraftLearningDecisionState {
  return decision.kind === "generative" ? "authored" : decision.action;
}

export interface DraftLearningDecisionAcknowledgement {
  recordId: string;
  decision: "useful" | "not_useful" | "authored";
  recordKind: "evaluation" | "generative";
  contentDigest: string;
  changed: boolean;
  updatedAt: string;
}
```

Implement `stageDraftLearningDecision(workspace, contactId, draftHistoryId, decision, now)`, `acknowledgeDraftLearningDecision(workspace, response)`, `failDraftLearningDecision(workspace, recordId, now)`, and `clearDraftLearningDecision(workspace, recordId, now)` with these rules:

```ts
const pending = {
  mutationKind: "draft_decision" as const,
  recordId,
  decision,
  sourceCollection: "draftHistory" as const,
  sourceLocalId: draftHistoryId,
  createdAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1_000).toISOString(),
};

// Replace only the same decision record; do not disturb legacy uploads.
pendingLearningRecords: [
  ...workspace.pendingLearningRecords.filter((item) => !(item.mutationKind === "draft_decision" && item.recordId === recordId)),
  pending,
].slice(-1_000)
```

Acknowledgement applies only when the current pending decision is compatible with the response: exact state match, or response `authored` acknowledging a Useful request against an already-authored server row. It clears only the matched pending mutation and sets `syncStatus: "synced"`. A missing pending mutation, cleared tombstone, late Useful/Not-useful response against authored state, or older incompatible state returns the workspace unchanged.

- [ ] **Step 5: Normalize and merge decision metadata fail-closed**

In `secureVault.ts`, normalize `learningDecision` only when it has the exact four keys, valid record ID/state/status, and a canonical ISO timestamp. Normalize v14 generic pending records to `mutationKind: "record_upload"`; validate v15 decision mutations with exact keys and never persist `knownIdentifiers`.

In `cloudWorkspaceMerge.ts`, replace same-ID draft-history merging with a merge that preserves current editable drafts while selecting the latest valid decision by parsed `updatedAt`; if timestamps tie, order states `authored > not_useful > useful`. Merge pending decision mutations by record ID and latest `createdAt`, then apply existing deletion markers and `cloudLearningClearedAt` before returning.

- [ ] **Step 6: Run the focused durability suite and verify green**

Run:

```powershell
& $node node_modules/vitest/vitest.mjs run tests/draftLearningDecision.test.ts tests/secureVault.test.ts tests/cloudWorkspaceMerge.test.ts tests/cloudRecovery.test.ts tests/cloudRecoverySync.test.ts tests/privacyLogic.test.ts
```

Expected: PASS. Also run scoped ESLint and `git diff --check`.

- [ ] **Step 7: Commit the durable v15 boundary**

```powershell
git add src/lib/workspaceTypes.ts src/lib/draftLearningDecision.ts src/lib/secureVault.ts src/lib/cloudWorkspaceMerge.ts src/lib/retention.ts tests/draftLearningDecision.test.ts tests/secureVault.test.ts tests/cloudWorkspaceMerge.test.ts tests/cloudRecovery.test.ts tests/cloudRecoverySync.test.ts tests/privacyLogic.test.ts
git commit -m "feat: persist draft learning decisions"
```

---

### Task 2: Add the authenticated atomic Worker decision endpoint

**Files:**
- Create: `cloudflare/worker/src/draftLearningDecision.js`
- Create: `tests/draftLearningDecisionWorker.test.ts`
- Modify: `cloudflare/worker/src/neonLearning.js`
- Test: `tests/neonLearningWorker.test.ts`
- Test: `tests/cloudWorker.test.ts`

**Interfaces:**
- Consumes: `validateLearningRecord` and `digestableLearningRecord` from `learningPolicy.js`; `NEON_TESTING` or `NEON_PRODUCTION` binding already selected by `neonLearning.js`; server-derived `identity.accountId`.
- Produces: `putDraftLearningDecision(binding, accountId, recordId, payload, options): Promise<DraftLearningDecisionResponse>` and the authenticated `PUT /api/learning/decisions/:recordId` route used by Task 3.

- [ ] **Step 1: Write failing strict-route and transition tests**

Cover every row in the approved transition matrix and exact lifecycle behavior. Representative tests:

```ts
it("atomically transforms one not-useful row into one authored row", async () => {
  const client = transactionClient([
    preferenceEnabledRow(),
    storedEvaluationRow("not_useful"),
    updatedGenerativeRow(),
  ]);
  const response = await decisionCall(RECORD_ID, authoredBody("My independently written reply"), { createClient: () => client });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    recordId: RECORD_ID,
    decision: "authored",
    recordKind: "generative",
    contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    changed: true,
    updatedAt: NOW,
  });
  expect(client.commands()).toEqual(["CONNECT", "BEGIN", "PREFERENCE_LOCK", "RECORD_LOCK", "UPDATE", "COMMIT", "END"]);
});

it("rejects stale not-useful after authored without mutating the row", async () => {
  const response = await decisionCall(RECORD_ID, evaluationBody("not_useful"), {
    createClient: () => transactionClient([preferenceEnabledRow(), storedGenerativeRow()]),
  });
  expect(response.status).toBe(409);
});
```

Also assert authentication/rate-limit/header rejection occurs before `request.text()`, malformed/extra keys fail, transient identifiers are never returned/logged, distinct record IDs with identical Useful payloads get different digests, and connection/BEGIN/query/COMMIT failures roll back and always close.

- [ ] **Step 2: Run the Worker tests and verify red**

```powershell
& $node node_modules/vitest/vitest.mjs run tests/draftLearningDecisionWorker.test.ts tests/neonLearningWorker.test.ts tests/cloudWorker.test.ts
```

Expected: FAIL because the route and transaction module do not exist.

- [ ] **Step 3: Implement exact request validation and namespaced digesting**

In `draftLearningDecision.js`, validate only these exact bodies:

```js
const EVALUATION_KEYS = ["action", "goalCategory", "kind", "relationshipStage", "roleId"];
const GENERATIVE_KEYS = ["goalCategory", "kind", "privacyAttested", "provenance", "relationshipStage", "rightsAttested", "roleId", "target"];
const KNOWN_KEYS = ["company", "contactName", "profileHandle", "profileUrl"];

export function validateDraftLearningDecision(payload, now) {
  if (!exactKeys(payload, payload?.decision?.kind === "generative" ? ["decision", "knownIdentifiers"] : ["decision"])) throw new DraftDecisionRequestError("Learning decision is invalid.");
  const decision = payload.decision;
  if (decision.kind === "evaluation") {
    if (!exactKeys(decision, EVALUATION_KEYS) || !["useful", "not_useful"].includes(decision.action)) throw new DraftDecisionRequestError("Learning decision is invalid.");
    return validateLearningRecord({ recordKind: "evaluation", roleId: decision.roleId, relationshipStage: decision.relationshipStage, goalCategory: decision.goalCategory, provenance: "human_confirmed", evaluationAction: decision.action }, now);
  }
  if (!exactKeys(decision, GENERATIVE_KEYS) || !exactKeys(payload.knownIdentifiers, KNOWN_KEYS)) throw new DraftDecisionRequestError("Learning decision is invalid.");
  return validateLearningRecord({ recordKind: "generative", roleId: decision.roleId, relationshipStage: decision.relationshipStage, goalCategory: decision.goalCategory, provenance: decision.provenance, target: decision.target, rightsAttested: decision.rightsAttested, privacyAttested: decision.privacyAttested }, now, payload.knownIdentifiers);
}
```

Compute the digest as SHA-256 over `accountId`, literal namespace `draft-decision-v1`, `recordId`, and canonicalized `digestableLearningRecord(record)`. Never reuse the generic semantic digest function.

- [ ] **Step 4: Implement the one-client transaction and transition matrix**

Use one `pg.Client`: connect, `BEGIN`, create the default-enabled preference row if missing, lock that row, lock the account/record row, validate the transition, issue exactly one INSERT or UPDATE when changed, `COMMIT`, and always end. Roll back after every post-BEGIN failure.

The UPDATE must set every kind-specific column explicitly:

```sql
UPDATE dialogmint_learning_records
SET record_kind = $3,
    schema_version = $4,
    role_id = $5,
    relationship_stage = $6,
    goal_category = $7,
    classifier_features = NULL,
    evaluation_action = $8,
    target_text = $9,
    provenance = $10,
    rights_attested_at = $11,
    privacy_attested_at = $12,
    content_digest = $13,
    enabled = true,
    created_at = $14,
    updated_at = $14,
    expires_at = $15
WHERE account_id = $1 AND record_id = $2
RETURNING record_id, record_kind, evaluation_action, content_digest, updated_at
```

Return `changed: false` without an UPDATE for identical evaluation, identical authored digest, or Useful against an authored row. Missing authored inserts directly. Useful-evaluation to authored, authored to Not useful, and authored to different authored content return a safe 409.

- [ ] **Step 5: Route the endpoint after the existing security boundary**

In `handleLearningRequest`, keep environment resolution, identity matching, rate limiting, and `X-Account-Id`/`X-User-Email` rejection untouched. Reject query parameters, then add:

```js
const decisionMatch = request.method === "PUT"
  && url.pathname.match(/^\/api\/learning\/decisions\/([a-z0-9-]{1,64})$/u);
if (decisionMatch) {
  return noStoreJson(await putDraftLearningDecision(
    binding,
    identity.accountId,
    decisionMatch[1],
    await readStrictJson(request),
    options,
  ));
}
```

Map validation/conflict errors to safe 400/409 responses and unexpected database errors to the existing safe 503 response. All responses retain `Cache-Control: no-store`.

- [ ] **Step 6: Run focused and broader Worker suites**

```powershell
& $node node_modules/vitest/vitest.mjs run tests/draftLearningDecisionWorker.test.ts tests/neonLearningWorker.test.ts tests/cloudWorker.test.ts tests/accessAuth.test.ts tests/learningPolicy.test.ts
```

Expected: PASS with no target, known identifier, account ID, SQL, or provider text in response/log assertions.

- [ ] **Step 7: Commit the Worker endpoint**

```powershell
git add cloudflare/worker/src/draftLearningDecision.js cloudflare/worker/src/neonLearning.js tests/draftLearningDecisionWorker.test.ts tests/neonLearningWorker.test.ts tests/cloudWorker.test.ts
git commit -m "feat: add atomic draft learning decisions"
```

---

### Task 3: Add the strict browser client and latest-mutation retry flow

**Files:**
- Modify: `src/lib/cloudLearning.ts`
- Modify: `src/lib/draftLearningDecision.ts`
- Modify: `tests/cloudLearning.test.ts`
- Modify: `tests/draftLearningDecision.test.ts`

**Interfaces:**
- Consumes: Task 1 pending union/helpers and Task 2 response contract.
- Produces: `putDraftLearningDecision`, strict response parsing, `syncPendingDraftLearningDecisions`, and a current-contact identifier resolver contract used by Task 5.

- [ ] **Step 1: Write failing HTTP, parser, retry, and late-ack tests**

```ts
it("uses the same-origin no-store decision route and parses the exact response", async () => {
  fetchMock.mockResolvedValue(decisionResponse({ decision: "useful", changed: true }));
  await expect(putDraftLearningDecision(RECORD_ID, { decision: usefulDecision() })).resolves.toMatchObject({ recordId: RECORD_ID, decision: "useful" });
  expect(fetchMock).toHaveBeenCalledWith(`/api/learning/decisions/${RECORD_ID}`, {
    method: "PUT",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: usefulDecision() }),
  });
});

it("retries only the latest mutation for a decision record", async () => {
  const workspace = workspaceWithSupersededUsefulAndCurrentNegative();
  await syncPendingDraftLearningDecisions(workspace, identifiersForDraft);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).decision.action).toBe("not_useful");
});
```

Reject missing/extra keys, bad enum pairs, unsafe timestamps, bad digests, mismatched record IDs, and non-JSON responses. Prove retry-derived known identifiers are request-only and absent from returned workspace state.

- [ ] **Step 2: Run the client tests and verify red**

```powershell
& $node node_modules/vitest/vitest.mjs run tests/cloudLearning.test.ts tests/draftLearningDecision.test.ts
```

Expected: FAIL because the decision client/parser/retry exports are missing.

- [ ] **Step 3: Implement the strict client request and response parser**

Add exact public types in `cloudLearning.ts`:

```ts
export type DraftLearningDecisionRequest =
  | { decision: Extract<DraftLearningDecisionPayload, { kind: "evaluation" }> }
  | { decision: Extract<DraftLearningDecisionPayload, { kind: "generative" }>; knownIdentifiers: CloudLearningKnownIdentifiers };

export type DraftLearningDecisionResponse = DraftLearningDecisionAcknowledgement;
```

`parseDraftLearningDecisionResponse` must require exactly six keys, validate the decision/record-kind pair, lower-hex digest, canonical ISO timestamp, boolean `changed`, and requested record-ID equality. `putDraftLearningDecision` uses the existing same-origin/no-store fetch boundary and throws only safe client errors.

- [ ] **Step 4: Implement split retry without changing generic upload semantics**

Add:

```ts
export async function syncPendingDraftLearningDecisions(
  workspace: WorkspaceData,
  resolveKnownIdentifiers: (sourceLocalId: string) => CloudLearningKnownIdentifiers | null,
  now = new Date(),
): Promise<WorkspaceData>
```

For each latest `mutationKind: "draft_decision"` record, build the exact request; for authored mutations, add identifiers only in the in-memory request. On success call `acknowledgeDraftLearningDecision`; on safe failure call `failDraftLearningDecision`. Never remove a newer mutation after awaiting an older request. Keep `uploadCloudLearningRecords` and existing batch behavior limited to `mutationKind: "record_upload"`.

- [ ] **Step 5: Verify client privacy and durability green**

```powershell
& $node node_modules/vitest/vitest.mjs run tests/cloudLearning.test.ts tests/draftLearningDecision.test.ts tests/secureVault.test.ts tests/cloudWorkspaceMerge.test.ts
```

Expected: PASS. Run scoped ESLint and `git diff --check`.

- [ ] **Step 6: Commit the client and retry boundary**

```powershell
git add src/lib/cloudLearning.ts src/lib/draftLearningDecision.ts tests/cloudLearning.test.ts tests/draftLearningDecision.test.ts
git commit -m "feat: sync draft learning decisions"
```

---

### Task 4: Replace the completed-card controls and authored dialog

**Files:**
- Create: `src/components/DraftLearningStatus.tsx`
- Create: `src/components/AddOwnVersionDialog.tsx`
- Delete: `src/components/SaveImprovementDialog.tsx`
- Modify: `src/components/CompletedDraftCard.tsx`
- Modify: `src/app/globals.css`
- Modify: `tests/compactDraftingUi.test.tsx`
- Modify: `tests/cloudLearningUi.test.tsx`
- Modify: `tests/workspaceLayout.test.ts`

**Interfaces:**
- Consumes: `DraftLearningDecision` from Task 1.
- Produces: direct card callbacks and an authored-only dialog contract consumed by Task 5.

- [ ] **Step 1: Write failing card, status, dialog, responsive, and reduced-motion tests**

```tsx
it("shows only Copy Useful and Not useful as completed-draft actions", () => {
  renderCompletedDraft();
  for (const label of ["Copy", "Useful", "Not useful"]) expect(screen.getByRole("button", { name: label })).toBeVisible();
  for (const label of ["Mark sent", "Save improvement", "More", "Dismiss", "Accept", "Save edit", "Reject"]) expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();
});

it("renders saved inside Ready to review and leaves failure retryable", async () => {
  const { rerender } = renderCompletedDraft({ learningStatus: { kind: "saved", acknowledgementId: "digest-1" } });
  expect(screen.getByText("Learning saved").closest("header")).toHaveTextContent("READY TO REVIEW");
  rerender(renderCompletedDraftProps({ learningStatus: { kind: "failed", onRetry } }));
  await user.click(screen.getByRole("button", { name: "Retry learning sync" }));
  expect(onRetry).toHaveBeenCalledTimes(1);
});
```

Keep all blank-editor sanitizer, attestation invalidation, focus return, Escape, focus trap, active-contact change, and no-LinkedIn-command tests. Add CSS source assertions for dark theme, `@media (max-width: 720px)`, `@media (max-width: 360px)`, focus-visible, and `prefers-reduced-motion: reduce`.

- [ ] **Step 2: Run the UI tests and verify red**

```powershell
& $node node_modules/vitest/vitest.mjs run tests/compactDraftingUi.test.tsx tests/cloudLearningUi.test.tsx tests/workspaceLayout.test.ts
```

Expected: FAIL on the old primary actions, More disclosure, chooser/rating dialog, and adjacent sync text.

- [ ] **Step 3: Implement the direct completed-card contract**

Replace the legacy callbacks with:

```ts
export type DraftLearningUiStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; acknowledgementId: string }
  | { kind: "pending" | "failed"; onRetry: () => void };

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
```

Render `Copy`, `Useful`, and `Not useful` directly. Set `aria-pressed` from the durable decision state. Preserve authored as selected Useful, disable Not useful for authored, and show `Add my own version` only for local Not useful/pending-negative state. Remove the More disclosure and every legacy action from the DOM.

- [ ] **Step 4: Implement the authored-only dialog and integrated status**

`AddOwnVersionDialog` accepts only `knownIdentifiers`, `onClose`, and `onSaveIndependent`. Render the blank 2,000-character editor immediately; retain the exact sanitized preview, both mandatory attestations, submit error, focus trap, Escape, focus return, and context-change invalidation. Do not render rating or path chooser controls.

`DraftLearningStatus` renders no idle text, polite `Saving learning…`, polite `Learning saved` for 3 seconds keyed by `acknowledgementId`, or an alert button `Learning sync pending — Retry`. The timer changes visibility only; it never moves focus or clears durable state.

- [ ] **Step 5: Add stable visual states and motion safety**

Use existing color/border/radius tokens. Selected Useful and Not useful must differ by label, `aria-pressed`, border width, and surface—not color alone. Give the header status a reserved minimum inline area so animation does not shift layout. Animate opacity and `translateY` only; the reduced-motion rule removes transition/transform but keeps the saved message readable for the same duration.

- [ ] **Step 6: Run focused UI and accessibility tests**

```powershell
& $node node_modules/vitest/vitest.mjs run tests/compactDraftingUi.test.tsx tests/cloudLearningUi.test.tsx tests/workspaceLayout.test.ts tests/themeToggle.test.tsx
```

Expected: PASS in light/dark, 720/360 contracts, keyboard paths, and reduced motion.

- [ ] **Step 7: Commit the direct card experience**

```powershell
git add src/components/CompletedDraftCard.tsx src/components/DraftLearningStatus.tsx src/components/AddOwnVersionDialog.tsx src/components/SaveImprovementDialog.tsx src/app/globals.css tests/compactDraftingUi.test.tsx tests/cloudLearningUi.test.tsx tests/workspaceLayout.test.ts
git commit -m "feat: simplify draft learning actions"
```

---

### Task 5: Integrate clipboard ordering, same-row replacement, and Settings cleanup

**Files:**
- Modify: `src/components/ChatHelpApp.tsx`
- Modify: `src/lib/cloudLearning.ts`
- Modify: `src/lib/draftLearningDecision.ts`
- Modify: `tests/interaction.test.tsx`
- Modify: `tests/cloudLearningUi.test.tsx`
- Modify: `tests/cloudLearning.test.ts`

**Interfaces:**
- Consumes: all Task 1–4 types, clients, helpers, and components.
- Produces: complete user flow from draft generation through direct decision, retry, authored replacement, Settings deletion, and disable/delete.

- [ ] **Step 1: Write failing end-to-end component tests**

Add route-aware fetch mocks and assert exact bodies, order, stable IDs, and absence of provider/contact text:

```tsx
it("copies first and then marks the same draft useful", async () => {
  const clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  renderAppWithGeneratedDraft();
  await user.click(screen.getByRole("button", { name: "Copy" }));
  await waitFor(() => expect(decisionRequests()).toHaveLength(1));
  expect(clipboard.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder.at(-1)!);
  expect(decisionRequests()[0].recordId).toBe(`learning-decision-${activeDraftHistoryId}`);
  expect(JSON.stringify(decisionRequests()[0].body)).not.toMatch(/draft text|contact name|provider/i);
});

it("replaces staged not-useful with authored under one stable ID", async () => {
  renderAppWithGeneratedDraft();
  await user.click(screen.getByRole("button", { name: "Not useful" }));
  await user.click(screen.getByRole("button", { name: "Add my own version" }));
  await submitIndependentVersion("My independently written response");
  expect(decisionRequests().map((item) => item.recordId)).toEqual([RECORD_ID, RECORD_ID]);
  expect(screen.getByRole("button", { name: "Useful" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("button", { name: "Add my own version" })).not.toBeInTheDocument();
});
```

Also cover clipboard rejection, repeated Copy, repeated Useful, negative pending before authored, late negative response after authored, contact switch during request, reload/recovery, Settings individual delete, global disable/delete, and every action emitting zero LinkedIn bridge commands.

- [ ] **Step 2: Run integration tests and verify red**

```powershell
& $node node_modules/vitest/vitest.mjs run tests/interaction.test.tsx tests/cloudLearningUi.test.tsx tests/cloudLearning.test.ts
```

Expected: FAIL because `ChatHelpApp` still generates random feedback IDs, shows legacy actions, and uses the generic upload API.

- [ ] **Step 3: Bind actions to the active draft-history entry**

Use `activeDraftHistory.id` as the only source identity. Remove `markDraftManuallySent`, completed-card calls to `recordDraftFeedback`, old rating handlers, and random `newId("learning")` decision IDs. Store authored dialog state as `{ contactId, draftHistoryId }`, not a draft array index.

Add an app helper with stage-first durability:

```ts
async function submitDraftLearningDecision(
  draftHistoryId: string,
  decision: DraftLearningDecisionPayload,
  knownIdentifiers?: CloudLearningKnownIdentifiers,
): Promise<void> {
  const stagedAt = new Date();
  const request: DraftLearningDecisionRequest = decision.kind === "generative"
    ? (() => {
        if (!knownIdentifiers) throw new Error("Known identifiers are required for an authored decision.");
        return { decision, knownIdentifiers };
      })()
    : { decision };
  updateWorkspace((current) => stageDraftLearningDecision(current, contact.id, draftHistoryId, decision, stagedAt));
  setDraftLearningActivity({ recordId: draftLearningDecisionRecordId(draftHistoryId), kind: "saving" });
  try {
    const response = await putDraftLearningDecision(
      draftLearningDecisionRecordId(draftHistoryId),
      request,
    );
    updateWorkspace((current) => acknowledgeDraftLearningDecision(current, response));
    setDraftLearningActivity({ recordId: response.recordId, kind: "saved", acknowledgementId: `${response.contentDigest}:${response.updatedAt}` });
  } catch {
    updateWorkspace((current) => failDraftLearningDecision(current, draftLearningDecisionRecordId(draftHistoryId), new Date()));
    setDraftLearningActivity({ recordId: draftLearningDecisionRecordId(draftHistoryId), kind: "failed" });
  }
}
```

Reject a generative call before staging when `knownIdentifiers` is absent. The authored dialog always supplies identifiers from the currently bound contact; retry leaves the encrypted pending mutation untouched when its owning contact cannot be resolved.

Before applying success/failure UI, verify the originating contact and active history still match; still reconcile durable acknowledgement into the correct history entry without rendering cross-contact status.

- [ ] **Step 4: Enforce clipboard-before-Useful and direct button behavior**

```ts
async function copyAndMarkUseful(): Promise<void> {
  try {
    await navigator.clipboard.writeText(drafts[0]);
  } catch {
    setAppError("Clipboard access was blocked.");
    return;
  }
  setExtensionStatus("Draft copied. Review and send it yourself.");
  await submitDraftLearningDecision(activeDraftHistory.id, evaluationDecision("useful"));
}
```

Useful calls the same evaluation path directly. Not useful stages before awaiting the network so `Add my own version` appears immediately. Authored save reuses the same history ID and sends the blank-editor sanitized target. If the negative request has not arrived, Task 2 inserts authored directly; any later negative request conflicts and cannot overwrite it.

- [ ] **Step 5: Integrate per-card status and retry**

Remove the adjacent `cloudLearningSyncStatus` paragraph from drafting. Keep account-wide Settings status and pending count. Derive the active card's durable selection from `activeDraftHistory.learningDecision`; derive saving/saved only from the active request activity; derive pending/failed from the durable decision. Retry calls `syncPendingDraftLearningDecisions` first and the legacy batch retry second.

- [ ] **Step 6: Make deletion and disable/delete authoritative**

When Settings deletes a draft decision, call `clearDraftLearningDecision` after the server DELETE succeeds and add the existing deletion tombstone. Global disable/delete clears every draft-history decision and pending decision mutation before a late response can reconcile. Recovery merge must honor those markers. A late request may finish server-side but cannot restore cleared local state; the next authenticated delete remains the authoritative account action.

- [ ] **Step 7: Run all integration, recovery, and no-automation tests**

```powershell
& $node node_modules/vitest/vitest.mjs run tests/interaction.test.tsx tests/cloudLearningUi.test.tsx tests/cloudLearning.test.ts tests/draftLearningDecision.test.ts tests/secureVault.test.ts tests/cloudWorkspaceMerge.test.ts tests/cloudRecovery.test.ts tests/cloudRecoverySync.test.ts tests/extensionBridge.test.ts tests/extensionSync.test.ts
```

Expected: PASS. Run scoped ESLint, introduced-diagnostic TypeScript review, and `git diff --check`.

- [ ] **Step 8: Commit the integrated flow**

```powershell
git add src/components/ChatHelpApp.tsx src/lib/cloudLearning.ts src/lib/draftLearningDecision.ts tests/interaction.test.tsx tests/cloudLearningUi.test.tsx tests/cloudLearning.test.ts tests/draftLearningDecision.test.ts
git commit -m "feat: connect direct draft learning flow"
```

---

### Task 6: Align privacy documentation and run the complete local release gate

**Files:**
- Modify: `PRIVACY.md`
- Modify: `SECURITY.md`
- Modify: `docs/cloud-learning-usage-release.md`
- Modify: `tests/securityBoundary.test.ts`
- Modify: `tests/nativeBoundary.test.ts`

**Interfaces:**
- Consumes: completed implementation from Tasks 1–5.
- Produces: accurate public privacy/security disclosure and a release candidate proven by the full local gate.

- [ ] **Step 1: Write failing documentation boundary tests**

```ts
it("documents direct text-free decisions and atomic authored replacement", () => {
  for (const text of [privacy, security, releaseGuide]) {
    expect(text).toMatch(/Copy.*Useful.*Not useful/is);
    expect(text).toMatch(/one.*record|same.*row/is);
    expect(text).toMatch(/independently authored.*sanitized/is);
    expect(text).not.toMatch(/Save improvement uploads/i);
  }
});
```

Keep existing secret, Access, encrypted recovery, numeric usage, retention, provider fallback, and no-LinkedIn-automation assertions.

- [ ] **Step 2: Run documentation tests and verify red**

```powershell
& $node node_modules/vitest/vitest.mjs run tests/securityBoundary.test.ts tests/nativeBoundary.test.ts
```

Expected: FAIL because the current documents still describe `Save improvement`.

- [ ] **Step 3: Update the three disclosures precisely**

State that Useful, Not useful, and successful Copy store only a bounded text-free evaluation. State that Add my own version starts blank, sanitizes and previews the independently authored target, requires both attestations, and atomically replaces the same negative decision row. Preserve the 365-day readable-learning retention, encrypted 90-day recovery boundary, account isolation, deletion controls, and no-training-now wording.

- [ ] **Step 4: Run the full acceptance gate**

Run, in order:

```powershell
& $node node_modules/vitest/vitest.mjs run
& $node node_modules/eslint/bin/eslint.js .
& $node scripts/verify-extension.mjs
& $node node_modules/next/dist/bin/next build
```

Start the built server using the existing CI pattern, then run `verify:live-csp` and `verify:browser` against the same process, stopping it in `finally`. Continue with:

```powershell
& $node scripts/build-native.mjs
& $node scripts/verify-static-csp.mjs
& $node node_modules/wrangler/bin/wrangler.js deploy --config wrangler.jsonc --env testing --name testing-chathelp-private-cloud --dry-run
& $node node_modules/wrangler/bin/wrangler.js deploy --config wrangler.jsonc --env production --name chathelp-private-cloud --dry-run
```

Run `npm audit --omit=dev --audit-level=high` with the pinned lockfile. Expected: all tests/gates pass, both Wrangler commands exit after dry run, production audit reports no high vulnerabilities, and no authentication/upload/deploy occurs.

- [ ] **Step 5: Obtain two independent reviews and fix every blocking finding**

Reviewer A checks Worker transactions, request ordering, privacy, mutation races, recovery tombstones, and no secret/account leakage. Reviewer B checks direct-action clarity, selected/disabled states, dialog focus, status semantics, 720/360 layouts, light/dark themes, reduced motion, and no LinkedIn automation. Add a failing regression for every confirmed Critical/Important/spec gap before fixing it, then rerun the affected and full gates and obtain explicit re-approval.

- [ ] **Step 6: Commit documentation and final reviewer fixes**

```powershell
git add PRIVACY.md SECURITY.md docs/cloud-learning-usage-release.md tests/securityBoundary.test.ts tests/nativeBoundary.test.ts
git commit -m "docs: explain direct draft learning"
```

If reviewer fixes touched implementation files, amend only the relevant task commit when the branch has not been shared; otherwise create a focused fix commit with the exact affected tests.

---

### Task 7: Push the exact release candidate and deploy testing only

**Files:**
- No source changes expected.
- Update the ignored implementation evidence ledger under `.superpowers/sdd/2026-08-09-dialogmint-cloud-learning-usage-compact-ui/`.

**Interfaces:**
- Consumes: a clean branch, passing Task 6 evidence, existing testing migration, and the approved Cloudflare account `project.mission.ai@gmail.com`.
- Produces: exact-SHA GitHub CI proof, one explicit testing Worker version at 100%, unchanged production snapshot, and authenticated manual smoke evidence.

- [ ] **Step 1: Confirm exact branch state and account without exposing secrets**

```powershell
git status --short
git log -1 --format="%H %s"
& $node node_modules/wrangler/bin/wrangler.js whoami
```

Expected: clean `codex/draft-progress-stream`; Cloudflare identity is `project.mission.ai@gmail.com`. Stop if either differs.

- [ ] **Step 2: Snapshot testing and production deployment states**

```powershell
& $node node_modules/wrangler/bin/wrangler.js deployments status --config wrangler.jsonc --env testing --name testing-chathelp-private-cloud --json
& $node node_modules/wrangler/bin/wrangler.js deployments status --config wrangler.jsonc --env production --name chathelp-private-cloud --json
```

Save only version IDs, percentages, environment, and commit SHA in the ignored evidence report. Never capture secret values.

- [ ] **Step 3: Push and require CI for the exact SHA**

```powershell
git push origin codex/draft-progress-stream
$releaseSha = git rev-parse HEAD
$runs = gh run list --repo netcore-beast/ChatHelp --workflow CI --limit 10 --json databaseId,status,conclusion,url,headSha | ConvertFrom-Json
$runId = ($runs | Where-Object { $_.headSha -eq $releaseSha } | Select-Object -First 1).databaseId
if (-not $runId) { throw "No CI run matches the release SHA." }
gh run watch $runId --repo netcore-beast/ChatHelp --exit-status
```

Expected: the run whose `headSha` equals local HEAD concludes `success`. Stop on any mismatch or failure.

- [ ] **Step 4: Upload and promote one explicit testing version**

```powershell
$releaseSha = git rev-parse HEAD
$uploadOutput = (& $node node_modules/wrangler/bin/wrangler.js versions upload --config wrangler.jsonc --env testing --name testing-chathelp-private-cloud --preview-alias testing --keep-vars --strict --message $releaseSha 2>&1 | Out-String)
$uploadOutput
$testingVersion = [regex]::Match($uploadOutput, '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', 'IgnoreCase').Value
if (-not $testingVersion) { throw "Wrangler did not return a testing version ID." }
& $node node_modules/wrangler/bin/wrangler.js versions deploy "$testingVersion@100%" --config wrangler.jsonc --env testing --name testing-chathelp-private-cloud --yes --message $releaseSha
```

Require the parsed version ID to be present; do not use a production deploy script.

- [ ] **Step 5: Verify testing and production isolation**

Re-read both deployment states. Testing must be 100% on the new version. Production version IDs and percentages must exactly equal the Step 2 snapshot.

- [ ] **Step 6: Ask the user to run the authenticated testing smoke checklist**

The user verifies in the signed-in testing UI:

1. Health remains testing with Claude primary, two permanent fallbacks, learning/usage configured, and encrypted recovery.
2. Useful creates one evaluation row; repeated Useful and reload do not add a row.
3. Not useful updates that row and reveals Add my own version.
4. Add my own version starts blank, sanitizes identifiers, requires both attestations, and leaves one generative row under the same record ID with no negative row.
5. Successful Copy copies first and selects Useful; blocked clipboard creates no learning record.
6. The completed card has no Sent, More, Dismiss, Accept, Save edit, Reject, or Save improvement controls.
7. `Learning saved` appears inside `READY TO REVIEW`; a forced safe failure remains retryable.
8. Settings counts/list/delete/disable-and-delete and usage cards remain correct.
9. Keyboard, narrow layout, light/dark theme, and reduced-motion behavior remain usable.

Stop before production until every item passes.

---

### Task 8: Resume private production only after the testing checkpoint

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes: user-confirmed Task 7 smoke evidence, unchanged production snapshot, and user confirmation that the existing `0002_dialogmint_cloud_learning_usage.sql` migration is applied to the production Neon database.
- Produces: a controlled private-production version promotion with rollback evidence.

- [ ] **Step 1: Require the trusted production migration confirmation**

Do not request or inspect a connection string. Ask the user to apply the already-reviewed `cloudflare/neon/0002_dialogmint_cloud_learning_usage.sql` in Neon's trusted production SQL editor and confirm four tables plus the usage trigger. No new SQL is required for direct decisions.

- [ ] **Step 2: Reconfirm account, exact SHA, CI, and production snapshot**

Use the same safe commands as Task 7. Stop if the account is not `project.mission.ai@gmail.com`, the branch is dirty, CI does not match HEAD, or production changed unexpectedly.

- [ ] **Step 3: Upload a production version without changing traffic**

```powershell
$releaseSha = git rev-parse HEAD
$productionUploadOutput = (& $node node_modules/wrangler/bin/wrangler.js versions upload --config wrangler.jsonc --env production --name chathelp-private-cloud --keep-vars --strict --message $releaseSha 2>&1 | Out-String)
$productionUploadOutput
$productionVersion = [regex]::Match($productionUploadOutput, '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', 'IgnoreCase').Value
if (-not $productionVersion) { throw "Wrangler did not return a production version ID." }
```

Record the returned version ID. Re-read deployment status and confirm traffic is still unchanged.

- [ ] **Step 4: Promote the explicit production version and verify health**

```powershell
& $node node_modules/wrangler/bin/wrangler.js versions deploy "$productionVersion@100%" --config wrangler.jsonc --env production --name chathelp-private-cloud --yes --message $releaseSha
```

The user opens authenticated private-production health and repeats the essential decision, usage, deletion, and no-automation smoke checks with non-sensitive test content.

- [ ] **Step 5: Roll back on any failed production check**

Deploy the exact prior production version ID from Task 7's snapshot at 100%. Rollback changes only Worker/app traffic; it does not delete learning or usage data. Record the failed check and restored version in the ignored evidence report.

---

## Plan Self-Review Checklist

- Every approved direct action, Copy ordering rule, same-row transition, authored replacement, status animation, removal, privacy boundary, retry race, deletion path, and release checkpoint maps to a task above.
- All new public types and function names are introduced before later tasks consume them.
- Worker and browser contracts use the same six-field success response and decision enum.
- No step adds a Neon migration, provider change, account selector, secret handling, or LinkedIn automation.
- No code step relies on draft text as identity or sends provider/contact text through an evaluation request.
- Generic classifier/record uploads remain intact and separate from mutable draft decisions.
- Production remains conditional on repeated testing evidence and trusted production migration confirmation.
