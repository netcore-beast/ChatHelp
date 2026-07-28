# ChatHelp

ChatHelp is a local-first, encrypted web application that helps a person write thoughtful replies for selected professional conversations. The human chooses the context, reviews every draft, and manually copies a response into the selected platform.

## Privacy architecture

- No ChatHelp backend, account database, analytics, or prompt API.
- AES-256-GCM encrypted IndexedDB vault with a passphrase-derived, memory-only key.
- Llama 3.2 generation through WebLLM in a dedicated browser worker.
- Local relevance ranking for imported context; no embedding service.
- Self-hosted Tesseract worker, WebAssembly engine, and English OCR data.
- Manual screen selection and manual LinkedIn/Gmail/Outlook handoff; no account scanning or message automation.
- Per-contact retention, encrypted backup/import, lock, and complete erasure.
- Restrictive CSP and browser permission policy.

Read SECURITY.md and PRIVACY.md before using real conversation data.

## Use in GitHub Codespaces

1. Create or open the repository Codespace.
2. Run npm ci. The postinstall step prepares self-hosted OCR assets.
3. Run npm run dev.
4. Open the forwarded port 3000 preview.
5. Create a unique passphrase of at least 12 characters and export an encrypted backup.

The first draft generation downloads the selected public model weights. Depending on the model and device, this is a large download and requires WebGPU support. The Llama 3.2 1B option is intended for lighter devices; the 3B option generally produces stronger drafts.

## Verification

Run these commands inside the Codespace:

    npm run prepare:ocr
    npm run lint
    npm test
    npm run build
    npm audit --audit-level=high

The test suite covers encrypted storage, wrong-passphrase and tamper rejection, unique AES-GCM IVs, retention, retrieval, prompt-injection boundaries, response parsing, security headers, self-hosted OCR assets, and the create/edit/lock/unlock browser workflow.

## Installable clients and platform support

ChatHelp supports selected LinkedIn, Gmail, Outlook, and other HTTPS conversations without connecting account credentials or automatically sending content. Install the PWA from a supported browser, or download preview Windows and Android artifacts from the **Package installable apps** GitHub Actions workflow.

- Windows: sandboxed Electron Setup and portable executables.
- Android: Capacitor debug APK for preview testing.
- Browser/PWA: installable, with an offline application shell after the first successful load.

See [docs/NATIVE_PACKAGING.md](docs/NATIVE_PACKAGING.md) for artifact and signing details. See [docs/CLOUD_LLM_ROADMAP.md](docs/CLOUD_LLM_ROADMAP.md) for the optional, consent-based managed LLM roadmap. Local inference remains the default and free/private tier.

## Important product boundary

ChatHelp is a drafting assistant, not a messaging automation client. It does not bypass platform APIs, scrape accounts, inject into third-party pages, or send messages. This reduces privacy and account-risk concerns and keeps the user in control.
