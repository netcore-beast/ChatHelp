# ChatHelp security model

ChatHelp is designed as a local-first writing assistant. There is no ChatHelp application backend and no AI prompt API in the current architecture.

## Protected data

Chat history, profile notes, guidance, imported documents, OCR text, outcome notes, feedback, and generated drafts are treated as sensitive. Persistent workspace data is stored only as one encrypted IndexedDB envelope.

- Key derivation: PBKDF2-HMAC-SHA-256, 600,000 iterations, random 128-bit salt.
- Encryption: AES-256-GCM with a fresh random 96-bit IV for every save and authenticated additional data.
- Key lifecycle: the derived, non-extractable Web Crypto key exists in memory only while the vault is unlocked.
- Locking: manual lock plus a 15-minute inactivity lock; locking also unloads and terminates the AI worker.
- Backup: exports remain encrypted with the same passphrase. There is deliberately no passphrase recovery.
- Retention: per-contact automatic retention supports 30 days, 90 days, one year, or manual deletion.

## Network boundary

User content is not intentionally transmitted by ChatHelp. The restrictive Content Security Policy only permits the app origin and the known hosts needed to download the selected open model. On first model use, the browser downloads public weights from Hugging Face and the WebLLM runtime from its pinned package configuration. Those hosts can observe ordinary download metadata such as the user's IP address, but ChatHelp does not send prompts to them.

OCR worker, WebAssembly engine, and English language files are copied into the application build and served from the ChatHelp origin. LinkedIn is opened only through a normal user-activated link with no referrer; ChatHelp does not read an account, inject a page script, paste, or send messages automatically.

## Defensive controls

- Worker-isolated WebLLM inference.
- Prompt-injection boundary marking every imported or captured item as untrusted evidence.
- File type, size, record count, and text-length limits.
- Content Security Policy, denied framing, no-referrer policy, MIME sniffing prevention, and denied camera/microphone/geolocation permissions.
- No analytics, advertising SDK, telemetry endpoint, remote OCR, or remote code execution.
- CI lint, unit tests, encrypted-vault tamper tests, DOM workflow tests, production build, and production dependency audit.

## Browser startup protection

- The server-rendered web app issues a unique CSP nonce for each request and authorizes only the matching Next.js scripts.
- Windows, Android, and other static packages receive a build-time SHA-256 allow-list for every inline bootstrap script.
- Secure-storage startup is time-bounded. If IndexedDB is blocked or unavailable, ChatHelp shows a recovery screen instead of waiting forever; retrying does not erase an existing vault.
- Development origins are limited to localhost and GitHub Codespaces preview domains. This allow-list is only used by the development server.

## Honest limits

No browser application can promise absolute security. Content is readable in memory while the vault is unlocked. A compromised application origin, malicious browser extension, device malware, someone with the passphrase, or a future dependency vulnerability could expose it. Browser storage can also be cleared by the user or operating system. Encryption does not protect a screen that another person can see.

For high-risk deployments, use a dedicated browser profile, a strong unique passphrase in a password manager, full-disk encryption, automatic OS updates, and a reviewed production origin. A professional independent security review is recommended before representing the product as suitable for regulated or highly sensitive information.

## Reporting

Do not include real conversation data in a vulnerability report. Open a private GitHub security advisory for the repository owner and include reproduction steps using synthetic data.
