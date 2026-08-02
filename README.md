# ChatHelp

ChatHelp is a local-first, encrypted web application that helps a person write thoughtful replies for selected professional conversations. The human chooses the context, reviews every draft, and manually copies a response into the selected platform.

## Privacy architecture

- Cloudflare Access email verification and MFA protect the deployed application.
- AES-256-GCM encrypted IndexedDB vault with a non-exportable, browser-held device key and no additional passphrase prompt.
- Draft generation through an authenticated Cloudflare Worker and Workers AI; no model is downloaded to the device.
- Local relevance ranking for imported context; no embedding service.
- Self-hosted Tesseract worker, WebAssembly engine, and English OCR data.
- Explicit-click Chrome extension import for the currently open LinkedIn conversation, plus manual screen/OCR fallback; no background account scanning or message automation.
- Local inbox, CRM pipeline stages, labels, private notes, snooze/follow-up reminders, editable draft history, and local AI usage metadata.
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

The test suite covers automatic device encryption, one-time migration of older passphrase vaults, tamper rejection, extension snapshot validation/deduplication, minimal Chrome permissions, manual-send boundaries, retention, retrieval, prompt-injection boundaries, response parsing, security headers, self-hosted OCR assets, and browser reopen behavior.

## Desktop LinkedIn extension workflow

1. Load the unpacked `extension` directory in desktop Chrome during private beta testing.
2. Add or select the intended LinkedIn contact in ChatHelp.
3. Open that same contact's LinkedIn Messaging conversation.
4. Click the ChatHelp extension icon. Its temporary `activeTab` grant verifies the visible contact before reading any message nodes; a different conversation is blocked.
5. ChatHelp opens or focuses, validates the snapshot, merges new messages into only the selected existing contact, encrypts it locally, and clears the extension&apos;s pending copy.
6. Triage the conversation with pipeline stages, labels, notes, snooze/follow-up times, and keyboard shortcuts. Generate three editable drafts only when needed.
7. Copy the chosen draft, review it on LinkedIn, and send it yourself. ChatHelp never types or clicks Send.

See [extension/README.md](extension/README.md) and [docs/DESKTOP_LINKEDIN_WORKFLOW.md](docs/DESKTOP_LINKEDIN_WORKFLOW.md).

## Installable clients and platform support

ChatHelp supports selected LinkedIn, Gmail, Outlook, and other HTTPS conversations without connecting account credentials or automatically sending content. Install the PWA from a supported browser, or download preview Windows and Android artifacts from the **Package installable apps** GitHub Actions workflow.

- Windows: sandboxed Electron Setup and portable executables.
- Android: Capacitor debug APK for preview testing.
- Browser/PWA: installable, with an offline application shell after the first successful load.

See [docs/NATIVE_PACKAGING.md](docs/NATIVE_PACKAGING.md) for artifact and signing details. Cloud inference remains explicitly consented to inside the application.

## Important product boundary

ChatHelp is a drafting assistant, not a messaging automation client. Its extension runs an isolated DOM reader only after the user clicks it on the active LinkedIn conversation. It does not enumerate the inbox, bypass platform APIs, click controls, type, insert drafts, or send messages. This keeps the user in control.


## Guided LinkedIn profile test

After Cloudflare Access authentication, choose **Guided LinkedIn test** to walk through one explicitly selected profile and conversation. The profile URL is temporary, context capture/paste is user-directed, generation uses the consented Cloudflare AI service, and the final message is reviewed and sent manually. See [docs/LINKEDIN_TEST_WIZARD.md](docs/LINKEDIN_TEST_WIZARD.md).
