/**
 * Session 1 teaching exercise, using invented data only.
 * This suggests a card ID; it does not decide the rules or play a move.
 */
export function recommendCard(view) {
  const playableCardIds = view.legalActions.playableCardIds;
  if (playableCardIds.length === 0) return null;

  return playableCardIds[0];
}
