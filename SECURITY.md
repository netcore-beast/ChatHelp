# ChatHelp security model

ChatHelp is designed as a local-first writing assistant. There is no ChatHelp application backend and no AI prompt API in the current architecture.

## Protected data

Chat history, profile notes, guidance, imported documents, OCR text, outcome notes, feedback, and generated drafts are treated as sensitive. Persistent workspace data is stored only as one encrypted IndexedDB envelope.

- Key creation: Web Crypto generates a random, non-exportable AES-256 device key and stores it in the same-origin browser profile using IndexedDB structured cloning.
- Encryption: AES-256-GCM with a fresh random 96-bit IV for every save and authenticated additional data.
- Key lifecycle: the key never leaves the browser and is not extractable through Web Crypto. The application opens the local vault automatically after Cloudflare Access authentication.
- Legacy migration: older passphrase-derived vaults require the old passphrase once and are re-encrypted with a device key.
- Recovery: device-encrypted vaults have no export or recovery in this release. Clearing site data or losing the device loses the local workspace.
- Retention: per-contact automatic retention supports 30 days, 90 days, one year, or manual deletion.

## Network boundary

After explicit consent, ChatHelp transmits only the selected recent context, guidance, and agenda to its authenticated Cloudflare Worker for Workers AI generation. No LLM weights run on or download to the device. Screenshots, the full encrypted vault, its device key, and platform credentials are not included in the AI request.

OCR worker, WebAssembly engine, and English language files are copied into the application build and served from the ChatHelp origin. LinkedIn is opened only through a normal user-activated link with no referrer; ChatHelp does not read an account, inject a page script, paste, or send messages automatically.

## Defensive controls

- Cloudflare Access authentication and MFA in front of the production Worker.
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

No browser application can promise absolute security. Content is readable in memory while the application is open. A compromised application origin, malicious browser extension, device malware, someone controlling the authenticated browser profile, or a future dependency vulnerability could expose it. Browser storage can also be cleared by the user or operating system. Encryption does not protect a screen that another person can see.

For high-risk deployments, use a dedicated browser profile, full-disk encryption, automatic OS updates, phishing-resistant MFA where available, and a reviewed production origin. A professional independent security review is recommended before representing the product as suitable for regulated or highly sensitive information.

## Reporting

Do not include real conversation data in a vulnerability report. Open a private GitHub security advisory for the repository owner and include reproduction steps using synthetic data.
