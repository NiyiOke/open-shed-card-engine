"use client";

import { ArrowRightIcon, ArrowUpRightIcon } from "@phosphor-icons/react";
import { useEffect, useState, type MouseEvent } from "react";
import { OPEN_SHED_RULES_GUIDE } from "../../lib/game/rules-guide";
import type { Card } from "../../lib/game/types";
import { CardFace } from "./CardFace";
import { ReleaseIdentity } from "./release-ui";
import {
  RulesGuideCards,
  RulesGuideDeckInventory,
  RulesGuideScoring,
  RulesGuideSections,
} from "./RulesGuide";
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

export function SignedOutLanding({ signInPath }: { signInPath: string }) {
  const [openTables, setOpenTables] = useState<{
    availability: PublicAvailability;
    rooms: PublicRoomCard[];
  } | null>(null);
  const inviteJourney = isInviteSignInPath(signInPath);

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

  const focusSection = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    const section = document.getElementById(id);
    if (!section) return;
    event.preventDefault();
    section.scrollIntoView({ block: "start", behavior: "auto" });
    window.requestAnimationFrame(() => section.focus({ preventScroll: true }));
    window.history.replaceState(window.history.state, "", `#${id}`);
  };

  return (
    <div className="signed-out-page">
      <header className="public-header">
        <a className="public-wordmark" href="#top" aria-label="Open Shed home">
          <span>OPEN</span><span>SHED</span>
        </a>
        <nav className="public-nav" aria-label="Landing page navigation">
          <a href="#how-to-play" onClick={(event) => focusSection(event, "how-to-play")}>Rules</a>
          <a href="#action-cards" onClick={(event) => focusSection(event, "action-cards")}>Action cards</a>
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
            <a className="secondary-button" href="#how-to-play" onClick={(event) => focusSection(event, "how-to-play")}>Learn the rules</a>
          </div>
          {inviteJourney ? (
            <aside className="public-invite-auth" aria-label="Invite sign-in help">
              <strong>Joining a friend?</strong>
              <p>Sign in with ChatGPT shares only basic identity—not your conversations or files.</p>
              <details>
                <summary>Having trouble?</summary>
                <p>Open this page in Safari or Chrome and retry with your personal ChatGPT account. In ChatGPT, use ••• → Open in browser. A managed workspace may require admin approval.</p>
              </details>
            </aside>
          ) : null}
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

      <section id="how-to-play" className="public-rules" aria-labelledby="how-to-play-title" tabIndex={-1}>
        <div className="public-section-heading">
          <span className="eyebrow">How to play</span>
          <h2 id="how-to-play-title">One card per turn. Two ways to win.</h2>
          <p>Play your final card, or become the last active player after the Mercy rule clears the table.</p>
        </div>
        <RulesGuideSections idPrefix="public-rules" variant="public" />
      </section>

      <section id="action-cards" className="public-action-guide" aria-labelledby="action-cards-title" tabIndex={-1}>
        <div className="public-section-heading public-section-heading--split">
          <div>
            <span className="eyebrow">Action card guide</span>
            <h2 id="action-cards-title">Know what hits the table.</h2>
          </div>
          <p>Draw penalties can be stacked. Every other effect resolves immediately unless the play ends the game.</p>
        </div>

        <RulesGuideCards idPrefix="public-rules" variant="public" />
        <RulesGuideDeckInventory idPrefix="public-rules" variant="public" />
        <RulesGuideScoring idPrefix="public-rules" variant="public" />
        <p className="public-scope-note">
          Only your own hand reaches your screen, while the server decides turns and outcomes. {OPEN_SHED_RULES_GUIDE.sourceNote}
        </p>
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

function isInviteSignInPath(signInPath: string): boolean {
  try {
    const url = new URL(signInPath, "https://open-shed.local");
    return /(?:^|[?&])join=[A-Z0-9]{6}(?:&|$)/u.test(url.searchParams.get("return_to") ?? "");
  } catch {
    return false;
  }
}
