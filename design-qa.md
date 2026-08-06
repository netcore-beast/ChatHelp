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
