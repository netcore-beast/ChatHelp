# ChatHelp

ChatHelp is a local-first, encrypted web application that helps a person write thoughtful replies for selected professional conversations. The human chooses the context, reviews every draft, and manually copies a response into the selected platform.

## Privacy architecture

- Cloudflare Access email verification and MFA protect the deployed application.
- AES-256-GCM encrypted IndexedDB vault with a non-exportable, browser-held device key and no additional passphrase prompt.
- Draft generation through an authenticated Cloudflare Worker and Workers AI; no model is downloaded to the device.
- Local relevance ranking for imported context; no embedding service.
- Self-hosted Tesseract worker, WebAssembly engine, and English OCR data.
- Desktop-first, opt-in Chrome synchronization for only the LinkedIn conversation the user manually opens. Unknown contacts are created locally; mobile uses manual paste/import, and one-time extension capture plus screen/OCR remain fallbacks.
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

1. Load the unpacked `extension` directory in desktop Chrome during private beta testing. After updating the source, click **Reload** for ChatHelp in `chrome://extensions`, then reload the ChatHelp tab; the app shows the connected extension version.
2. Click **Enable automatic LinkedIn conversation sync** and approve Chrome's optional LinkedIn host permission. This setting is off by default and can be paused or disabled at any time.
3. Manually open a conversation in LinkedIn Messaging. ChatHelp reads the visible central header and thread only; it never opens, scrolls, clicks, types, or scans the inbox.
4. ChatHelp matches by normalized profile URL, then conversation URL, then guarded unique name. Unknown contacts are created in the encrypted local vault, while ambiguous identities are never merged.
5. Manually opening another conversation synchronizes it without another toolbar click. Repeated DOM changes and captures are deduplicated.
6. Triage the conversation with pipeline stages, labels, notes, snooze/follow-up times, and keyboard shortcuts. Generate three editable drafts only when needed.
7. Copy the chosen draft, review it on LinkedIn, and send it yourself. The toolbar's one-time capture remains available as a fallback; ChatHelp never types or clicks Send.

See [extension/README.md](extension/README.md) and [docs/DESKTOP_LINKEDIN_WORKFLOW.md](docs/DESKTOP_LINKEDIN_WORKFLOW.md).

## Installable clients and platform support

ChatHelp supports selected LinkedIn, Gmail, Outlook, and other HTTPS conversations without connecting account credentials or automatically sending content. Install the PWA from a supported browser, or download preview Windows and Android artifacts from the **Package installable apps** GitHub Actions workflow.

- Windows: sandboxed Electron Setup and portable executables.
- Android: Capacitor debug APK for preview testing.
- Browser/PWA: installable, with an offline application shell after the first successful load.

See [docs/NATIVE_PACKAGING.md](docs/NATIVE_PACKAGING.md) for artifact and signing details. Cloud inference remains explicitly consented to inside the application.

## Important product boundary

ChatHelp is a drafting assistant, not a messaging automation client. After explicit opt-in, its isolated DOM reader observes only the central conversation the user manually opens. It does not enumerate the inbox, use LinkedIn APIs or cookies, click controls, type, insert drafts, or send messages. This keeps the user in control.

## Deployment channels

- Production remains `https://chathelp-private-cloud.project-mission-ai.workers.dev/` until a public custom domain is purchased and explicitly attached.
- Testing uses the stable aliased preview `https://testing-chathelp-private-cloud.project-mission-ai.workers.dev/`.
- The testing link is a preview version of the same Worker, not a duplicate Worker. Uploading a test version does not promote it to production.
- GitHub remains the release source of truth: changes are reviewed through a pull request and production is promoted only after checks and testing pass.


## Guided LinkedIn profile test

After Cloudflare Access authentication, choose **Guided LinkedIn test** to walk through one explicitly selected profile and conversation. The profile URL is temporary, context capture/paste is user-directed, generation uses the consented Cloudflare AI service, and the final message is reviewed and sent manually. See [docs/LINKEDIN_TEST_WIZARD.md](docs/LINKEDIN_TEST_WIZARD.md).
