export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 2,
    readonly retryable = false,
    readonly data: unknown = null,
    readonly details: { retry_after_seconds?: number; api_request_id?: string } = {},
  ) {
    super(message);
  }
}

export function unavailable(): never {
  throw new CliError("INTEGRATION_NOT_CONFIGURED", "Live API integration is not configured in this development build.", 6);
}

export const safeText = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
