"use client";

import { RuntimeErrorFallback } from "./components/RuntimeErrorFallback";

export default function GlobalErrorBoundary({
  reset,
}: Readonly<{ reset: () => void }>) {
  return (
    <html lang="en">
      <body>
        <RuntimeErrorFallback reset={reset} />
      </body>
    </html>
  );
}
