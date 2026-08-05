# LeadDelta-Aligned Inbox Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add privacy-safe conversation state, context transparency, synchronization diagnostics, archive restoration, and local pin/read-later controls without changing ChatHelp's existing LinkedIn, AI, encryption, or manual-send boundaries.

**Architecture:** Durable user choices and the latest safe synchronization summary live on the encrypted `Contact` record. A new pure conversation-state module derives transient status and sorting from existing contact data. Snapshot merging remains the single deduplication boundary and returns/persists message-free diagnostics, while the composer context inspector consumes a summary built beside the existing prompt builder so it cannot drift from generation inputs.

**Tech Stack:** Next.js 16.2 App Router, React 19, TypeScript 5, Vitest 4, Testing Library, IndexedDB encrypted vault, Manifest V3 extension bridge, Cloudflare Workers static assets.

## Global Constraints

- Preserve the encrypted local vault and normalize all legacy contacts safely.
- Do not add Chrome permissions, LinkedIn network requests, cookie/token access, DOM automation, or message sending.
- Do not scan the LinkedIn inbox or hidden conversations.
- Do not change the authenticated same-origin `/api/drafts` boundary.
- Do not store conversation text in diagnostics, logs, extension storage, or Cloudflare state.
- Preserve notes, labels, pipeline, reminders, snooze state, outcomes, and draft history during imports.
- Deploy only to `testing-chathelp-private-cloud.project-mission-ai.workers.dev` in Cloudflare account `8c9e063cdf6a3f83f474a7535845cbb2`.
- Do not deploy or alter the production Worker and do not use the netcore.beast Cloudflare account.

## File map

- Create `src/lib/conversationState.ts`: pure derived-state labels, explanations, and stable pinned sorting.
- Modify `src/lib/workspaceTypes.ts`: durable pin/read-later and safe sync diagnostic types.
- Modify `src/lib/secureVault.ts`: legacy-safe normalization for new optional metadata.
- Modify `src/lib/linkedinExtension.ts`: diagnostic counts/fingerprint and new-incoming archive restoration.
- Modify `src/lib/privateAi.ts`: prompt-aligned draft context summary.
- Modify `src/components/ChatHelpApp.tsx`: state badges, controls, context inspector, diagnostics UI, pinned sorting.
- Modify `src/app/globals.css`: compact controls, badges, inspector, diagnostic disclosure.
- Modify `tests/secureVault.test.ts`, `tests/linkedinExtension.test.ts`, `tests/cloudAi.test.ts`, and `tests/interaction.test.tsx`.
- Create `tests/conversationState.test.ts`.

---

### Task 1: Durable local metadata and derived conversation state

**Files:**
- Create: `src/lib/conversationState.ts`
- Modify: `src/lib/workspaceTypes.ts`
- Modify: `src/lib/secureVault.ts`
- Create: `tests/conversationState.test.ts`
- Modify: `tests/secureVault.test.ts`

**Interfaces:**
- Produces: `ConversationStateCode`, `ConversationState`, `deriveConversationState(contact, now)`, and `sortPinnedThenRecent(contacts)`.
- Produces on `Contact`: optional `pinned`, `readLater`, and `lastSyncDiagnostic` fields.
- Consumers: Tasks 2 and 4.

- [ ] **Step 1: Write failing state and vault tests**

Add literal table cases that prove precedence and persistence:

```ts
expect(deriveConversationState({ ...base, archivedAt: nowIso }, now).code).toBe("archived");
expect(deriveConversationState({ ...base, snoozedUntil: futureIso }, now).code).toBe("snoozed");
expect(deriveConversationState({ ...base, followUpAt: pastIso }, now).code).toBe("follow-up-due");
expect(deriveConversationState({ ...base, readLater: true }, now).code).toBe("read-later");
expect(deriveConversationState({ ...base, chat: [incoming] }, now).code).toBe("to-respond");
expect(deriveConversationState({ ...base, chat: [outgoing] }, now).code).toBe("awaiting-reply");
expect(sortPinnedThenRecent([recent, pinnedOlder]).map((item) => item.id)).toEqual(["pinned", "recent"]);
```

Extend the secure-vault fixture with `pinned: true`, `readLater: true`, and a safe diagnostic, reopen it, and assert those values persist. Normalize a legacy contact with none of the fields and assert `false`, `false`, and `undefined`.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
npx vitest run tests/conversationState.test.ts tests/secureVault.test.ts
```

Expected: FAIL because the module and contact fields do not exist.

- [ ] **Step 3: Implement minimal types, normalization, and pure state helpers**

Add:

```ts
export interface ContactSyncDiagnostic {
  action: "created" | "updated" | "no-change";
  visibleMessages: number;
  importedMessages: number;
  duplicateMessages: number;
  restoredFromArchive: boolean;
  snapshotFingerprint: string;
  synchronizedAt: string;
}

export interface ConversationState {
  code: "archived" | "snoozed" | "follow-up-due" | "read-later" | "to-respond" | "awaiting-reply" | "no-messages" | "up-to-date";
  label: string;
  explanation: string;
}
```

Normalize booleans with strict equality and accept a diagnostic only when its action and numeric fields are valid. Implement state precedence from the approved design. `sortPinnedThenRecent` must copy before sorting, put pinned contacts first, and use the existing latest-message/last-sync descending timestamp as its secondary order.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```powershell
npx vitest run tests/conversationState.test.ts tests/secureVault.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```powershell
git add src/lib/conversationState.ts src/lib/workspaceTypes.ts src/lib/secureVault.ts tests/conversationState.test.ts tests/secureVault.test.ts
git commit -m "feat: add local conversation state metadata"
```

### Task 2: Snapshot diagnostics and archive restoration

**Files:**
- Modify: `src/lib/linkedinExtension.ts`
- Modify: `tests/linkedinExtension.test.ts`

**Interfaces:**
- Consumes: `ContactSyncDiagnostic` from Task 1.
- Extends: `LinkedInSnapshotUpsertResult` with `duplicateMessages`, `restoredFromArchive`, and `snapshotFingerprint`.
- Persists: `Contact.lastSyncDiagnostic` for non-ambiguous imports.
- Consumers: Task 4 UI.

- [ ] **Step 1: Write failing import tests**

Add separate tests for each break:

```ts
expect(result.importedMessages).toBe(1);
expect(result.duplicateMessages).toBe(1);
expect(result.snapshotFingerprint).toMatch(/^[a-z0-9]+$/);
expect(result.contacts[0].lastSyncDiagnostic).toMatchObject({ action: "updated", importedMessages: 1, duplicateMessages: 1 });
```

For an archived contact receiving a new incoming message:

```ts
expect(result.restoredFromArchive).toBe(true);
expect(updated.archivedAt).toBe("");
expect(updated.pipelineStage).toBe("inbox");
expect(updated.notes).toBe("preserve me");
```

Add literal counterexamples proving duplicate snapshots, outgoing-only imports, and metadata-only updates leave `archivedAt` and `pipelineStage` unchanged.

- [ ] **Step 2: Run the targeted test and verify RED**

Run:

```powershell
npx vitest run tests/linkedinExtension.test.ts
```

Expected: FAIL because diagnostics and restoration are not implemented.

- [ ] **Step 3: Return merge diagnostics from the existing deduplication loop**

Change `mergeMessages` to count excluded snapshot messages without retaining their text. Determine `hasNewIncoming` from the `imported` array after stable-ID/fingerprint deduplication. Derive a snapshot fingerprint from contact identity plus stable message IDs/roles/timestamps/attachment labels using the existing non-cryptographic local hash.

After calculating the final action, construct one `ContactSyncDiagnostic` and store it on the merged contact. When `existing.archivedAt` is truthy and `hasNewIncoming` is true, clear `archivedAt`, set `pipelineStage: "inbox"`, and report restoration. Do not alter any unrelated contact property.

- [ ] **Step 4: Run the targeted test and verify GREEN**

Run:

```powershell
npx vitest run tests/linkedinExtension.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```powershell
git add src/lib/linkedinExtension.ts tests/linkedinExtension.test.ts
git commit -m "feat: add safe sync diagnostics and archive restoration"
```

### Task 3: Prompt-aligned draft context summary

**Files:**
- Modify: `src/lib/privateAi.ts`
- Modify: `tests/cloudAi.test.ts`

**Interfaces:**
- Produces: `DraftContextSummary` and `buildDraftContextSummary(input: PrivateAiInput)`.
- Shares normalization: the same repaired chat, 80-message window, latest meaningful incoming selection, recent conversation captures, and rejected full-page rules used by `buildPrompt`.
- Consumer: Task 4 composer inspector.

- [ ] **Step 1: Write failing summary tests**

Use a fixture with 85 structured messages, notes, full-page noise, one valid capture, rules, and an objective. Assert hand-derived values:

```ts
expect(summary.structuredMessagesIncluded).toBe(80);
expect(summary.latestIncomingText).toBe("Could you send the role details?");
expect(summary.replyRuleCharacters).toBe(24);
expect(summary.hasRelationshipGoal).toBe(true);
expect(summary.hasObjective).toBe(true);
expect(summary.hasContactNotes).toBe(true);
expect(summary.conversationCaptureCount).toBe(1);
```

Also assert a blank objective is reported as absent.

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
npx vitest run tests/cloudAi.test.ts
```

Expected: FAIL because the summary API does not exist.

- [ ] **Step 3: Extract shared prompt-context selection and implement the summary**

Create a private `selectPromptContext(input)` that returns repaired chat, the last 80 messages, latest message, latest meaningful incoming, reply target, valid conversation captures, and supporting evidence. Update `buildPrompt` to consume it without changing emitted prompt text. Implement `buildDraftContextSummary` from that same selection and clip the displayed latest incoming text to 240 characters.

- [ ] **Step 4: Run cloud AI tests and verify GREEN**

Run:

```powershell
npx vitest run tests/cloudAi.test.ts
```

Expected: PASS, including existing prompt snapshots/assertions.

- [ ] **Step 5: Commit Task 3**

```powershell
git add src/lib/privateAi.ts tests/cloudAi.test.ts
git commit -m "feat: expose grounded draft context summary"
```

### Task 4: Compact inbox controls, context inspector, and diagnostics UI

**Files:**
- Modify: `src/components/ChatHelpApp.tsx`
- Modify: `src/app/globals.css`
- Modify: `tests/interaction.test.tsx`

**Interfaces:**
- Consumes: `deriveConversationState`, `sortPinnedThenRecent`, `buildDraftContextSummary`, and `Contact.lastSyncDiagnostic`.
- Preserves: existing `updateWorkspace`, `updateContact`, extension status, filters, composer generation, and manual-send controls.

- [ ] **Step 1: Write failing interaction tests**

Render a real workspace and verify accessible behavior rather than CSS implementation:

```ts
expect(screen.getByText("To respond")).toBeInTheDocument();
await user.click(screen.getByRole("button", { name: "Pin Taylor Lee" }));
expect(screen.getByRole("button", { name: "Unpin Taylor Lee" })).toHaveAttribute("aria-pressed", "true");
await user.click(screen.getByRole("button", { name: "Read Taylor Lee later" }));
expect(screen.getByText("Read later")).toBeInTheDocument();
```

Open `Draft context` and assert the selected role, 80-or-fewer history count, rule character count, objective state, notes state, and latest incoming target. Open `Sync diagnostics` and assert visible/new/duplicate counts and restoration state. Re-render from the saved encrypted workspace and assert pin/read-later remain selected.

- [ ] **Step 2: Run interaction tests and verify RED**

Run:

```powershell
npx vitest run tests/interaction.test.tsx
```

Expected: FAIL because the new controls and disclosures are absent.

- [ ] **Step 3: Implement minimal accessible UI integration**

Use the state engine for badges and the pinned sorter for the existing visible-contact result. Add compact header and row buttons with `aria-pressed`. Use native `<details>` for `Draft context` and `Sync diagnostics` so collapsed controls add minimal height and retain keyboard support.

Build the context summary from the same `PrivateAiInput` created for generation; factor the existing input construction into one component helper if necessary. Display only the latest incoming excerpt inside the local authenticated UI. Diagnostics display counts and a shortened fingerprint but no message body.

When a snapshot reports restoration, keep the existing synchronization message and append `Archived conversation restored because a new incoming message was found.`

- [ ] **Step 4: Add compact styles**

Add focused classes for:

```css
.conversation-state-badge { /* compact pill using existing palette */ }
.inbox-quick-actions { /* icon-sized accessible buttons */ }
.context-inspector,
.sync-diagnostics { /* native details with restrained borders/padding */ }
```

Reuse existing CSS variables, focus-visible treatment, typography, and responsive breakpoints. Do not change workspace columns or message/draft scroll behavior.

- [ ] **Step 5: Run interaction and focused library tests and verify GREEN**

Run:

```powershell
npx vitest run tests/interaction.test.tsx tests/conversationState.test.ts tests/linkedinExtension.test.ts tests/cloudAi.test.ts tests/secureVault.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```powershell
git add src/components/ChatHelpApp.tsx src/app/globals.css tests/interaction.test.tsx
git commit -m "feat: add transparent inbox workflow controls"
```

### Task 5: Full verification, GitHub push, and testing-only deployment

**Files:**
- Modify only if verification reveals an in-scope regression.

**Interfaces:**
- Consumes all previous tasks.
- Produces a pushed focused branch and verified testing deployment.

- [ ] **Step 1: Read the installed Next.js 16 documentation relevant to App Router client components before final component edits**

Read the client-component and accessibility/rendering guidance under `node_modules/next/dist/docs/` selected by filename/content search. Apply only guidance relevant to the files changed.

- [ ] **Step 2: Run complete local verification**

Run:

```powershell
npx vitest run
npx eslint .
npx next build
$env:CHATHELP_NATIVE_BUILD='1'; node node_modules/next/dist/bin/next build
node scripts/inject-static-csp.mjs
node scripts/verify-static-csp.mjs
node scripts/verify-extension.mjs
npx wrangler@4 deploy --dry-run --outdir .wrangler-dry-run
```

Expected: every command exits 0; report warnings separately.

- [ ] **Step 3: Review the complete diff against the approved design**

Check:

```powershell
git diff --check
git status --short
git diff codex/linkedin-auto-sync-workspace...HEAD -- src tests extension cloudflare wrangler.jsonc
```

Confirm no extension permission, sending, LinkedIn network, production Worker name, or secret-handling change was introduced.

- [ ] **Step 4: Commit any verification-only fixes and push the branch**

```powershell
git push -u origin codex/leaddelta-aligned-inbox
```

- [ ] **Step 5: Verify GitHub CI for the pushed branch**

Use `gh run list`, `gh run view`, and `gh run watch` for the matching commit. Do not deploy if CI fails.

- [ ] **Step 6: Read the Cloudflare and Wrangler skills, then verify account routing**

Run `wrangler whoami` and confirm account ID `8c9e063cdf6a3f83f474a7535845cbb2`. Do not inspect or expose tokens. Stop if the account differs.

- [ ] **Step 7: Deploy only the testing environment**

Use the repository's established testing deployment configuration or alias workflow. The final URL must be:

```text
https://testing-chathelp-private-cloud.project-mission-ai.workers.dev
```

Do not run a command that targets `chathelp-private-cloud` production without the testing alias/environment. Do not create another Worker.

- [ ] **Step 8: Verify the deployed testing build**

Check `/health`, load the testing application, and verify state controls/context disclosures without entering or inspecting credentials. Confirm production was not changed.

- [ ] **Step 9: Record release evidence**

Report branch, commit, CI URL, testing deployment URL, verification commands, test counts, warnings, and any user-assisted browser checks still required.
