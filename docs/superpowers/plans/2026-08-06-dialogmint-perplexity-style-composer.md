# DialogMint Perplexity-Style Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stacked objective/generate layout with an approved Perplexity-style integrated composer while preserving DialogMint's behavior and real streamed AI progress.

**Architecture:** `ChatHelpApp.tsx` will only regroup the existing objective textarea, status caption, and generate button inside a shared prompt-composer surface. `globals.css` will provide the denser desktop and 320px layouts using existing design tokens and CSS transitions. Existing `DraftProgressPanel`, SSE parsing, `/api/drafts` payload, model pipeline, persistence, and error handling remain unchanged.

**Tech Stack:** React 19, TypeScript, Next.js 16, CSS, Vitest, Testing Library, Cloudflare Workers.

## Global Constraints

- Keep existing DialogMint colors, fonts, type scale, radii, borders, and design tokens.
- Do not add an animation dependency; use the existing CSS transition and spinner.
- Keep the `/api/drafts` request payload and Worker pipeline unchanged.
- Keep the button's idle label exactly `Generate 3 Drafts`.
- Keep the textarea labeled, resizable, and usable down to a 320px viewport.
- Keep AI steps collapsed by default, keyboard accessible, and driven by real streamed stages.
- Do not change encrypted backup, LinkedIn synchronization, or the manual-send boundary.
- Prepare and deploy only to the existing testing environment unless production is separately authorized.

---

## File map

- Modify `src/components/ChatHelpApp.tsx`: group the existing objective textarea and generation controls inside the integrated composer surface.
- Modify `src/app/globals.css`: compact spacing, style the prompt surface/action rail, and add the 320px fallback.
- Modify `tests/interaction.test.tsx`: verify semantic containment, loading stability, and retained AI-step behavior.
- Modify `tests/workspaceLayout.test.ts`: verify the responsive CSS hooks and static button copy remain present.
- Create `design-qa.md`: record the same-state visual comparison and final pass/block status.

### Task 1: Lock the integrated composer contract with failing tests

**Files:**
- Modify: `tests/interaction.test.tsx:280-313`
- Modify: `tests/workspaceLayout.test.ts`

**Interfaces:**
- Consumes: existing accessible textarea name `What should your reply accomplish?`, button names `Generate 3 Drafts` and `Generating Drafts`, and AI-step toggle names.
- Produces: DOM contract `.prompt-composer` containing `.objective-field` and `.prompt-composer-actions`; static CSS contract for the compact mobile rule.

- [ ] **Step 1: Add a failing semantic-containment assertion**

Add this assertion before clicking Generate in the existing live-progress interaction test:

```tsx
const objective = screen.getByRole("textbox", { name: "What should your reply accomplish?" });
const promptComposer = objective.closest(".prompt-composer");
expect(promptComposer).toBeTruthy();
expect(within(promptComposer as HTMLElement).getByRole("button", { name: "Generate 3 Drafts" })).toBeTruthy();
expect(promptComposer?.querySelector(".prompt-composer-actions")).toBeTruthy();
```

- [ ] **Step 2: Add a failing static responsive-contract assertion**

Extend `tests/workspaceLayout.test.ts` with:

```ts
expect(styles).toContain(".prompt-composer");
expect(styles).toContain(".prompt-composer-actions");
expect(styles).toContain("@media (max-width: 360px)");
expect(styles).toMatch(/\.prompt-composer-actions\s+\.draft-generate-button\s*\{[^}]*width:\s*100%/s);
```

- [ ] **Step 3: Run the focused tests and confirm failure**

Run:

```powershell
& 'C:\Users\anshj\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd' exec vitest run tests/interaction.test.tsx tests/workspaceLayout.test.ts
```

Expected: FAIL because `.prompt-composer` and `.prompt-composer-actions` do not exist.

- [ ] **Step 4: Commit the failing tests**

```powershell
git add tests/interaction.test.tsx tests/workspaceLayout.test.ts
git commit -m "test: specify integrated draft composer"
```

### Task 2: Integrate the objective and generate action without changing behavior

**Files:**
- Modify: `src/components/ChatHelpApp.tsx:1358-1363`
- Test: `tests/interaction.test.tsx`

**Interfaces:**
- Consumes: existing `agenda`, `agendaRef`, `generate`, `isGenerating`, `conversationReady`, `cloudReady`, `aiStatus`, and `draftError` state.
- Produces: `.prompt-composer` and `.prompt-composer-actions` wrappers; no new state, props, hooks, or request fields.

- [ ] **Step 1: Regroup the existing controls inside the prompt surface**

Replace the standalone objective label and generate row with this structure, preserving the existing expressions verbatim:

```tsx
<label className="objective-field">
  <span>What should your reply accomplish? <span className="field-optional">Optional</span> {/* existing info tooltip */}</span>
  <div className="prompt-composer">
    <textarea
      aria-label="What should your reply accomplish?"
      ref={agendaRef}
      maxLength={5_000}
      value={agenda}
      onChange={(event) => setAgenda(event.target.value.slice(0, 5_000))}
      placeholder="Optional objective for this reply"
    />
    <div className="prompt-composer-actions">
      {aiStatus && <span className="status" aria-live="polite">{aiStatus}</span>}
      <button
        className={`primary draft-generate-button${isGenerating ? " is-loading" : ""}`}
        disabled={!conversationReady || !cloudReady || isGenerating || Boolean(aiStatus && !aiStatus.includes("Generated") && !aiStatus.includes("processed locally"))}
        aria-busy={isGenerating}
        onClick={() => void generate()}
      >
        {isGenerating && <span className="draft-button-spinner" aria-hidden="true" />}
        <span>{isGenerating ? "Generating Drafts" : "Generate 3 Drafts"}</span>
      </button>
    </div>
  </div>
</label>
```

Keep the existing Cloudflare-consent notice, missing-conversation notice, `DraftProgressPanel`, and draft error immediately outside this surface.

- [ ] **Step 2: Run the focused interaction test**

Run:

```powershell
& 'C:\Users\anshj\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd' exec vitest run tests/interaction.test.tsx
```

Expected: the new containment assertion still fails until CSS hooks are added, while existing loading and SSE assertions remain behaviorally unchanged.

- [ ] **Step 3: Commit the markup change**

```powershell
git add src/components/ChatHelpApp.tsx
git commit -m "refactor: integrate draft composer action"
```

### Task 3: Apply the compact Perplexity-style spacing and responsive layout

**Files:**
- Modify: `src/app/globals.css:633-690`
- Test: `tests/interaction.test.tsx`
- Test: `tests/workspaceLayout.test.ts`

**Interfaces:**
- Consumes: `.prompt-composer`, `.prompt-composer-actions`, `.objective-field`, `.draft-generate-button`, `.draft-progress-panel`.
- Produces: a contained prompt surface, stable lower-right action rail, compact disclosure row, and full-width mobile action at 360px and below.

- [ ] **Step 1: Add the integrated composer rules using current tokens**

Add or replace the composer-specific declarations with the following shape, retaining current token-backed colors and existing radius values:

```css
.composer-card { gap: .28rem; padding: .42rem; }
.draft-playbook-control { gap: .4rem; }
.objective-field { gap: .14rem; }
.prompt-composer { overflow: hidden; border: 1px solid var(--line); border-radius: 9px; background: #fff; }
.prompt-composer textarea { width: 100%; min-height: 34px; padding: .38rem .5rem .2rem; border: 0; border-radius: 0; box-shadow: none; resize: vertical; }
.prompt-composer textarea:focus { outline: 0; box-shadow: none; }
.prompt-composer:focus-within { outline: 3px solid rgba(20, 92, 62, .34); outline-offset: 1px; }
.prompt-composer-actions { min-width: 0; display: flex; align-items: center; justify-content: flex-end; gap: .4rem; padding: .18rem .28rem .28rem; }
.prompt-composer-actions .status { min-width: 0; flex: 1; padding: .28rem .4rem; }
.prompt-composer-actions .draft-generate-button { flex: 0 0 auto; }
```

The focus outline reuses the repository's existing `:focus-visible` color exactly; it does not introduce a new color value.

- [ ] **Step 2: Tighten supporting rows without changing their visual tokens**

Reduce only the existing padding/gap values for `.composer-heading`, `.draft-role-select`, `.active-playbook-summary`, `.draft-context-inspector summary`, `.draft-progress-toggle`, and expanded progress content. Preserve their colors, type sizes, borders, radii, and shadows.

- [ ] **Step 3: Add the 320px-safe mobile action rule**

```css
@media (max-width: 360px) {
  .composer-card { padding: .36rem; }
  .draft-playbook-control { grid-template-columns: minmax(0, 1fr); }
  .composer-heading { align-items: flex-start; }
  .composer-heading > span { max-width: 9rem; text-align: right; }
  .prompt-composer-actions { flex-wrap: wrap; }
  .prompt-composer-actions .status { flex-basis: 100%; }
  .prompt-composer-actions .draft-generate-button { width: 100%; }
}
```

- [ ] **Step 4: Run focused tests and confirm they pass**

Run:

```powershell
& 'C:\Users\anshj\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd' exec vitest run tests/interaction.test.tsx tests/workspaceLayout.test.ts
```

Expected: PASS, including containment, loading reset, streamed stages, keyboard disclosure, and responsive CSS contracts.

- [ ] **Step 5: Commit the compact layout**

```powershell
git add src/app/globals.css tests/interaction.test.tsx tests/workspaceLayout.test.ts
git commit -m "style: compact integrated draft composer"
```

### Task 4: Full verification and visual design QA

**Files:**
- Create: `design-qa.md`
- Verify: all modified files and existing build/deployment boundaries

**Interfaces:**
- Consumes: the completed composer implementation and the three supplied reference screenshots.
- Produces: evidence that automated behavior and visual fidelity pass before testing deployment.

- [ ] **Step 1: Run the complete automated suite**

```powershell
& 'C:\Users\anshj\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd' test
& 'C:\Users\anshj\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd' lint
```

Expected: all Vitest files pass; ESLint has zero errors, with only documented pre-existing warnings allowed.

- [ ] **Step 2: Run the production and Cloudflare verification builds**

```powershell
& 'C:\Users\anshj\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd' build
$env:CHATHELP_NATIVE_BUILD='1'
& 'C:\Users\anshj\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' node_modules/next/dist/bin/next build
& 'C:\Users\anshj\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' scripts/inject-static-csp.mjs
& 'C:\Users\anshj\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd' verify:static-csp
& 'C:\Users\anshj\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd' verify:extension
```

Expected: both builds, CSP injection/verification, and extension boundary pass.

- [ ] **Step 3: Capture and compare the component at desktop and 320px**

Use the user-approved local browser surface only. Capture the idle, loading, and expanded AI-step states at the same viewport as the DialogMint reference, then capture the 320px state. Compare the implementation and references side by side for spacing, button containment, textarea height, chevron direction, clipping, focus, and layout shift.

- [ ] **Step 4: Record the design QA result**

Create `design-qa.md` with this completed structure:

```markdown
# DialogMint compact composer design QA

- Source: supplied DialogMint and Perplexity screenshots
- States checked: idle, loading, AI steps expanded, 320px
- P0/P1/P2 findings: none
- P3 follow-ups: none
- final result: passed
```

If any P0/P1/P2 issue exists, document it, fix it, recapture, and update the report only after it is resolved. If local visual capture is unavailable, set `final result: blocked` and do not claim visual verification.

- [ ] **Step 5: Commit verification evidence**

```powershell
git add design-qa.md
git commit -m "test: verify compact draft composer design"
```

### Task 5: Publish to the testing preview only

**Files:**
- Verify: `wrangler.jsonc`

**Interfaces:**
- Consumes: fully verified branch and existing Project Mission Cloudflare bindings.
- Produces: a new testing preview version without changing production traffic.

- [ ] **Step 1: Verify Cloudflare account and dry-run bindings**

Confirm the active account is `project.mission.ai@gmail.com`, account ID `8c9e063cdf6a3f83f474a7535845cbb2`, then run the existing Wrangler dry run. Do not inspect secret values.

- [ ] **Step 2: Upload a testing preview version**

Use the repository's existing testing-only Wrangler version upload with `--preview-alias testing --keep-vars`. Do not run a production deployment command.

- [ ] **Step 3: Verify the testing alias boundary**

Confirm `https://testing-chathelp-private-cloud.project-mission-ai.workers.dev` resolves to the new version and remains protected by Cloudflare Access. Confirm production traffic is unchanged.
