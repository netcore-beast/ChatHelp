# Design QA - integrated draft composer

## Sources

- DialogMint baseline: `C:/Users/anshj/AppData/Local/Temp/codex-clipboard-ecb4a26e-4bdf-44e0-b248-85d38087609d.png` (1158 x 457)
- Perplexity prompt reference: `C:/Users/anshj/AppData/Local/Temp/codex-clipboard-89e9ba8a-73d5-4839-a5e3-9f32decfe523.png` (1076 x 160)
- Perplexity progress reference: `C:/Users/anshj/AppData/Local/Temp/codex-clipboard-997c91b8-3187-4772-8989-7df0dfc156d3.png` (979 x 243)
- Generate-button reference: `C:/Users/anshj/AppData/Local/Temp/codex-clipboard-72403a62-7e7c-49e1-b15b-19d6cd067a84.png` (237 x 102)

## Rendered implementation

- Focused desktop card: `artifacts/dialogmint-composer-desktop.png` (712 x 236, desktop density 1x)
- Desktop loading state: `artifacts/dialogmint-composer-loading-full.png` (1440 x 900, density 1x)
- Desktop expanded AI steps: `artifacts/dialogmint-composer-ai-steps-full.png` (1440 x 900, density 1x)
- Focused narrow card: `artifacts/dialogmint-composer-mobile.png` (283 x 295 within a 320 x 900 viewport, density 1x)

## Comparison

The baseline, Perplexity prompt reference, and rendered desktop card were inspected together. The implementation keeps DialogMint's existing color, border, radius, and typography tokens while adopting the reference's dense integrated-composer behavior:

- the optional objective and action now share one bordered prompt surface;
- the static `Generate 3 Drafts` action is anchored at the lower-right without shifting the card;
- while processing, the label is replaced in-place by a rotating progress indicator and pulsing stop symbol, preserving the action footprint;
- the symbol-only processing control remains enabled so a click can abort the active request without displaying a false generation error;
- AI steps remain available as a compact collapsed row with a directional chevron;
- expanding AI steps reveals the actual four-stage pipeline without changing elements above the row;
- the 320px rendering stacks the role selector and playbook badge, keeps the text area resizable, and exposes a full-width action without clipped controls.

## Findings and fixes

1. The original action sat outside the objective surface and left excess vertical whitespace. Fixed by moving the existing button and status into an internal action rail.
2. The objective text area was too tall for an optional short instruction. Fixed with a smaller default and minimum height while preserving resize behavior.
3. Mobile needed a stable action width and wrapping status region. Fixed with the existing narrow breakpoint and no new visual tokens.
4. Loading and error resolution were exercised in the local preview. The button returned to its idle label after the request failed because the local Cloudflare Access session was intentionally unavailable; the AI steps panel remained expandable for diagnostics.
5. The supplied button crop and the rendered idle card were inspected together. The idle label remains exactly `Generate 3 Drafts`, while interaction tests verify the same button switches to the accessible `Stop generating drafts` processing control and restores its idle state after cancellation.

## Verification history

- Desktop idle: passed
- Desktop loading: passed
- Desktop expanded AI steps: passed
- Narrow 320px layout: passed
- Keyboard/ARIA coverage: passed by automated interaction tests
- Processing animation and mid-stream cancellation: passed by automated interaction tests
- Full automated suite: 172/172 passed

## Final result

passed

---

# Design QA - dark card theme

## Comparison setup

- Source: user-supplied `codex-clipboard-2a5b90db-0004-4fc6-8214-ccc9aeaf0353.png`.
- Implementation: PR #19 local browser capture at a 1280px desktop viewport.
- State: signed-out/empty local workspace with the default dark theme active.
- Scope: color palette, surface hierarchy, borders, and card treatment only. The existing DialogMint information architecture and behavior were intentionally preserved.

## Visual comparison

- The page canvas matches the reference's near-black foundation.
- Navigation, inbox, composer, draft, settings, and context surfaces use layered charcoal cards with thin low-contrast borders.
- Primary text remains bright and secondary text muted without reducing readability.
- DialogMint green remains the sole brand accent for active, success, and primary-action states.
- No Axora branding, layout, artwork, or proprietary graphics were copied.

## Interaction and responsive checks

- Dark mode is the default.
- The light/dark control is keyboard-accessible and persists only the appearance preference.
- The saved theme restores after reload.
- At 320px, the document width remains within the viewport and the theme control stays available.
- Browser console check completed with no application warnings or errors.

## Result

Passed. No P0, P1, or P2 visual defects were found. The only intentional difference is the underlying DialogMint workspace layout, which remains unchanged per the implementation constraint.

---

# Design QA - conversation inbox density and unread state

## Sources

- Current DialogMint contact context: `C:/Users/anshj/AppData/Local/Temp/codex-clipboard-96f2c9df-4bbe-42b2-a309-35bc227f1657.png`.
- LinkedIn conversation reference: `C:/Users/anshj/AppData/Local/Temp/codex-clipboard-802d3e54-a963-4d34-9080-d83436c3f798.png`.
- Local DialogMint preview with an incoming message and a user label, inspected in the in-app browser.

## Comparison and implementation

- The permanent left workspace rail was removed while navigation remains available from the compact `Workspace view` selector in the inbox header.
- The conversation inbox remains visible as the primary navigation surface.
- Selected conversation styling now uses a restrained green-to-charcoal gradient, a five-pixel green inset edge, and a low-contrast shadow. This follows the reference hierarchy without copying LinkedIn colors or trade dress.
- Conversation tiles no longer display derived workflow, synchronization, or pipeline chips. Only labels entered by the user are rendered.
- A new incoming message displays a compact green unread indicator anchored to the contact avatar. Explicitly opening that conversation clears the indicator.
- The visible contact name, profile URL, headline, company, and avatar remain populated only from the current LinkedIn conversation header exposed to the extension.

## Interaction and accessibility checks

- The workspace selector exposes all existing destinations and is keyboard accessible.
- The unread indicator has an accessible label naming the contact.
- The active tile remains a normal conversation button, so keyboard selection also marks the latest incoming message as read.
- The tile title, timestamp, preview, user labels, pin, and read-later controls remain usable without system chips.
- The desktop preview showed no clipped tile content or overlap between the unread marker and avatar.

## Result

Passed. The requested inbox hierarchy is present and the existing conversation, drafting, contact-context, and synchronization flows remain intact.
