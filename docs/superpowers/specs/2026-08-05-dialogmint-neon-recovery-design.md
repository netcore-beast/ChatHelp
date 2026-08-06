# DialogMint Neon Recovery and Branding

Date: 2026-08-05
Status: Approved architecture; pending written-spec review
Target: Existing Project Mission testing deployment first, then the existing private production Worker
Supersedes: `2026-08-05-encrypted-cloud-recovery-design.md` for the storage and authentication implementation

## Objective

Rebrand the customer-facing ChatHelp product as DialogMint and add an authoritative, end-to-end encrypted 90-day workspace history in Neon PostgreSQL. Clearing browser history or changing devices must no longer permanently blank an already-backed-up workspace. The application must visibly distinguish a locally saved workspace from a Neon-confirmed backup.

This work is additive. It must preserve visible-thread-only LinkedIn capture, automatic contact matching, message deduplication, extension least privilege, role playbooks, the three-stage two-model draft pipeline, explicit AI consent, encrypted local storage, and manual review/send.

Conversation data cleared before the first successful Neon backup cannot be recovered retroactively. The UI must say this accurately.

## Naming and compatibility

DialogMint replaces ChatHelp in customer-facing locations:

- application header, title, metadata, PWA manifest, accessible labels, disclosures, empty states, dialogs, and error copy;
- Chrome extension name, action title, popup/disclosure text, and user-visible status;
- documentation intended for customers and future public-domain links;
- recovery-file name and visible encrypted-envelope format label.

The following internal identifiers remain temporarily unchanged to avoid breaking installed extensions and current deployments:

- GitHub repository name;
- package name where changing it has no user-visible value;
- existing Cloudflare Worker name and workers.dev hostnames;
- extension ID and installed stable unpacked-extension folder;
- existing `CHATHELP_*` bridge events, storage keys, IndexedDB name, CSP scripts, and Worker environment-variable names.

The extension may advertise itself as DialogMint while continuing to speak the existing versioned internal protocol. `DialogMint.com` is not configured until the user has purchased the domain, added it to the authorized Cloudflare account, and explicitly approved the domain deployment.

## Selected storage architecture

Neon PostgreSQL is the authoritative recovery store. IndexedDB remains the fast, immediate, encrypted local cache.

Store one opaque encrypted workspace snapshot per authenticated account and environment. Do not normalize contacts or messages into server-readable rows. This keeps the database unable to read LinkedIn identities, messages, notes, playbooks, draft history, or outcomes and avoids metadata leakage from per-message records.

Use Cloudflare Hyperdrive for Worker-to-Neon connectivity. Configure two bindings:

- `NEON_TESTING` for the stable testing preview alias;
- `NEON_PRODUCTION` for the existing private production hostname and, later, the approved `DialogMint.com` production hostname.

Only exact trusted hostnames may select a binding. Versioned preview hostnames and unknown hosts must not access the vault API. Testing and production use separate Neon projects or independent databases with different least-privilege roles. Production data must never be cloned into testing.

The user enters Neon connection credentials personally through Neon and Cloudflare trusted interfaces. Credentials are never copied into prompts, source control, command lines, logs, screenshots, application storage, or chat.

## Database schema

The Worker owns a narrow `dialogmint_vault_snapshots` table:

```sql
CREATE TABLE dialogmint_vault_snapshots (
  account_id text PRIMARY KEY,
  format_version integer NOT NULL,
  schema_version integer NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  ciphertext jsonb NOT NULL,
  ciphertext_digest text NOT NULL,
  encrypted_bytes integer NOT NULL CHECK (encrypted_bytes > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX dialogmint_vault_snapshots_expiry_idx
  ON dialogmint_vault_snapshots (expires_at);
```

`account_id` is a SHA-256 digest of the validated Access issuer, application audience, and subject. Email is not used or stored. `ciphertext_digest` hashes the encrypted envelope, not readable workspace data. Conversation and message counts remain inside the local encrypted device vault and are not database columns.

Writes use an expected revision in a transaction. Create requires no existing row. Update succeeds only when the current revision matches; otherwise it returns a conflict so the browser can download, decrypt, merge once, and retry once. A second conflict stops to avoid loops.

## Authentication

Cloudflare Access authorizes both `/api/drafts` and `/api/vault`.

The Worker validates the Access JWT signature, issuer, environment-specific audience, expiry, and subject using the official Access public-key endpoint. It never trusts an unverified email header and never reads or modifies the browser's Cloudflare Access cookie. The browser sends same-origin requests with normal credentials; it does not inspect, copy, store, or expose Access tokens. Testing and production use distinct configured Access audience identifiers; unknown hosts have no valid audience and fail closed.

After successful validation, the Worker derives the opaque `account_id` from verified claims. It does not persist the JWT, email, OTP, MFA code, Access cookie, or identity-provider credentials.

The separate Draft-generation access-code field and bearer-code requirement are removed only after Access validation tests prove equivalent or stronger protection. AI consent remains a separate explicit checkbox and defaults to off. If Access validation is unavailable or misconfigured, both draft and vault APIs fail closed with a generic authentication message.

## Browser encryption and recovery

The browser creates a recovery file only after an explicit user action. It contains:

- recovery format version;
- an AES-256-GCM workspace encryption key encoded for import.

The account locator is not required because the validated Access identity selects the account row. The recovery key never leaves the browser and is never sent to Cloudflare or Neon. The active device imports it as a non-extractable CryptoKey in IndexedDB. The recovery file is downloaded to a user-selected location and its contents are never rendered back into the interface, logs, telemetry, or errors.

Before upload, the browser:

1. normalizes and repairs the workspace with the existing migration and message-deduplication rules;
2. applies contact retention and encrypted deletion tombstones;
3. removes the retired draft access code, recovery settings, backup confirmations, and ephemeral extension/session state;
4. removes dated conversation material older than 90 days even when the local contact retention is unlimited;
5. serializes the exact cloud-safe workspace;
6. calculates its logical digest and local contact/message counts;
7. encrypts it using AES-256-GCM with a new 96-bit IV and authenticated additional data bound to the DialogMint vault format, schema version, and exact environment name.

The uploaded envelope contains only format/schema versions, IV, ciphertext, revision, encrypted byte count, and save timestamp. It contains no readable contact data, message data, notes, playbooks, access codes, authentication data, screenshots, recovery material, or extension coordination state.

After browser storage is cleared, the user signs in through Cloudflare Access and selects the recovery file. The browser downloads the account ciphertext and decrypts locally. A wrong or corrupted file must not modify local or remote state. Losing both browser storage and the recovery file makes the encrypted snapshot intentionally unrecoverable.

## API boundary

Add same-origin endpoints without changing LinkedIn behavior:

- `GET /api/vault`: returns the authenticated account's encrypted envelope and current revision, or 404.
- `PUT /api/vault`: validates a bounded envelope, applies create/update revision conditions, refreshes `expires_at`, and returns the confirmed revision and ciphertext digest.
- `DELETE /api/vault`: explicitly deletes the authenticated account's entire encrypted backup without silently erasing the local vault.

Requirements:

- Access authentication before parsing request bodies or querying Neon;
- exact environment-host routing;
- POST/PUT body limit of 10 MiB;
- `application/json` only for writes;
- parameterized SQL only;
- generic `401`, `404`, `409`, `413`, and `5xx` errors;
- `Cache-Control: no-store` on every vault/auth response;
- no request-body, token, ciphertext, identity, or database-credential logging;
- no database connection from the Chrome extension or browser;
- no public Neon Data API.

## Synchronization and backup status

The local vault remains the immediate UI source. Its existing 500 ms save is never blocked by Neon.

Cloud synchronization runs in a separate debounce after successful local save:

1. Build and summarize the current cloud-safe workspace.
2. If its digest matches the last Neon-confirmed digest and counts, do nothing.
3. Encrypt and upload with the last confirmed revision.
4. On success, record the returned revision, ciphertext digest, logical digest, local conversation/message counts, and timestamp inside the encrypted local vault.
5. On one conflict, download, decrypt, merge deterministically, save locally, and retry once.
6. On failure, preserve local state and show a retryable status.

The Inbox may show `All N conversations backed up · M messages` only when the current logical digest and local counts match the last successful database confirmation. Other states are:

- `Encrypted backup off`;
- `Preparing encrypted backup`;
- `Backing up N conversations`;
- `Local changes waiting for backup`;
- `Restoring encrypted workspace`;
- `Backup needs attention`;
- `Backup expired or deleted`.

OTP and MFA only establish website identity. AI consent only permits on-demand draft generation. Neither status may claim that conversations are backed up.

## Conflict, merge, and deletion behavior

Merge rules preserve existing identity precedence:

- normalized LinkedIn profile URL first;
- stable conversation URL second;
- normalized name only as an unambiguous fallback;
- stable DOM message ID first and existing local fingerprint second;
- never automatically merge ambiguous contacts.

Merge notes, labels, pipeline stages, reminders, outcomes, feedback, playbooks, and draft history without replacing newer nonblank edits with blanks.

Deleting a contact while backup is enabled creates an encrypted tombstone with contact ID, stable identity hashes, and deletion time. Tombstones are applied before contacts during merges and retained for 90 days. The control reads `Delete contact everywhere` and warns that the local copy and next encrypted Neon snapshot are affected.

`Delete encrypted cloud backup` deletes the Neon row but leaves the local vault unless the user separately chooses to erase local data. `Erase all local data` never silently deletes the Neon copy.

## Ninety-day retention

Retention is enforced at three layers:

1. Client cloud-safe snapshots exclude dated conversation material older than 90 days.
2. Every successful database write sets `expires_at = now() + interval '90 days'`.
3. A scheduled Cloudflare Worker runs daily and deletes `expires_at <= now()` rows from the selected testing and production bindings using parameterized SQL.

The scheduled deletion is idempotent and reports only aggregate success/failure without account IDs or ciphertext. A read also treats an expired row as absent and may delete it transactionally, so retention does not depend solely on the scheduler.

## User interface and disclosures

Settings receives a compact `Encrypted 90-day backup` card with setup, restore, last-confirmed time, retry, and delete-backup controls. The Inbox gets a compact verified status line without reducing conversation-list space materially.

The disclosure states:

> DialogMint stores an AES-256-GCM encrypted workspace snapshot in Neon PostgreSQL for recovery. DialogMint's Worker, Cloudflare, and Neon do not receive the recovery key and cannot read the stored conversations. The cloud copy contains at most 90 days of conversation history and is deleted after 90 days without a successful update. Keep the recovery file safe; without it, restoration is impossible.

Privacy copy continues to state that DialogMint never reads LinkedIn cookies, Cloudflare cookies, credentials, OTP/MFA values, hidden inbox conversations, or private LinkedIn APIs and never types, clicks, scrolls, pastes, or sends on LinkedIn.

## Testing and production isolation

- Testing remains the existing stable testing alias in the Project Mission Cloudflare account.
- Private production remains the existing Project Mission Worker until `DialogMint.com` is purchased and separately approved.
- Each environment has its own Neon project/database, database role, Hyperdrive configuration, and data.
- Exact-host tests prove testing cannot select production and production cannot select testing.
- Versioned preview hosts cannot access either database.
- No resources are created in the `netcore.beast@gmail.com` Cloudflare account.

## Automated verification

Tests must prove:

1. all customer-facing application and extension branding is DialogMint while internal bridge compatibility remains intact;
2. Cloudflare Access validation checks signature, issuer, audience, expiry, and subject and rejects unverified identity headers;
3. `/api/drafts` no longer requires a separate access code after valid Access authentication, while AI consent remains required client-side;
4. testing and production exact hosts select only their corresponding Hyperdrive binding;
5. unknown and versioned preview hosts cannot query Neon;
6. SQL is parameterized and malformed, oversized, cross-origin, and unauthenticated requests fail before database access;
7. a cloud envelope reveals none of the fixture's names, messages, profile URLs, notes, playbooks, drafts, access data, or recovery material;
8. correct recovery material restores the cloud-safe workspace and wrong material leaves state unchanged;
9. browser-data loss can restore an already-confirmed snapshot after Access login;
10. the UI never shows a confirmed backup before Neon acknowledges the matching revision and digest;
11. a new message immediately changes status to pending and successful upload updates exact local counts;
12. revision conflicts merge and retry once without feedback loops;
13. profile URL precedence, guarded identity matching, ambiguity protection, and message deduplication remain intact;
14. deletion tombstones prevent contact resurrection across devices;
15. local contact deletion, entire backup deletion, and local-vault erasure remain distinct explicit operations;
16. material older than 90 days is excluded before encryption;
17. database rows receive a 90-day expiry and expired rows are unreadable and deleted;
18. daily scheduled cleanup targets both environments without logging account data;
19. existing draft-model, rate-limit, extension permission, cookie, network, inbox-scan, and manual-send tests continue passing;
20. full Vitest, ESLint, Next.js production, native/static Cloudflare, CSP, extension-boundary, database migration, and Wrangler dry-run checks pass.

## Release sequence

1. Implement with test-driven changes on the existing focused branch.
2. User creates or selects two Neon databases and their least-privilege roles through Neon personally.
3. User personally supplies each connection credential to the corresponding Cloudflare Hyperdrive configuration; no credential is shared with Codex.
4. Apply the schema independently to empty testing and production databases using a reviewed migration run through Neon's trusted SQL editor or an approved migration workflow.
5. Verify the Project Mission Cloudflare account before binding or deployment.
6. Deploy to the existing testing alias and run only synthetic encrypted fixtures.
7. Verify restore after disposable browser-data deletion, confirmed status, conflict handling, and 90-day cleanup without inspecting any recovery material.
8. Push the focused GitHub branch, update the existing pull request, and wait for all CI checks.
9. Promote the identical verified build to the existing private production Worker.
10. Attach `DialogMint.com` only after purchase, Cloudflare-zone setup, and separate explicit production-domain approval.
