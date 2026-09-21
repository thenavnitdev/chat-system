/**
 * FakeProvider - deterministic LLM for testing with no network calls.
 * Streams a reply word-by-word with configurable delay.
 * Throws mid-stream if prompt contains "[fail]".
 */

import type { LLMProvider } from './provider.js';

export class FakeProvider implements LLMProvider {
  private delayMs: number;

  constructor(delayMs: number = 100) {
    this.delayMs = delayMs;
  }

  async *generate(prompt: string): AsyncGenerator<string, void, unknown> {
    // Generate contextual reply based on prompt
    const words = this.generateReply(prompt);

    for (let i = 0; i < words.length; i++) {
      // Simulate failure if prompt contains [fail]
      if (prompt.includes('[fail]') && i === Math.floor(words.length / 2)) {
        throw new Error('Simulated provider failure');
      }

      await this.sleep(this.delayMs);
      yield words[i] + (i < words.length - 1 ? ' ' : '');
    }
  }

  private generateReply(prompt: string): string[] {
    const lowerPrompt = prompt.toLowerCase();

    // Contextual responses based on prompt content
    if (lowerPrompt.includes('hello') || lowerPrompt.includes('hi')) {
      return ['Hello!', 'How', 'can', 'I', 'help', 'you', 'today?'];
    }

    if (lowerPrompt.includes('how are you')) {
      return ['I\'m', 'doing', 'great,', 'thank', 'you', 'for', 'asking!', 'How', 'about', 'you?'];
    }

    if (lowerPrompt.includes('bye') || lowerPrompt.includes('goodbye')) {
      return ['Goodbye!', 'Have', 'a', 'wonderful', 'day!'];
    }

    if (lowerPrompt.includes('thank')) {
      return ['You\'re', 'welcome!', 'Happy', 'to', 'help!'];
    }

    if (lowerPrompt.includes('help')) {
      return ['I\'d', 'be', 'happy', 'to', 'help', 'you.', 'What', 'do', 'you', 'need', 'assistance', 'with?'];
    }

    if (lowerPrompt.includes('test')) {
      return ['This', 'is', 'a', 'test', 'response.', 'The', 'resumable', 'chat', 'is', 'working', 'correctly!'];
    }

    if (lowerPrompt.includes('?')) {
      // It's a question
      return ['That\'s', 'a', 'great', 'question!', 'Let', 'me', 'think', 'about', 'that.', 'Based', 'on', 'your', 'message,', 'I', 'would', 'say', 'that', 'it', 'depends', 'on', 'the', 'context.'];
    }

    // Default response with some variety based on prompt
    const hash = this.simpleHash(prompt);
    const responses = [
      ['I', 'understand', 'your', 'message.', 'Let', 'me', 'provide', 'a', 'thoughtful', 'response.'],
      ['Thank', 'you', 'for', 'sharing', 'that.', 'I', 'appreciate', 'your', 'input.'],
      ['That\'s', 'interesting!', 'I', 'see', 'what', 'you', 'mean.', 'Let\'s', 'discuss', 'this', 'further.'],
      ['I', 'hear', 'you.', 'Your', 'point', 'is', 'well', 'taken.', 'Here\'s', 'my', 'perspective.'],
      ['Absolutely!', 'I', 'can', 'help', 'with', 'that.', 'Let', 'me', 'explain', 'in', 'detail.'],
    ];

    return responses[hash % responses.length];
  }

  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
