# ChatHelp privacy notice

ChatHelp uses Cloudflare Access for approved-email authentication and MFA. It has no advertising or analytics SDK. Raw conversations and ordinary drafts stay in the encrypted browser workspace and, when the user enables recovery, an encrypted recovery snapshot. Separately approved learning records and numeric usage data are stored through the authenticated Worker under an opaque, server-derived account key.

## Data the user chooses to add

A user may add selected chat lines, profile notes, personal guidance, context files, a user-selected screen capture, private conversation notes, labels, reminders, draft feedback, and outcome notes. On desktop Chrome, the optional ChatHelp extension can read only the visible LinkedIn conversation the user manually opens. It does not enumerate the inbox, choose people, type, click Send, or send a message.

## Encrypted workspace and recovery

Persistent workspace content is encrypted in IndexedDB using a random, non-exportable AES-256 device key held by the browser. An older passphrase vault requires its existing passphrase once for local conversion. Screen images used by the OCR fallback are captured only after the browser permission prompt, processed locally, and are not persisted.

If the user enables cloud recovery, the browser encrypts a bounded workspace snapshot with AES-256-GCM before upload. The server receives ciphertext, an IV, a digest, size/timestamp metadata, and a revision; it does not receive the recovery key or plaintext workspace. Raw conversations and ordinary drafts remain inside the encrypted workspace and encrypted recovery snapshot. Encrypted recovery snapshots are retained for at most 90 days. A successful update renews that window, expiry cleanup removes old ciphertext, and the user can delete the server snapshot separately.

## Approved cloud learning

Approved learning records are server-readable, de-identified, purpose-limited, and retained for 365 days. They can contain only bounded role/stage/goal fields plus one of: a text-free rating, bounded classifier features from an explicit human confirmation, or a separately authored sanitized target with both rights and privacy attestations.

Save improvement never uploads raw prompts, raw replies, provider reasoning, or original drafts. It also never uploads a contact ID, contact name, company, profile URL, email address, phone number, or other direct identifier. Known values are replaced before the exact preview, and residual identifier patterns are rejected. Individual records can be deleted. Disable-and-delete disables learning and removes every approved learning record for the signed-in account.

Saving a Neon record does not train a model. It supplies bounded retrieval context: the Worker may select at most three enabled, unexpired, same-account approved generative targets for a later request. Persistence does not itself train Anthropic, Llama, GPT-OSS, the local classifier, or any other model.

## Usage records

The numeric/model-only usage ledger contains no conversation or draft text. It stores provider/model and pipeline-stage labels, request/attempt identifiers, terminal state, timestamps, numeric token or neuron counts, usage-quality labels, and numeric cost estimates under the server-derived account key and deployment environment. Usage attempts are retained for 365 days.

Usage is a server-authoritative, per-signed-in-account ChatHelp app allowance estimate. It is not provider credit, a billing balance, a prepaid balance, or a provider account balance.

## External generation requests

When the user requests a draft and has consented, ChatHelp sends the relevant recent chat, selected context, guidance, agenda, and up to three approved retrieval examples to its authenticated Cloudflare Worker. Anthropic Claude Opus 4.6 Thinking is primary. If the primary pipeline cannot complete safely, Workers AI may use `@cf/meta/llama-3.1-8b-instruct-fast` and `@cf/openai/gpt-oss-120b` as the fallback pipeline. The complete vault, screenshots, browser device key, recovery key, and platform credentials are not included in an AI request.

Opening LinkedIn is a separate user action, and LinkedIn operates under its own terms and privacy policy. ChatHelp never sends a message on the user's behalf.

## User control and separation

Users can select per-contact workspace retention, remove individual local documents or contacts, erase the local vault and browser-held device key, delete individual approved cloud-learning records, disable and delete all approved cloud learning, and delete encrypted recovery ciphertext. Learning, usage, recovery, and the local workspace have separate deletion controls; deleting one does not silently delete the others. Testing and production data are also separate.

Clearing browser site data, changing browser profiles, or losing the device may remove the local key needed to open the browser vault. Keep user-managed recovery material private; ChatHelp support cannot reconstruct it.

See [SECURITY.md](SECURITY.md) for the threat model and [the cloud learning and usage release guide](docs/cloud-learning-usage-release.md) for migration, smoke, rollback, and future-training boundaries.
