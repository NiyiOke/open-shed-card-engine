# Action-card rules layout — design QA

## Evidence

- Source visual truth: `/var/folders/l9/m1ccvftn5w3bfjslr_p1l6rm0000gn/T/TemporaryItems/NSIRD_screencaptureui_PKkVVU/Screenshot 2026-08-13 at 19.32.04.png`.
- Browser-rendered production implementation: `/tmp/open-shed-action-cards-fixed-1764x881.png`.
- Full-view side-by-side comparison: `/tmp/open-shed-action-cards-before-after.png`.
- Source and implementation pixels: 1764 × 881 at device scale 1.
- Intended state: signed-out `#action-cards` rules section with both Action-card disclosures open.

## Findings

- No actionable P0, P1, or P2 findings remain.
- [P1, fixed] The four-card Wild Action panel was stretched to the height of the six-card Color Action panel, producing a large empty bordered block below Color Roulette. The shared two-column grid used CSS Grid's default cross-axis stretching. `.rules-guide-card-groups` now uses `align-items: start`, so each disclosure sizes to its own content while preserving equal column widths.
- Fonts and typography: unchanged by the fix.
- Spacing and layout rhythm: the only intended change is removal of the false empty height from the shorter Wild panel; card rows, column gap, borders, and the following section remain unchanged.
- Colors and visual tokens: unchanged.
- Image quality and asset fidelity: the existing semantic `CardFace` assets are unchanged.
- Copy and content: unchanged; all ten Action-card types remain rendered from the canonical rules registry.
- Accessibility and interaction: native `<details>/<summary>` behavior, focus styles, type counts, and the ≤720px one-column reflow are unchanged.
- Responsiveness: production geometry is clean at 1764, 1280, and 320 CSS pixels. At 1764, the Wild panel ends one pixel after Color Roulette with no false empty region. At 1280, the groups remain two equal 608-pixel columns and the Wild panel remains independently shorter. At 320, both groups stack in one 292-pixel column with the 16-pixel grid gap, 52-pixel summary controls, and no page-level horizontal overflow.
- Console: the production rules page emitted no warnings or errors during the responsive checks.

## Comparison history

1. The supplied 1771 × 881 screenshot exposed the P1 grid-stretch defect.
2. Source inspection confirmed six Color cards and four Wild cards share one grid row with default `align-items: stretch`.
3. The scoped `align-items: start` correction and a block-bounded regression contract were added. Focused rules tests, the full unit suite, TypeScript, lint, production build, diff-check, and client performance budgets pass.
4. Production was captured at the source's exact 1764 × 881 dimensions. The side-by-side comparison shows the Wild border now ending directly below Color Roulette while the taller Color group continues normally.
5. Production geometry checks confirmed ten cards, `align-items: start`, one pixel of normal border after each final card, following content below the taller group, and no horizontal overflow at desktop or mobile widths.

## Implementation checklist

- [x] Scope the fix to Action-card groups; leave scoring grids unchanged.
- [x] Preserve mobile one-column behavior and native disclosure semantics.
- [x] Add a regression contract that cannot match declarations outside the target CSS block.
- [x] Run focused and full automated release gates.
- [x] Capture and compare the corrected 1764 × 881 public rules page in the selected browser.
- [x] Recheck 1280px and 320px geometry; the 320 CSS-pixel reflow also represents the layout width produced by 200% zoom from a 640-pixel viewport.

final result: passed
