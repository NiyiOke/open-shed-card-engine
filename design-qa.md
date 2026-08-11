# Option 1 card redesign — design QA

## Evidence

- Source visual truth: `docs/design/option-1-card-reference.webp`.
- Browser-rendered desktop implementation: `docs/design/option-1-card-implementation-desktop.jpg`.
- Browser-rendered mobile implementation: `docs/design/option-1-card-implementation-mobile.jpg`.
- Full-view side-by-side comparison: `docs/design/option-1-card-comparison-full.jpg`.
- Focused hand-card comparison: `docs/design/option-1-card-comparison-focused.jpg`.
- Source pixels: 1492 × 1054.
- Desktop capture: 1492 × 1200 pixels from a 1492 × 1200 CSS viewport at device scale 1. The comparison preserves the shared 1492-pixel width; the implementation is taller because it retains the functional draw stack and the full live-game page.
- Mobile capture: 320 × 900 pixels from a 320 × 900 CSS viewport at device scale 1.
- State: the source concept shows an opponent turn with Yellow 4; the live capture shows the next turn with Yellow 3 after a real remote command. The hand keeps the same visual archetypes. Dynamic player/card copy was excluded from fidelity judgments where the states differ.

## Findings

- No actionable P0, P1, or P2 findings remain.
- Fonts and typography: the implementation preserves the concept's heavy sans numerals, compact mono corner identifiers, and bold uppercase rule labels. Long action names wrap to two short lines without clipping.
- Spacing and layout rhythm: at the 1492-pixel comparison width, hand cards reach the same approximately 150-pixel width and 1:1.83 proportion as the source. The table discard keeps the shorter pile-card proportion. The added draw stack is an intentional gameplay affordance rather than design drift.
- Colors and visual tokens: the charcoal chassis, warm keyline, subdued red/yellow/green/blue faces, and acid interaction ring map closely to the selected direction. Text and icons retain strong contrast on every color.
- Image quality and asset fidelity: the generated charcoal pressed-paper texture is a real optimized raster asset; Phosphor supplies crisp vector action icons. No copied UNO artwork, inline custom SVG, emoji, Unicode action glyph, or branded card asset is used.
- Copy and content: implementation labels come from the rules model and correct semantic errors in the generated concept, including the red 8 and green 9 labels.
- Accessibility and behavior: hand cards remain native buttons with full accessible names, playable/not-playable status, visible non-color `PLAY` cues, elevated focus stacking, and a lime focus ring. The choice dialog autofocuses, fits at 320 pixels, closes with Escape, and restores focus.
- Responsiveness: the page has no root overflow at 320 pixels; the hand alone scrolls horizontally, and both the first and final cards remain reachable. Mobile cards retain the large identifier, icon, label, and minimum touch area.
- Console: a fresh preview tab produced only Vite/React development messages and no errors.

## Comparison history

1. Initial comparison found a P2 density issue: the original 34-pixel negative overlap covered wild-spectrum markers and parts of longer labels.
2. The hand was changed to responsive 128–150-pixel cards with a 10-pixel desktop overlap, preserving labels and the selected concept's wider fan.
3. Post-fix evidence in `docs/design/option-1-card-comparison-focused.jpg` shows the markers, central icons, labels, and lime selected state clearly at the same normalized card height.

## Open questions

- None blocking. The implementation keeps sharper angular panel joins than the slightly rounded AI concept so the geometry is repeatable across every dynamic card; this is acceptable P3 identity polish.

## Implementation checklist

- [x] Reusable card presentation model covers every card kind.
- [x] Hand and table discard use the same DOM card face.
- [x] Desktop, mobile, focus, playable, dialog, and live remote-turn states verified.
- [x] Unit tests, typecheck, lint, production build, and production dependency audit pass.

## Follow-up polish

- P3: if a future art pass calls for softer panel seams, replace the shared normalized polygon with a reusable masked asset while preserving the current dynamic color and icon layers.

final result: passed
