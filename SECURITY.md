# ChatHelp security model

ChatHelp is a local-first writing assistant with an authenticated Cloudflare Worker and environment-isolated Neon storage. Raw workspace content is encrypted before persistence. The backend has defined storage responsibilities for encrypted recovery ciphertext, narrowly approved server-readable learning records, and a text-free usage ledger, and generation can use Anthropic or the Workers AI fallbacks described below.

## Protected data and retention

Chat history, profile notes, guidance, imported documents, OCR text, outcome notes, feedback, and generated drafts are sensitive.

- **Local workspace:** Web Crypto generates a random, non-exportable AES-256 device key and stores it in the same-origin browser profile through IndexedDB structured cloning. The workspace is one AES-256-GCM envelope with a fresh 96-bit IV and authenticated additional data for every save. The key is not extractable through Web Crypto.
- **Encrypted recovery:** The browser creates a distinct user-managed recovery key and encrypts a bounded workspace snapshot with AES-256-GCM before upload. Neon stores only the ciphertext envelope, digest, revision, byte count, and timestamps under the server-derived account key. Encrypted recovery snapshots are retained for at most 90 days. The server never receives the recovery key, and deletion of the recovery row is separate from local erasure.
- **Approved learning:** Approved learning records are server-readable, de-identified, purpose-limited, and retained for 365 days. Evaluation records are text-free; classifier records contain bounded structured features; generative records contain only a separately authored sanitized target after rights and privacy attestations. Raw prompts, generated replies, provider reasoning, original drafts, contact IDs, names, companies, URLs, and other direct identifiers are prohibited.
- **Usage:** The numeric/model-only usage ledger contains no conversation or draft text. It contains the opaque account key, environment, provider/model and pipeline labels, request/attempt IDs, terminal state, timestamps, and numeric usage/cost fields. Usage attempts are retained for 365 days.

Save improvement never uploads raw prompts, raw replies, provider reasoning, or original drafts. Contact IDs, names, companies, URLs, email addresses, phone numbers, and other direct identifiers are also prohibited.

An older passphrase-derived local vault requires the old passphrase once and is then re-encrypted with the device key. Per-contact local retention supports 30 days, 90 days, one year, or manual retention/deletion; that local policy is separate from the 365-day approved-learning/usage windows and the 90-day encrypted-recovery maximum. Learning, usage, recovery, and the local workspace have separate deletion controls; deleting one does not silently delete the others.

## Identity, database, and API boundary

Cloudflare Access authenticates before protected request-body parsing or database access. The Worker verifies the Access assertion for the exact testing or production hostname, derives an opaque account key on the server, and rejects browser-supplied account identifiers or user-email headers. Testing and production select distinct Hyperdrive bindings and environment labels; unsupported hosts and cross-environment identities fail closed.

Approved-learning queries and deletions are scoped by account key. Retrieval returns at most three enabled, unexpired generative targets for the same account. Usage gates every actual provider attempt and stores only numeric/model metadata. Encrypted recovery uses optimistic revisions and validates ciphertext size, envelope shape, and digest before storage.

Every protected API response and the `/health` response uses `Cache-Control: no-store`. The service worker bypasses `/api/*` and `/health`, caches only the public application shell and allowlisted static assets, and cannot make a protected response available offline. `/health` exposes only safe deployment/provider/schema/pricing/retention metadata; it must never expose an identity, account key, binding identifier, connection material, request content, or secret value.

There is no runtime migration or admin schema route. The additive cloud-learning/usage migration is applied separately to testing and production by the user in Neon's trusted SQL editor; it is never run by the Worker or CI. No connection string, credential, token, secret value, API-key assignment, account ID, or binding ID belongs in release documentation or source control.

## Generation and training boundary

After explicit consent, ChatHelp sends only the selected recent context, guidance, agenda, and bounded approved retrieval examples to the authenticated Worker. Anthropic Claude Opus 4.6 Thinking is primary. `@cf/meta/llama-3.1-8b-instruct-fast` and `@cf/openai/gpt-oss-120b` are the permanent Workers AI fallbacks. Screenshots, the complete encrypted vault, device key, recovery key, and platform credentials are not sent to an AI provider.

Saving a Neon record does not train a model. It provides bounded retrieval context or a provenance-controlled record for separately reviewed future work; it does not itself retrain Anthropic, either Workers AI fallback, the local relationship-stage classifier, or another model. Any future adapter or training project requires separate provenance, privacy, rights, licensing, compatibility, evaluation, cost, and deployment approval.

Usage is a server-authoritative, per-signed-in-account ChatHelp app allowance estimate. It is not provider credit, a billing balance, a prepaid balance, or a provider account balance.

## Extension and local-processing boundary

OCR worker code, the WebAssembly engine, and English language data are copied into the application build and served from the ChatHelp origin. Screen capture requires the browser permission prompt, OCR runs locally, and the image is not persisted.

The companion extension observes only the central LinkedIn conversation the user manually opens after opt-in. Captures are validated by the extension and again by ChatHelp before being merged into the selected encrypted contact. The extension does not use LinkedIn APIs or cookies, crawl the inbox, navigate, scroll, click controls, type, insert a draft, or send a message. Draft review, copying, and sending remain human actions.

## Defensive controls

- Cloudflare Access authentication and MFA protect the private application.
- Strict origin/host/environment resolution prevents a testing request from selecting production storage.
- Parameterized database queries, narrow JSON schemas, input-size limits, identifier rejection, per-account rate limits, and atomic disable-and-delete constrain server operations.
- Prompt-injection boundaries mark imported, captured, and retrieved examples as untrusted evidence.
- Content Security Policy, denied framing, no-referrer policy, MIME sniffing prevention, and denied camera/microphone/geolocation permissions reduce browser exposure.
- Static checks reject a runtime migration route, secret-bearing release text, cached API/health responses, automation expansion, and contradictory privacy/storage claims.
- CI lint, unit tests, encrypted-vault tamper tests, learning/usage isolation tests, DOM workflow tests, production builds, and dependency audit are required before promotion.

## Browser startup protection

- The server-rendered web app issues a unique CSP nonce for each request and authorizes only the matching Next.js scripts.
- Windows, Android, and other static packages receive a build-time SHA-256 allowlist for every inline bootstrap script.
- Secure-storage startup is time-bounded. If IndexedDB is blocked or unavailable, ChatHelp shows a recovery screen instead of waiting forever; retrying does not erase an existing vault.
- Development origins are limited to localhost and GitHub Codespaces preview domains. This allowlist is only used by the development server.

## Honest limits

No browser application can promise absolute security. Content is readable in memory while the application is open. A compromised application origin, malicious browser extension, device malware, someone controlling the authenticated browser profile, stolen user-managed recovery material, an Access misconfiguration, an operator with database privileges, or a future dependency vulnerability could expose data within that boundary. Encryption does not protect a visible screen, and server-readable approved records are not protected from an authorized database operator by the recovery encryption.

For high-risk deployments, use a dedicated browser profile, full-disk encryption, automatic OS updates, phishing-resistant MFA where available, reviewed Access and environment configuration, and synthetic release smokes. A professional independent security review is recommended before representing the product as suitable for regulated or highly sensitive information.

## Reporting

Do not include real conversation data, draft text, recovery material, identities, database identifiers, or secret values in a vulnerability report. Open a private GitHub security advisory for the repository owner and include reproduction steps using synthetic data.

See [the cloud learning and usage release guide](docs/cloud-learning-usage-release.md) for the trusted migration order, exact smoke cases, application-only rollback, and current LoRA wording.
