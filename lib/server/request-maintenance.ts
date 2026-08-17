export type RequestMaintenanceRun<T> =
  | Readonly<{ started: false }>
  | Readonly<{ started: true; value: T }>;

/**
 * Applies an isolate-local cadence without sharing request-bound promises.
 *
 * Worker requests may overlap, but I/O created by one request must never be
 * awaited by another. The timestamp is only an advisory duplicate-work guard;
 * durable idempotency remains the responsibility of the underlying storage.
 */
export function createRequestMaintenanceGate(intervalMs: number): Readonly<{
  run<T>(now: number, task: () => Promise<T>): Promise<RequestMaintenanceRun<T>>;
}> {
  let lastAttemptAt: number | null = null;

  return Object.freeze({
    async run<T>(
      now: number,
      task: () => Promise<T>,
    ): Promise<RequestMaintenanceRun<T>> {
      if (lastAttemptAt !== null && now - lastAttemptAt < intervalMs) {
        return Object.freeze({ started: false });
      }

      const attemptAt = now;
      lastAttemptAt = attemptAt;

      try {
        const value = await task();
        return Object.freeze({ started: true, value });
      } catch (error) {
        // A slower, older request must not reset a newer attempt's cadence.
        if (lastAttemptAt === attemptAt) lastAttemptAt = null;
        throw error;
      }
    },
  });
}
