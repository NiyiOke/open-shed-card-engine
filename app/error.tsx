"use client";

import { RuntimeErrorFallback } from "./components/RuntimeErrorFallback";

export default function ErrorBoundary({ reset }: Readonly<{ reset: () => void }>) {
  return <RuntimeErrorFallback reset={reset} />;
}
