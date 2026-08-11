# Cloud conversation-model architecture

DialogMint is local-first for workspace storage and manual-send workflow. Cloud inference is optional, explicitly consented to, and invoked only when the user requests one draft.

## Current testing architecture

`encrypted browser workspace → selected bounded context → authenticated Cloudflare Worker → Claude primary or Workers AI fallback → deterministic policy gate → one editable draft`

- Claude Opus 4.6 Thinking performs bounded analysis, single-reply writing, and independent review/rewrite.
- The permanent fallback preserves the earlier Llama 3.1 8B Fast analysis step and GPT-OSS 120B writer/reviewer steps.
- Both paths return the same exact one-draft schema and pass the same stage gate, 100-point rubric, ethical-selling rules, and deterministic output checks.
- Provider failures are classified before fallback. Authentication, authorization, invalid-input, and policy/quality failures do not trigger paid retry loops.
- Internal reasoning, scores, rejected drafts, prompts, request bodies, provider errors, and secret values are not returned, logged, or stored.
- The final user-visible draft remains editable and is never typed or sent automatically.

## Context and privacy boundary

Only the selected recent conversation, latest meaningful incoming message, active role playbook, up-to-2,000-character personal guidelines, conversation goal, manual relationship stage, bounded facts/questions, at most three approved learning examples, and optional reply objective can enter a generation request.

Model providers process this selected request as plaintext during inference. The product does not claim end-to-end encryption for inference. Screenshots, cookies, LinkedIn credentials, Cloudflare Access credentials, API keys, recovery keys, the full vault, unrelated contacts, and extension state are excluded.

The local workspace and optional recovery snapshot remain AES-256-GCM encrypted at rest. Responses use `Cache-Control: no-store`; no remote vector database, prompt analytics, or centralized plaintext learning corpus is added.

## Personal learning

Personal learning is disabled by default and retrieval-based. It does not fine-tune Claude or Workers AI. Only independently authored/licensed responses with explicit user attestation and eligibility can become local retrieval examples, with a maximum of three per request.

A narrow local classifier can learn relationship-stage suggestions from versioned bounded features and human-confirmed labels. Suggestions are non-authoritative and require a separate user action.

See [TRAINING_AND_LORA.md](TRAINING_AND_LORA.md) for export and training boundaries. Claude outputs and provider-assisted text are excluded from competing generative-model training exports.

## Future scale gates

Before expanding beyond testing:

- measure quality, latency, fallback rate, and cost using synthetic or approved evaluation conversations;
- define request and monthly spend ceilings, timeout behavior, and overload rejection;
- complete privacy, subprocessors, retention, incident-response, and deletion reviews;
- red-team prompt injection, cross-contact leakage, premature pitching, unsafe persuasion, and denial of service;
- keep model/prompt versions independently reversible and preserve the manual-send boundary;
- obtain separate approval before any production promotion, public domain, fine-tune, adapter upload, or new paid model resource.

Testing uses only `https://testing-chathelp-private-cloud.project-mission-ai.workers.dev/`. Production remains unchanged until separately authorized.
