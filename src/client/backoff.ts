/**
 * Exponential backoff with full jitter for reconnection delays.
 * Injectable random and clock for testing.
 */

export interface BackoffConfig {
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  randomFn?: () => number; // For testing
}

export class ExponentialBackoff {
  private config: BackoffConfig;
  private attempt: number = 0;

  constructor(config: BackoffConfig) {
    this.config = {
      ...config,
      randomFn: config.randomFn || Math.random,
    };
  }

  /**
   * Get the next backoff delay in milliseconds.
   * Uses full jitter: random value between 0 and exponential delay.
   */
  next(): number {
    const exponentialDelay = Math.min(
      this.config.initialDelayMs * Math.pow(this.config.multiplier, this.attempt),
      this.config.maxDelayMs
    );

    this.attempt++;

    // Full jitter: random value between 0 and exponentialDelay
    return Math.floor(this.config.randomFn!() * exponentialDelay);
  }

  /**
   * Reset the backoff state (called on successful connection).
   */
  reset(): void {
    this.attempt = 0;
  }
}
