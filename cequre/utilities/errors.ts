export interface FieldDetail { path: string; code: string }

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryable = false,
    public details: FieldDetail[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
