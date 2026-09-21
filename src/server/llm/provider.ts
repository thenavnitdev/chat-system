/**
 * LLMProvider interface - abstraction for text generation.
 * Implementations stream text chunks asynchronously.
 */

export interface LLMProvider {
  /**
   * Generate a response to a prompt.
   * Returns an async generator that yields text chunks.
   * May throw mid-stream to simulate failures.
   */
  generate(prompt: string): AsyncGenerator<string, void, unknown>;
}
