# Cloud learning and usage release guide

This guide defines the privacy disclosure and the testing-to-private-production operating sequence for the DialogMint cloud-learning and server-authoritative usage release. It does not authorize a deployment, a database change, provider authentication, browser automation, or access to a secret. Use synthetic data for every smoke check.

## Data and privacy boundaries

ChatHelp remains local-first for raw work. Raw conversations and ordinary drafts remain in the encrypted workspace and encrypted recovery snapshot; they are not copied into the approved-learning or usage tables. The recovery service stores an AES-GCM ciphertext envelope and integrity metadata, not plaintext. Encrypted recovery snapshots are retained for at most 90 days, and an account-wide recovery deletion removes the server snapshot.

Approved learning records are server-readable, de-identified, purpose-limited, and retained for 365 days. They are keyed to an opaque, server-derived signed-in account identifier and isolated by deployment environment. The approved record types are deliberately narrow:

- evaluation records contain a text-free action plus bounded role, relationship-stage, and goal-category fields;
- classifier records contain bounded booleans and a message-count bucket from an explicit human confirmation, never raw message text or free-form goals; and
- generative records contain only a separately authored, sanitized target with both rights and privacy attestations, plus bounded role, stage, and goal fields.

Copy stores a bounded text-free Useful evaluation only after a successful clipboard write. Useful and Not useful directly store bounded text-free evaluations. Each generated draft uses one mutable learning record. Add my own version starts blank, sanitizes and previews the independently authored sanitized target, requires both rights and privacy attestations, and atomically replaces the same Not useful decision row. The direct decision flow never uploads raw prompts, raw replies, provider reasoning, original drafts, contact IDs, contact names, companies, profile URLs, email addresses, phone numbers, or other known direct identifiers. Known values are replaced before preview, residual direct identifiers are rejected, and the exact sanitized target must be reviewed before both attestations are accepted.

The numeric/model-only usage ledger contains no conversation or draft text. It records the server-derived account key, deployment environment, provider/model and pipeline-stage labels, request/attempt identifiers, terminal status, timestamps, token or neuron counts, usage-quality labels, and numeric cost estimates. Usage attempts are retained for 365 days.

Saving a Neon record does not train a model. Saving an approved record provides bounded retrieval context and does not itself train Anthropic, Llama, GPT-OSS, the local relationship-stage classifier, or any other model. During generation, the Worker may retrieve at most three enabled, unexpired, same-account approved generative targets as lower-priority untrusted context.

Individual learning records can be deleted separately. Disable-and-delete atomically disables cloud learning for the signed-in account and deletes all of that account's learning records. These actions do not erase the encrypted local workspace, the separately encrypted recovery snapshot, or the numeric usage ledger; those products have their own deletion and retention controls.

## Providers, allowance language, and training

Anthropic Claude Opus 4.6 Thinking (`claude-opus-4-6`) is the primary generation provider. The permanent Workers AI fallback pipeline keeps both deployed model IDs:

- `@cf/meta/llama-3.1-8b-instruct-fast`
- `@cf/openai/gpt-oss-120b`

Usage is a server-authoritative, per-signed-in-account ChatHelp app allowance estimate. It is not provider credit, a billing balance, a prepaid balance, or a provider account balance. Anthropic and Workers AI are shown separately, recorded usage quality is disclosed as exact, estimated, or unavailable, estimated remaining allowance never goes below zero, and the monthly period resets at 00:00 UTC on the first day of the month.

Cloudflare's current individual model schemas expose a generic `lora` input, but that does not make every model a dedicated LoRA base. These exact deployed model IDs are not currently listed as LoRA-capable targets. Model support can change and must be re-verified in the current catalog and fine-tune tooling before any adapter project. This release neither uploads an adapter nor runs fine-tuning, and it does not claim that LoRA is universally unsupported.

Current references, checked for this release on 2026-08-10:

- [Using LoRA adapters](https://developers.cloudflare.com/workers-ai/features/fine-tunes/loras/)
- [Workers AI model catalog](https://developers.cloudflare.com/workers-ai/models/)
- [Llama 3.1 8B Fast](https://developers.cloudflare.com/workers-ai/models/llama-3.1-8b-instruct-fast/)
- [GPT-OSS 120B](https://developers.cloudflare.com/workers-ai/models/gpt-oss-120b/)

Any future dataset or adapter project requires a separate review of provenance, privacy, rights, licensing, model compatibility, evaluation, cost, target environment, and current provider tooling. Downloading an approved export is not an upload and does not start training.

## Migration and promotion order

`cloudflare/neon/0002_dialogmint_cloud_learning_usage.sql` is an additive, idempotent migration for the learning preferences, learning records, usage attempts, and allowance tables plus the usage lifecycle trigger. The user applies the reviewed file separately to testing and production through each Neon project's trusted SQL editor. The user confirms the four tables and trigger there without sharing a connection string, credential, token, secret value, API-key assignment, account ID, binding ID, or SQL-console session.

There is no runtime migration route or admin schema route. A Worker request, deployment command, build, or CI job must never apply this migration automatically. Do not add `/api/migrate`, `/api/admin/schema`, or an equivalent schema-management endpoint.

The required order is:

1. The user applies and verifies the testing migration in Neon's trusted SQL editor.
2. GitHub CI passes for the exact release SHA.
3. The verified release is deployed only to testing, while the prior testing Worker version and deployment IDs remain recorded.
4. Signed-in users complete the authenticated testing smoke, isolation, deletion, recovery, and rollback-readiness checks below.
5. The user applies and verifies the same migration separately in production; no testing rows are copied.
6. The exact tested release is deployed to production, while the prior production Worker version and deployment IDs remain recorded.
7. A signed-in user completes the production smoke checks with synthetic data.
8. The operator verifies rollback readiness and the post-rollback compatibility checklist without changing Neon schema or data.

Stop if the active Cloudflare account is not the intended project account for this private release, the environment name is wrong, a migration is unconfirmed, CI or a smoke check fails, testing changes production, an unexpected health field appears, or any secret or confidential conversation data could be exposed.

## Safe health check

`GET /health` is the only unauthenticated operational smoke request in this guide. Treat the following as an allowlist, not merely a list of examples:

- `ok` and `service`;
- `deploymentEnvironment`;
- `primaryProvider` and `primaryModel`;
- `fallbackModels` containing exactly the two deployed Workers AI fallback IDs;
- `learning.configured`, `learning.schemaVersion`, and `learning.retentionDays`;
- `usage.configured`, `usage.pricingVersion`, `usage.estimatorVersion`, and `usage.retentionDays`; and
- `recovery.configured`, `recovery.encrypted`, and `recovery.retentionDays`.

Testing must report the testing environment and production must report production. Learning and usage retention must be 365 days; recovery must be encrypted and at most 90 days. The response must not contain an email, opaque account key, database or binding identifier, connection material, request content, or secret value. `/health` is network-only and must not be served from a service-worker cache.

## Authenticated testing smoke

These are user-performed checks in the testing UI. Do not use browser automation, do not authenticate on the user's behalf, and do not enter real confidential contact data.

1. **Access and API boundary.** Confirm the health allowlist while signed out. Confirm a protected `/api/*` request is rejected without Cloudflare Access, then sign in through the trusted Access interface. Protected APIs must authenticate before body parsing or database access, derive the account key on the server, and reject browser-supplied account IDs or emails.
2. **One precise draft and provider metadata.** With a synthetic conversation, generate one precise editable draft. Confirm manual review/copy/send remains required and confirm the result shows the actual provider, exact model, mode, request ID, fallback reason when applicable, and usage-accounting state. Anthropic should be primary. Exercise a fallback only through an already approved safe test fixture; never break or replace provider configuration to force it.
3. **Usage refresh.** Open Settings and confirm the signed-in account's Anthropic and Workers AI cards refresh after generation, show consumed and estimated remaining ChatHelp app allowance, disclose usage quality, show the next UTC reset, and do not claim provider credits or balances.
4. **Direct draft-learning decisions.** Confirm Copy, Useful, and Not useful use one stable draft decision record. Confirm Copy writes to the clipboard before it stores the text-free Useful evaluation, and a blocked clipboard creates no learning record. Confirm Not useful reveals Add my own version. Open its blank independent-author flow, write a synthetic target from scratch, verify known-name/company/profile replacement, verify that email/URL/phone input is rejected, review the exact sanitized preview, and complete both attestations. Confirm the independently authored sanitized target atomically replaces the same Not useful row, leaving one generative record. Confirm one explicit human stage confirmation produces only bounded classifier features and no message text.
5. **Management and pagination.** Open Advanced learning management, confirm it lazily lists only the current account's classifier, evaluation, and generative records, and load every bounded page using the returned cursor until no next page remains. Confirm exports omit prohibited fields and do not upload anything.
6. **Per-account isolation.** Using two separately authorized synthetic testing accounts, create a unique non-identifying marker under the first account and verify the second cannot list, retrieve, update, or delete it. Do not record either person's email or account key in release evidence.
7. **Cross-environment isolation.** Confirm testing records, usage, recovery ciphertext, and deletion state never appear in production, and a testing action does not change the recorded production Worker deployment snapshot.
8. **Deletion.** Delete one learning record and confirm it disappears only after the scoped server deletion succeeds. Then use disable-and-delete, confirm all current-account learning records are gone and learning is disabled, and confirm re-enabling starts from no saved learning records. Deletion must not affect another account or environment.
9. **Encrypted recovery.** With a synthetic workspace, create an encrypted recovery snapshot, update it, restore it only with the user-managed recovery material, verify wrong recovery material cannot decrypt it, and delete the server snapshot. Confirm the service returns only ciphertext/envelope metadata and uses the 90-day maximum retention boundary.
10. **No platform automation.** Confirm the extension observes only the central conversation the user manually opens. It must not enumerate the inbox, navigate, scroll, click, type, insert a draft, or send a message. Sending remains a separate human action.
11. **Service-worker bypass.** The service worker must bypass `/api/*` and `/health`; authenticated API and health responses must come from the network with `Cache-Control: no-store`. Offline shell/static caching must not make a protected API response available offline.

Record the release SHA, CI result, pass/fail outcome, and the retained non-secret Worker version/deployment IDs. Do not record request text, output text, user identities, database identifiers, recovery material, or secret values.

## Authenticated production smoke

After the separately confirmed production migration and deployment of the same tested release, repeat the health allowlist and Access checks. With fresh synthetic data, verify one primary draft and its actual provider/model metadata, usage refresh, cloud-learning status, one separately authored generative add/delete cycle, one bounded classifier record, encrypted recovery create/restore/delete, the manual-send boundary, and testing/production isolation. Do not copy testing data into production and do not reuse a production record merely to make the smoke shorter.

## Application-only rollback

Retain the previous Worker version and deployment IDs for testing and production before changing either environment. If rollback is required, deploy only the saved prior Worker version to 100% in the affected environment.

A Worker rollback does not revert the Neon schema or data. Leave the additive tables, trigger, approved records, usage rows, and encrypted recovery ciphertext in place; do not run a down migration, delete rows in bulk, or copy data between environments as part of application rollback. If the prior Worker is not compatible with the additive schema, stop and prepare a forward application fix rather than changing schema or data.

Run these post-rollback compatibility checks:

1. The stable environment points entirely to the saved prior Worker version, and the other environment's deployment snapshot is unchanged.
2. The prior application's expected health response contains no sensitive data, Cloudflare Access still protects every `/api/*` route, and the service worker still bypasses APIs and health.
3. A synthetic user can open the encrypted workspace, complete the prior version's supported draft flow, and recover the encrypted snapshot without exposing recovery material.
4. Existing Neon data remains untouched and environment/account isolation still holds. New-release-only records may remain dormant until the verified release is rolled forward again.
5. After a later roll-forward, repeat health, one draft, usage refresh, learning list/delete, encrypted recovery, and isolation checks before closing the incident.
