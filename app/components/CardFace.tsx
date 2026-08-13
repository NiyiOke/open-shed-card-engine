"use client";

import {
  ApertureIcon,
  ArrowsClockwiseIcon,
  CardsThreeIcon,
  ProhibitIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";
import type { MouseEvent } from "react";
import {
  getCardPresentation,
  type CardIconKey,
} from "../../lib/game/card-presentation";
import { COLORS, type Card, type CardColor } from "../../lib/game/types";

export type CardFaceVariant = "compact" | "hand" | "table";

type SharedCardFaceProps = {
  activeWildColor?: CardColor | null;
  card: Card;
  className?: string;
  selected?: boolean;
  variant?: CardFaceVariant;
};

type StaticCardFaceProps = SharedCardFaceProps & {
  interaction?: {
    accessiblePrefix?: string;
    hiddenFromAssistiveTech?: boolean;
    kind: "static";
  };
};

type PlayCardFaceProps = SharedCardFaceProps & {
  interaction: {
    kind: "play";
    onActivate: (card: Card, trigger: HTMLButtonElement) => void;
    pending: boolean;
    playable: boolean;
  };
};

export type CardFaceProps = StaticCardFaceProps | PlayCardFaceProps;

export function CardFace({
  activeWildColor = null,
  card,
  className = "",
  interaction = { kind: "static" },
  selected = false,
  variant = "hand",
}: CardFaceProps) {
  const model = getCardPresentation(card, activeWildColor);
  const artwork = (
    <CardArtwork
      activeWildColor={model.activeWildColor}
      centerMark={model.centerMark}
      color={model.color}
      cornerMark={model.cornerMark}
      icon={model.icon}
      label={model.label}
      playable={interaction.kind === "play" && interaction.playable}
      selected={selected}
      supportMark={model.supportMark}
      variant={variant}
    />
  );

  if (interaction.kind === "play") {
    const stateCopy = interaction.pending
      ? "Action pending"
      : interaction.playable
        ? "Playable"
        : "Not playable";
    const activate = (event: MouseEvent<HTMLButtonElement>) => {
      if (!interaction.pending && interaction.playable) {
        interaction.onActivate(card, event.currentTarget);
      }
    };

    return (
      <button
        type="button"
        className={`playing-card ${interaction.playable ? "is-playable" : ""} ${className}`.trim()}
        disabled={interaction.pending}
        aria-disabled={interaction.pending || !interaction.playable}
        aria-label={`${model.accessibleName} ${stateCopy}.`}
        onClick={activate}
      >
        {artwork}
      </button>
    );
  }

  const accessiblePrefix = interaction.accessiblePrefix
    ? `${interaction.accessiblePrefix}: `
    : "";
  return (
    <div
      className={`static-card-face ${className}`.trim()}
      role={interaction.hiddenFromAssistiveTech ? undefined : "img"}
      aria-hidden={interaction.hiddenFromAssistiveTech || undefined}
      aria-label={
        interaction.hiddenFromAssistiveTech
          ? undefined
          : `${accessiblePrefix}${model.accessibleName}`
      }
    >
      {artwork}
    </div>
  );
}

export function CardBack({ count }: { count: number }) {
  return (
    <div className="card-back" aria-hidden="true">
      <div className="card-back__frame">
        <span className="card-back__eyebrow">Draw stack</span>
        <strong>
          OPEN<span>SHED</span>
        </strong>
        <span className="card-back__count">{count}</span>
      </div>
    </div>
  );
}

type CardArtworkProps = {
  activeWildColor: CardColor | null;
  centerMark: string | null;
  color: CardColor | "wild";
  cornerMark: string;
  icon: CardIconKey | null;
  label: string;
  playable: boolean;
  selected: boolean;
  supportMark: string | null;
  variant: CardFaceVariant;
};

function CardArtwork({
  activeWildColor,
  centerMark,
  color,
  cornerMark,
  icon,
  label,
  playable,
  selected,
  supportMark,
  variant,
}: CardArtworkProps) {
  return (
    <span
      className="card-face"
      data-active-color={activeWildColor ?? undefined}
      data-color={color}
      data-label-density={label.length > 10 ? "long" : undefined}
      data-playable={playable || undefined}
      data-selected={selected || undefined}
      data-value-density={
        centerMark && centerMark.length >= 3 ? "long" : undefined
      }
      data-variant={variant}
      aria-hidden="true"
    >
      <span className="card-face__field-shell">
        <span className="card-face__field" />
      </span>

      {color === "wild" ? (
        <span className="card-face__spectrum">
          {COLORS.map((spectrumColor) => (
            <span key={spectrumColor} data-color={spectrumColor} />
          ))}
        </span>
      ) : null}

      <span className="card-face__corner card-face__corner--top">
        {cornerMark}
      </span>
      <span className="card-face__center">
        {centerMark ? (
          <strong className="card-face__value">{centerMark}</strong>
        ) : null}
        {icon ? <CardIcon icon={icon} /> : null}
        {supportMark ? (
          <span className="card-face__support">{supportMark}</span>
        ) : null}
      </span>
      <span className="card-face__corner card-face__corner--bottom">
        {cornerMark}
      </span>
      <span className="card-face__label">{label}</span>
      {activeWildColor ? (
        <span
          className="card-face__active-color"
          data-color={activeWildColor}
        >
          {activeWildColor} active
        </span>
      ) : null}
      {playable ? <span className="card-face__play-cue">Play</span> : null}
    </span>
  );
}

function CardIcon({ icon }: { icon: CardIconKey }) {
  const props = {
    "aria-hidden": true,
    className: "card-face__icon",
    focusable: false,
    weight: "bold" as const,
  };

  if (icon === "aperture") return <ApertureIcon {...props} />;
  if (icon === "cards") return <CardsThreeIcon {...props} />;
  if (icon === "reverse") return <ArrowsClockwiseIcon {...props} />;
  if (icon === "skip_all") return <UsersThreeIcon {...props} />;
  return <ProhibitIcon {...props} />;
}
