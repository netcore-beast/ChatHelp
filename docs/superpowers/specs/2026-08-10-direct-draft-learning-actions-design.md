# Direct draft learning actions design

Date: 2026-08-10  
Status: Written specification approved; implementation planning in progress  
Targets: Project Mission testing first, then private production after repeat verification

## Objective

Replace the completed draft card's indirect feedback workflow with three clear primary actions: `Copy`, `Useful`, and `Not useful`. Make each generated draft own one mutable, idempotent Neon learning decision. A separately authored correction must atomically replace that draft's `Not useful` evaluation without retaining a second negative row. Remove the manual-sent and legacy local-feedback actions, and integrate cloud-learning synchronization feedback into the existing `READY TO REVIEW` header.

This revision is a pre-production extension of `2026-08-09-dialogmint-cloud-learning-usage-compact-ui-design.md`. It supersedes that specification only where it previously required `Mark sent`, `Save improvement`, or a `More` action group on a completed draft. Claude Opus 4.6 remains primary, both Workers AI fallbacks remain permanent, approved learning remains server-readable and de-identified, and LinkedIn sending remains a separate manual action outside DialogMint.

## Approved product decisions

- Show `Copy`, `Useful`, and `Not useful` directly on every completed draft.
- Remove `Mark sent`, `Save improvement`, the completed-card `More` disclosure, and its `Dismiss`, `Accept`, `Save edit`, and `Reject` actions.
- Preserve the editable draft textarea and its existing encrypted local draft-history persistence.
- Clicking `Useful` saves a text-free useful evaluation to Neon.
- Clicking `Not useful` saves a text-free not-useful evaluation and reveals `Add my own version`.
- `Add my own version` opens a blank independent-author editor. It retains known-identifier replacement, direct-identifier rejection, exact sanitized preview, rights attestation, and privacy attestation.
- Submitting the independent version atomically transforms the same Not-useful Neon row into the sanitized independently authored row. The negative evaluation does not remain as a second row.
- Clicking `Copy` marks the same draft decision Useful only after the clipboard write succeeds. Clipboard failure creates no learning decision.
- Repeated actions, reloads, retries, and concurrent requests reuse one stable decision record per generated draft and never create duplicate rows.
- A successfully authored replacement is the final useful record for that draft. Copy or Useful acknowledges it without downgrading it to a text-free evaluation. Changing it back to Not useful requires deleting the authored example from Settings first.
- Replace the separate `Cloud learning sync complete` text near the card with an accessible transient `Learning saved` animation inside the `READY TO REVIEW` header. Persistent failures remain actionable.
- No new Neon schema migration is required. The existing learning-record table already supports the required evaluation and generative shapes.
- Production promotion remains paused. The revision must pass local verification, GitHub CI, a fresh testing deployment, and repeat authenticated testing smoke checks before production migration or deployment resumes.

## Approaches considered

### Atomic mutable decision record

Use one stable record ID per draft and an authenticated Worker endpoint that inserts or mutates the row inside one Neon transaction. The endpoint supports text-free evaluation changes and the guarded Not-useful-to-authored transition. It is idempotent and rollback-safe.

Selected because it exactly matches the approved replacement semantics without a new database table or partial delete/create states.

### Delete then create with the existing APIs

Delete the Not-useful evaluation and then upload a new authored record, or upload first and delete second.

Rejected because a transport failure, browser close, or concurrent action can leave no record, both records, or a retry conflict.

### Retain both negative and authored records

Keep the original text-free negative evaluation and add the independently authored useful target.

Rejected because it contradicts the approved requirement that the authored version replace the negative row.

## User experience

### Default completed draft card

The card retains the current provider/model metadata, fallback/accounting disclosure, editable draft, and `READY TO REVIEW` heading. Its action area contains only:

```text
Copy    Useful    Not useful
```

`Useful` and `Not useful` are toggle buttons with `aria-pressed`. Their selected styling must use text and shape/border differences in addition to color. The buttons remain usable at desktop and narrow widths and have at least the existing project touch-target size.

There is no `Sent` button and no `More` disclosure. The following strings and interactive controls must be absent from the completed card: `Mark sent`, `Save improvement`, `Dismiss`, `Accept`, `Save edit`, and `Reject`.

Editing the textarea remains allowed. Blur continues to persist the edited draft in encrypted draft history. Editing alone does not upload text or create learning data.

### Useful

Selecting `Useful` stages and saves a text-free evaluation for the stable draft decision ID. The provider draft text, edited textarea text, prompt, contact identity, and conversation text are not included. Re-selecting Useful is idempotent.

If the current server row is Not useful, Useful updates the same row. If the current row is an independently authored generative record, Useful treats it as already useful and leaves the authored target unchanged.

### Not useful

Selecting `Not useful` stages and saves a text-free negative evaluation for the same stable ID. Once the local durable state has staged the negative decision, the card reveals `Add my own version`.

The action remains available while synchronization is pending. The independent-author path may open while the negative mutation is pending, and final authored submission uses the same record ID. If the negative row has already arrived, the server transforms it atomically. If it has not arrived, the server inserts the authored final state directly. A stale negative response must not overwrite a later authored success.

Not useful is not allowed to overwrite an already authored final record. The UI disables that transition and directs the user to Settings if deletion is required.

### Copy

Copy first calls the browser clipboard API with the current editable draft. Only after that promise resolves does the client stage Useful for the stable decision ID.

- Clipboard success plus learning success: show `Copied` through the existing app status and animate `Learning saved` in the card.
- Clipboard success plus learning failure: the clipboard operation remains successful; show persistent `Learning sync pending — Retry` in the card.
- Clipboard failure: show the existing copy error and do not stage, upload, or mutate a learning decision.
- Repeated Copy: reuse the same stable record ID and produce no duplicate Neon row.

### Add my own version

This action appears only while the active decision is Not useful or a Not-useful mutation is pending. It opens the independent-author dialog directly; the old chooser and rating screens are removed.

The textarea is always blank on open and never receives provider draft text. The existing 2,000-character maximum remains. Known contact name, company, profile URL, and profile handle are replaced with `[contact]`, `[company]`, and `[profile]`. Email addresses, URLs, and phone numbers are rejected. The exact sanitized preview is displayed, and changing text or known-identifier context invalidates the privacy attestation.

Both checkboxes remain mandatory:

- `I wrote this response independently or have the rights to use it.`
- `I reviewed the sanitized preview and it contains no personal or confidential information.`

`Save approved example` stays disabled until server-valid sanitized content and both attestations are present. A successful save closes the dialog, selects Useful on the card, hides `Add my own version`, and leaves one generative Neon row under the original stable decision ID.

## Stable decision identity and local durability

Each generated `DraftHistoryEntry` gains bounded encrypted local metadata:

```ts
type DraftLearningDecision = {
  recordId: string;
  state: "useful" | "not_useful" | "authored";
  syncStatus: "pending" | "synced" | "failed";
  updatedAt: string;
};
```

The stable record ID is derived once from the existing unique draft-history entry ID and persisted with that entry. It must satisfy the current learning-record ID pattern and 64-character maximum. The active completed draft must retain its history-entry identity across edits and reloads; draft text is not used as identity.

The encrypted workspace schema advances from v14 to v15 to normalize this optional metadata and a decision-mutation discriminator on pending learning records. Existing v14 workspaces migrate without creating decisions. Draft-history retention naturally removes the local decision metadata with its draft, while the Neon record retains its independent 365-day policy unless the user deletes it.

Before a network request, the browser writes the intended decision and pending mutation to the encrypted vault. Repeated actions replace the pending mutation for the same record ID rather than appending another item. Retry dispatches the latest mutation only. Successful acknowledgement updates the same draft-history decision and clears pending metadata. Disable-and-delete cloud learning clears decision and pending metadata so recovery merging cannot resurrect it.

## Worker API

Add an authenticated same-origin endpoint:

```text
PUT /api/learning/decisions/:recordId
```

It uses the existing Cloudflare Access authentication and server-derived opaque account ID. Authentication occurs before body parsing or Neon access. The browser cannot supply an account ID, email address, environment, created timestamp, content digest, or attestation timestamp.

The request is strict and has one of two exact bodies:

```ts
type EvaluationDecisionRequest = {
  decision: {
    kind: "evaluation";
    roleId: RoleId;
    relationshipStage: RelationshipStage;
    goalCategory: GoalCategory;
    action: "useful" | "not_useful";
  };
};

type AuthoredDecisionRequest = {
  decision: {
    kind: "generative";
    roleId: RoleId;
    relationshipStage: RelationshipStage;
    goalCategory: GoalCategory;
    provenance: "independently_user_authored";
    target: string;
    rightsAttested: true;
    privacyAttested: true;
  };
  knownIdentifiers: {
    contactName: string;
    company: string;
    profileUrl: string;
    profileHandle: string;
  };
};
```

`knownIdentifiers` are transient sanitizer input and are never persisted or logged. The Worker reruns normalization, known-identifier replacement, forbidden-identifier detection, provenance validation, and canonical digest generation. Client preview is never treated as authoritative.

Decision-endpoint digests use a separate canonical namespace and include the opaque stable decision record ID. This allows two distinct generated drafts to hold identical bounded decisions without violating the table's account-scoped digest uniqueness. Existing non-decision learning uploads retain their current semantic deduplication.

The exact success response contains only bounded non-sensitive metadata:

```ts
type DraftLearningDecisionResponse = {
  recordId: string;
  decision: "useful" | "not_useful" | "authored";
  recordKind: "evaluation" | "generative";
  contentDigest: string;
  changed: boolean;
  updatedAt: string;
};
```

All responses use `Cache-Control: no-store`. Errors use safe codes and do not expose SQL, account keys, stored content, known identifiers, or provider text.

## Atomic Neon transition

The endpoint uses one PostgreSQL client and transaction:

1. `BEGIN`.
2. Lock the current account's learning-preference row and require enabled cloud learning.
3. Select the current account and record ID `FOR UPDATE`.
4. Validate the requested transition against the locked row.
5. Insert a missing evaluation row or update every kind-specific field, canonical digest, expiry, and update timestamp in one statement.
6. `COMMIT`.
7. On any error after `BEGIN`, `ROLLBACK`; always close the client.

Allowed transitions:

| Current row | Requested decision | Result |
|---|---|---|
| Missing | Useful or Not useful evaluation | Insert evaluation |
| Missing | Authored | Insert authored final state; this covers a locally superseded Not-useful request that has not reached Neon |
| Useful evaluation | Useful | Idempotent success |
| Useful evaluation | Not useful | Update same row |
| Useful evaluation | Authored | Reject |
| Not useful evaluation | Not useful | Idempotent success |
| Not useful evaluation | Useful | Update same row |
| Not useful evaluation | Authored | Atomically transform same row to generative |
| Authored generative | Useful | Idempotent acknowledgement; preserve authored row |
| Authored generative | Authored with identical digest | Idempotent success |
| Authored generative | Not useful or different authored digest | Reject with conflict |

The update clears evaluation-only columns when becoming generative and fills every generative-only column required by existing table constraints. A validation, uniqueness, preference, database, or connection failure leaves the previous row unchanged. Concurrent requests serialize on the row. The first valid transition wins; stale incompatible requests receive a conflict and cannot overwrite a newer authored record.

No SQL migration is required because `dialogmint_learning_records` already permits both row kinds and the transaction updates the same primary key in place.

## Status integration and animation

Add a small `DraftLearningStatus` element inside the completed-card header beside `READY TO REVIEW`.

States:

- idle: render no additional status;
- saving: `Saving learning…`;
- saved: `Learning saved`, animated briefly for approximately three seconds and then visually dismissed;
- pending or failed: persistent `Learning sync pending — Retry` button;
- authored: selected Useful state remains visible even after the transient success badge disappears.

The saved badge may animate opacity and vertical position using existing design tokens. It must not move surrounding layout. `prefers-reduced-motion: reduce` removes movement and transition while preserving the same three-second readable state. Saving and saved use `role="status"` with `aria-live="polite"`; failures use `role="alert"`. Focus never moves automatically. Retry is keyboard accessible and preserves the current selected decision.

The separate completed-card-adjacent `Cloud learning sync complete` text is removed. Settings retains account-wide state, pending count, and retry controls.

## Privacy and security invariants

- Useful, Not useful, and Copy never upload draft text, edited draft text, prompt text, conversation text, contact identifiers, provider reasoning, or provider output.
- Only the independent-author path may upload target text, after blank authoring, client preview, two attestations, and Worker revalidation.
- Known identifiers remain request-only sanitizer input and never enter Neon, logs, responses, local decision metadata, or usage accounting.
- Account identity is derived only from the validated Cloudflare Access JWT. Testing and production remain isolated by exact host, audience, environment, and Neon binding.
- The existing encrypted vault and encrypted recovery boundary remain unchanged except for bounded v15 decision metadata inside ciphertext.
- No action navigates, clicks, types, scrolls, pastes into, or sends through LinkedIn. Copy writes only to the system clipboard; sending remains a separate human action.
- Provider outputs remain ineligible as generative training targets.

## Error handling

- Authentication or learning-disabled errors do not parse or retain request content and show a safe unavailable/pending message.
- Clipboard failure creates no learning mutation.
- Evaluation network failure leaves the intended text-free decision encrypted and retryable.
- Authored validation failure leaves the prior Not useful server row and local state intact and keeps the dialog open.
- Authored network or database failure leaves any prior Not useful server row intact and the sanitized pending mutation encrypted for retry.
- A stale evaluation response cannot overwrite a later authored local state.
- A stale request from another tab cannot overwrite a locked authored server row.
- Disable-and-delete wins against pending or late decision operations and prevents recovery conflict resurrection.
- The card never claims `Learning saved` until a strict server acknowledgement is validated.

## Acceptance tests

### Worker and Neon

- Missing evaluation inserts under the server-derived account and active environment.
- Useful and Not useful update the same primary key with no duplicate row.
- Not-useful-to-authored transformation clears evaluation fields, fills generative fields, and commits one row.
- Insert/update failure rolls back and preserves the prior row.
- Disabled preference, cross-account ID, invalid transition, malformed body, extra key, prohibited identifier, and invalid attestation fail closed.
- Identical retry returns a strict idempotent acknowledgement.
- Concurrent conflicting requests serialize; authored success cannot be overwritten by stale evaluation.
- Client-supplied account, timestamps, digest, environment, email, or attestation timestamps are rejected.
- Response and logs contain no request target, known identifier, account key, SQL detail, or provider text.
- Database connection, begin, rollback, commit, and close lifecycle paths are covered.

### Client durability

- Stable decision ID survives edits, reload, encrypted recovery, and retries.
- Repeated Copy or button clicks keep one pending mutation and one server row.
- Clipboard rejection creates no mutation.
- Latest decision wins over late acknowledgements.
- Disable-and-delete removes decision/pending state and tombstones it against recovery merge.
- v14-to-v15 migration is bounded, backward compatible, and rejects malformed metadata.

### UI and accessibility

- Copy, Useful, and Not useful are visible; removed action labels are absent from the completed card.
- Useful and Not useful expose correct pressed/disabled state without relying on color alone.
- Not useful reveals Add my own version; Useful hides it.
- The independent editor is blank and never contains provider text.
- Email, URL, and phone rejection, known-identifier replacement, exact-preview invalidation, and both attestations remain covered.
- Success animation is inside the Ready-to-review header, does not shift layout, and obeys reduced motion.
- Pending failure is persistent, announced, and keyboard retryable.
- Focus return, Escape, Tab containment, narrow layout, light/dark theme, and descriptive accessible names pass.
- Copy, Useful, Not useful, authored save, Retry, and every remaining draft action emit no LinkedIn bridge command.

## Release sequence

1. Implement with strict red-green tests and independent code/privacy plus UX/accessibility review.
2. Run the complete local release gate and dependency audit.
3. Push the revision and require GitHub CI success for the exact SHA.
4. Upload and promote a new explicit testing Worker version only.
5. Repeat testing checks for direct decisions, Copy-as-Useful, atomic authored replacement, Settings records/counts/deletion, animation/reduced motion, usage, provider metadata, and production isolation.
6. Recheck production's deployment snapshot remains unchanged.
7. Resume the separately confirmed production migration and promotion process only after the revised testing evidence passes.
