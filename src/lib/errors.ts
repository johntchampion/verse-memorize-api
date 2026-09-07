/**
 * Errors meaning "the client asked for something invalid", as opposed to
 * "something broke".
 *
 * Express 5 forwards both synchronous throws and rejected promises to the error
 * middleware, so these can be thrown from anywhere — a route, a model, a
 * repository — and app.ts turns them into the right status. Nothing catches.
 */
export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = new.target.name
    this.status = status
  }

  body(): Record<string, unknown> {
    return { error: this.message }
  }
}

export class NotFoundError extends ApiError {
  constructor(message: string) {
    super(message, 404)
  }
}

export class ConflictError extends ApiError {
  constructor(message: string) {
    super(message, 409)
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message: string) {
    super(message, 401)
  }
}

export class BadRequestError extends ApiError {
  constructor(message: string) {
    super(message, 400)
  }
}

/**
 * A body that failed its schema. `details` is omitted on the login route, which
 * must not describe which field was wrong.
 */
export class ValidationError extends ApiError {
  readonly details?: unknown

  constructor(details?: unknown) {
    super('invalid body', 400)
    this.details = details
  }

  override body(): Record<string, unknown> {
    return this.details === undefined
      ? { error: this.message }
      : { error: this.message, details: this.details }
  }
}

export class QueueError extends ApiError {
  constructor(message: string, status = 400) {
    super(message, status)
  }
}

export class SlotError extends ApiError {
  constructor(message: string, status = 400) {
    super(message, status)
  }
}

/**
 * 503 rather than 500: nothing is broken, the feature simply isn't configured
 * here, and that is what tells the client to render the reminder toggle as
 * unavailable rather than as failing.
 */
export class PushNotConfiguredError extends ApiError {
  constructor() {
    super('push notifications are not configured', 503)
  }
}
