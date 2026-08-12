"use client";

import { ArrowRightIcon, ArrowUpRightIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { Card } from "../../lib/game/types";
import { CardFace } from "./CardFace";
import { ReleaseIdentity } from "./release-ui";
import {
  cappedCountLabel,
  parsePublicAvailability,
  parsePublicRoomPage,
  signInPathForListing,
  type PublicAvailability,
  type PublicRoomCard,
  waitingAgeLabel,
} from "./public-discovery";

const HERO_CARDS: Card[] = [
  { id: "landing-red-eight", kind: "number", color: "red", number: 8 },
  { id: "landing-yellow-draw-two", kind: "draw_two", color: "yellow", number: null },
  { id: "landing-wild-reverse-four", kind: "wild_reverse_draw_four", color: null, number: null },
  { id: "landing-green-discard-all", kind: "discard_all", color: "green", number: null },
];

const COLOR_ACTION_RULES: Array<{ card: Card; description: string; title: string }> = [
  {
    card: { id: "rules-red-draw-two", kind: "draw_two", color: "red", number: null },
    title: "Draw 2",
    description: "The next active player faces a 2-card penalty and loses their turn unless they stack it.",
  },
  {
    card: { id: "rules-yellow-draw-four", kind: "draw_four", color: "yellow", number: null },
    title: "Draw 4",
    description: "The next active player faces a 4-card penalty and loses their turn unless they stack it.",
  },
  {
    card: { id: "rules-blue-skip", kind: "skip", color: "blue", number: null },
    title: "Skip",
    description: "The next active player loses their turn.",
  },
  {
    card: { id: "rules-green-reverse", kind: "reverse", color: "green", number: null },
    title: "Reverse",
    description: "Reverse play. With two active players, the other player is skipped and you play again.",
  },
  {
    card: { id: "rules-red-discard-all", kind: "discard_all", color: "red", number: null },
    title: "Discard All",
    description: "Discard every other card in your hand with this color. Cards placed beneath it do not activate.",
  },
  {
    card: { id: "rules-yellow-skip-everyone", kind: "skip_everyone", color: "yellow", number: null },
    title: "Skip Everyone",
    description: "Skip every other active player and immediately take another turn.",
  },
];

const WILD_ACTION_RULES: Array<{ card: Card; description: string; title: string }> = [
  {
    card: { id: "rules-wild-reverse-four", kind: "wild_reverse_draw_four", color: null, number: null },
    title: "Wild Reverse Draw 4",
    description: "Choose the color and reverse play. The next active player in the new direction faces 4. With only two active players, the penalty comes back to you—but it can be stacked.",
  },
  {
    card: { id: "rules-wild-draw-six", kind: "wild_draw_six", color: null, number: null },
    title: "Wild Draw 6",
    description: "Choose the continuing color. The next active player faces 6 cards and loses their turn unless they stack.",
  },
  {
    card: { id: "rules-wild-draw-ten", kind: "wild_draw_ten", color: null, number: null },
    title: "Wild Draw 10",
    description: "Choose the continuing color. The next active player faces 10 cards and loses their turn unless they stack.",
  },
  {
    card: { id: "rules-wild-roulette", kind: "wild_color_roulette", color: null, number: null },
    title: "Wild Color Roulette",
    description: "The next active player chooses a color, then reveals until that color appears. Wilds do not count. They take every revealed card, lose their turn, and their chosen color becomes active.",
  },
];

export function SignedOutLanding({ signInPath }: { signInPath: string }) {
  const [openTables, setOpenTables] = useState<{
    availability: PublicAvailability;
    rooms: PublicRoomCard[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [availabilityResponse, roomsResponse] = await Promise.all([
          fetch("/api/public/availability", { cache: "no-store" }),
          fetch("/api/public/rooms", { cache: "no-store" }),
        ]);
        if (!availabilityResponse.ok || !roomsResponse.ok) return;
        const [availabilityBody, roomsBody] = await Promise.all([
          availabilityResponse.json(),
          roomsResponse.json(),
        ]);
        const availability = parsePublicAvailability(availabilityBody);
        const rooms = parsePublicRoomPage(roomsBody, 6);
        if (!cancelled && availability && rooms) {
          setOpenTables({ availability, rooms: rooms.rooms.slice(0, 6) });
        }
      } catch {
        // Discovery is optional and fail-closed. The private game journey remains available.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="signed-out-page">
      <header className="public-header">
        <a className="public-wordmark" href="#top" aria-label="Open Shed home">
          <span>OPEN</span><span>SHED</span>
        </a>
        <nav className="public-nav" aria-label="Landing page navigation">
          <a href="#how-to-play">Rules</a>
          <a href="#action-cards">Action cards</a>
          <a className="public-nav-cta" href={signInPath}>Sign in</a>
        </nav>
      </header>

      <main>
      <section id="top" className="public-hero" aria-labelledby="public-hero-title">
        <div className="public-hero-copy">
          <span className="eyebrow">2–6 player online shedding game</span>
          <h1 id="public-hero-title">Shed your hand.<br /><em>Survive the draw.</em></h1>
          <p>
            Match fast, stack penalties, trade entire hands, and stay below 25 cards. Open Shed brings the full merciless rules profile to a private online table.
          </p>
          <div className="public-hero-actions">
            <a className="primary-button sign-in-button" href={signInPath}>
              Sign in to play <ArrowRightIcon aria-hidden="true" weight="bold" />
            </a>
            <a className="secondary-button" href="#how-to-play">Learn the rules</a>
          </div>
        </div>

        <div
          className="public-card-stage"
          role="img"
          aria-label="A fan of original Open Shed number, draw, wild reverse, and discard cards"
        >
          <span className="public-stage-label">Original card system / v1</span>
          <div className="landing-card-fan" aria-hidden="true">
            {HERO_CARDS.map((card) => (
              <CardFace
                key={card.id}
                card={card}
                className="landing-card"
                interaction={{ kind: "static", hiddenFromAssistiveTech: true }}
              />
            ))}
          </div>
          <span className="public-stage-caption">Every hand can turn in one card.</span>
        </div>
      </section>

      <dl className="public-quick-facts" aria-label="Game facts">
        <div><dt>Players</dt><dd>2–6</dd></div>
        <div><dt>Starting hand</dt><dd>7 cards</dd></div>
        <div><dt>Deck</dt><dd>168 cards</dd></div>
        <div><dt>Mercy limit</dt><dd>25 cards</dd></div>
      </dl>

      <section id="how-to-play" className="public-rules" aria-labelledby="how-to-play-title">
        <div className="public-section-heading">
          <span className="eyebrow">How to play</span>
          <h2 id="how-to-play-title">One card per turn. Two ways to win.</h2>
          <p>Play your final card, or become the last active player after the Mercy rule clears the table.</p>
        </div>
        <ol className="public-rule-steps">
          <li><span>01</span><h3>Start with seven</h3><p>The server deals seven cards each and skips opening Action Cards until a number starts play clockwise.</p></li>
          <li><span>02</span><h3>Match one card</h3><p>Match the active color, number, or symbol. Wild cards can set a continuing color. If you have a legal card, you must play one.</p></li>
          <li><span>03</span><h3>Draw to a match</h3><p>No legal card? Draw until the first playable card appears, then play that exact card.</p></li>
          <li><span>04</span><h3>Resolve the effect</h3><p>Complete every required color, target, draw, swap, or direction choice before play moves on.</p></li>
          <li><span>05</span><h3>Call UNO or win</h3><p>Call UNO at one card. Empty your hand—or outlast every other active player—to win.</p></li>
        </ol>
      </section>

      <section className="public-power-rules" aria-labelledby="power-rules-title">
        <h2 id="power-rules-title" className="sr-only">Merciless table rules</h2>
        <article><span>Stack</span><h3>Equal or higher</h3><p>During a draw chain, normal matching is suspended. Stack only an equal-or-higher Draw Card; values add until someone takes the full penalty.</p></article>
        <article><span>0 / 7</span><h3>Move every hand</h3><p>A 0 passes every active hand in the current direction. A 7 forces you to swap with an active player of your choice.</p></article>
        <article><span>Mercy</span><h3>25 means out</h3><p>Ordinary draws, penalties, and UNO catches eliminate you as card 25 enters. Roulette adds its full batch before checking.</p></article>
        <article><span>UNO</span><h3>Call it in time</h3><p>Reach exactly one card and call UNO. Until the next substantive turn action is accepted, another player may catch you; if caught, draw 2.</p></article>
      </section>

      <section id="action-cards" className="public-action-guide" aria-labelledby="action-cards-title">
        <div className="public-section-heading public-section-heading--split">
          <div>
            <span className="eyebrow">Action card guide</span>
            <h2 id="action-cards-title">Know what hits the table.</h2>
          </div>
          <p>Draw penalties can be stacked. Every other effect resolves immediately unless the play ends the game.</p>
        </div>

        <div className="public-action-groups">
          <RuleCardGroup label="Color action cards" rules={COLOR_ACTION_RULES} />
          <RuleCardGroup label="Wild action cards" rules={WILD_ACTION_RULES} />
        </div>
        <p className="public-scope-note">
          Only your own hand reaches your screen, while the server decides turns and outcomes. Open Shed currently resolves one hand at a time; the paper game&apos;s optional multi-hand point scoring is not enabled in this rules profile.
        </p>
      </section>

      <section className="public-edge-rules" aria-labelledby="online-rules-title">
        <details>
          <summary>
            <span className="eyebrow">Merciless baseline / v1</span>
            <h2 id="online-rules-title">How edge cases work online</h2>
          </summary>
          <div className="public-edge-grid">
            <article><h3>Final card wins first</h3><p>A final 0, 7, or Draw Card ends the hand before it moves another player&apos;s cards. Discard All removes its matching cards before victory is checked.</p></article>
            <article><h3>Only new actions open UNO</h3><p>Any move to exactly one card—including a 0 pass or 7 swap—opens a brief call-or-catch window. The next accepted turn action closes it.</p></article>
            <article><h3>Roulette cannot loop forever</h3><p>If the chosen color is absent after every recyclable card is revealed, the target keeps that full batch and play continues with the chosen color active.</p></article>
            <article><h3>Mercy timing is exact</h3><p>Ordinary draws stop as card 25 enters. Roulette adds its complete revealed batch first, then checks whether its target has reached the limit.</p></article>
          </div>
        </details>
      </section>

      {openTables ? (
        <section className="public-open-tables" aria-labelledby="open-tables-title">
          <div className="public-section-heading public-section-heading--split">
            <div>
              <span className="eyebrow">Open tables now</span>
              <h2 id="open-tables-title">Find a seat.<br />Keep your identity private.</h2>
            </div>
            <p>
              These cards are anonymous before sign-in. They show only table size, pace, rules, and a broad waiting window—never a player name, table code, or game ID.
            </p>
          </div>

          <div className="public-availability-strip" aria-label="Open table availability">
            <div>
              <span>Open tables</span>
              <strong>{cappedCountLabel(openTables.availability.tableCount, openTables.availability.tableCountCapped)}</strong>
            </div>
            <div>
              <span>Open seats</span>
              <strong>{cappedCountLabel(openTables.availability.openSeatCount, openTables.availability.openSeatCountCapped)}</strong>
            </div>
            <p>Sign in only when you choose a table. You will confirm a separate room alias before taking a seat.</p>
          </div>

          {openTables.rooms.length ? (
            <div className="public-table-grid">
              {openTables.rooms.map((room) => (
                <article className="public-table-card" key={room.listingId}>
                  <div className="public-table-card__status">
                    <span className="status-pip" aria-hidden="true" />
                    <span>{room.occupancy} of {room.capacity} players</span>
                  </div>
                  <strong>{room.capacity - room.occupancy} {room.capacity - room.occupancy === 1 ? "seat" : "seats"} open</strong>
                  <dl>
                    <div><dt>Pace</dt><dd>{room.pace === "quick" ? "Quick" : "Casual"}</dd></div>
                    <div><dt>Rules</dt><dd>Merciless baseline</dd></div>
                    <div><dt>Waiting</dt><dd>{waitingAgeLabel(room.waitingAge)}</dd></div>
                  </dl>
                  <a
                    className="primary-button acid"
                    href={signInPathForListing(signInPath, room.listingId)}
                    aria-label={`Sign in to join an anonymous ${room.pace} table with ${room.occupancy} of ${room.capacity} players`}
                  >
                    Sign in to join <ArrowRightIcon aria-hidden="true" weight="bold" />
                  </a>
                </article>
              ))}
            </div>
          ) : (
            <div className="public-table-empty">
              <strong>No open table is waiting right now.</strong>
              <span>Sign in to create the next one, or check again in a moment.</span>
            </div>
          )}
        </section>
      ) : null}

      <section className="public-final-cta" aria-labelledby="public-cta-title">
        <div>
          <span className="eyebrow">The table is ready</span>
          <h2 id="public-cta-title">Bring the players.<br />We&apos;ll enforce the rules.</h2>
        </div>
        <a className="primary-button acid" href={signInPath}>
          Sign in and play <ArrowRightIcon aria-hidden="true" weight="bold" />
        </a>
      </section>
      </main>

      <footer className="public-footer">
        <ReleaseIdentity className="release-identity--public" />
        <p>Original code and visual system. No commercial card artwork or assets.</p>
        <p>
          Rules adapted for deterministic online play from Mattel&apos;s 2023 instruction sheet. UNO and related names are Mattel trademarks. Open Shed is unofficial and is not affiliated with or endorsed by Mattel.
        </p>
        <a href="https://service.mattel.com/instruction_sheets/HVW18-Eng.pdf" target="_blank" rel="noreferrer">
          Official rules source <span className="sr-only">(opens in a new tab)</span><ArrowUpRightIcon aria-hidden="true" weight="bold" />
        </a>
      </footer>
    </div>
  );
}

function RuleCardGroup({
  label,
  rules,
}: {
  label: string;
  rules: Array<{ card: Card; description: string; title: string }>;
}) {
  return (
    <details className="public-action-group" open>
      <summary>{label}<span>{rules.length} types</span></summary>
      <div>
        {rules.map((rule) => (
          <article className="public-action-rule" key={rule.card.id}>
            <CardFace
              card={rule.card}
              className="public-rule-card-face"
              variant="compact"
              interaction={{ kind: "static", hiddenFromAssistiveTech: true }}
            />
            <div><h3>{rule.title}</h3><p>{rule.description}</p></div>
          </article>
        ))}
      </div>
    </details>
  );
}
