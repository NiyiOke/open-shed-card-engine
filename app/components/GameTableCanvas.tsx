"use client";

import { useEffect, useRef } from "react";
import { cardLabel } from "../../lib/game/deck";
import type { GameView } from "../../lib/game/types";

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
    <canvas
      ref={canvasRef}
      className="game-canvas"
      role="img"
      aria-label={gameTableLabel(game)}
    />
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

  const cardWidth = Math.min(126, width * 0.27);
  const cardHeight = cardWidth * 1.42;
  const centerX = width / 2;
  const centerY = height / 2;
  roundedRect(
    context,
    centerX - cardWidth - 30,
    centerY - cardHeight / 2,
    cardWidth,
    cardHeight,
    15,
  );
  context.fillStyle = "#151515";
  context.fill();
  context.strokeStyle = "#151515";
  context.lineWidth = 2;
  context.stroke();
  context.fillStyle = "#f6f1e8";
  context.font = `800 ${Math.max(12, cardWidth * 0.11)}px Geist, sans-serif`;
  context.textAlign = "center";
  context.fillText("DRAW", centerX - cardWidth / 2 - 30, centerY - 4);
  context.font = `600 ${Math.max(11, cardWidth * 0.1)}px Geist Mono, monospace`;
  context.fillText(`${game.drawPileCount}`, centerX - cardWidth / 2 - 30, centerY + 19);

  const top = game.topDiscard;
  const color = top?.color ?? game.activeColor;
  roundedRect(
    context,
    centerX + 30,
    centerY - cardHeight / 2,
    cardWidth,
    cardHeight,
    15,
  );
  context.fillStyle = canvasCardColor(color);
  context.fill();
  context.strokeStyle = "#151515";
  context.stroke();
  context.fillStyle = color === "yellow" || color === "green" ? "#151515" : "#ffffff";
  context.font = `800 ${Math.max(13, cardWidth * 0.105)}px Geist, sans-serif`;
  wrapCenteredText(
    context,
    top ? cardLabel(top).toUpperCase() : "NO DISCARD",
    centerX + 30 + cardWidth / 2,
    centerY - 5,
    cardWidth - 18,
    Math.max(15, cardWidth * 0.13),
  );

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

function canvasCardColor(color: GameView["activeColor"]): string {
  if (color === "red") return "#d93a22";
  if (color === "yellow") return "#f2d529";
  if (color === "green") return "#7cae35";
  if (color === "blue") return "#2f4bff";
  return "#151515";
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

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function wrapCenteredText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
) {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (context.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  lines.push(line);
  const startY = y - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((entry, index) => context.fillText(entry, x, startY + index * lineHeight));
}
