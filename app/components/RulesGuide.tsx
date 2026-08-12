import {
  RULES_GUIDE_CARD_FAMILIES,
  RULES_GUIDE_CARDS_BY_KIND,
  RULES_GUIDE_SCORING_MODES,
  RULES_GUIDE_SECTIONS,
  type RuleGuideCard,
} from "../../lib/game/rules-guide";
import type { Card, CardColor, CardKind } from "../../lib/game/types";
import { CardFace } from "./CardFace";

export type RulesGuideVariant = "public" | "dialog";

const ACTION_CARD_KINDS = [
  "draw_two",
  "draw_four",
  "skip",
  "reverse",
  "discard_all",
  "skip_everyone",
  "wild_reverse_draw_four",
  "wild_draw_six",
  "wild_draw_ten",
  "wild_color_roulette",
] as const satisfies readonly Exclude<CardKind, "number">[];

const SAMPLE_COLORS: Readonly<
  Record<Exclude<CardKind, "number">, CardColor | null>
> = Object.freeze({
  draw_two: "red",
  draw_four: "yellow",
  skip: "blue",
  reverse: "green",
  discard_all: "red",
  skip_everyone: "yellow",
  wild_reverse_draw_four: null,
  wild_draw_six: null,
  wild_draw_ten: null,
  wild_color_roulette: null,
});

export function RulesGuideSections({
  idPrefix,
  variant,
}: {
  idPrefix: string;
  variant: RulesGuideVariant;
}) {
  return (
    <section
      className={`rules-guide-section rules-guide-section--${variant}`}
      aria-labelledby={`${idPrefix}-overview-title`}
    >
      <div className="rules-guide-section__heading">
        <span className="eyebrow">Complete rules</span>
        <h3 id={`${idPrefix}-overview-title`} tabIndex={-1}>How a round works</h3>
        <p>Every rule below is enforced by the same versioned server profile used at the table.</p>
      </div>
      <ol className="rules-guide-steps">
        {RULES_GUIDE_SECTIONS.map((section, index) => (
          <li key={section.id}>
            <span className="rules-guide-step-number" aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </span>
            <h4>{section.title}</h4>
            <p>{section.summary}</p>
            <ul>
              {section.details.map((detail) => <li key={detail}>{detail}</li>)}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function RulesGuideCards({
  idPrefix,
  variant,
}: {
  idPrefix: string;
  variant: RulesGuideVariant;
}) {
  const colorCards = ACTION_CARD_KINDS
    .map((kind) => RULES_GUIDE_CARDS_BY_KIND[kind])
    .filter((card) => card.familyId === "color_actions");
  const wildCards = ACTION_CARD_KINDS
    .map((kind) => RULES_GUIDE_CARDS_BY_KIND[kind])
    .filter((card) => card.familyId === "wild_actions");

  return (
    <section
      className={`rules-guide-section rules-guide-section--${variant}`}
      aria-labelledby={`${idPrefix}-cards-title`}
    >
      <div className="rules-guide-section__heading">
        <span className="eyebrow">All 10 action types</span>
        <h3 id={`${idPrefix}-cards-title`} tabIndex={-1}>Action card guide</h3>
        <p>Draw penalties can be stacked. Every other effect resolves immediately unless the play ends the round.</p>
      </div>
      <div className="rules-guide-card-groups">
        <RulesGuideCardGroup label="Color Action cards" cards={colorCards} variant={variant} />
        <RulesGuideCardGroup label="Wild Action cards" cards={wildCards} variant={variant} />
      </div>
    </section>
  );
}

export function RulesGuideDeckInventory({
  idPrefix,
  variant,
}: {
  idPrefix: string;
  variant: RulesGuideVariant;
}) {
  const cards = RULES_GUIDE_CARD_FAMILIES.flatMap((family) => family.cards);

  return (
    <section
      className={`rules-guide-section rules-guide-section--${variant}`}
      aria-labelledby={`${idPrefix}-deck-title`}
    >
      <div className="rules-guide-section__heading">
        <span className="eyebrow">Core deck complete</span>
        <h3 id={`${idPrefix}-deck-title`} tabIndex={-1}>168-card inventory</h3>
        <p>The current rules profile includes every core number, Color Action, and Wild Action card family.</p>
      </div>
      <dl className="rules-deck-inventory" aria-label="Core deck card quantities">
        {cards.map((card) => (
          <div key={card.kind}>
            <dt>{card.title}</dt>
            <dd>
              <span>{copiesLabel(card)}</span>
              <strong>{card.totalCopies} total</strong>
            </dd>
          </div>
        ))}
        <div className="rules-deck-inventory__total">
          <dt>Complete core deck</dt>
          <dd><strong>168 cards</strong></dd>
        </div>
      </dl>
    </section>
  );
}

export function RulesGuideScoring({
  idPrefix,
  variant,
}: {
  idPrefix: string;
  variant: RulesGuideVariant;
}) {
  return (
    <section
      className={`rules-guide-section rules-guide-section--${variant}`}
      aria-labelledby={`${idPrefix}-scoring-title`}
    >
      <div className="rules-guide-section__heading">
        <span className="eyebrow">Game-night format</span>
        <h3 id={`${idPrefix}-scoring-title`} tabIndex={-1}>Round wins, not card points</h3>
      </div>
      <div className="rules-guide-scoring">
        {RULES_GUIDE_SCORING_MODES.map((mode) => (
          <article key={mode.id} data-availability={mode.availability}>
            <span>{mode.availability === "enabled" ? "Enabled" : "Not enabled"}</span>
            <h4>{mode.title}</h4>
            <p>{mode.summary}</p>
            <ul>{mode.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>
          </article>
        ))}
      </div>
    </section>
  );
}

function RulesGuideCardGroup({
  cards,
  label,
  variant,
}: {
  cards: readonly RuleGuideCard[];
  label: string;
  variant: RulesGuideVariant;
}) {
  return (
    <details className="rules-guide-card-group" open={variant === "public"}>
      <summary>{label}<span>{cards.length} types</span></summary>
      <div>
        {cards.map((rule) => {
          const card = sampleCard(rule.kind);
          return (
            <article className="rules-guide-card" key={rule.kind}>
              <CardFace
                card={card}
                className="rules-guide-card-face"
                variant="compact"
                interaction={{ kind: "static", hiddenFromAssistiveTech: true }}
              />
              <div>
                <h4>{rule.title}</h4>
                <p>{rule.summary}</p>
                <ul>{rule.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>
              </div>
            </article>
          );
        })}
      </div>
    </details>
  );
}

function sampleCard(kind: CardKind): Card {
  if (kind === "number") {
    return { id: "rules-number-seven", kind, color: "red", number: 7 };
  }
  return {
    id: `rules-${kind}`,
    kind,
    color: SAMPLE_COLORS[kind],
    number: null,
  };
}

function copiesLabel(card: RuleGuideCard): string {
  if (card.copiesPerRankPerColor) {
    return `${card.copiesPerRankPerColor} of each number per color`;
  }
  if (card.copiesPerColor) return `${card.copiesPerColor} per color`;
  return `${card.totalCopies} Wild`;
}
