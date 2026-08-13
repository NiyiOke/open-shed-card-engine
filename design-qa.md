# Action-card rules layout — design QA

## Evidence

- Source visual truth: `/var/folders/l9/m1ccvftn5w3bfjslr_p1l6rm0000gn/T/TemporaryItems/NSIRD_screencaptureui_PKkVVU/Screenshot 2026-08-13 at 19.32.04.png`.
- Source pixels and target CSS viewport: 1771 × 881 at device scale 1.
- Intended state: signed-out `#action-cards` rules section with both Action-card disclosures open.
- Browser-rendered post-fix implementation screenshot: unavailable. The selected Codex in-app browser rejected the local preview URL under its local-URL policy after the preview server was started, so a compliant fresh capture and same-viewport visual comparison could not be completed.

## Findings

- [P1, fixed in source] The four-card Wild Action panel was stretched to the height of the six-card Color Action panel, producing a large empty bordered block below Color Roulette. The shared two-column grid used CSS Grid's default cross-axis stretching. `.rules-guide-card-groups` now uses `align-items: start`, so each disclosure sizes to its own content while preserving equal column widths.
- Fonts and typography: unchanged by the fix.
- Spacing and layout rhythm: the only intended change is removal of the false empty height from the shorter Wild panel; card rows, column gap, borders, and the following section remain unchanged.
- Colors and visual tokens: unchanged.
- Image quality and asset fidelity: the existing semantic `CardFace` assets are unchanged.
- Copy and content: unchanged; all ten Action-card types remain rendered from the canonical rules registry.
- Accessibility and interaction: native `<details>/<summary>` behavior, focus styles, type counts, and the ≤720px one-column reflow are unchanged.

## Comparison history

1. The supplied 1771 × 881 screenshot exposed the P1 grid-stretch defect.
2. Source inspection confirmed six Color cards and four Wild cards share one grid row with default `align-items: stretch`.
3. The scoped `align-items: start` correction and a block-bounded regression contract were added. Focused rules tests, the full unit suite, TypeScript, lint, production build, diff-check, and client performance budgets pass.
4. A post-fix same-viewport browser capture remains blocked by the selected browser's local-preview URL policy. No visual pass is claimed from source/tests alone.

## Implementation checklist

- [x] Scope the fix to Action-card groups; leave scoring grids unchanged.
- [x] Preserve mobile one-column behavior and native disclosure semantics.
- [x] Add a regression contract that cannot match declarations outside the target CSS block.
- [x] Run focused and full automated release gates.
- [ ] Capture and compare the corrected 1771 × 881 public rules page in the selected browser.
- [ ] Recheck 1280px, 320px, and effective 200% zoom geometry before deployment.

final result: blocked
