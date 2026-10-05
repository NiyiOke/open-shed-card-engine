export function recommendCard(view) {
  if (view.legalActions.playableCardIds.length === 0) return null;
  return view.legalActions.playableCardIds[0]?? null;
}
