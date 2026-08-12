"use client";

import { useRef } from "react";
import {
  APP_BUILD_ID,
  APP_RELEASE_LABEL,
  APP_VERSION_LABEL,
} from "../../lib/app-version";

export const NEXT_RELEASE_LABEL = "V1.6.0" as const;

export const RELEASE_NOTES = Object.freeze([
  "The app release, rules profile, and table revision now have clear, separate labels.",
  "Open-table discovery, safer table chat, sound cues, and privacy-safe issue reports form the V1.5 game-night foundation.",
] as const);

export const NEXT_RELEASE_PREVIEW =
  "Game Night Continuity adds server-verified host recovery and a round-by-round series score that survives rematches.";

export function tableRevisionLabel(revision: number): string {
  const safeRevision = Number.isSafeInteger(revision) && revision >= 0
    ? revision
    : 0;
  return `Table revision ${safeRevision}`;
}

export function ReleaseIdentity({ className = "" }: { className?: string }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const open = () => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    window.requestAnimationFrame(() => closeButtonRef.current?.focus());
  };

  const close = () => dialogRef.current?.close();

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`release-identity ${className}`.trim()}
        aria-haspopup="dialog"
        aria-label={`About ${APP_RELEASE_LABEL} and what is new`}
        onClick={open}
      >
        <span>Open Shed</span>
        <strong>{APP_VERSION_LABEL}</strong>
        <span className="release-identity__action">About &amp; what&apos;s new</span>
      </button>

      <dialog
        ref={dialogRef}
        className="release-dialog"
        aria-labelledby="release-dialog-title"
        aria-describedby="release-dialog-summary"
        onClose={() => triggerRef.current?.focus()}
      >
        <div className="release-dialog__panel">
          <div className="release-dialog__heading">
            <div>
              <span className="eyebrow">{APP_RELEASE_LABEL}</span>
              <h2 id="release-dialog-title">About Open Shed</h2>
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              className="release-dialog__close"
              aria-label="Close About Open Shed"
              onClick={close}
            >
              Close
            </button>
          </div>

          <p id="release-dialog-summary" className="release-dialog__summary">
            An unofficial, server-authoritative 2–6 player shedding game built for
            private hands, durable tables, and the Merciless baseline rules profile.
          </p>

          <dl className="release-facts">
            <div><dt>App release</dt><dd>{APP_VERSION_LABEL}</dd></div>
            <div><dt>Rules profile</dt><dd>Merciless baseline V1</dd></div>
            <div><dt>Table revision</dt><dd>Changes after accepted table actions</dd></div>
            {APP_BUILD_ID ? <div><dt>Public build</dt><dd>{APP_BUILD_ID}</dd></div> : null}
          </dl>

          <section className="release-notes" aria-labelledby="release-notes-title">
            <span className="eyebrow">Current release</span>
            <h3 id="release-notes-title">What&apos;s new in {APP_VERSION_LABEL}</h3>
            <ul>
              {RELEASE_NOTES.map((note) => <li key={note}>{note}</li>)}
            </ul>
          </section>

          <section className="release-next" aria-labelledby="release-next-title">
            <span className="eyebrow">Up next</span>
            <h3 id="release-next-title">{NEXT_RELEASE_LABEL} · Game Night Continuity</h3>
            <p>{NEXT_RELEASE_PREVIEW}</p>
          </section>

          <button type="button" className="secondary-button release-dialog__done" onClick={close}>
            Back to the game
          </button>
        </div>
      </dialog>
    </>
  );
}
