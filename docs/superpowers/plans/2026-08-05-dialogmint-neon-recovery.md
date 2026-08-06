# DialogMint Neon Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebrand customer-facing ChatHelp surfaces as DialogMint and preserve up to 90 days of end-to-end encrypted conversation history in environment-isolated Neon PostgreSQL snapshots authorized by Cloudflare Access.

**Architecture:** IndexedDB remains the immediate encrypted cache, while one browser-encrypted workspace snapshot per validated Access subject becomes authoritative recovery state in Neon. The existing Worker validates Access, uses exact-host-selected Hyperdrive bindings, performs optimistic revision writes, and runs daily expired-row cleanup; it never receives the recovery key or readable conversation data.

**Tech Stack:** Next.js 16.2.12, React 19, TypeScript, Web Crypto AES-256-GCM/SHA-256, IndexedDB CryptoKey storage, Cloudflare Workers and Access, Hyperdrive, Neon PostgreSQL, `jose`, `pg`, Vitest, Testing Library, Wrangler 4.

## Global Constraints

- Preserve the existing GitHub repository, package, Worker, workers.dev hostnames, extension installation, IndexedDB name, and `CHATHELP_*` bridge identifiers until a separately approved internal migration.
- Change all customer-visible branding to `DialogMint`; reserve `DialogMint.com` for the later user-approved custom-domain step.
- Preserve visible-central-thread-only LinkedIn DOM capture, optional host permission, no cookies permission, no LinkedIn network calls, no inbox crawl, and no click/type/scroll/paste/send automation.
- Never upload or log recovery keys, Access assertions, cookies, OTP/MFA values, database credentials, screenshots, access codes, or readable workspace data.
- Use Cloudflare Access for `/api/drafts` and `/api/vault`; remove the separate draft access-code UI and request header only after fail-closed Access tests pass.
- Store one opaque encrypted snapshot per account. Do not create server-readable contact or message rows.
- Exclude all dated cloud conversation material older than 90 days and delete inactive database rows after 90 days.
- Never show `All N conversations backed up · M messages` until Neon confirms the exact current logical digest and revision.
- Testing and existing private production remain in Cloudflare account `8c9e063cdf6a3f83f474a7535845cbb2`; do not create resources in the netcore account.
- The user personally enters Neon and Cloudflare configuration credentials through trusted dashboards; implementation and tests use names and non-secret synthetic fixtures only.
- Deploy testing first, then promote the identical verified build to existing private production. Do not attach a custom domain in this plan.

---

### Task 1: Version the workspace for Access consent and Neon confirmation state

**Files:**
- Modify: `src/lib/workspaceTypes.ts`
- Modify: `src/lib/secureVault.ts`
- Modify: `src/lib/retention.ts`
- Test: `tests/secureVault.test.ts`
- Test: `tests/privacyLogic.test.ts`

**Interfaces:**
- Produces `WorkspaceData.version = 10`.
- Produces `CloudInferenceSettings = { consentedAt: string }`.
- Produces `CloudRecoverySettings = { enabled, revision, lastConfirmedDigest, lastConfirmedCiphertextDigest, lastConfirmedContacts, lastConfirmedMessages, lastSyncedAt }`.
- Retains encrypted `ContactDeletionTombstone[]` and the 90-day tombstone pruning added in version 9.

- [ ] **Step 1: Write failing migration tests**

Assert a version-9 workspace containing retired `accessToken`, `rememberAccessToken`, `locatorHash`, and `etag` values normalizes to version 10 without those fields. Assert `consentedAt` survives, recovery counters are bounded non-negative integers, and tombstones remain normalized.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
& $node node_modules\vitest\vitest.mjs run tests\secureVault.test.ts tests\privacyLogic.test.ts
```

Expected: failures show version 9 and retired credential/locator fields.

- [ ] **Step 3: Implement the version-10 migration**

Remove access-code persistence and initialize:

```ts
cloudRecovery: {
  enabled: false,
  revision: 0,
  lastConfirmedDigest: "",
  lastConfirmedCiphertextDigest: "",
  lastConfirmedContacts: 0,
  lastConfirmedMessages: 0,
  lastSyncedAt: "",
}
```

Normalize legacy workspaces without mutating contacts, playbooks, drafts, or extension metadata.

- [ ] **Step 4: Run focused tests and verify GREEN**

- [ ] **Step 5: Commit**

```powershell
git add src/lib/workspaceTypes.ts src/lib/secureVault.ts src/lib/retention.ts tests/secureVault.test.ts tests/privacyLogic.test.ts
git commit -m "feat: prepare workspace for Neon recovery"
```

### Task 2: Generate recovery files and encrypt 90-day cloud-safe snapshots

**Files:**
- Create: `src/lib/cloudRecovery.ts`
- Modify: `src/lib/secureVault.ts`
- Test: `tests/cloudRecovery.test.ts`

**Interfaces:**
- Produces `DialogMintRecoveryBundleV1`, `CloudVaultEnvelopeV1`, and `CloudBackupSummary`.
- Produces `createRecoveryBundle`, `serializeRecoveryBundle`, `parseRecoveryBundle`, `importRecoveryKey`, `createCloudSafeWorkspace`, `encryptCloudWorkspace`, `decryptCloudWorkspace`, and `summarizeCloudBackup`.
- Produces `saveCloudRecoveryKey`, `openCloudRecoveryKey`, and `removeCloudRecoveryKey` using a dedicated IndexedDB record containing a non-extractable `CryptoKey`.

- [ ] **Step 1: Write failing crypto and privacy tests**

Use clearly marked non-secret fixtures. Prove bundle parsing rejects extra/malformed fields; runtime generation creates distinct 32-byte values without printing them; the imported AES key is non-extractable; correct-key round trips succeed; wrong-key authentication fails safely; and the serialized envelope contains none of the fixture's unique names, messages, URLs, notes, rules, drafts, or consent state.

Assert `createCloudSafeWorkspace(workspace, environment, now)` removes backup metadata and all dated messages/documents/outcomes/drafts/feedback/usage older than exactly 90 days even when local retention is unlimited.

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
& $node node_modules\vitest\vitest.mjs run tests\cloudRecovery.test.ts
```

- [ ] **Step 3: Implement the browser-only crypto boundary**

Use `crypto.getRandomValues`, URL-safe base64 without padding, AES-256-GCM with a fresh 12-byte IV, and AAD `DialogMint cloud vault v1:<environment>:schema-10`. Never render, log, or send raw recovery material. Hash the exact normalized cloud-safe JSON for the logical digest and hash the serialized envelope for the ciphertext digest.

- [ ] **Step 4: Run focused tests and verify GREEN**

- [ ] **Step 5: Commit**

```powershell
git add src/lib/cloudRecovery.ts src/lib/secureVault.ts tests/cloudRecovery.test.ts
git commit -m "feat: encrypt DialogMint recovery snapshots"
```

### Task 3: Merge revisions without duplicate messages or contact resurrection

**Files:**
- Create: `src/lib/cloudWorkspaceMerge.ts`
- Test: `tests/cloudWorkspaceMerge.test.ts`

**Interfaces:**
- Produces `mergeCloudWorkspaces(local, remote): Promise<WorkspaceData>` so tombstone identity comparisons use SHA-256 rather than a weak synchronous hash.
- Produces `deleteContactEverywhere(workspace, contactId, now): Promise<WorkspaceData>`.

- [ ] **Step 1: Write failing merge and tombstone tests**

Prove profile URL precedence, conversation URL secondary matching, guarded unambiguous name fallback, stable message-ID/fingerprint deduplication, preservation of nonblank notes/labels/stages/reminders/outcomes/playbooks/feedback/draft history, and refusal to merge ambiguous identities. Prove a newer encrypted tombstone removes contacts from both sides and contains only the contact ID, identity hashes, and timestamp.

- [ ] **Step 2: Run the focused test and verify RED**

- [ ] **Step 3: Implement deterministic merge/deletion functions**

Reuse existing LinkedIn URL normalization and message fingerprint helpers. Apply tombstones before returning contacts and retain tombstones for the existing 90-day retention pass.

- [ ] **Step 4: Run focused tests and verify GREEN**

- [ ] **Step 5: Commit**

```powershell
git add src/lib/cloudWorkspaceMerge.ts tests/cloudWorkspaceMerge.test.ts
git commit -m "feat: merge encrypted DialogMint workspaces"
```

### Task 4: Validate Cloudflare Access and remove the draft access code

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `cloudflare/worker/src/accessAuth.js`
- Modify: `cloudflare/worker/src/index.js`
- Modify: `src/lib/privateAi.ts`
- Test: `tests/accessAuth.test.ts`
- Modify: `tests/cloudWorker.test.ts`
- Modify: `tests/cloudAi.test.ts`

**Interfaces:**
- Produces `authenticateAccessRequest(request, env, hostname, verifier?) -> { accountId, environment }`.
- Produces `resolveAccessEnvironment(hostname, env)` with exact testing/production hostname and audience selection.
- `generateWithCloud` requires consent but sends no bearer access code.

- [ ] **Step 1: Add failing Access boundary tests**

Use dependency-injected verification with non-secret synthetic assertions. Prove absent/malformed assertions fail, an unverified `Cf-Access-Authenticated-User-Email` header is never trusted, issuer/audience/expiry/subject constraints are passed to verification, testing and production audiences cannot cross, preview/unknown hosts fail, and the returned account ID is a deterministic 64-hex digest that does not contain email or subject text.

- [ ] **Step 2: Add failing draft-client tests**

Prove consent is still required, same-origin credentials remain enabled, no `Authorization` header is sent, Access HTML produces safe sign-in guidance, and the request contains only selected conversation/playbook/objective content.

- [ ] **Step 3: Run focused tests and verify RED**

- [ ] **Step 4: Install reviewed dependencies**

Add pinned-compatible `jose` and `pg` runtime dependencies plus `@types/pg` only if TypeScript requires it. Use the bundled package manager and review the lockfile; do not add a Neon browser/Data-API client.

- [ ] **Step 5: Implement Access validation and migrate `/api/drafts`**

Use `jose` remote JWK validation against configured `ACCESS_TEAM_DOMAIN`, select `ACCESS_AUD_TESTING` or `ACCESS_AUD_PRODUCTION` by exact hostname, verify issuer/audience/expiry/subject, derive `accountId = SHA-256(issuer + "\n" + audience + "\n" + subject)`, and rate-limit by the account digest. Do not return or log claims/assertions. Keep generic `401` responses and `no-store` headers.

- [ ] **Step 6: Run focused and existing draft tests and verify GREEN**

- [ ] **Step 7: Commit**

```powershell
git add package.json pnpm-lock.yaml cloudflare/worker/src/accessAuth.js cloudflare/worker/src/index.js src/lib/privateAi.ts tests/accessAuth.test.ts tests/cloudWorker.test.ts tests/cloudAi.test.ts
git commit -m "feat: authorize DialogMint with Cloudflare Access"
```

### Task 5: Add the Neon vault schema, Hyperdrive API, and 90-day cleanup

**Files:**
- Create: `cloudflare/neon/0001_dialogmint_vault.sql`
- Create: `cloudflare/worker/src/neonVault.js`
- Modify: `cloudflare/worker/src/index.js`
- Modify: `wrangler.jsonc`
- Create: `tests/neonVaultWorker.test.ts`
- Modify: `tests/cloudWorker.test.ts`
- Modify: `tests/nativeBoundary.test.ts`

**Interfaces:**
- Produces `handleVaultRequest(request, env, url, identity): Promise<Response | null>`.
- Produces `cleanupExpiredVaults(env): Promise<{ testing: number; production: number }>` for the scheduled handler.
- Consumes `env.NEON_TESTING.connectionString` and `env.NEON_PRODUCTION.connectionString` through Hyperdrive.

- [ ] **Step 1: Write failing schema and Worker tests**

Use an in-memory parameterized-query adapter. Prove the migration contains the exact table/check/index fields; exact hosts choose only one binding; preview hosts choose none; Access authentication occurs before query/body parsing; GET excludes expired rows; PUT validates format/schema/revision/digest/10-MiB bounds; create/update revisions are conditional; conflicts return 409; DELETE removes only the authenticated row; every SQL value is parameterized; and responses are same-origin/no-store.

Prove scheduled cleanup executes `DELETE ... WHERE expires_at <= now()` against both bindings, returns aggregate counts only, and continues the second environment when the first fails.

- [ ] **Step 2: Run focused Worker tests and verify RED**

- [ ] **Step 3: Implement the schema and Hyperdrive boundary**

Open and close a `pg.Client` inside each request/scheduled operation. Set `expires_at = now() + interval '90 days'` on every successful write. Add `nodejs_compat`, the daily UTC cron `0 3 * * *`, and observability metadata without placing connection strings in `wrangler.jsonc`.

Do not add Hyperdrive IDs until the user has created both configurations in the trusted Cloudflare dashboard. Keep their binding-name insertion as a release configuration step, not a source-code credential step.

- [ ] **Step 4: Route vault and scheduled requests**

Authenticate `/api/vault` before calling `handleVaultRequest`, leave assets unchanged, and export both `fetch` and `scheduled` handlers. Update `/health` to report `service: "dialogmint-cloud"`, `persistentStorage: "client-encrypted-neon"`, `retentionDays: 90`, and boolean binding readiness without database identifiers.

- [ ] **Step 5: Run focused and existing Worker tests and verify GREEN**

- [ ] **Step 6: Commit**

```powershell
git add cloudflare/neon/0001_dialogmint_vault.sql cloudflare/worker/src/neonVault.js cloudflare/worker/src/index.js wrangler.jsonc tests/neonVaultWorker.test.ts tests/cloudWorker.test.ts tests/nativeBoundary.test.ts
git commit -m "feat: store encrypted workspaces in Neon"
```

### Task 6: Add the browser client, confirmed-status calculation, and one-conflict retry

**Files:**
- Create: `src/lib/cloudRecoveryClient.ts`
- Create: `src/lib/cloudRecoverySync.ts`
- Test: `tests/cloudRecoveryClient.test.ts`
- Test: `tests/cloudRecoverySync.test.ts`

**Interfaces:**
- `readCloudVault(fetchImpl?) -> { envelope, revision } | null`.
- `writeCloudVault(envelope, expectedRevision, fetchImpl?) -> { revision, ciphertextDigest }`.
- `deleteCloudVault(fetchImpl?) -> void`.
- `synchronizeCloudWorkspace({ workspace, key, environment, fetchImpl }) -> { workspace, state }`.
- `CloudSyncState` includes `off | preparing | pending | encrypting | syncing | synced | restoring | needs-attention | expired | deleted`.

- [ ] **Step 1: Write failing transport tests**

Assert `/api/vault`, `credentials: "same-origin"`, no Authorization header, create revision 0, update revision N, no-store behavior, bounded JSON parsing, and safe mappings for Access HTML/401/404/409/413/5xx.

- [ ] **Step 2: Write failing synchronization tests**

Prove a matching logical digest and counts yields exact confirmed status; any local mutation yields pending immediately; success records returned revision/digests/counts/time; one 409 downloads/decrypts/merges/retries once; and a second 409 stops without looping or discarding local state.

- [ ] **Step 3: Run focused tests and verify RED**

- [ ] **Step 4: Implement transport and synchronization**

Use dependency-injected fetch, safe typed errors, and no response-body echo. Keep synchronization independent of LinkedIn snapshot acknowledgement and the existing local save.

- [ ] **Step 5: Run focused tests and verify GREEN**

- [ ] **Step 6: Commit**

```powershell
git add src/lib/cloudRecoveryClient.ts src/lib/cloudRecoverySync.ts tests/cloudRecoveryClient.test.ts tests/cloudRecoverySync.test.ts
git commit -m "feat: synchronize encrypted Neon snapshots"
```

### Task 7: Integrate encrypted restore, verified backup status, and deletion controls

**Files:**
- Modify: `src/components/ChatHelpApp.tsx`
- Modify: `src/app/globals.css`
- Modify: `tests/interaction.test.tsx`
- Create: `tests/startupRecovery.test.tsx`

**Interfaces:**
- Consumes Tasks 1–3 and 6.
- Preserves extension bridge handlers, local `saveVault`, draft generation, role selection, and manual-send controls.

- [ ] **Step 1: Write failing UI tests**

Prove an empty local workspace offers `Restore encrypted backup`; enabling backup requires a user gesture and recovery-file download before upload; pending state appears before confirmation; only matching confirmation shows `All 6 conversations backed up · 42 messages`; a new message immediately returns to pending; wrong recovery material changes nothing; successful restore opens conversations; contact deletion creates a tombstone; and entire-backup deletion leaves local data.

Prove Settings contains AI consent without an API-key field and explains OTP/MFA, AI consent, and backup status separately.

- [ ] **Step 2: Run focused UI tests and verify RED**

- [ ] **Step 3: Add narrow UI integration**

Add a compact Inbox status and Settings `Encrypted 90-day backup` card. Run cloud sync in a separate debounced effect after local persistence. Use file inputs only; never render recovery-file contents. Keep automatic drafting default-off and retain manual review/send.

- [ ] **Step 4: Add deletion/restore disclosures**

Use `Delete contact everywhere` only while backup is enabled, keep `Delete encrypted cloud backup` separate from `Erase all local data`, and state that conversations erased before their first confirmed backup cannot be restored.

- [ ] **Step 5: Run focused tests and verify GREEN**

- [ ] **Step 6: Commit**

```powershell
git add src/components/ChatHelpApp.tsx src/app/globals.css tests/interaction.test.tsx tests/startupRecovery.test.tsx
git commit -m "feat: show verified DialogMint backup status"
```

### Task 8: Apply DialogMint customer-facing branding without breaking internal bridges

**Files:**
- Modify: `src/app/layout.tsx`
- Modify: `src/components/ChatHelpApp.tsx`
- Modify: `src/components/LinkedInTestWizard.tsx`
- Modify: `src/components/PwaInstall.tsx`
- Modify: `src/components/ScreenRegionSelector.tsx`
- Modify: `public/manifest.webmanifest`
- Modify: `public/offline.html`
- Modify: `desktop/main.cjs`
- Modify: `electron-builder.yml`
- Modify: `extension/manifest.json`
- Modify: `extension/background.js`
- Modify: `extension/app-bridge.js`
- Modify: `extension/extractor.js`
- Modify: `extension/linkedin-sync.js`
- Modify: `extension/README.md`
- Modify: `scripts/verify-extension.mjs`
- Modify: relevant tests asserting visible copy/version
- Create: `tests/branding.test.ts`

**Interfaces:**
- Customer-visible brand is DialogMint.
- Existing workers.dev origins and `CHATHELP_*`, `chathelp-*`, `chathelp://`, IndexedDB, and extension storage identifiers remain unchanged.
- Extension version increments from `0.4.2` to `0.5.0`.

- [ ] **Step 1: Write failing branding/compatibility tests**

Assert page metadata, PWA/offline text, primary UI, extension manifest/status/errors, desktop product metadata, and user documentation say DialogMint. Assert exact production/testing Worker origins, extension protocol sources/events, IndexedDB name, Electron scheme, and stable script IDs remain unchanged.

- [ ] **Step 2: Run focused tests and verify RED**

- [ ] **Step 3: Replace customer-visible copy and increment the extension version**

Use `DialogMint`, `DialogMint Private Conversation Studio`, and `DialogMint LinkedIn Conversation Reader` consistently. Do not change the underlying component/function names solely for branding.

- [ ] **Step 4: Run branding, extension, interaction, and boundary tests and verify GREEN**

- [ ] **Step 5: Commit**

```powershell
git add src public desktop electron-builder.yml extension scripts tests
git commit -m "feat: rebrand the product as DialogMint"
```

### Task 9: Configure Neon and Hyperdrive through trusted dashboards

**Files:**
- Modify only after non-secret IDs exist: `wrangler.jsonc`

**Interfaces:**
- Produces bindings `NEON_TESTING` and `NEON_PRODUCTION` in Project Mission Cloudflare.
- Produces the migration table in two empty, isolated Neon databases.

- [ ] **Step 1: Verify Cloudflare routing account without viewing credentials**

Run `wrangler whoami` and require account `8c9e063cdf6a3f83f474a7535845cbb2`. Stop if it differs.

- [ ] **Step 2: Ask the user to create two isolated Neon projects/databases and least-privilege application roles**

The user performs this personally in Neon. Production must not be branched from or copied into testing. The user confirms completion without sharing connection strings, passwords, tokens, or screenshots containing them.

- [ ] **Step 3: Ask the user to create two Hyperdrive configurations in Cloudflare**

The user pastes each corresponding Neon connection string directly into Cloudflare's trusted interface and confirms the non-secret Hyperdrive configuration names/IDs are visible. Codex never requests or inspects the connection strings.

- [ ] **Step 4: Add only the non-secret binding IDs and Access configuration names**

Update `wrangler.jsonc` with `NEON_TESTING` and `NEON_PRODUCTION` binding IDs. Configure `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD_TESTING`, and `ACCESS_AUD_PRODUCTION` through trusted Cloudflare settings without copying assertion/cookie values.

- [ ] **Step 5: Apply the reviewed SQL migration independently**

The user runs `cloudflare/neon/0001_dialogmint_vault.sql` in each Neon SQL editor and confirms table/index existence with a schema-only query. Do not inspect data or credentials.

- [ ] **Step 6: Run Wrangler dry-run and commit non-secret binding configuration**

Require Workers AI, assets, rate limiter, `NEON_TESTING`, and `NEON_PRODUCTION`; require no R2, public database URL, or plaintext credential.

### Task 10: Full verification, GitHub publication, testing deployment, and production promotion

**Files:**
- No source changes unless verification begins a new RED/GREEN cycle.

- [ ] **Step 1: Run the complete local matrix**

Run full Vitest, ESLint, standard Next.js production build, native/static Cloudflare build, CSP injection, static CSP verification, extension-boundary verification, schema checks, and Wrangler dry-run. Require no new errors and document only pre-existing warnings.

- [ ] **Step 2: Push the focused branch and update draft PR #17**

Review `origin/main...HEAD`, push, and wait for every GitHub CI check. Do not merge until testing verification passes.

- [ ] **Step 3: Deploy only the stable testing preview alias**

Upload the verified version to alias `testing`. Confirm `/health` reports DialogMint, Access authorization, encrypted Neon storage, 90-day retention, and both model IDs without revealing configuration values.

- [ ] **Step 4: Run disposable live testing**

The user signs in personally. Use only synthetic conversations and browser-generated recovery material that Codex never reads. Verify confirmed counts, clear disposable browser storage, restore with the user-selected file, synchronize a new message without duplicates, trigger one revision conflict, and delete the disposable backup.

- [ ] **Step 5: Verify scheduled cleanup safely**

Insert only a disposable encrypted expired fixture through an approved test path, run the scheduled handler, confirm aggregate deletion, and verify the fixture is gone without selecting ciphertext or account identifiers.

- [ ] **Step 6: Synchronize the verified extension build**

Copy only the verified `extension` directory contents into `C:\Users\anshj\Documents\LinkedIn - ChatHelp\chathelp-work\extension`, preserving unrelated files, then instruct the user to reload version `0.5.0` at `chrome://extensions`.

- [ ] **Step 7: Promote the identical build to existing private production**

After testing passes, deploy the exact version to `chathelp-private-cloud` in Project Mission. Do not create another Worker, use the netcore account, or attach `DialogMint.com` yet.

- [ ] **Step 8: Final read-only verification**

Confirm testing and production health, Access-protected drafts, vault host isolation, CI success, extension boundaries, no plaintext storage, and a clean worktree. State clearly that pre-backup data erased earlier was not recoverable.
