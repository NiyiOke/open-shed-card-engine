# Rules decisions: `merciless-baseline-v1`

Paper card rules leave several effect-ordering cases undefined. Online play cannot. Every game pins this profile so later interpretations do not silently alter an in-progress or replayed game.

## Sources

- Primary behavior: [Mattel English instruction sheet HVW18](https://service.mattel.com/instruction_sheets/HVW18-Eng.pdf), ©2023.
- The sheet states 168 cards but does not itemize copies. The manifest uses independently corroborated physical-deck inventories and is asserted to total 168 unique instances.

## Pinned policies

1. **No voluntary draw.** If a legal card is in hand, one legal card must be played. Otherwise draw until the first playable card appears, then that specific card must be played.
2. **Wild continuing color.** The actor chooses the continuing color for Wild Reverse Draw 4, Wild Draw 6, and Wild Draw 10. The Roulette target chooses its color, and that becomes the continuing color.
3. **Stack matching.** During a draw chain, ordinary color/number/symbol matching is suspended. Only a Draw Card whose printed value is at least the last Draw Card's value is legal.
4. **Final-card precedence.** A player's final card wins before effects targeting another hand. Discard All's same-color removal is part of the actor's play. A final 0 or 7 therefore ends the hand before a pass/swap; a final Draw Card ends it before the target accepts cards.
5. **Mercy timing.** Ordinary draw loops, stack penalties, and UNO catches eliminate immediately when card 25 enters the hand; unused penalty cards stay in the Draw Pile. Roulette first assembles its revealed batch, adds the batch, then checks Mercy.
6. **UNO after hand movement.** Any transition to exactly one card creates an authoritative liability, including 0/7 hand movement. Self-call and catches resolve in server order. The next accepted substantive turn action closes open reaction windows.
7. **Opening actions.** Setup keeps flipping Action cards without executing them until a number is visible. Ignored actions stay below that visible number in the Discard Pile. A flipped 0 or 7 is a number but its rule does not execute.
8. **Recycling.** The visible top discard is retained. Older discards and Mercy-reserve cards are shuffled into a new Draw Pile with Web Crypto in production. Conformance tests may inject a deterministic numeric fixture; public room identifiers never seed a deck.
9. **Roulette exhaustion.** If the selected color is absent after every currently recyclable card is revealed, all revealed cards enter the target hand and Roulette ends with the selected active color. This prevents an infinite loop.
10. **Active seats only.** Turn targets, 7 swaps, and 0 rotations skip eliminated and departed players. Two-player Reverse behavior begins whenever only two active players remain, regardless of the original lobby size.

## Adding or changing a policy

- Create a new rules version constant and immutable profile.
- Add golden transition tests for old and new interpretations.
- Preserve deserialization and replay support for old snapshots.
- Document client copy/UI differences.
- Include a persistence migration only when the stored state shape changes.
