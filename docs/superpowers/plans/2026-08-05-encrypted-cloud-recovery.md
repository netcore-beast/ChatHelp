# Encrypted Cloud Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve up to 90 days of ChatHelp conversation context in an end-to-end encrypted Cloudflare R2 snapshot that can be restored with a user-held recovery file, while showing a verified backed-up conversation/message count.

**Architecture:** Keep IndexedDB AES-GCM as the immediate local source of truth. Add a client-only recovery crypto/merge layer, a narrow same-origin R2 Worker API that can never decrypt the payload, and small ChatHelpApp integration points for setup, restore, background synchronization, deletion, and status. Use separate private testing and production R2 bindings selected only from exact hostnames.

**Tech Stack:** Next.js 16.2.12, React 19, TypeScript, Web Crypto AES-256-GCM/SHA-256, IndexedDB CryptoKey storage, Cloudflare Workers, private R2 bindings, Vitest, Testing Library, Wrangler 4.

## Global Constraints

- Preserve LinkedIn visible-thread capture, contact matching, message deduplication, extension permissions, role playbooks, draft generation, AI consent, and manual-send behavior.
- Never upload a recovery encryption key, draft access code, cookie, browser credential, screenshot, or extension session state.
- Store only ciphertext plus format, revision, timestamp, byte count, and sync-token verifier metadata in R2.
- Cloud snapshots contain no dated conversation material older than 90 days and expire after 90 days without a successful replacement upload.
- Never report “All conversations backed up” until the current cloud-safe workspace digest and counts match an R2-confirmed upload.
- Testing and existing private production remain in Cloudflare account `8c9e063cdf6a3f83f474a7535845cbb2`; do not create resources in the netcore account.
- Deploy the stable testing preview first. Promote the identical verified version to the existing private production deployment only after live testing passes.
- Do not expose, inspect, enter, or log any real recovery file, access code, authentication token, OTP, MFA value, cookie, or API key.
- Use `$node = 'C:\Users\anshj\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'` and `$pnpm = 'C:\Users\anshj\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'` for local commands.

---

### Task 1: Version the workspace for local recovery configuration and encrypted tombstones

**Files:**
- Modify: `src/lib/workspaceTypes.ts`
- Modify: `src/lib/secureVault.ts`
- Modify: `src/lib/retention.ts`
- Test: `tests/secureVault.test.ts`
- Test: `tests/privacyLogic.test.ts`

**Interfaces:**
- Produces `CloudRecoverySettings`, `ContactDeletionTombstone`, and `WorkspaceData.version = 9`.
- Produces `createCloudSafeWorkspace(workspace, now)` input fields for Task 2.

- [ ] **Step 1: Write failing schema migration tests**

Add literal expectations proving a version-8 workspace normalizes to:

```ts
cloudRecovery: {
  enabled: false,
  locatorHash: "",
  syncToken: "",
  etag: "",
  lastConfirmedDigest: "",
  lastConfirmedContacts: 0,
  lastConfirmedMessages: 0,
  lastSyncedAt: "",
},
deletionTombstones: [],
```

Add a retention test proving a 91-day tombstone is removed while a 30-day tombstone remains.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
& $node node_modules\vitest\vitest.mjs run tests\secureVault.test.ts tests\privacyLogic.test.ts
```

Expected: FAIL because version 9 recovery fields do not exist.

- [ ] **Step 3: Add the minimal version-9 types and normalization**

Add:

```ts
export interface CloudRecoverySettings {
  enabled: boolean;
  locatorHash: string;
  syncToken: string;
  etag: string;
  lastConfirmedDigest: string;
  lastConfirmedContacts: number;
  lastConfirmedMessages: number;
  lastSyncedAt: string;
}

export interface ContactDeletionTombstone {
  contactId: string;
  identityHashes: string[];
  deletedAt: string;
}
```

Normalize bounded strings/counts, default missing values, bump workspace version to 9, and prune tombstones after 90 days in `applyRetention`.

- [ ] **Step 4: Run focused tests and verify GREEN**

- [ ] **Step 5: Commit**

```powershell
git add src/lib/workspaceTypes.ts src/lib/secureVault.ts src/lib/retention.ts tests/secureVault.test.ts tests/privacyLogic.test.ts
git commit -m "feat: add encrypted recovery workspace state"
```

### Task 2: Generate recovery files and encrypt cloud-safe snapshots

**Files:**
- Create: `src/lib/cloudRecovery.ts`
- Modify: `src/lib/secureVault.ts`
- Test: `tests/cloudRecovery.test.ts`

**Interfaces:**
- Produces `RecoveryBundleV1`, `CloudVaultEnvelopeV1`, `CloudBackupSummary`.
- Produces `createRecoveryBundle`, `serializeRecoveryBundle`, `parseRecoveryBundle`, `importRecoveryKey`, `createCloudSafeWorkspace`, `encryptCloudWorkspace`, `decryptCloudWorkspace`, and `summarizeCloudBackup`.
- Produces device-key record functions `saveCloudRecoveryKey`, `openCloudRecoveryKey`, and `removeCloudRecoveryKey`.

- [ ] **Step 1: Write failing crypto and privacy tests**

Tests must prove:

```ts
const bundle = await createRecoveryBundle();
expect(bundle.locator).toMatch(/^[A-Za-z0-9_-]{43}$/);
expect(bundle.encryptionKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
expect(bundle.syncToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
expect(new Set([bundle.locator, bundle.encryptionKey, bundle.syncToken]).size).toBe(3);
```

Use a workspace fixture containing a unique contact name, message, profile URL, rule, and draft access code. Assert none occurs in `JSON.stringify(envelope)`. Assert correct-key decryption restores the cloud-safe fixture and a different key rejects with the safe recovery error.

Assert the cloud-safe copy clears `cloudInference.accessToken`, `cloudRecovery.syncToken`, ETag/status metadata, and material older than 90 days.

- [ ] **Step 2: Run `tests/cloudRecovery.test.ts` and verify RED**

- [ ] **Step 3: Implement the minimal browser crypto boundary**

Use `crypto.getRandomValues`, URL-safe base64 without padding, AES-GCM with a new 12-byte IV per upload, and AAD:

```ts
new TextEncoder().encode(`ChatHelp cloud vault v1:${locatorHash}`)
```

`summarizeCloudBackup` returns a SHA-256 digest of the exact normalized cloud-safe JSON plus literal contact/message counts. Add separate IndexedDB records for the non-exportable cloud AES key; never store its raw bytes.

- [ ] **Step 4: Run focused tests and verify GREEN**

- [ ] **Step 5: Commit**

```powershell
git add src/lib/cloudRecovery.ts src/lib/secureVault.ts tests/cloudRecovery.test.ts
git commit -m "feat: encrypt cloud recovery snapshots"
```

### Task 3: Merge encrypted snapshots without duplicates or resurrection

**Files:**
- Create: `src/lib/cloudWorkspaceMerge.ts`
- Test: `tests/cloudWorkspaceMerge.test.ts`

**Interfaces:**
- Consumes normalized `WorkspaceData` from Task 1.
- Produces `mergeCloudWorkspaces(local, remote): WorkspaceData` and `deleteContactEverywhere(workspace, contactId, now): WorkspaceData`.

- [ ] **Step 1: Write failing merge tests**

Use hand-built fixtures to prove:

- profile URL wins over same-name conflicts;
- conversation URL is the secondary identity;
- ambiguous normalized names stay separate;
- stable message IDs and fallback fingerprints deduplicate;
- labels, notes, reminders, outcomes, playbooks, feedback, and draft history survive;
- a newer tombstone removes the matching contact from both sides;
- a second device cannot resurrect a deleted contact;
- tombstones contain only contact ID, hashed identity values, and timestamp.

- [ ] **Step 2: Run the focused test and verify RED**

- [ ] **Step 3: Implement deterministic merging**

Reuse exported LinkedIn normalization/fingerprint helpers where possible. Keep the current guarded identity precedence and merge nonblank metadata by latest synchronization/deletion evidence. Never automatically combine an ambiguous pair.

- [ ] **Step 4: Run focused tests and verify GREEN**

- [ ] **Step 5: Commit**

```powershell
git add src/lib/cloudWorkspaceMerge.ts tests/cloudWorkspaceMerge.test.ts
git commit -m "feat: merge recovered conversations safely"
```

### Task 4: Add the authenticated cloud-vault browser client and one-retry synchronizer

**Files:**
- Create: `src/lib/cloudRecoveryClient.ts`
- Create: `src/lib/cloudRecoverySync.ts`
- Test: `tests/cloudRecoveryClient.test.ts`
- Test: `tests/cloudRecoverySync.test.ts`

**Interfaces:**
- `readCloudVault(locatorHash, syncToken, fetchImpl?) -> { envelope, etag } | null`
- `writeCloudVault(locatorHash, syncToken, envelope, etag, fetchImpl?) -> { etag }`
- `deleteCloudVault(locatorHash, syncToken, fetchImpl?) -> void`
- `synchronizeCloudWorkspace({ workspace, key, fetchImpl }) -> { workspace, state }`
- `CloudSyncState` includes `off | preparing | pending | encrypting | syncing | synced | needs-attention | expired | deleted` and exact confirmed counts.

- [ ] **Step 1: Write failing transport tests**

Assert same-origin `/api/vault/<64-hex>` URLs, `X-ChatHelp-Vault-Token`, `If-None-Match` on create, `If-Match` on update, `credentials: "same-origin"`, `Cache-Control: no-store`, and safe mappings for 401/404/409/413/5xx.

- [ ] **Step 2: Write failing synchronization tests**

Prove a matching confirmed digest yields:

```ts
{ code: "synced", contactCount: 6, messageCount: 42 }
```

Prove any workspace mutation immediately yields `pending`, R2 success yields `synced`, one 409 downloads/merges/retries once, and a second 409 stops without looping.

- [ ] **Step 3: Run both files and verify RED**

- [ ] **Step 4: Implement transport and synchronizer**

Never put the sync token in a URL or error. Use dependency-injected `fetch` for real behavioral tests. Return safe typed errors without response bodies that could contain Access HTML.

- [ ] **Step 5: Run focused tests and verify GREEN**

- [ ] **Step 6: Commit**

```powershell
git add src/lib/cloudRecoveryClient.ts src/lib/cloudRecoverySync.ts tests/cloudRecoveryClient.test.ts tests/cloudRecoverySync.test.ts
git commit -m "feat: synchronize encrypted cloud workspaces"
```

### Task 5: Add private R2 vault endpoints without changing draft generation

**Files:**
- Create: `cloudflare/worker/src/vault.js`
- Modify: `cloudflare/worker/src/index.js`
- Modify: `wrangler.jsonc`
- Test: `tests/cloudVaultWorker.test.ts`
- Modify: `tests/cloudWorker.test.ts`
- Modify: `tests/nativeBoundary.test.ts`

**Interfaces:**
- `handleVaultRequest(request, env, url): Promise<Response | null>` handles only `/api/vault/<locatorHash>`.
- Consumes `env.VAULT_TESTING` and `env.VAULT_PRODUCTION` R2 bindings.
- Leaves `/api/drafts` request, authentication, rate limiting, model calls, and response unchanged.

- [ ] **Step 1: Write failing Worker boundary tests**

Build an in-memory R2 double with complete `head/get/put/delete` behavior, ETags, custom metadata, and conditional writes. Prove:

- exact testing host selects only `VAULT_TESTING`;
- exact private production host selects only `VAULT_PRODUCTION`;
- versioned preview and unknown hosts receive 404 for vault routes;
- create stores ciphertext and only the SHA-256 token verifier;
- reads/writes/deletes require the matching token;
- wrong tokens do not reveal object existence;
- `If-Match` conflicts return 409;
- oversized and malformed requests fail before R2 write;
- successful delete is immediately unreadable;
- responses are same-origin and `no-store`.

- [ ] **Step 2: Run Worker tests and verify RED**

- [ ] **Step 3: Implement the R2 handler and configuration**

Add private bindings:

```jsonc
"r2_buckets": [
  { "binding": "VAULT_TESTING", "bucket_name": "chathelp-vault-testing" },
  { "binding": "VAULT_PRODUCTION", "bucket_name": "chathelp-vault-production" }
]
```

Route vault requests before the draft-only path. Update `/health` to report `vaultRecovery: true`, `vaultEncryption: "client-aes-256-gcm"`, and `vaultRetentionDays: 90`; change `persistentStorage` from `false` to `"encrypted-r2"` without changing model metadata.

- [ ] **Step 4: Run Worker tests and verify GREEN**

- [ ] **Step 5: Run existing draft/auth tests unchanged**

- [ ] **Step 6: Commit**

```powershell
git add cloudflare/worker/src/vault.js cloudflare/worker/src/index.js wrangler.jsonc tests/cloudVaultWorker.test.ts tests/cloudWorker.test.ts tests/nativeBoundary.test.ts
git commit -m "feat: add encrypted R2 recovery boundary"
```

### Task 6: Integrate setup, restore, verified status, and deletion into the existing UI

**Files:**
- Modify: `src/components/ChatHelpApp.tsx`
- Modify: `src/app/globals.css`
- Test: `tests/interaction.test.tsx`
- Test: `tests/startupRecovery.test.tsx`

**Interfaces:**
- Consumes Tasks 1–4.
- Preserves existing `UnlockedWorkspace`, LinkedIn message handler, local `saveVault`, draft generation, and extension controls.

- [ ] **Step 1: Write failing UI tests**

Prove:

- an empty workspace offers `Restore from recovery file`;
- OTP/MFA and Draft-generation access-code copy does not claim backup;
- enabling recovery downloads a recovery file before the first upload;
- before upload confirmation the Inbox shows `Local changes waiting for backup`;
- after confirmed upload it shows `All 6 conversations backed up · 42 messages`;
- importing a new message immediately changes status to pending and the next confirmation updates counts;
- restore decrypts a fixture and opens its conversations;
- wrong recovery material leaves the current workspace unchanged;
- delete contact uses `Delete contact everywhere`, creates a tombstone, and never blocks extension acknowledgement;
- delete cloud backup leaves local data intact unless the user separately erases it.

- [ ] **Step 2: Run focused interaction tests and verify RED**

- [ ] **Step 3: Add the narrow UI integration**

Add a compact Inbox status line and a Settings card. Keep cloud synchronization in a debounced effect separate from the existing 500 ms local save. A local save remains successful even if cloud synchronization fails. Add recovery-file inputs with password-style paste fields and never render key contents back to the DOM.

- [ ] **Step 4: Update privacy and retention copy**

State that Cloudflare stores unreadable ciphertext for recovery, while OTP/MFA and the AI access code are not backup mechanisms. Keep the cookie, screenshot, extension, AI-consent, and manual-send disclosures intact.

- [ ] **Step 5: Run focused tests and verify GREEN**

- [ ] **Step 6: Commit**

```powershell
git add src/components/ChatHelpApp.tsx src/app/globals.css tests/interaction.test.tsx tests/startupRecovery.test.tsx
git commit -m "feat: show verified encrypted backup status"
```

### Task 7: Provision private testing/production buckets and validate lifecycle configuration

**Files:**
- No repository files change in this provisioning task.

**Interfaces:**
- Produces existing-account resources `chathelp-vault-testing` and `chathelp-vault-production`.
- Produces a 90-day lifecycle expiration rule for both private buckets.

- [ ] **Step 1: Verify the active Cloudflare account and Wrangler version**

Run `wrangler whoami` and require account ID `8c9e063cdf6a3f83f474a7535845cbb2`. Stop if it differs. Do not expose OAuth material.

- [ ] **Step 2: Inspect existing R2 buckets before mutation**

Run:

```powershell
$env:Path = (Split-Path $node) + ';' + $env:Path
& $pnpm dlx wrangler@4 r2 bucket list
```

Create only the missing exact bucket names; never delete or reuse an unrelated bucket.

- [ ] **Step 3: Create missing private buckets**

For each missing bucket run exactly:

```powershell
& $pnpm dlx wrangler@4 r2 bucket create chathelp-vault-testing
& $pnpm dlx wrangler@4 r2 bucket create chathelp-vault-production
```

Do not run either create command for a name already returned by Step 2. Do not enable `r2.dev` or a public custom domain.

- [ ] **Step 4: Configure and read back 90-day lifecycle rules**

First list each bucket. If the exact rule is missing, add it; never add a duplicate:

```powershell
& $pnpm dlx wrangler@4 r2 bucket lifecycle list chathelp-vault-testing
& $pnpm dlx wrangler@4 r2 bucket lifecycle add chathelp-vault-testing expire-cloud-vaults-90-days "" --expire-days 90 --force
& $pnpm dlx wrangler@4 r2 bucket lifecycle list chathelp-vault-production
& $pnpm dlx wrangler@4 r2 bucket lifecycle add chathelp-vault-production expire-cloud-vaults-90-days "" --expire-days 90 --force
```

Read back both lifecycle configurations and require the exact rule name with `Expiration: 90 days` before continuing.

- [ ] **Step 5: Run `wrangler versions upload --dry-run --keep-vars`**

Verify bindings list Workers AI, the existing draft rate limiter, assets, `VAULT_TESTING`, and `VAULT_PRODUCTION` only.

### Task 8: Full verification, GitHub publication, testing deployment, and private production promotion

**Files:**
- No source changes unless verification finds a reproducible defect; any defect begins a new RED/GREEN cycle.

- [ ] **Step 1: Run the full local verification matrix**

Run 118 existing tests plus all new tests, ESLint, standard Next.js production build, native/static Cloudflare build, CSP injection, static CSP verification, extension-boundary verification, and Wrangler dry-run.

- [ ] **Step 2: Push the focused branch and update draft PR #17**

Confirm only intended files changed. Push without merging `main`. Wait for every GitHub CI check.

- [ ] **Step 3: Upload only the stable testing preview alias**

Use `wrangler versions upload --preview-alias testing --keep-vars`. Confirm the testing health payload reports encrypted R2 recovery.

- [ ] **Step 4: Perform disposable live recovery checks**

Generate synthetic recovery material and synthetic conversation text locally. Verify create/read/update/conflict/delete against testing, inspect only ciphertext responses, verify no plaintext appears, and delete the disposable object. Never use real user recovery material or conversation content.

- [ ] **Step 5: Verify the testing UI**

Use a synthetic local workspace to verify pending and confirmed counts, restore after clearing disposable browser storage, deduplication after a new snapshot, and delete-everywhere behavior. The user personally manages any OTP/MFA/API/recovery values.

- [ ] **Step 6: Promote the exact tested version to existing private production**

Deploy only after Steps 1–5 pass. Confirm the production deployment version changes to the tested version and the production health payload matches testing. Do not create a public domain, another Worker, or any netcore-account resource.

- [ ] **Step 7: Final read-only verification**

Confirm both URLs return the expected app and health metadata, unauthenticated draft calls remain rejected, vault endpoints reject invalid tokens without revealing objects, CI is green, and the worktree is clean.
