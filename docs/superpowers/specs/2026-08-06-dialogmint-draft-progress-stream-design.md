# DialogMint compact drafting and live AI progress design

## Scope

This change compacts only the Inbox drafting composer, renames its primary action to **Generate 3 Drafts**, adds a stable loading treatment, and exposes the existing Cloudflare AI pipeline as a collapsed, accessible progress panel. Conversation selection, prompt construction, model selection, role playbooks, draft persistence, manual sending, encrypted recovery, extension synchronization, and the `/api/drafts` request body remain unchanged.

The verified build will be published to the existing `testing-chathelp-private-cloud.project-mission-ai.workers.dev` preview alias only. Production remains unchanged until separately approved.

## Composer layout

The existing `composer-card` retains its colors, typography scale, border, radius, and shadow. Its internal gaps and vertical padding become smaller. The heading, role selector/playbook summary, draft-context inspector, objective field, generate row, progress panel, and completion caption remain in the same order.

The optional objective textarea keeps its label and resizable behavior but uses a smaller default minimum height suitable for one or two lines. Existing responsive rules continue stacking the role selector and playbook summary. At widths down to 320px, controls may wrap or occupy the full available width, but text must remain visible and no horizontal clipping may be introduced.

The primary action label is always **Generate 3 Drafts**. Its occupied dimensions remain stable during generation. Pointer activation briefly scales the button down, followed by a disabled loading variant containing a CSS spinner and the label **Generating Drafts**. Transitions use a 150–250ms ease-out duration and respect `prefers-reduced-motion`.

## Progress interaction

The progress control appears directly below the generate row once a generation has started and remains available after success or failure. It is collapsed by default for each new request. The visible control contains a short label and an icon-only chevron button with an accessible name. The chevron points down when expanded and returns when collapsed.

The control uses `aria-expanded` and `aria-controls`. The panel remains in the document and animates between closed and open states with a grid-row/height transition instead of abrupt `display: none` changes. Its step list is announced through a polite live region without moving focus away from the Generate button.

The four user-facing steps are:

1. **Planning reply with Llama 3.1 8B** — parsing the grounded conversation and selected playbook digest.
2. **Drafting 3 replies with GPT-OSS 120B**.
3. **Reviewing drafts against the selected role rulebook** — includes the exact local rule-character count shown elsewhere in the composer.
4. **Finalizing drafts**.

Each step has one of `pending`, `in-progress`, `done`, or `error`. Pending uses a neutral marker, in-progress uses a small CSS spinner, done uses a checkmark, and error uses the existing error color. A successful request leaves the panel collapsed under the label **How this was generated** and retains a concise summary that the drafts were reviewed against the full selected-role rulebook in Cloudflare Workers AI and nothing was sent to LinkedIn. An error restores the normal button, retains the existing visible error notice, and leaves the progress panel available for diagnosis.

## Streaming API contract

`POST /api/drafts` keeps the existing JSON request schema and all authentication, origin, rate-limit, request-size, grounding, parsing, correction, and safety behavior.

The DialogMint client opts into streaming by sending `Accept: text/event-stream`. Clients that request JSON continue receiving the current JSON response unchanged.

For streaming clients, the Worker returns `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-store`, and `X-Accel-Buffering: no`. The response emits bounded UTF-8 Server-Sent Event frames:

- `event: stage` with `{ "stage": "planning|drafting|reviewing|finalizing", "status": "in-progress|done" }`
- `event: result` with the existing successful draft payload
- `event: error` with the same generic safe error message currently returned to JSON clients

The Worker emits stage events only at real pipeline boundaries. Planning completes after the Llama planner returns. Drafting completes after the first GPT-OSS writer call. Reviewing remains in progress through any existing quality-correction review calls and completes only after the final reviewed set passes deterministic validation. Finalizing covers final response validation and serialization.

The stream sends no prompts, conversation text, model output other than the final three drafts, credentials, internal provider errors, recovery data, or database content. Request-scoped stream state stays inside the request handler, every write is awaited, cancellation closes the writer, and failures close the stream after a safe error event.

## Client stream handling

`generateWithCloud` keeps the same arguments and return type. It requests SSE, incrementally parses bounded event frames from `response.body`, maps stage events to typed progress updates, parses the final payload with the existing draft sanitizer, and preserves the current safe error messages. It retains JSON parsing as a compatibility fallback when the response is `application/json`.

Progress updates use a typed object rather than display strings so the component can render stable labels and status indicators. Existing non-cloud generation progress remains compatible through the current string callback boundary.

The component stores only transient progress state. Stage events are not written to the encrypted vault, Neon, extension storage, draft history, or analytics. Switching contacts or roles during a request keeps the existing result-discard behavior and clears the transient progress view for the obsolete request.

## Error handling

- Authentication, rate limiting, invalid input, and pre-stream validation keep their existing HTTP JSON responses.
- Once an SSE response has started, pipeline failures use an `error` event and close the stream.
- A missing, malformed, oversized, or prematurely closed stream produces the existing generic Cloudflare AI failure in the UI.
- The button always returns to its normal enabled/disabled state in `finally`, whether generation succeeds, fails, or becomes obsolete after a role switch.

## Verification

Automated coverage will prove:

1. The client sends the unchanged request body with SSE content negotiation.
2. JSON responses remain supported for backward compatibility.
3. The Worker emits real planning, drafting, reviewing, finalizing, and result events in order.
4. Correction review calls do not falsely mark reviewing complete early.
5. Streaming errors expose no provider detail or conversation content.
6. The static button label, stable loading state, spinner, disabled behavior, and restoration work on success and failure.
7. The progress panel is collapsed by default, keyboard operable, correctly labeled, remains available after completion, and shows accurate role/rulebook information.
8. The compact textarea remains labeled, resizable, and responsive at 320px.
9. Existing exact-three-draft, role isolation, Cloudflare Access, encrypted recovery, CSP, extension boundary, and manual-send tests continue passing.

Release verification includes the full Vitest suite, ESLint, standard production build, static/native Cloudflare build, CSP injection and verification, extension-boundary verification, Wrangler dry run, and a testing-only preview deployment.
