# Action-card readability annotations — design QA

## Evidence

- Source visual truth: annotated production page captured before the fix at `/tmp/open-shed-card-readability-before.png`; full production source capture at `/tmp/open-shed-card-readability-before-full.png`.
- Browser-rendered implementation: `/tmp/open-shed-card-readability-after.png` at the same Action-card anchor and viewport.
- Full-view comparison input: `/tmp/open-shed-card-readability-comparison.png`.
- Focused Wild-card comparison input: `/tmp/open-shed-card-readability-comparison-wild.png`.
- Focused long-label comparison input: `/tmp/open-shed-card-readability-comparison-labels.png`.
- Responsive implementation captures: `/tmp/open-shed-card-readability-desktop-1280.png`, `/tmp/open-shed-card-readability-mobile-320.png`, `/tmp/open-shed-card-readability-mobile-details.png`, and `/tmp/open-shed-card-readability-mobile-wild.png`.
- Source and primary implementation pixels: 801 × 998 at device scale 1; CSS viewport 801 × 998.
- State: signed-out `#action-cards` rules section with both native Action-card disclosures open.

## Findings

- No actionable P0, P1, or P2 findings remain.
- [P1, fixed] Wild Draw 10 used the same minimum center-value size as two-character values, so `+10` reached the compact face edge and appeared cut off. Three-character center values now use a length-aware scale while `+2`, `+4`, and `+6` retain their original emphasis.
- [P1, fixed] Wild Reverse Draw 4 rendered a redundant boxed `+4` beside its Reverse icon in addition to the two corner marks. The duplicate support mark is removed; the card still shows the Reverse icon, both `+4` corner values, its title, and the same accessible card identity.
- [P1, fixed] Discard All, Skip Everyone, and Color Roulette inherited a short-label width that clipped or crowded their compact bottom labels. Only compact faces with long labels now receive the full bottom width and a bounded, two-line-capable optical size.
- [P2, fixed] Taller Draw 4 and Wild Reverse Draw 4 explanations left the thumbnail pinned to the top of a much taller row. Card artwork now centers beside tall explanatory copy, and tablet/desktop rows use a 16px card-to-copy gutter and 16px inset.
- Fonts and typography: display/body typography is unchanged. Card-only value and label sizing is content-aware, remains high contrast, and stays within the card chassis at both 70 × 128 and 62 × 113 pixels.
- Spacing and layout rhythm: panel widths, section order, borders, 16px group gap, and independent group heights remain unchanged. Card-row spacing is intentionally relaxed from 14px to 16px at tablet/desktop sizes; mobile keeps its existing 12px gutter.
- Colors and visual tokens: unchanged.
- Image quality and asset fidelity: the existing shared `CardFace` presentation is preserved; no source asset, icon family, texture, shadow, or card silhouette was replaced. Phosphor action icons remain sharp and optically centered.
- Copy and content: rules copy and all ten card types are unchanged. The only removed visual content was the redundant inner `+4`; accessible names and rule titles are unchanged.
- Accessibility and interactions: guide artwork remains `aria-hidden="true"` beside visible semantic card headings/copy. Native 52px disclosure summaries still open/close, retain focus, and show a 3px focus outline. Reduced-motion behavior is unaffected.
- Responsiveness: at 1280px the groups remain equal 608px columns with independent heights; at 801px both columns fit with a measured 16px art/copy gutter and no x-overflow; at 320px the groups reflow to one 292px column, 62 × 113 thumbnails remain inside the viewport, all long labels and `+10` remain inside the face, summaries remain 52px, and `scrollWidth === innerWidth === 320`. The existing 200%-zoom contract remains green, and the same effective 320px reflow was visually inspected.
- Console/runtime: the local in-app browser emitted no warnings or errors. The required game client captured the signed-out state with no error artifact.

## Comparison history

1. The user’s seven browser annotations identified a clipped `+10`, a duplicate inner `+4`, three crowded long labels, and weak spacing in two tall rule rows.
2. The 801 × 998 production capture reproduced the compact-card defects. Source inspection tied them to one duplicate `supportMark`, a fixed 34px minimum value size inside a 68%-wide center, a short-label right inset, and top-aligned art in variable-height rows.
3. The first implementation pass removed the duplicate support mark, introduced content-density hooks, widened long compact labels, and centered the artwork. Focused source tests and TypeScript/lint checks passed.
4. The initial rendered pass showed the defects resolved. A final scoped spacing refinement increased tablet/desktop card-row inset and gutter from 14px to 16px without changing the two-column information architecture.
5. The revised 801px full and focused comparison inputs show `+10` with clear side room, Reverse +4 with one visual penalty indicator system, readable complete long labels, and balanced art/copy rows. Desktop and mobile captures show no new clipping or overflow.

## Implementation checklist

- [x] Remove only the redundant Wild Reverse Draw 4 support badge.
- [x] Scale long center values without reducing ordinary number/action values.
- [x] Keep long compact labels fully readable without changing gameplay-card labels.
- [x] Balance card artwork beside tall copy and preserve mobile reflow.
- [x] Add regression coverage for presentation data, density hooks, and guide spacing.
- [x] Compare before/after at the exact annotated viewport and inspect focused card regions.
- [x] Verify 1280px and 320px layouts, disclosure focus, ARIA-hidden artwork, no horizontal overflow, and no browser errors.
- [x] Run the required game client and automated release gates.

final result: passed
