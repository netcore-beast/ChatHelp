# ChatHelp

ChatHelp is a local-first, encrypted web application that helps a person write thoughtful replies for selected professional conversations. The human chooses the context, reviews every draft, and manually copies a response into the selected platform.

## Privacy architecture

- Cloudflare Access email verification and MFA protect the deployed application.
- AES-256-GCM encrypted IndexedDB vault with a non-exportable, browser-held device key and no additional passphrase prompt.
- Optional encrypted recovery stores only ciphertext and integrity metadata for at most 90 days; raw conversations and ordinary drafts never enter the server-readable learning or usage tables.
- One stage-aware draft through an authenticated Cloudflare Worker. Anthropic Claude Opus 4.6 Thinking is primary; `@cf/meta/llama-3.1-8b-instruct-fast` and `@cf/openai/gpt-oss-120b` remain the permanent Workers AI fallbacks.
- Local relevance ranking for imported context; no embedding service.
- Approved cloud learning stores only server-readable, de-identified, purpose-limited records for 365 days and retrieves at most three separately authored, attested examples for bounded context. Saving a record does not train a model.
- A server-authoritative, per-signed-in-account numeric/model-only usage ledger is retained for 365 days and reports estimated ChatHelp app allowance, never provider credit or billing balance.
- A narrow offline relationship-stage classifier trained only from explicit human confirmations; suggestions never change a stage without a separate user action.
- Self-hosted Tesseract worker, WebAssembly engine, and English OCR data.
- Desktop-first, opt-in Chrome synchronization for only the LinkedIn conversation the user manually opens. Unknown contacts are created locally; mobile uses manual paste/import, and one-time extension capture plus screen/OCR remain fallbacks.
- Local inbox, CRM pipeline stages, labels, private notes, snooze/follow-up reminders, editable draft history, and local AI usage metadata.
- Per-contact retention and complete local erasure, including the browser-held device key.
- Restrictive CSP and browser permission policy.

Read [SECURITY.md](SECURITY.md), [PRIVACY.md](PRIVACY.md), and the [cloud learning and usage release guide](docs/cloud-learning-usage-release.md) before using real conversation data or promoting a release.

## Use in GitHub Codespaces

1. Create or open the repository Codespace.
2. Run npm ci. The postinstall step prepares self-hosted OCR assets.
3. Run npm run dev.
4. Open the forwarded port 3000 preview.
5. Open ChatHelp. The browser creates and opens its encrypted workspace automatically after Cloudflare Access authentication.

Draft generation runs through the authenticated Cloudflare Worker. Claude is the primary provider and the earlier Workers AI models remain the fallback. ChatHelp does not download or run conversation-model weights on the user device.

## Verification

Run these commands inside the Codespace:

    npm run prepare:ocr
    npm run lint
    npm test
    npm run build
    npm audit --audit-level=high

The test suite covers device encryption, migration, tamper rejection, stage-aware single-draft policy, Claude/fallback routing, opt-in retrieval learning, provenance-gated training exports, the offline stage classifier, extension snapshot validation/deduplication, minimal Chrome permissions, manual-send boundaries, retention, prompt-injection boundaries, response parsing, security headers, self-hosted OCR assets, and browser reopen behavior.

## Desktop LinkedIn extension workflow

1. Load the unpacked `extension` directory in desktop Chrome during private beta testing. After updating the source, click **Reload** for ChatHelp in `chrome://extensions`, then reload the ChatHelp tab; the app shows the connected extension version.
2. Click **Enable automatic LinkedIn conversation sync** and approve Chrome's optional LinkedIn host permission. This setting is off by default and can be paused or disabled at any time.
3. Manually open a conversation in LinkedIn Messaging. ChatHelp reads the visible central header and thread only; it never opens, scrolls, clicks, types, or scans the inbox.
4. ChatHelp matches by normalized profile URL, then conversation URL, then guarded unique name. Unknown contacts are created in the encrypted local vault, while ambiguous identities are never merged.
5. Manually opening another conversation synchronizes it without another toolbar click. Repeated DOM changes and captures are deduplicated.
6. Triage the conversation with pipeline stages, labels, notes, snooze/follow-up times, and keyboard shortcuts. Set the relationship stage and goal, then generate one precise editable draft when needed.
7. Review and copy the draft to LinkedIn, then send it yourself. The toolbar's one-time capture remains available as a fallback; ChatHelp never types or clicks Send.

See [extension/README.md](extension/README.md) and [docs/DESKTOP_LINKEDIN_WORKFLOW.md](docs/DESKTOP_LINKEDIN_WORKFLOW.md).

## Installable clients and platform support

ChatHelp supports selected LinkedIn, Gmail, Outlook, and other HTTPS conversations without connecting account credentials or automatically sending content. Install the PWA from a supported browser, or download preview Windows and Android artifacts from the **Package installable apps** GitHub Actions workflow.

- Windows: sandboxed Electron Setup and portable executables.
- Android: Capacitor debug APK for preview testing.
- Browser/PWA: installable, with an offline application shell after the first successful load.

See [docs/NATIVE_PACKAGING.md](docs/NATIVE_PACKAGING.md) for artifact and signing details. Cloud inference remains explicitly consented to inside the application.

Approved retrieval and any future training/export project remain separate operations. See the [cloud learning and usage release guide](docs/cloud-learning-usage-release.md) for current storage, migration, smoke, rollback, provider, and LoRA boundaries, and [docs/TRAINING_AND_LORA.md](docs/TRAINING_AND_LORA.md) for classifier and dataset-provenance constraints.

## Important product boundary

ChatHelp is a drafting assistant, not a messaging automation client. After explicit opt-in, its isolated DOM reader observes only the central conversation the user manually opens. It does not enumerate the inbox, use LinkedIn APIs or cookies, click controls, type, insert drafts, or send messages. This keeps the user in control.

## Deployment channels

- Production remains `https://chathelp-private-cloud.project-mission-ai.workers.dev/` until a public custom domain is purchased and explicitly attached.
- Testing uses the stable Worker route `https://testing-chathelp-private-cloud.project-mission-ai.workers.dev/`.
- GitHub remains the release source of truth. Cloudflare serves the verified static frontend assets and the private API from the Worker bundle built from that source.
- Testing and production use explicit Wrangler environments and separate Worker/database bindings. Deploy testing with `npm run deploy:cloudflare:testing`; it updates only the stable testing URL and cannot access the production database.
- Production deployment remains a separate, explicitly authorized action through `npm run deploy:cloudflare` after checks and testing pass.


## Guided LinkedIn profile test

After Cloudflare Access authentication, choose **Guided LinkedIn test** to walk through one explicitly selected profile and conversation. The profile URL is temporary, context capture/paste is user-directed, generation uses the consented Cloudflare AI service, and the final message is reviewed and sent manually. See [docs/LINKEDIN_TEST_WIZARD.md](docs/LINKEDIN_TEST_WIZARD.md).
