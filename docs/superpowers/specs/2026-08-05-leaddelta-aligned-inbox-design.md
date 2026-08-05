# LeadDelta-aligned local inbox enhancements

Date: 2026-08-05

## Objective

Strengthen ChatHelp's conversation workflow with the privacy-compatible features selected from the LeadDelta teardown while preserving the encrypted local vault, progressive visible-conversation sync, existing drafting behavior, manual-send boundary, and current desktop layout.

This release is testing-only. It must not change the production Worker, introduce LinkedIn sending, broaden Chrome permissions, crawl the LinkedIn inbox, or centralize conversation storage.

## Scope

The release adds five related capabilities:

1. Transparent conversation-state badges.
2. A compact draft-context inspector.
3. Message-free sync diagnostics.
4. Automatic restoration of an archived conversation when a genuinely new incoming message is synchronized.
5. Local pin and read-later controls.

## Approaches considered

### Selected: integrated local metadata plus derived state

Add only durable user choices to the encrypted contact record and derive operational states from data ChatHelp already stores. Extend the existing LinkedIn snapshot import result with diagnostic counts instead of creating a second event store.

This approach has the smallest migration surface, preserves current code paths, and keeps every new state local.

### Rejected: event-ledger architecture

A full synchronization event ledger could support historical audits and advanced analytics, but it would add substantial storage, migration, retention, and UI complexity beyond the current need.

### Rejected: UI-only indicators

Pure component state would be quick but would lose pin/read-later choices across refreshes and could disagree with the encrypted vault.

## Data model

### Contact metadata

Add two optional booleans to `Contact`:

- `pinned`: user explicitly keeps the conversation at the top of applicable lists.
- `readLater`: user explicitly marks the conversation for later attention.

Both values default to `false` during vault normalization. They are encrypted with the rest of the contact record and are not synchronized to LinkedIn.

No stored `conversationState` field is added. Conversation state is derived to prevent stale duplicate truth.

### Sync diagnostics

The snapshot merge function returns an additional structured diagnostic summary:

- matched or created contact ID
- import action (`created`, `updated`, or `unchanged`)
- total visible messages in the snapshot
- number of newly imported messages
- number of duplicate messages excluded
- whether an archived conversation was restored
- stable snapshot fingerprint when available
- synchronization timestamp

The persisted contact may retain only the latest safe diagnostic summary needed by the UI. Message text, cookies, credentials, tokens, DOM HTML, selectors, and unrelated page content are excluded.

## Conversation-state engine

Expose a pure function that derives one primary state from the current contact and current time.

Precedence:

1. `Archived` when the pipeline stage is archived/done according to existing application semantics.
2. `Snoozed` while the snooze timestamp is in the future.
3. `Follow-up due` when an existing reminder or expired snooze is due.
4. `Read later` when explicitly selected by the user.
5. `To respond` when the latest meaningful message is incoming.
6. `Awaiting reply` when the latest meaningful message is outgoing.
7. `No messages` when the thread is empty.
8. `Up to date` otherwise.

The UI shows the state badge and a short accessible explanation. Existing Inbox filters continue using their current logic; the new engine consolidates labels and tests without changing unrelated filtering behavior.

Pinned contacts sort before unpinned contacts within the existing filtered result. The existing secondary ordering remains unchanged.

## Archive restoration

During snapshot import, determine whether at least one genuinely new message is incoming. A message counts as new only after the existing stable-ID/fingerprint deduplication has run.

If the contact is archived and a new incoming message is added:

- move the contact back to the Inbox stage;
- clear no notes, labels, reminders, snooze data, outcomes, draft history, pin, or read-later metadata;
- mark the import result as `restoredFromArchive`;
- surface a non-intrusive updated status.

An outgoing-only update, repeated snapshot, duplicate message, metadata-only change, or empty snapshot must not restore an archived conversation.

## Draft-context inspector

Add a compact collapsible inspector inside the existing composer without increasing the default vertical footprint materially.

It displays:

- selected role/playbook;
- relationship goal presence;
- reply-rule character count;
- optional objective present or absent;
- contact notes present or absent;
- number of conversation messages included by the current prompt builder;
- the latest meaningful incoming message used as the reply target;
- the generation mode already selected in Settings.

The inspector reads from the same normalized inputs passed to the existing draft request builder. It does not create another prompt-building implementation and does not send any data by itself.

## Sync diagnostics interface

Extend the existing compact automatic-sync card with an information control that opens a small diagnostic popover or collapsible region.

It displays:

- automatic-sync permission and pause state;
- extension bridge connection state;
- last observed/synchronized contact;
- visible, new, and duplicate message counts;
- created/updated/unchanged result;
- restored-from-archive status;
- last successful synchronization time;
- a shortened snapshot fingerprint.

The collapsed card remains as compact as the existing testing version. Diagnostics use `aria-live` only for meaningful state transitions to avoid repetitive screen-reader announcements during DOM mutation debouncing.

## Pin and read-later controls

Add compact, labelled controls to the selected-conversation header and accessible actions on each inbox row.

- Pin toggles durable local priority and changes ordering.
- Read later toggles durable local attention state and its derived badge.
- Controls use buttons with `aria-pressed` and clear accessible names.
- Neither action modifies LinkedIn, generates a draft, or calls a network endpoint.

## Error handling

- Legacy vault contacts without the new fields normalize safely to `false`.
- Missing diagnostic metadata renders as `Not yet available` rather than an error.
- A malformed diagnostic summary is discarded during normalization.
- Snapshot merging remains idempotent.
- UI controls are disabled only when no contact is selected.
- Extension permission removal and invalidated context continue using the existing safe error paths.

## Testing strategy

Follow test-driven development for each behavior:

1. Vault normalization and persistence for pin/read-later metadata.
2. Deterministic derived-state precedence.
3. Pinned ordering without changing secondary ordering.
4. Archive restoration only for a new incoming message.
5. No restoration for duplicates, outgoing messages, or metadata-only updates.
6. Diagnostic created/updated/unchanged and message counts.
7. Context inspector reflects the same role, rules, objective, notes, history, and latest incoming target used by generation.
8. Accessible pin/read-later and diagnostic controls.
9. Existing extension, deduplication, drafting, Cloudflare authentication, CSP, and privacy-boundary tests remain passing.

## Verification and release

Run the full Vitest suite, ESLint, standard production build, native/static Cloudflare build, CSP injection and verification, and extension-boundary verification. Perform a browser-level testing-environment check without accessing user credentials or secrets.

Push the focused branch to GitHub. Deploy only to the existing Project Mission testing environment at `testing-chathelp-private-cloud.project-mission-ai.workers.dev`. Do not deploy or alter the production Worker, create a new Worker, or use the netcore.beast Cloudflare account.

## Non-goals

- Direct or automatic LinkedIn sending
- Bulk messaging or campaigns
- Background LinkedIn inbox/network scanning
- New Chrome permissions
- LinkedIn cookies, tokens, APIs, `webRequest`, or debugger access
- Contact enrichment
- Team/shared workspace storage
- CRM synchronization
- Redesign of unrelated pages or controls
