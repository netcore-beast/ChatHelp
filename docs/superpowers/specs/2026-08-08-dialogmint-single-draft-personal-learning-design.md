# DialogMint stage-aware single-draft and personal-learning design

Date: 2026-08-08
Status: Approved source design; implementation pending written-spec review
Target: Project Mission testing environment only

## Objective

Replace DialogMint's exactly-three-drafts workflow with one exceptionally precise, context-grounded LinkedIn reply. The primary pipeline uses Claude Opus 4.6 Thinking to analyze the relationship stage, draft one reply, and independently review or rewrite it against a 100-point rubric. A Cloudflare-hosted pipeline remains available as the privacy-preserving fallback.

The feature also adds opt-in, encrypted personalization that learns through retrieval of user-owned examples rather than silently changing model weights. A later training phase may build a narrow local relationship-stage classifier from human-confirmed labels and may prepare a compatible LoRA experiment from independently user-authored or properly licensed data. Claude outputs must never be used as training targets for a competing open-ended generative model without Anthropic's written permission.

The change preserves these existing invariants:

- Manifest V3 extension and optional LinkedIn host permission, off by default;
- visible-central-conversation-only synchronization;
- no LinkedIn API, inbox crawling, automated navigation, typing, clicking, or sending;
- encrypted local vault and opaque 90-day encrypted Neon recovery snapshots;
- Cloudflare Access authentication without exposing or repurposing Access credentials;
- manual review, copy, and send;
- no plaintext conversation persistence in Cloudflare, Anthropic configuration, extension storage, logs, analytics, or model-training storage;
- no production deployment or GitHub merge in this testing release.

## Approaches considered

### One model call returning one draft

This is cheapest and fastest, but the same response has no isolated planning or compliance pass. It cannot reliably prove that the latest message, 2,000-character personal guidelines, goal stage, factual boundaries, and ethical-selling constraints were all applied.

### One Claude call plus deterministic validation

This catches formatting, length, copying, and basic prohibited phrases, but cannot reliably identify premature pitching, invented rapport, weak need discovery, or subtle goal-stage violations.

### Three isolated Claude calls returning one final draft

One request analyzes context, one writes a single candidate, and one independently scores and rewrites it when necessary. This costs more, but it gives each responsibility a bounded schema and directly implements the approved precision rubric.

Selected: three isolated Claude Opus 4.6 calls, with the established two-model Cloudflare-hosted pipeline permanently retained as the fallback and adapted to return the same single-draft contract.

## Release phases

The work is delivered sequentially so each phase is independently testable and reversible.

1. **Phase 1 — stage-aware single-draft generation:** one final draft, Claude primary, Cloudflare fallback, structured context, relationship stages, 100-point review, revised consent, and safe progress streaming.
2. **Phase 2 — encrypted personal learning without weight training:** user-owned feedback and example retrieval, entirely opt-in and locally encrypted.
3. **Phase 3 — narrow training preparation and classifier experiment:** human-confirmed stage labels, consented/redacted dataset export, local classifier evaluation, and a gated LoRA compatibility path. No Claude-output distillation and no automatic upload or fine-tune.

The testing deployment occurs only after all implemented phase gates and the full release suite pass.

## Phase 1: stage-aware single-draft generation

### Relationship-stage model

Drafting uses this ordered enum:

1. `new_connection` — New connection
2. `genuine_rapport` — Build genuine rapport
3. `learn_interests` — Learn interests and situation
4. `identify_need` — Identify a relevant need
5. `ask_permission` — Ask permission to discuss an idea
6. `introduce_value` — Introduce relevant business or product value
7. `answer_without_pressure` — Answer questions without pressure
8. `voluntary_next_step` — Agree on a voluntary next step

The selected conversation stores a manually controllable `relationshipStage`, defaulting to `new_connection`, and a bounded `conversationGoal`. The planner returns an observed stage and evidence, but generation may not advance more than one stage beyond the stored stage. If evidence is insufficient, the effective stage moves backward to discovery rather than inventing justification for a pitch.

DialogMint does not silently persist a planner's stage suggestion. A compact control lets the user confirm or change the stage. The generated response follows the effective stage for the current request, while permanent stage changes remain user-controlled.

### Personal guidance and role playbook

The existing role-specific playbook remains intact, including its encrypted full boundaries/rulebook. A separate `personalGuidelines` value, capped at exactly 2,000 Unicode characters after normalization, stores concise cross-role conversational preferences. It is encrypted with the workspace and never written to extension storage.

For each generation, the selected role contributes its role, objective, voice, full rulebook, and digest. The workspace contributes `personalGuidelines`. The selected conversation contributes `conversationGoal` and `relationshipStage`.

### Structured context contract

The client sends only data relevant to the selected conversation:

- authoritative recent messages with explicit `self` and `contact` speaker labels;
- latest meaningful incoming message repeated in a dedicated field;
- selected contact name and available profile metadata;
- selected role, relationship objective, voice, full rulebook, and digest;
- personal guidelines, capped at 2,000 characters;
- conversation goal and current relationship stage;
- bounded notes, outcomes, prior rejected suggestions, and relevant captured evidence;
- request-scoped known facts and unanswered questions when already available locally.

The request excludes unrelated contacts, screenshots, cookies, access credentials, API secrets, recovery keys, complete vault contents, sidebar/navigation text, and extension synchronization internals.

All contact-controlled text is serialized as untrusted data. Static model behavior, rubric, and ethical boundaries remain in system instructions. User-controlled strings cannot close instruction delimiters or override system requirements.

### Provider routing

Primary provider: Anthropic Messages API using model ID `claude-opus-4-6` with supported thinking/effort configuration and structured JSON output.

The Worker accesses the already dashboard-configured `ANTHROPIC_API_KEY` secret through `env`. The value is never returned, logged, written to configuration, placed in a command, or exposed to the client. Health output may report only `anthropicConfigured: true|false`.

Cloudflare fallback permanently retains the two earlier models:

- planner: `@cf/meta/llama-3.1-8b-instruct-fast`;
- writer and independent reviewer: `@cf/openai/gpt-oss-120b`.

These two models remain configured and tested in every release even when Anthropic is healthy. They are fallback capacity, not additional paid calls on every successful Claude request. The fallback preserves the same context contract, relationship-stage gates, 100-point rubric, bounded single rewrite, and exactly-one-draft response as the Claude path.

Fallback is used only for provider unavailability, safe timeout, supported rate-limit failure, or an explicit testing override. Invalid requests, failed authentication, rubric failures, and policy violations do not trigger provider fallback. The final response identifies only the safe provider label needed by the UI; it exposes no internal error or prompt.

### Stage 1: context analysis

The planner returns strict JSON containing:

- `storedStage`;
- `observedStage`;
- `effectiveStage`;
- `nextAllowedStage`;
- `latestIncomingIntent`;
- `knownFacts` containing only conversation-supported facts;
- `unansweredQuestions`;
- `goalForThisReply`;
- `toneDirectives`;
- `prohibitedMoves`;
- `replyPlan`;
- `evidence` with bounded message references rather than copied paragraphs.

The planner never writes final reply prose. It must prefer learning and clarification when the recipient's need is unknown. It cannot recommend introducing a business, opportunity, or product before the permission stage unless the recipient explicitly requested that information.

### Stage 2: one-draft generation

The writer receives the structured plan, the same bounded untrusted conversation context, the full selected-role playbook, and personal guidelines. It returns exactly one draft object containing internal metadata and paste-ready text.

The draft must:

- directly acknowledge or answer the latest meaningful incoming message;
- advance only the `goalForThisReply` and no later stage;
- sound natural, concise, warm, and specific to the real conversation;
- avoid canned networking language, fake familiarity, unsupported personal claims, fake urgency, pressure, or manipulation;
- ask at most one meaningful question unless the conversation explicitly requires otherwise;
- avoid introducing a business or product until need and permission conditions are satisfied;
- remain manual-review-only and never be inserted into LinkedIn automatically.

### Stage 3: independent 100-point review and rewrite

The reviewer receives the candidate, analysis, full rulebook, personal guidelines, goal/stage state, and untrusted conversation context. It scores these exact dimensions:

| Dimension | Weight | Pass requirement |
|---|---:|---|
| Conversation grounding | 25 | References the actual discussion without copying it mechanically |
| Latest-message relevance | 20 | Directly answers or acknowledges the newest meaningful point |
| Personal-guideline compliance | 15 | Follows the complete 2,000-character guidance and selected role playbook |
| Goal and stage alignment | 15 | Advances only the proper stage and never pitches prematurely |
| Human tone | 10 | Natural, concise, warm, and free of canned sales language |
| Curiosity and need discovery | 5 | Learns before recommending when relevant information is missing |
| Technical/factual accuracy | 5 | Uses supported facts and explains technical subjects accurately |
| Ethical selling boundaries | 5 | Contains no pressure, manipulation, fake urgency, or invented rapport |

The result passes only when the total is at least 90 and all critical rules pass. Critical failures include unsupported factual claims, invented personal familiarity, deceptive identity, premature business/product introduction, manipulation, pressure, or copying the recipient's message as the response.

The reviewer rewrites a failed candidate once and rescored output must pass deterministic and schema validation. A second failure returns the existing generic safe generation error. Internal analysis, scores, rejected drafts, chain-of-thought, and provider errors are not returned or persisted.

### API response and progress

The successful JSON contract becomes:

```json
{
  "draft": "One paste-ready response",
  "model": "claude-opus-4-6",
  "provider": "anthropic",
  "mode": "stage-aware-single-draft-v1"
}
```

Streaming clients receive these request-scoped stages:

1. `analyzing`
2. `drafting`
3. `reviewing`
4. `finalizing`

The stream contains only stage/status metadata and the final safe result. It never emits prompts, conversation excerpts, scores, reasoning, rejected candidates, credentials, or internal provider errors.

The UI action becomes **Generate Precise Draft**. Exactly one editable draft card is shown. Existing draft history records the final returned text and provider/model label but not hidden analysis. Manual copy/send behavior remains unchanged.

### Consent and privacy

Cloud inference remains opt-in. Updated consent states that, only when the user requests a draft, relevant visible conversation text, role playbook, personal guidelines, and goal/stage context are sent through DialogMint's authenticated Cloudflare Worker to Anthropic, with Cloudflare-hosted models available as fallback.

The consent must not claim end-to-end encryption during inference. It must clearly distinguish the encrypted-at-rest vault/recovery design from plaintext processing required by the selected model provider. The application never sends the recovery key, entire vault, Access credentials, API key, cookies, screenshots, or unrelated conversations.

Requests and responses use `Cache-Control: no-store`. DialogMint adds no provider prompt logging, AI Gateway logging, analytics, or plaintext persistence.

## Phase 2: encrypted personal learning without weight training

### Purpose

Personal learning adapts future prompts by retrieving a small number of user-approved examples and preferences. It does not fine-tune Claude, a local LLM, or Workers AI and does not imply that a normal inference request teaches a model.

### Feedback data model

Each encrypted feedback record contains:

- stable local ID and conversation ID;
- relationship stage and conversation-goal snapshot;
- generated provider/model label;
- action: `accepted`, `edited`, or `rejected`;
- optional user-authored preferred response;
- optional outcome and short reason;
- origin: `provider_assisted` or `independently_user_authored`;
- `eligibleForRetrieval`, default `false`;
- creation/update timestamps already allowed inside the encrypted vault.

Provider-generated and provider-assisted text may remain in ordinary encrypted draft history for workflow continuity, but it is never eligible as a training target for a competing model. Cross-model learning eligibility requires the user to explicitly attest that an example is independently authored or properly licensed.

### User controls

Feedback collection is off by default. The user may accept, edit, reject, and optionally record a reason or outcome. A separate unchecked control allows an independently authored example to become eligible for retrieval. The UI explains that retrieval uses the example as context and does not retrain a model.

The user can list, disable, edit, or delete learning examples. These actions update only the encrypted workspace and its opaque encrypted backup. Extension storage retains none of this data.

### Retrieval

Retrieval is local and deterministic. It matches relationship stage, selected role, goal keywords, and bounded outcome metadata, then selects at most three eligible examples. It excludes the current contact's private facts unless that example belongs to the same conversation and is already present in the selected context.

The client sends selected examples in a clearly delimited untrusted block. Examples can influence tone and structure but cannot override the current conversation, latest message, role rulebook, personal guidelines, stage gate, or ethical boundaries.

Retrieval failure or an empty example set silently falls back to the Phase 1 prompt. No remote vector database, analytics service, or centralized plaintext corpus is added.

## Phase 3: narrow training preparation and classifier experiment

### Legal and product boundary

Anthropic's published policy prohibits using Claude outputs as targets to train a general-purpose chatbot or open-ended text-generation model without written permission. Therefore:

- Claude outputs, reviewer rewrites, hidden analysis, and provider-assisted edits are excluded from all generative training exports;
- DialogMint will not distill Opus 4.6 into its browser model or a Workers AI model;
- any future exception requires separate written Anthropic permission and a new approved design;
- specialized classification may use human-confirmed labels, but this release does not depend on Claude-generated labels.

### Local stage classifier

The first trainable component is a narrow relationship-stage classifier, not a reply generator. Its job is to suggest one of the eight stages from bounded, locally derived features. The user remains authoritative and can correct every suggestion.

Training records contain human-confirmed stage labels and redacted/bounded features. Raw full conversations are not required for the export. The classifier must run locally, return confidence, and fall back to `new_connection` or the stored manual stage below the approved confidence threshold.

The trained artifact is versioned with its dataset schema, label set, evaluation metrics, and source-data policy. It cannot generate text, send network requests, advance a stage automatically, or bypass the Phase 1 planner.

### Training export

Dataset export is a deliberate user action from Settings. The export includes only records marked eligible and displays a pre-export count by origin and stage. It excludes secrets, recovery keys, contact identifiers, profile URLs, raw provider reasoning, Claude-generated drafts, provider-assisted text, unrelated notes, and unapproved conversations.

The exporter produces versioned JSONL suitable for local classifier training and, in a separately labeled file, independently user-authored generative examples. Export does not automatically upload or start training.

### Optional local/open-weight LoRA path

DialogMint may include documentation and validation for training a LoRA outside the browser on an explicitly selected open-weight base model. In-browser Qwen 0.5B inference remains a fallback; browser training is not promised because memory, GPU, thermal, and training-runtime requirements are not reliable across customer devices.

Only independently user-authored or properly licensed examples may enter a generative LoRA dataset. A compatible adapter must pass schema, provenance, license, privacy, and quality checks before it can be considered for inference.

### Optional Cloudflare LoRA path

Workers AI LoRA inference is open beta and limited to compatible non-quantized Mistral, Gemma, or Llama bases and adapter constraints. The current fallback models, Llama 3.1 8B Fast and GPT-OSS 120B, are not assumed to be fine-tunable through this path; any future LoRA experiment requires a separately selected, currently supported base.

This testing release may validate adapter compatibility and configuration structure but will not create or upload a Cloudflare fine-tune unless all of these gates are met:

1. sufficient eligible, non-Claude training data exists;
2. the user separately approves the exact dataset count, base model, license, cost, and upload;
3. the active Cloudflare account is Project Mission account `8c9e063cdf6a3f83f474a7535845cbb2`;
4. a currently supported, non-deprecated LoRA base is documented by Cloudflare;
5. offline evaluation meets or exceeds the approved thresholds;
6. no credential value is exposed to Codex, source, commands, files, logs, or chat.

If any gate is missing, Phase 3 completes with the local classifier, exporter, compatibility report, and no Cloudflare fine-tune resource.

## Error handling and cost controls

- Missing Anthropic configuration produces a safe fallback decision, never the secret name or provider response body.
- Provider timeouts are bounded and request cancellation is propagated.
- Anthropic 401/403 errors do not reveal account or key details and do not trigger repeated paid retries.
- Rate limits retain the existing per-identity/request controls and add a bounded provider-attempt count.
- One generation permits at most one call per normal stage plus one reviewer rewrite; there is no unbounded agent loop.
- A final response is stored only after it passes schema, deterministic, stage, and ethical validation.
- Usage metadata may count requests and tokens without recording prompts or replies.

## Testing strategy

### Phase 1 automated tests

1. existing encrypted workspaces migrate without data loss;
2. personal guidelines normalize and cap at 2,000 characters;
3. relationship stage defaults safely and round-trips through encryption/recovery;
4. request construction includes only the selected bounded context and repeats the latest meaningful incoming message;
5. unrelated contacts, credentials, screenshots, recovery material, and extension state are excluded;
6. prompt-injection strings remain untrusted data;
7. normal Claude generation makes exactly one analysis, one writer, and one reviewer call;
8. reviewer rewrite is bounded to one correction attempt;
9. total score below 90 fails and every critical violation fails regardless of total;
10. a recipient with no established need cannot receive a business/product pitch;
11. generation cannot advance more than one relationship stage;
12. output contains exactly one non-empty draft;
13. SSE stages occur in order and expose no prompt, score, reasoning, rejected draft, or provider error;
14. safe Cloudflare fallback permanently retains Llama 3.1 8B planning plus GPT-OSS 120B writing/review and uses the identical response schema;
15. authentication, origin, content type, body size, cancellation, rate limiting, and no-store behavior remain enforced;
16. the UI renders one editable card, updated consent, progress, failure recovery, and manual-copy boundary.

### Phase 2 automated tests

1. feedback collection defaults off and learning eligibility defaults false;
2. provider-assisted content cannot become a generative-training target;
3. only explicitly eligible examples participate in retrieval;
4. retrieval selects at most three examples with deterministic ordering;
5. current conversation and rulebook outrank retrieved example wording;
6. deleting/disabling an example removes it from retrieval and encrypted recovery state;
7. no learning record enters extension storage, telemetry, logs, or plaintext cloud storage;
8. empty/corrupt learning data fails closed to Phase 1 behavior.

### Phase 3 automated tests

1. export excludes Claude/provider-assisted text, identifiers, secrets, and unapproved records;
2. export schema and relationship-stage labels are versioned and deterministic;
3. classifier training/evaluation uses human-confirmed labels only;
4. classifier confidence fallback preserves the manual stored stage;
5. classifier cannot generate replies, perform network access, or change stage state;
6. LoRA validator rejects unsupported model types, ranks, sizes, filenames, provenance, and licenses;
7. Cloudflare upload remains disabled unless every explicit gate is satisfied;
8. synthetic fixtures contain no real conversation or secret data.

### Release verification

The complete testing report must include:

- targeted red/green test evidence for every implementation task;
- full Vitest suite;
- ESLint;
- standard Next.js production build;
- native/static Cloudflare build;
- CSP injection and verification across exported HTML;
- Chrome extension boundary verification;
- Wrangler production-style dry run for the testing target with existing variables preserved;
- static secret scan confirming no Anthropic value or other credential entered source/output;
- Cloudflare account and Worker-name verification without inspecting credentials;
- testing-only deployment result and version ID;
- `/health` verification showing only safe binding/configuration status;
- live unauthenticated boundary checks;
- an authenticated synthetic draft smoke test performed only through the user's trusted Cloudflare Access session if required.

## Deployment boundary

All Cloudflare work targets only the account identified by `project.mission.ai@gmail.com`, account ID `8c9e063cdf6a3f83f474a7535845cbb2`.

The release targets only:

`https://testing-chathelp-private-cloud.project-mission-ai.workers.dev/`

The existing `chathelp-private-cloud` Worker and testing routing/configuration are reused. No new Worker, public domain, production deployment, production database change, production Git merge, or netcore resource is authorized.

Deployment preserves dashboard-managed variables and secrets, including the user-confirmed `ANTHROPIC_API_KEY`, without reading or validating its value. The production URL `https://chathelp-private-cloud.project-mission-ai.workers.dev/` remains unchanged.

## Success criteria

The testing release succeeds when:

1. one user request produces exactly one editable, context-grounded final draft;
2. the reply follows the eight-stage relationship progression and 100-point rubric;
3. the latest incoming message, selected conversation, personal guidelines, role playbook, and goal are all demonstrably enforced by tests;
4. no premature pitch, fabricated rapport, manipulative urgency, or automated LinkedIn action is possible through the intended flow;
5. Claude is primary, the earlier Llama 3.1 8B plus GPT-OSS 120B Cloudflare pipeline always remains available as a bounded fallback, and provider details remain safely disclosed;
6. personal learning is opt-in, encrypted, reversible, and retrieval-based;
7. Claude outputs are excluded from competing generative-model training;
8. the narrow local stage classifier and training exporter meet their privacy and provenance gates;
9. no Cloudflare LoRA resource is created without the separately enumerated approvals and eligible dataset;
10. the full existing and new test suite passes and the verified build is deployed only to the testing URL.
