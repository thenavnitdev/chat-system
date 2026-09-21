/**
 * Simple structured logger to make lifecycle events observable.
 */

type LogLevel = 'info' | 'warn' | 'error';

export function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const logData = data ? ` ${JSON.stringify(data)}` : '';
  console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}${logData}`);
}
