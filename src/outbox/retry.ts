/** Conditions outside the job itself must not consume its failure budget. */
export class DeferredWork extends Error {
  constructor(message: string, public readonly retryAfterMs = 30_000) { super(message); }
}
