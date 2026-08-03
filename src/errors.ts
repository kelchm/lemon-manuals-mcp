export class PublicError extends Error {
  readonly detail: string;

  constructor(message: string, detail: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PublicError";
    this.detail = detail;
  }
}

export function errorDetail(error: unknown): string {
  if (error instanceof PublicError) return error.detail;
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

export function publicMessage(error: unknown, fallback: string): string {
  return error instanceof PublicError ? error.message : fallback;
}
