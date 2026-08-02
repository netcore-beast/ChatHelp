# ChatHelp private AI architecture

Last reviewed: 2026-07-28

## Product decision

ChatHelp is a user-controlled writing workspace, not a LinkedIn bot. It does not call LinkedIn APIs, read the LinkedIn DOM, inject controls into LinkedIn, run a background recorder, paste automatically, or send messages.

That boundary is intentional. LinkedIn says third-party browser extensions, crawlers, bots, and other software that scrape or copy profile/service data, modify the site, or automate activity are not permitted and can lead to account restriction. A Grammarly-style LinkedIn overlay or auto-sender would therefore create unacceptable account and compliance risk.

Official sources:

- LinkedIn prohibited software: https://www.linkedin.com/help/linkedin/answer/a1341387
- LinkedIn automated activity: https://www.linkedin.com/help/linkedin/answer/a1340567/automated-activity-on-linkedin
- LinkedIn User Agreement: https://www.linkedin.com/legal/user-agreement
- LinkedIn AI policy for developer data: https://learn.microsoft.com/en-us/linkedin/marketing/developer-ai-policy

## Private inference

The initial private AI provider is WebLLM. It runs an open instruction model through WebGPU inside the browser, without a ChatHelp model server or external completion API.

Default model:

- Llama 3.2 3B Instruct, 4-bit WebLLM build: recommended for the best quality that is still practical in a modern desktop browser.
- Llama 3.2 1B Instruct, 4-bit WebLLM build: lower-memory fallback.

The first use downloads model weights from WebLLM's configured model host. Those files are large and are cached by the browser. Prompts, chat history, profile notes, capture text, guidance, drafts, and feedback are not included in model-download requests and are passed only to the in-browser model.

For a later hardened release, model assets should be pinned to reviewed versions, checksummed, and self-hosted from the ChatHelp origin. That removes the third-party model-host request and provides stronger supply-chain control.

Official technical sources:

- WebLLM repository and supported models: https://github.com/mlc-ai/web-llm
- WebLLM API documentation: https://webllm.mlc.ai/docs/user/api_reference.html
- WebGPU browser inference alternative, Transformers.js: https://huggingface.co/docs/transformers.js/en/guides/webgpu
- Chrome built-in Prompt API and Gemini Nano: https://developer.chrome.com/docs/ai/prompt-api
- Chrome built-in AI hardware and download requirements: https://developer.chrome.com/docs/ai/get-started

## Context capture

Screen capture uses the standard getDisplayMedia browser API. It is intentionally one-shot:

1. The user clicks One-shot capture.
2. The browser shows its own tab/window picker.
3. ChatHelp receives a temporary stream.
4. ChatHelp draws one video frame to an in-memory canvas.
5. Every media track is stopped immediately.
6. The user explicitly starts local OCR.
7. Extracted text is shown in an editable review/redaction field.
8. Only reviewed text is added to the selected contact.

The permission cannot be silently persisted by ChatHelp. Secure context and a fresh user gesture are required by the browser.

Official sources:

- Screen Capture API: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia
- Tesseract.js local browser OCR: https://github.com/naptha/tesseract.js

## Storage and personalization

The current MVP uses browser localStorage for contacts, imported messages, profile notes, reviewed capture text, the personal guidance document, and feedback. WebLLM manages its own browser model cache.

Preference feedback is transparent prompt memory, not hidden fine-tuning. ChatHelp summarizes liked and disliked response approaches and includes that summary in future on-device prompts. The base model is not retrained.

Current limitations:

- localStorage is not encrypted at rest.
- Data is scoped to the browser profile and device.
- Clearing browser data removes the workspace.
- Model quality is limited by the user's hardware and the selected small model.
- A local model has no current-web research capability unless the user supplies sources or a future local retrieval system indexes approved material.
- OCR can make mistakes, so review is mandatory.

## Threat and compliance controls

- No LinkedIn tokens or credentials.
- No LinkedIn API routes.
- No content script or browser extension.
- No DOM scraping.
- No auto-paste or auto-send.
- No continuous capture.
- Explicit capture permission every time.
- One selected contact per workspace view.
- Manual review before context is saved and before a message is used.
- One-click browser workspace erasure.

## Next hardening work

1. Move private inference to a dedicated Web Worker so long generation cannot block the interface.
2. Evaluate opt-in cloud synchronization and recovery separately from the current device-only encrypted vault.
3. Design a recovery mechanism before reintroducing encrypted backup/export.
4. Self-host pinned model artifacts with integrity metadata.
5. Add local retrieval over user-approved guidance and reference documents.
6. Add outcome notes and per-contact retention controls.
7. Add installable PWA support; reuse the web domain and data model for Android after the workflow is mature.
