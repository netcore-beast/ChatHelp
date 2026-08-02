# ChatHelp

ChatHelp is a local-first, encrypted web application that helps a person write thoughtful replies for selected professional conversations. The human chooses the context, reviews every draft, and manually copies a response into the selected platform.

## Privacy architecture

- Cloudflare Access email verification and MFA protect the deployed application.
- AES-256-GCM encrypted IndexedDB vault with a non-exportable, browser-held device key and no additional passphrase prompt.
- Draft generation through an authenticated Cloudflare Worker and Workers AI; no model is downloaded to the device.
- Local relevance ranking for imported context; no embedding service.
- Self-hosted Tesseract worker, WebAssembly engine, and English OCR data.
- Manual screen selection and manual LinkedIn/Gmail/Outlook handoff; no account scanning or message automation.
- Per-contact retention and complete local erasure, including the browser-held device key.
- Restrictive CSP and browser permission policy.

Read SECURITY.md and PRIVACY.md before using real conversation data.

## Use in GitHub Codespaces

1. Create or open the repository Codespace.
2. Run npm ci. The postinstall step prepares self-hosted OCR assets.
3. Run npm run dev.
4. Open the forwarded port 3000 preview.
5. Open ChatHelp. The browser creates and opens its encrypted workspace automatically after Cloudflare Access authentication.

Draft generation runs in Cloudflare Workers AI. ChatHelp does not download or run LLM weights on the user device.

## Verification

Run these commands inside the Codespace:

    npm run prepare:ocr
    npm run lint
    npm test
    npm run build
    npm audit --audit-level=high

The test suite covers automatic device encryption, one-time migration of older passphrase vaults, tamper rejection, unique AES-GCM IVs, retention, retrieval, prompt-injection boundaries, response parsing, security headers, self-hosted OCR assets, and browser reopen behavior.

## Installable clients and platform support

ChatHelp supports selected LinkedIn, Gmail, Outlook, and other HTTPS conversations without connecting account credentials or automatically sending content. Install the PWA from a supported browser, or download preview Windows and Android artifacts from the **Package installable apps** GitHub Actions workflow.

- Windows: sandboxed Electron Setup and portable executables.
- Android: Capacitor debug APK for preview testing.
- Browser/PWA: installable, with an offline application shell after the first successful load.

See [docs/NATIVE_PACKAGING.md](docs/NATIVE_PACKAGING.md) for artifact and signing details. Cloud inference remains explicitly consented to inside the application.

## Important product boundary

ChatHelp is a drafting assistant, not a messaging automation client. It does not bypass platform APIs, scrape accounts, inject into third-party pages, or send messages. This reduces privacy and account-risk concerns and keeps the user in control.


## Guided LinkedIn profile test

After Cloudflare Access authentication, choose **Guided LinkedIn test** to walk through one explicitly selected profile and conversation. The profile URL is temporary, context capture/paste is user-directed, generation uses the consented Cloudflare AI service, and the final message is reviewed and sent manually. See [docs/LINKEDIN_TEST_WIZARD.md](docs/LINKEDIN_TEST_WIZARD.md).
