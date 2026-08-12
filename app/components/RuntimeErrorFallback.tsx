"use client";

import type { CSSProperties } from "react";

type RuntimeErrorFallbackProps = Readonly<{
  reset: () => void;
}>;

const styles = {
  action: {
    alignItems: "center",
    background: "#151515",
    border: "1px solid #151515",
    color: "#f6f0e5",
    cursor: "pointer",
    display: "inline-flex",
    font: "700 0.78rem/1 system-ui, sans-serif",
    justifyContent: "center",
    minHeight: "44px",
    padding: "0.85rem 1rem",
    textDecoration: "none",
    textTransform: "uppercase",
  },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.65rem",
    marginTop: "1.4rem",
  },
  card: {
    background: "#f6f0e5",
    border: "1px solid #151515",
    boxShadow: "10px 10px 0 #dd3824",
    maxWidth: "38rem",
    padding: "clamp(1.4rem, 5vw, 2.5rem)",
  },
  copy: {
    color: "#4e4a43",
    font: "400 1rem/1.6 system-ui, sans-serif",
    margin: "0.8rem 0 0",
  },
  eyebrow: {
    font: "700 0.72rem/1.2 ui-monospace, monospace",
    letterSpacing: "0.12em",
    textTransform: "uppercase",
  },
  heading: {
    font: "800 clamp(2rem, 8vw, 4.5rem)/0.95 system-ui, sans-serif",
    letterSpacing: "-0.055em",
    margin: "0.8rem 0 0",
    textTransform: "uppercase",
  },
  main: {
    alignItems: "center",
    background: "#ede6d8",
    color: "#151515",
    display: "flex",
    justifyContent: "center",
    minHeight: "100vh",
    padding: "clamp(1rem, 5vw, 3rem)",
  },
  secondaryAction: {
    background: "transparent",
    color: "#151515",
  },
} satisfies Record<string, CSSProperties>;

/**
 * Last-resort recovery UI for render failures. It deliberately receives no
 * Error object, so stack traces, table identifiers, and framework digests can
 * never be reflected into the page.
 */
export function RuntimeErrorFallback({ reset }: RuntimeErrorFallbackProps) {
  return (
    <main style={styles.main} role="alert" aria-labelledby="runtime-error-title">
      <section style={styles.card}>
        <span style={styles.eyebrow}>Open Shed · recovery</span>
        <h1 id="runtime-error-title" style={styles.heading}>
          The table view hit a snag.
        </h1>
        <p style={styles.copy}>
          Your server-saved table is still separate from this screen. Try the
          view again, reload this page, or return to your games.
        </p>
        <div style={styles.actions}>
          <button type="button" style={styles.action} onClick={reset}>
            Try again
          </button>
          <button
            type="button"
            style={{ ...styles.action, ...styles.secondaryAction }}
            onClick={() => window.location.reload()}
          >
            Reload page
          </button>
          <button
            type="button"
            style={{ ...styles.action, ...styles.secondaryAction }}
            onClick={() => window.location.assign("/")}
          >
            Back to games
          </button>
        </div>
      </section>
    </main>
  );
}
