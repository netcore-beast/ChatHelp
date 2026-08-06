# Encrypted Cloud Recovery for ChatHelp

Date: 2026-08-05
Status: Approved for implementation
Target: Existing ChatHelp testing preview first, then the existing private production Worker

## Objective

Allow a user to recover and continue a ChatHelp workspace after browser site data is cleared, the browser profile changes, or the hosted session is re-established. Cloudflare must retain only an end-to-end encrypted workspace snapshot for up to 90 days. The user-controlled recovery bundle must be required to decrypt or modify that snapshot.

This feature is additive. It must not change LinkedIn DOM capture, extension permissions, automatic conversation detection, identity matching, message deduplication, role playbooks, draft generation, AI consent, local vault encryption, or the manual-send boundary.

## Current gap

ChatHelp currently encrypts the workspace with a non-exportable AES-GCM device key stored in IndexedDB. That protects local data, but clearing site data removes both the encrypted workspace and its device key. The Worker has a shared draft access-code hash, not a stable per-user identity, so it cannot safely associate recoverable workspaces with customer accounts.

The cloud-recovery design therefore does not use the shared draft access code as a user identity. It uses an unguessable, user-held recovery bundle to locate and decrypt the snapshot, while the existing session-only ChatHelp Cloud access code authorizes same-origin vault requests. The access code is never added to the snapshot or recovery file and is never newly persisted by cloud recovery.

## Selected architecture

Use Cloudflare R2 through an in-process Worker binding. Store one opaque encrypted object per recovery bundle.

R2 is selected because:

- the workspace is an opaque encrypted document and does not need database queries;
- R2 reads, writes, metadata updates, and deletes are strongly consistent;
- conditional ETag writes support optimistic concurrency;
- bucket lifecycle rules provide a server-side 90-day expiration safety net;
- direct Worker bindings avoid Cloudflare REST credentials and external network calls;
- testing and private production data can be isolated in separate buckets while using the existing Worker.

D1 is rejected because its relational/query features do not help with ciphertext and would add schema, migration, and row-size complexity. Workers KV is rejected because eventual consistency could return stale workspaces or temporarily resurrect deleted data.

## Recovery bundle

ChatHelp generates the recovery bundle entirely in the browser with Web Crypto. It contains:

- `version`: recovery format version;
- `locator`: 32 random bytes encoded for transport;
- `encryptionKey`: 32 random AES-256 key bytes;

The recovery file is a small JSON document with a ChatHelp-specific file extension. The user downloads and stores it personally. ChatHelp may also accept pasting its encoded contents into a password-style recovery field.

The encryption key is never transmitted to Cloudflare. The locator is hashed before it becomes an R2 object key. Every vault request uses the existing session-only ChatHelp Cloud access code through the same bearer-authentication boundary as `/api/drafts`; cloud recovery does not create or persist another authentication secret.

If the recovery file is lost after all device data has been cleared, the cloud snapshot is intentionally unrecoverable. The setup flow must disclose this before enabling recovery.

## Cloud encryption envelope

Before upload, the browser:

1. normalizes the workspace using the existing migration and duplicate-repair code;
2. applies the existing retention rules locally;
3. creates a cloud-safe copy that excludes the draft access code, cloud sync credential, recovery configuration, and ephemeral extension/session state;
4. limits dated conversation material in the cloud copy to the most recent 90 days;
5. serializes the cloud-safe workspace with its revision, tombstones, and save timestamp;
6. encrypts the serialization with AES-256-GCM and a new 96-bit IV;
7. binds the ciphertext to `ChatHelp cloud vault v1:<hashed locator>` as authenticated additional data.

The uploaded JSON envelope contains only:

- format and schema versions;
- IV;
- ciphertext;
- client revision;
- encrypted-workspace byte count;
- save timestamp.

It must not contain contact names, profile URLs, messages, notes, labels, rules, draft history, recovery keys, access codes, cookies, or authentication/session data in plaintext.

## Worker API

Add a same-origin `/api/vault` boundary without changing `/api/drafts`.

### `GET /api/vault/:locatorHash`

- requires the existing ChatHelp Cloud access code as a bearer credential;
- retrieves the R2 object through the selected environment binding;
- returns the encrypted envelope and quoted ETag with `Cache-Control: no-store`;
- returns `404` for a missing or expired object without revealing whether a different locator exists.

### `PUT /api/vault/:locatorHash`

- requires the existing ChatHelp Cloud access code, JSON content type, bounded content length, and a valid envelope shape;
- limits the encrypted object to 10 MiB;
- creates only with `If-None-Match: *` or updates only with `If-Match: <etag>`;
- stores only minimal format metadata with the opaque ciphertext;
- returns the new ETag and revision;
- returns `409` on an ETag conflict so the client can merge instead of overwriting.

### `DELETE /api/vault/:locatorHash`

- requires the existing ChatHelp Cloud access code;
- deletes the R2 object through the binding;
- returns success only after the strongly consistent delete resolves;
- is used only by the explicit “Delete encrypted cloud backup” control.

All vault responses use `no-store`, same-origin checks, bounded parsing, generic errors, and no request-body logging. The Worker never decrypts a vault.

## Environment isolation

Bind two private R2 buckets to the existing Worker:

- `chathelp-vault-testing` for the stable `testing-...workers.dev` alias;
- `chathelp-vault-production` for the existing private production hostname.

The Worker selects the bucket only from an exact allowlist of trusted hostnames. Versioned preview hostnames and unknown hosts cannot use `/api/vault`. Both buckets remain private and have no public R2 domain.

Each bucket receives a lifecycle rule that expires cloud-vault objects 90 days after the most recent upload. Regular synchronization replaces the object and refreshes its lifecycle age. Independently, the client removes dated conversation material older than 90 days before every upload, so continuing use does not preserve old messages indefinitely.

No test, preview, or project storage is created in the `netcore.beast@gmail.com` account. The testing and existing private production resources remain in the verified Project Mission account. A future public-domain production migration remains separate.

## Local setup and restore flow

### Enable recovery

1. The user selects “Enable encrypted 90-day recovery” in Settings.
2. ChatHelp generates the recovery bundle locally.
3. The user downloads the recovery file and confirms that losing it makes restoration impossible.
4. ChatHelp encrypts and conditionally creates the first cloud snapshot.
5. Only after R2 confirms the write does the UI show recovery as enabled.
6. The raw recovery bundle is not stored as plaintext. The active device stores the imported encryption key as a non-exportable IndexedDB CryptoKey and the non-secret locator hash inside the existing encrypted local device vault. The Cloud access code remains session-only unless the user separately chooses the existing remember-code option.

### Normal startup

- If a local device vault and recovery configuration exist, ChatHelp opens the local vault immediately.
- It then retrieves the encrypted cloud snapshot, decrypts it locally, merges it with local state, applies retention, and saves the merged state locally.
- Cloud failure does not block the local app; the status shows the error and a retry action.

### Browser data cleared or new device

- ChatHelp starts with an empty local vault and offers “Restore from recovery file.”
- The user selects or pastes the recovery bundle.
- The user enters the existing ChatHelp Cloud access code through the trusted application field and selects the recovery file.
- ChatHelp derives the locator hash, authenticates the request with that session-only access code, downloads ciphertext, and decrypts locally.
- On success it creates a new device-bound local vault, imports non-exportable CryptoKeys for future automatic sync, and displays the restored conversations.
- Wrong keys, corrupted files, expired objects, and deleted objects produce distinct safe guidance without exposing stored metadata.

## Synchronization and conflict handling

Cloud synchronization runs after the existing local save and is debounced separately so it never blocks LinkedIn snapshot acknowledgement.

- The local encrypted vault remains the immediate source for UI state.
- Every successful cloud read records the ETag and encrypted revision locally.
- A cloud write uses the last ETag.
- If the ETag changed, ChatHelp downloads and decrypts the newest object, deterministically merges it with the local workspace, saves the merged local vault, and retries one conditional upload.
- A second conflict stops automatic retry and shows “Cloud changes need another sync” to prevent loops.
- Failed uploads remain locally safe and retry only after another user change or explicit Retry.

Workspace merging reuses existing identity and message rules:

- normalized LinkedIn profile URL first;
- conversation URL second;
- guarded normalized-name fallback only when unambiguous;
- message DOM ID first and existing fingerprint fallback;
- union of labels, notes, reminders, outcomes, feedback, draft history, and role playbooks without replacing newer explicit local edits with blank fields;
- no automatic merge of ambiguous contacts.

## Deletion and tombstones

Deleting a contact must delete it locally and from the next encrypted cloud snapshot.

To stop concurrent or temporarily offline devices from restoring it, the encrypted workspace keeps a tombstone containing the contact ID, stable identity hashes when available, and deletion timestamp. Tombstones contain no plaintext contact identity and remain encrypted. Merge logic applies tombstones before contacts and removes tombstones after 90 days.

The delete UI changes from “Delete local contact” to “Delete contact everywhere” when recovery is enabled. The confirmation explains that the deletion affects this device and the encrypted cloud backup. If the cloud update fails, ChatHelp retains the encrypted tombstone locally and shows that cloud deletion is pending.

“Delete encrypted cloud backup” deletes the entire R2 object but does not silently erase the current local vault. “Erase all local data” remains separate and cannot delete the cloud copy unless the user explicitly selects both actions.

## Settings and disclosure

Add a compact “Encrypted cloud recovery” section with:

- recovery status: Off, Preparing, Protected, Syncing, Synced, Retry needed, Expired, or Deleted;
- `Cloud access code required` when a recovery configuration exists but the session has no authorization code;
- a compact Inbox status that says `All <count> conversations backed up` only when the digest and conversation/message counts of the current cloud-safe workspace match the last R2-confirmed upload;
- `Backing up <count> conversations`, `Local changes waiting for backup`, or `Cloud backup needs attention` when the current workspace is not fully confirmed;
- “Enable encrypted 90-day recovery”;
- “Download recovery file again” only while the active device can export the in-memory recovery material during the setup session; otherwise instruct the user to use the originally saved file;
- “Restore from recovery file”;
- last successful cloud synchronization time;
- Retry;
- “Delete encrypted cloud backup.”

The confirmed backup status is computed locally and stored only inside the encrypted device vault. It contains the last successfully uploaded cloud-safe workspace digest, contact count, message count, ETag, and timestamp. Counts are never stored in R2 plaintext metadata. OTP/MFA website authentication and the Draft-generation consent access code must be described separately: neither is a recovery key and neither proves that conversations are backed up.

The disclosure states:

> ChatHelp stores an AES-256-GCM encrypted workspace snapshot in private Cloudflare R2 for recovery. Cloudflare does not receive the encryption key and cannot read the stored conversations. The cloud copy contains up to 90 days of conversation context and expires after 90 days without a successful update. Keep the recovery file safe; without it, restoration is impossible.

The existing privacy dialog and contact retention summary are updated precisely. They must continue to say that LinkedIn cookies, browser credentials, access codes, screenshots, and extension session data are never uploaded.

## Failure handling

- Local IndexedDB failure: preserve the current secure-storage recovery screen.
- R2 unavailable: continue locally, show Retry needed, and never discard local changes.
- Wrong recovery file or AES authentication failure: do not modify local or cloud data.
- Cloud access-code verification failure: return a generic authorization error and do not reveal object existence.
- ETag conflict: merge once, retry once, then stop to avoid feedback loops.
- Oversized cloud snapshot: preserve local data, stop upload, and explain which imported documents or old context must be removed.
- Expired cloud object: explain that the 90-day cloud recovery window elapsed; do not erase an existing local vault.
- Explicit deletion failure: keep the local encrypted tombstone and surface pending deletion until a later retry succeeds.

## Security and privacy invariants

- No raw recovery encryption key is transmitted, logged, stored in R2 metadata, embedded in URLs, or committed.
- Cloud recovery creates no additional authentication secret and never stores the ChatHelp Cloud access code in R2 or the recovery file.
- No R2 bucket is public and no S3/API credential is introduced.
- Worker access uses an R2 binding, not Cloudflare REST or S3 network requests.
- Vault requests are same-origin, TLS-only, bounded, and `no-store`.
- Cloud snapshots exclude ChatHelp draft access codes and all browser/platform authentication data.
- The Chrome extension continues to retain no conversation content and makes no network request containing it.
- Cloud recovery does not grant AI consent. AI receives content only under the existing generation consent rules.
- Cloud recovery never types, clicks, scrolls, opens, or sends on LinkedIn.

## Automated verification

Add tests proving:

1. recovery bundle generation uses cryptographic randomness;
2. a cloud envelope decrypts only with the correct recovery key;
3. ciphertext and metadata do not reveal messages, names, URLs, notes, playbooks, access codes, or recovery material;
4. the draft access token and ephemeral extension state are excluded;
5. browser-data loss can be restored from a recovery file;
6. a wrong or corrupted recovery file cannot modify local state;
7. startup cloud failure leaves the local workspace usable;
8. new LinkedIn messages merge into the restored conversation without duplicates;
9. conditional ETags prevent silent overwrite;
10. one conflict merges and retries once without a loop;
11. ambiguous contacts are not merged;
12. contact deletion creates and applies encrypted tombstones;
13. tombstones prevent deleted contacts from reappearing on another device;
14. deleting the cloud backup removes the object and leaves local data unless separately requested;
15. conversation material older than 90 days is excluded from cloud snapshots;
16. R2 testing and production bindings are selected only for exact allowed hosts;
17. preview and unknown hosts cannot access vault storage;
18. vault endpoints reject cross-origin, malformed, oversized, unauthenticated, and stale writes using the existing constant-time access-code verification;
19. `/api/drafts`, Cloudflare model behavior, authentication, and rate limiting remain unchanged;
20. extension permission, cookie, network, inbox-scan, and send boundaries remain unchanged;
21. the full Vitest, lint, Next.js, Cloudflare static/native, CSP, extension-boundary, and Wrangler dry-run checks pass.
22. the UI never shows “All conversations backed up” before R2 confirms the matching encrypted snapshot;
23. changing or importing a conversation immediately changes the status to pending and a successful conditional upload changes it to the exact backed-up contact/message counts;

## Release plan

1. Implement on a focused branch based on the current rulebook branch so all already-tested changes remain included.
2. Create and bind private testing and production R2 buckets in the Project Mission account without exposing credentials.
3. Configure 90-day lifecycle deletion on both buckets.
4. Apply the Worker and UI changes with test-driven development.
5. Run all local verification and GitHub CI.
6. Upload the verified version only to the stable testing preview alias.
7. Verify live health, vault endpoint boundaries, encrypted create/read/update/delete using disposable generated test material, restoration, conflict handling, and absence of plaintext.
8. Promote the same verified Worker version to the existing private production deployment only after testing passes.
9. Verify production health and authentication without inspecting user secrets or real conversation content.
10. Keep the public-domain deployment and any `netcore.beast@gmail.com` Cloudflare resources out of scope.
