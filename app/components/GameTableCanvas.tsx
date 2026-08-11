"use client";

import { useEffect, useRef } from "react";
import { cardLabel } from "../../lib/game/deck";
import type { GameView } from "../../lib/game/types";
import { CardBack, CardFace } from "./CardFace";

export function GameTableCanvas({ game }: { game: GameView | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const render = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(rect.width * ratio));
      canvas.height = Math.max(1, Math.floor(rect.height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      drawTable(context, rect.width, rect.height, game);
    };

    render();
    const observer = new ResizeObserver(render);
    observer.observe(canvas);
    window.addEventListener("open-shed-step", render);
    return () => {
      observer.disconnect();
      window.removeEventListener("open-shed-step", render);
    };
  }, [game]);

  return (
    <div className="game-table-surface" role="img" aria-label={gameTableLabel(game)}>
      <canvas ref={canvasRef} className="game-canvas" aria-hidden="true" />
      {game && game.phase !== "lobby" ? (
        <div className="table-piles" aria-hidden="true">
          <div className="table-card-slot table-card-slot--draw">
            <CardBack count={game.drawPileCount} />
          </div>
          {game.topDiscard ? (
            <div className="table-card-slot table-card-slot--discard">
              <CardFace
                card={game.topDiscard}
                variant="table"
                activeWildColor={game.activeColor}
                interaction={{ kind: "static", hiddenFromAssistiveTech: true }}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function drawTable(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  game: GameView | null,
) {
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#ede6d8";
  context.fillRect(0, 0, width, height);

  context.strokeStyle = "rgba(21, 21, 21, 0.12)";
  context.lineWidth = 1;
  const grid = 28;
  for (let x = grid; x < width; x += grid) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }
  for (let y = grid; y < height; y += grid) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }

  if (!game || game.phase === "lobby") {
    context.fillStyle = "#151515";
    context.font = "700 16px Geist, sans-serif";
    context.textAlign = "center";
    context.fillText("THE TABLE IS READY", width / 2, height / 2 - 8);
    context.font = "13px Geist, sans-serif";
    context.fillStyle = "rgba(21, 21, 21, 0.62)";
    context.fillText("2–6 players · seven cards each", width / 2, height / 2 + 17);
    return;
  }

  context.fillStyle = "#151515";
  context.font = "700 12px Geist Mono, monospace";
  context.textAlign = "left";
  context.fillText(
    game.pendingDraw ? `PENDING +${game.pendingDraw.total}` : `TURN ${game.turnNumber}`,
    18,
    26,
  );
  context.textAlign = "right";
  context.fillText(
    game.direction === 1 ? "CLOCKWISE →" : "← COUNTER",
    width - 18,
    26,
  );
}

function gameTableLabel(game: GameView | null): string {
  if (!game || game.phase === "lobby") {
    return "Game table waiting for a lobby to start. Two to six players receive seven cards each.";
  }
  const parts = [
    "Game table.",
    game.phase === "complete" ? "Game complete." : `Turn ${game.turnNumber}.`,
    game.currentPlayerName ? `${game.currentPlayerName}'s turn.` : null,
    game.topDiscard ? `Top discard is ${cardLabel(game.topDiscard)}.` : "There is no discard.",
    game.activeColor ? `Active color is ${game.activeColor}.` : null,
    `${game.drawPileCount} cards remain in the draw pile.`,
    game.direction === 1 ? "Play moves clockwise." : "Play moves counterclockwise.",
    game.pendingDraw ? `The pending draw penalty is ${game.pendingDraw.total}.` : null,
  ];
  return parts.filter(Boolean).join(" ");
}
