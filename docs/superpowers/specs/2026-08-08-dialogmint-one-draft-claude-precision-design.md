# DialogMint One-Draft Claude Precision Design

## Objective

DialogMint will generate exactly one highly precise, context-grounded LinkedIn reply per explicit user request. Claude Opus 4.6 Thinking is the primary inference model. The existing Cloudflare-hosted pipeline remains an explicit fallback. The feature preserves visible-conversation-only capture, encrypted local storage, Cloudflare Access authentication, manual review, and manual sending.

The reply must help the user build authentic professional relationships. It must learn about the other person before introducing a business, product, or opportunity, and it must never use pressure, manipulation, fake urgency, invented familiarity, or unsupported claims.

## Non-goals and invariants

- DialogMint does not send messages to LinkedIn.
- DialogMint does not type, click, scroll, open conversations, crawl the inbox, or use LinkedIn APIs.
- The extension continues reading only the visible central conversation after the user opts in and manually opens it.
- The Anthropic API key remains a server-side Cloudflare Worker secret named `ANTHROPIC_API_KEY`. It is never returned to the client, persisted in the workspace, logged, or placed in source control.
- Conversation content is sent for inference only after the user explicitly requests a draft and has accepted the updated cloud-inference disclosure.
- No prompt, model output, evaluation detail, or provider error is written to Worker logs or analytics.
- Exactly one final draft is returned and persisted. Intermediate plans, rejected drafts, reasoning, and rubric evaluations remain request-scoped and are discarded.
- Existing encrypted Neon recovery continues storing only client-encrypted workspace snapshots. Cloudflare, Anthropic, and Neon never receive the recovery key.

## Relationship-oriented conversation stages

Drafting uses a distinct relationship stage that must not be confused with DialogMint's existing CRM pipeline stage.

1. `new-connection` — establish a relevant, low-pressure opening.
2. `genuine-rapport` — build rapport from facts actually present in the conversation or profile context.
3. `learn-interests` — learn the person's interests, situation, priorities, or work.
4. `identify-need` — determine whether a real need or useful opportunity exists.
5. `ask-permission` — ask permission before discussing a business, idea, product, or opportunity.
6. `introduce-value` — explain only the value relevant to the discovered need.
7. `answer-without-pressure` — answer questions accurately without manufactured urgency or a forced close.
8. `voluntary-next-step` — suggest or confirm an optional next step.

The planner may recommend staying at the current stage or advancing by one stage. It may not skip discovery stages merely because the user's long-term goal is commercial. It may move backward when the latest message shows uncertainty, resistance, or a need for clarification. A negative or uninterested response must be respected.

The stored `conversationStage` is user-editable. The model can recommend a stage but cannot silently persist a new one. The final response payload may include a safe stage recommendation for the client to present separately from the draft; accepting it remains a user action.

## Encrypted context fields

The encrypted workspace schema gains:

- `personalDraftGuidelines`: workspace-level plain text inside the encrypted vault, normalized and limited to 2,000 Unicode characters;
- `draftingGoal`: per-conversation plain text inside the encrypted vault, normalized and limited to 1,000 Unicode characters;
- `conversationStage`: per-conversation relationship-stage enum;
- existing draft history continues storing only final drafts and provider/model provenance.

These values participate in encrypted recovery because they are inside the client-encrypted workspace snapshot. Extension storage remains unchanged and does not receive them.

The compact composer exposes the per-conversation goal and selected relationship stage without removing the left navigation or changing the collapsed-by-default right contact panel. Personal drafting guidelines belong in workspace settings because they apply across conversations. Empty values are allowed; the generation UI clearly indicates when guidelines or a goal are not configured.

## Request context contract

The browser sends the authenticated same-origin `/api/drafts` request only after explicit generation. The bounded request contains:

- selected role and complete role playbook;
- the visible conversation's normalized recent message history with speaker roles;
- the latest meaningful incoming message repeated in a dedicated field;
- `personalDraftGuidelines`, up to 2,000 characters;
- `draftingGoal`, up to 1,000 characters;
- selected `conversationStage`;
- available contact/profile facts already captured from the visible LinkedIn DOM;
- a request for exactly one final draft.

The latest meaningful incoming message is selected deterministically from normalized messages. User-provided and LinkedIn-derived content is serialized as untrusted data inside explicit delimiters. It cannot override system rules, the stage policy, the role playbook, or the output schema.

## Primary Claude precision pipeline

The Worker calls Anthropic from the server using model ID `claude-opus-4-6`. Adaptive thinking is enabled at a bounded effort appropriate for interactive latency. The Worker uses a request timeout and cancellation signal and never exposes provider reasoning.

### Stage 1: context and next-move plan

Claude receives the full bounded context and returns structured data containing:

- current stage and evidence from the conversation;
- whether the latest message contains a direct question that must be answered;
- known relevant facts and material unknowns;
- whether a genuine need has been established;
- the single safest next conversational objective;
- prohibited moves for this reply;
- a concise drafting plan.

The Worker validates the structured result. A plan that skips required relationship stages, invents a need, or contradicts the latest message is rejected.

### Stage 2: one candidate draft

Claude receives the validated plan plus the original bounded context and returns exactly one candidate reply. The reply must be concise enough for a professional social-platform conversation, directly relevant to the latest message, and natural when read aloud. It must not include analysis, scores, alternatives, labels, or quotation marks around the response.

### Stage 3: rubric evaluation and bounded repair

A fresh Claude call independently evaluates the candidate against the original context, validated plan, and rubric. It returns structured scores, critical-rule results, and exactly one final draft. When the candidate is acceptable, the final draft may be unchanged. When it is deficient, this call rewrites it once.

The Worker rejects the result rather than returning a draft when:

- the total score is below 90;
- conversation grounding, latest-message relevance, personal-guideline compliance, or goal/stage alignment falls below 80% of that dimension's weight;
- any ethical boundary fails;
- the output contains multiple drafts or internal analysis;
- deterministic checks find copied conversation text, unsupported personal history, unsafe formatting, or a business introduction before the required discovery and permission stages.

There is no unbounded retry loop. Provider failure or final validation failure produces a safe, non-sensitive error or an explicit Cloudflare fallback attempt.

## Precision-quality rubric

| Quality dimension | Weight | Required behavior |
| --- | ---: | --- |
| Conversation grounding | 25 | Correctly references the actual discussion without copying it mechanically. |
| Latest-message relevance | 20 | Directly answers or acknowledges the person's newest meaningful point. |
| Personal-guideline compliance | 15 | Follows the complete personal drafting guidelines, up to 2,000 characters. |
| Goal and stage alignment | 15 | Advances the proper relationship stage without pitching prematurely. |
| Human tone | 10 | Natural, concise, warm, and free of canned sales language. |
| Curiosity and need discovery | 5 | Learns about the person before recommending anything. |
| Technical/factual accuracy | 5 | Avoids unsupported claims and explains technology clearly. |
| Ethical selling boundaries | 5 | Uses no pressure, manipulation, fake urgency, or invented rapport. |

The rubric is an evaluation control, not a claim of objective certainty. Model-generated scores are combined with deterministic validation and representative product evaluations. Scores and reasoning are not shown as factual guarantees to the user.

## Cloudflare-hosted fallback

The existing Cloudflare Workers AI boundary remains available when Anthropic is unavailable, times out, is not configured, or reaches its budget limit. The fallback preserves the same single-draft request contract, stage policy, rubric, deterministic checks, and manual-send boundary.

Fallback is explicit in the streamed progress and final provenance. DialogMint must not claim that a Cloudflare-generated draft was reviewed by Claude. If both pipelines fail validation, the request fails safely without returning a low-confidence draft.

The initial implementation keeps the current Cloudflare models unless representative evaluations justify a separate model migration. Changing fallback models is not required for the Claude integration.

## Consent, privacy, and provider disclosure

The current consent copy is updated before Anthropic can be used. It states that the relevant visible conversation text, latest meaningful message, selected role playbook, personal drafting guidelines, conversation goal, stage, and available contact context will be processed by Anthropic through DialogMint's authenticated Cloudflare Worker when the user requests a draft.

The disclosure also states:

- screenshots, cookies, the full vault, recovery key, and access credentials are not included;
- Anthropic is an external inference provider with its own commercial data terms;
- Cloudflare-hosted fallback may be used and will be identified;
- nothing is sent to LinkedIn and the user must review and send manually.

Existing consent timestamps are not silently reused because the provider and disclosed data categories changed. The user must affirm the revised disclosure once before the first Anthropic request.

## Streaming and user experience

The existing progress stream is retained and adapted to one final draft. User-visible steps are concise and disclose no private content:

1. Understanding the conversation and current stage.
2. Planning the safest next move.
3. Writing one response.
4. Reviewing context, tone, goal, and boundaries.

Cancellation aborts in-flight provider requests where supported and stops subsequent stages. The final UI presents one editable draft, model provenance, and the existing copy/manual-send controls. It does not display hidden reasoning, rejected drafts, or raw rubric evaluation output.

## Error handling and operational controls

- Missing `ANTHROPIC_API_KEY` disables the primary pipeline and reports configuration status without revealing secret metadata.
- Anthropic 401/403, rate-limit, timeout, malformed-output, and upstream failures map to stable safe errors; raw provider bodies are never returned or logged.
- Request size, same-origin, Cloudflare Access, and rate-limit checks run before external inference.
- Per-request token/output limits and a total deadline bound cost and latency.
- Model provenance and coarse token/cost metadata may be recorded only if they contain no conversation content or secrets.
- A server-side kill switch can disable Anthropic without a client release.
- Dashboard-managed secrets are preserved during deployment with `--keep-vars`.

## Testing and evaluation

Automated tests cover:

- one-draft response schema and persistence;
- 2,000-character guideline normalization and enforcement;
- per-conversation goal and relationship-stage migration, encryption, recovery, and user editing;
- latest meaningful incoming-message selection;
- stage non-skipping, permission before introduction, rejection handling, and voluntary next steps;
- the exact rubric weights, threshold, critical-dimension floors, and ethical hard failure;
- prompt-injection resistance for conversation, profile, guideline, and goal fields;
- structured-output parsing, bounded repair, cancellation, timeouts, and safe errors;
- primary/fallback provenance and no false Claude attribution;
- updated consent gating and no request before consent;
- no API key, prompt, reasoning, draft, or provider error leakage to client diagnostics or logs;
- manual-send, extension-permission, visible-thread-only, encrypted-vault, Neon-recovery, CSP, and Cloudflare Access regression boundaries.

Representative evaluation fixtures cover new connections, genuine rapport, discovery, no demonstrated need, permission requests, relevant introductions, objections, disinterest, technical questions, ambiguous messages, and malicious prompt injection. Fixtures use synthetic data. A release candidate must meet the rubric threshold and hard boundaries across the agreed evaluation set before production deployment.

## Success criteria

The feature is complete when an authenticated, consented user can configure encrypted personal guidelines, a conversation goal, and relationship stage; request generation; receive exactly one validated draft from Claude Opus 4.6 Thinking or the identified Cloudflare fallback; review and edit it; and copy it for manual sending without any automation or secret exposure. Production deployment and live smoke testing remain separate, explicitly verified release steps.
