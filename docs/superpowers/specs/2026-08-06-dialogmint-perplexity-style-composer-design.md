# DialogMint Perplexity-style compact composer design

## Scope

This change refines only the Inbox **Reply to [Contact]** drafting card. It translates the compact prompt-composer hierarchy in the approved Perplexity reference into DialogMint's existing visual system. DialogMint's colors, fonts, type scale, radii, borders, accessibility behavior, streamed AI stages, request payload, role playbooks, draft logic, encrypted storage, LinkedIn synchronization, and manual-send boundary remain unchanged.

The change extends the existing `codex/draft-progress-stream` implementation. It does not add another animation package or alter the `/api/drafts` protocol.

## Approved layout

The role selector and playbook summary remain a compact two-column row above the draft-context disclosure. At narrow widths they stack in the existing order without clipping.

The objective label remains above a single integrated prompt composer. The existing textarea becomes borderless inside that composer and starts at approximately two lines of text. It remains vertically resizable. A compact action rail sits inside the same bordered surface beneath the textarea, matching the structural hierarchy of the Perplexity reference without copying its styling.

The action rail places the existing green **Generate 3 Drafts** button at the lower-right. Its current disabled rules, accessible busy state, CSS spinner, 150-250ms ease-out transition, and success/error reset behavior stay intact. The rail reserves enough height for both normal and loading labels so generation causes no layout shift.

The AI progress disclosure remains directly below the integrated composer. Its collapsed state is a thin row containing **AI steps** and a chevron only. The chevron points right while collapsed and rotates downward while expanded. The expanded content continues showing the four real streamed stages and completion summary. Expansion uses the existing animated grid-row technique and does not move focus.

## Spacing and responsive behavior

The outer card keeps its current border, radius, shadow, colors, and type scale. Only spacing and sizing values change:

- reduce vertical gaps between the card header, role row, draft context, objective label, prompt composer, and AI steps;
- reduce padding inside the card, role controls, context disclosure, integrated composer, action rail, and AI steps disclosure;
- reduce the textarea's initial height while preserving its resize handle and readable line height;
- remove redundant vertical space formerly created by a separate generate row;
- keep minimum touch/focus targets usable without increasing the card's idle height unnecessarily.

At widths down to 320px, the role controls stack, the prompt composer remains full-width, and the button becomes full-width within its action rail. Typed text never sits beneath the button or resize handle, and no horizontal scrolling is introduced by this component.

## Component boundaries

`ChatHelpApp.tsx` continues owning generation state and request behavior. It changes only the drafting-card markup needed to group the objective textarea and generate action inside a shared composer surface.

`DraftProgressPanel.tsx` continues owning the disclosure control, accessible state, streamed stage list, and completion summary. Its behavior and public props remain unchanged.

`globals.css` owns the visual refinement. Existing selectors and design tokens are reused; no new color, font, radius, animation library, or unrelated layout system is introduced.

## Data flow and errors

Clicking **Generate 3 Drafts** follows the current flow: the button enters its stable loading state, `/api/drafts` receives the unchanged request payload, real SSE stage events update the AI steps panel, and the button returns to normal when the request succeeds, fails, or becomes obsolete.

Existing Cloudflare Access, validation, model, rate-limit, network, and safe-error handling remain unchanged. The error notice continues rendering outside the integrated composer so long messages do not distort its action rail. The AI steps disclosure remains available after success or failure.

## Accessibility

The objective textarea keeps its existing label association. The generate button keeps its accessible name, disabled state, focus treatment, and `aria-busy`. The AI steps trigger keeps `aria-expanded`, `aria-controls`, keyboard activation, and a clear accessible name. Motion continues respecting `prefers-reduced-motion`.

## Verification

Automated coverage will confirm:

1. The action label remains exactly **Generate 3 Drafts** in idle state.
2. The integrated composer retains the labeled, resizable objective textarea and contained generate action.
3. Loading remains disabled, animated, stable in size, and resets on success and error.
4. AI steps starts collapsed, toggles by keyboard, rotates its chevron, and remains available after completion.
5. Streamed planning, drafting, reviewing, and finalizing statuses remain unchanged.
6. The component stacks without clipping at a 320px viewport.
7. Existing draft payload, role isolation, exact-three-draft, Cloudflare Access, encrypted backup, extension boundary, CSP, and manual-send tests continue passing.

Visual verification will compare the rendered DialogMint card with the supplied DialogMint and Perplexity references at the same desktop state, then repeat at 320px. Any visible spacing, clipping, overlap, or layout-shift issue must be corrected before handoff.

This refinement is prepared for the existing testing environment only unless the user separately authorizes a production deployment.
