# Rulebook-grounded three-stage drafting pipeline

Date: 2026-08-05
Status: Approved source design; implementation pending written-spec review
Target: ChatHelp testing environment only

## Objective

Make ChatHelp's three generated LinkedIn replies consistently respect the selected role's full `Rules every reply must follow`, the actual synchronized conversation, the latest meaningful message, the relationship goal, voice, and any optional reply objective.

The change preserves the current encrypted local vault, same-origin authenticated `/api/drafts` boundary, Cloudflare Workers AI models, exactly-three-drafts response contract, manual review/send boundary, and all LinkedIn synchronization behavior.

## Approaches considered

1. Keep the current two-call flow and strengthen its combined GPT-OSS writer/reviewer prompt. This is cheapest, but it does not implement the attached design's independent compliance pass and is less reliable for long rulebooks.
2. Run a third GPT-OSS review only after deterministic validation flags a draft. This reduces average cost and latency, but surface validators cannot reliably detect semantic violations of a long personalization rulebook.
3. Run Llama planning, GPT-OSS writing, and a separate GPT-OSS compliance review for every generation. This adds one GPT-OSS call, but most faithfully implements the approved document and maximizes rule adherence.

Selected: approach 3, as explicitly confirmed by the user by directing ChatHelp to follow the attached document.

## Data model and encrypted storage

Each role-specific playbook will store:

- `objective`: existing relationship goal;
- `boundaries`: existing full rulebook, capped at 50,000 characters;
- `rulebookDigest`: a compact, deterministic directive-only digest used by the Llama planner.

The workspace schema will be versioned forward while retaining normalization for existing vaults. Missing digests will be derived from the existing rulebook during migration, so no user data is lost and users do not need to re-enter settings. The full rulebook and digest remain inside the encrypted local vault.

Saving playbook settings regenerates the digest for the edited rules. The digest builder is local and deterministic: it prioritizes bullet/numbered rules and sentences containing directive language such as `must`, `never`, `always`, `do not`, `avoid`, and `required`; removes duplicates; preserves source order; and applies a bounded length. It does not call an AI service.

## Client request boundary

`buildCloudDraftRequest` will send only the selected role's data:

- role;
- relationship goal;
- voice;
- full rulebook;
- cached rulebook digest;
- optional reply objective;
- a bounded, structured conversation context built from the same relevant local data already used for drafting.

The structured conversation context includes the selected contact metadata, authoritative recent message sequence, latest reply target, relevant captured conversation text, bounded notes/supporting evidence, rejected recent draft suggestions, outcomes, and feedback. It excludes unrelated contacts, the complete vault, screenshots, navigation/sidebar material, access values, cookies, and authentication data.

Conversation content is serialized as untrusted data inside explicit blocks. Literal angle brackets in user-controlled data are escaped before model interpolation so a LinkedIn message cannot close a delimiter and become a model instruction.

The Worker will accept the new structured request and retain a legacy `prompt` fallback for a safe rollout. The current client will use the structured path so instructions and conversation data are no longer mixed in a single free-form prompt.

## Cloudflare Worker pipeline

### Stage 1: Llama planner

Model: `@cf/meta/llama-3.1-8b-instruct-fast`.

The planner system message receives the selected role, relationship goal, voice, and compact rulebook digest. Its user message receives the untrusted structured conversation context and optional objective. It never writes final reply copy.

It returns strict JSON containing:

- objective;
- conversation stage;
- facts that may be referenced;
- tone directives;
- things to avoid;
- reply-length hint;
- three materially different response directions.

### Stage 2: GPT-OSS writer

Model: `@cf/openai/gpt-oss-120b`.

The writer system message contains the full rulebook as non-negotiable instructions, followed by the existing role/goal/voice and safety constraints. Its user message contains only the Llama plan and the delimited untrusted conversation context.

It returns exactly three distinct draft objects with an internal angle and paste-ready text. The Worker strips the internal angle before returning the existing `{ drafts: string[] }` API response, so no Inbox rendering or draft-history contract changes are required.

### Stage 3: GPT-OSS compliance reviewer

The reviewer runs on every successful generation. Its system message receives the full rulebook and a static compliance task. Its user message receives the Stage 2 drafts and the same untrusted conversation context.

The reviewer must rewrite any draft that violates the rulebook, tone, relationship goal, factual conversation context, latest reply target, distinctness, or no-invention requirements. It returns the same strict three-draft schema.

### Structured output and recovery

All three stages request JSON Schema output where supported. Because model/runtime combinations can reject `response_format`, each stage has a bounded compatibility fallback that repeats the same strict JSON contract without schema mode. Responses are parsed defensively and must contain exactly three non-empty, distinct draft texts.

Existing deterministic checks remain in force for copied conversation messages, unsupported personal origin stories, excessive questions, and unsafe formatting. A bounded correction attempt may ask GPT-OSS to repair a failed set. Failure still returns the existing safe 502 response without exposing model output or internal prompts.

## Prompt-injection and privacy controls

- Static behavior instructions remain in system messages; per-contact conversation data remains in user messages.
- LinkedIn text, imported context, and Llama planning output are explicitly untrusted data and can never override system instructions.
- The Llama planner receives only the digest, never the full rulebook.
- The GPT-OSS writer and reviewer each receive the full selected-role rulebook.
- No timestamps or random identifiers are added to model system prompts.
- Requests and responses retain `Cache-Control: no-store`; the Worker adds no persistence, logs, gateway, analytics, or centralized conversation storage.
- No LinkedIn API, cookie, token, network, typing, clicking, or sending behavior changes.
- Drafts remain on-demand and require manual review and sending.

## User interface impact

No layout redesign is required. Existing Settings controls, role selection, file upload/download, Inbox composer, exactly-three editable draft cards, and manual-send controls remain unchanged.

The existing generation progress/status copy may be updated to accurately describe the three stages. `rulebookDigest` is an internal encrypted field and is not exposed as another user setting.

## Tests

Automated coverage will prove:

1. digest generation is deterministic, directive-focused, deduplicated, bounded, and regenerated after rule changes;
2. existing vaults migrate without losing full rules, goals, roles, contacts, or other data;
3. each role retains its own full rulebook and digest after refresh;
4. the request sends only the selected playbook plus bounded structured context;
5. blank objectives remain optional and provided objectives remain additive;
6. Llama receives the digest but not the full rulebook;
7. GPT-OSS writer and reviewer each receive the full rulebook;
8. normal generation makes one planner call, one writer call, and one reviewer call;
9. all stages use strict structured output with bounded compatibility fallback;
10. LinkedIn-message instructions remain untrusted data and cannot override the rulebook;
11. reviewer corrections still produce exactly three distinct paste-ready strings;
12. existing authentication, rate limiting, privacy, Cloudflare build, CSP, extension boundary, synchronization, and interaction tests remain passing.

## Release boundary

Implementation will use a focused `codex/` branch and be pushed to GitHub. It will be built and deployed only to the existing Project Mission testing preview alias under Cloudflare account `8c9e063cdf6a3f83f474a7535845cbb2`, preserving existing Worker variables with `--keep-vars`.

The production Worker and production Git branch will not be deployed or merged as part of this testing request. No additional Cloudflare Worker will be created.
