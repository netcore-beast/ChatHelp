# ChatHelp

ChatHelp is a privacy-first web workspace for preparing thoughtful professional outreach from context a user intentionally supplies. It works with one selected person at a time, runs its language model in the browser, and never sends a message automatically.

## What is implemented

- On-device language generation with WebLLM and WebGPU; no external completion API.
- Llama 3.2 3B Instruct as the recommended private model and a 1B fallback for lower-memory devices.
- Three distinct message approaches generated from recent chat, profile context, a personal communication guide, the current agenda, and local feedback.
- Transparent deterministic templates when the private model is not loaded.
- Explicit one-shot screen capture using the browser's native permission picker.
- Local OCR with Tesseract.js, followed by mandatory review/redaction before text is saved.
- Chat import from JSON, CSV, and text; profile context import from JSON, Markdown, and text.
- Device-local contacts, guidance, reviewed capture text, drafts, and preference history.
- Manual copy for pasting after review.
- A privacy center and one-click workspace erasure.
- Responsive desktop and mobile web UI.

## Privacy boundary

ChatHelp does not use a hosted AI/LLM API. Conversation context is passed only to the model running in the browser.

The first model load downloads public model files from WebLLM's configured model host and caches them. The download is approximately 2.3 GB for the recommended model or 0.9 GB for the lightweight model. Private prompts and relationship data are not sent with that download.

The current workspace is stored in browser localStorage and is not yet encrypted at rest. It is specific to the browser profile and device. Clearing browser data removes it.

Read the detailed design and source research in docs/PRIVATE_AI_ARCHITECTURE.md.

## Why ChatHelp does not automate LinkedIn

LinkedIn's published rules prohibit third-party software and browser extensions that scrape or copy profile/service data, modify the site, or automate activity. ChatHelp therefore does not:

- call LinkedIn APIs;
- request or store LinkedIn credentials or tokens;
- read the LinkedIn DOM;
- inject a Grammarly-style overlay into LinkedIn;
- record in the background;
- paste or send a message automatically.

The compliant workflow is user-controlled: open LinkedIn, optionally take an explicit one-shot capture or import approved context, review/redact it, generate locally, copy a reviewed draft, and paste it manually.

## Codespaces development

All project commands should run in GitHub Codespaces. The repository includes a dev-container definition.

Install exactly from the lockfile:

    npm ci

Start the development server:

    npm run dev

Open forwarded port 3000 from the Codespaces Ports panel.

Validate:

    npm run lint
    npm run build
    npm audit --omit=dev

## Browser requirements

Private model generation requires a current browser with WebGPU enabled and enough memory for the selected model. If WebGPU is unavailable, ChatHelp keeps the transparent local-template workflow available.

Screen capture requires HTTPS, a user gesture, and browser permission every time. OCR runs locally but can make mistakes; always review extracted text.

## Data formats

Chat JSON can be an array or an object containing a messages array. Each message can include sender/from, text/content/message, and date/createdAt.

CSV should include a Content, Message, or Text column. Optional sender and date columns may be named From/Sender and Date/Time.

Profile JSON can include name, headline/title, company, location, notes, or summary.

## Roadmap

1. Dedicated Web Worker inference.
2. Encrypted IndexedDB and encrypted local backup.
3. Self-hosted, pinned model artifacts with integrity metadata.
4. Local retrieval over user-approved guidance and research documents.
5. Outcome notes and per-contact retention controls.
6. Installable PWA, followed later by an Android client reusing the same data model.

## Important

ChatHelp is not affiliated with LinkedIn. Users are responsible for having permission to use captured or imported information, following website terms, verifying OCR, and reviewing every generated message before use.
