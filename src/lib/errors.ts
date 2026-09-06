/**
 * Errors a service can throw to mean "the client asked for something invalid",
 * as opposed to "something broke".
 *
 * Express 5 forwards both synchronous throws and rejected promises to the error
 * middleware, so a service can throw one of these from anywhere and the handler
 * in app.ts turns it into the right status. Routes do not need to catch.
 */
export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = new.target.name
    this.status = status
  }
}

/** Invalid queue input — a bad verse id, theme, or ordering. */
export class QueueError extends ApiError {
  constructor(message: string, status = 400) {
    super(message, status)
  }
}

/** Invalid slot input — an out-of-range slot, or a verse not free to practice. */
export class SlotError extends ApiError {
  constructor(message: string, status = 400) {
    super(message, status)
  }
}

/**
 * The deployment has no VAPID keys, so it cannot send or accept push
 * subscriptions. 503 rather than 500: nothing is broken, the feature simply
 * isn't configured here, and that is what tells the client to render the
 * reminder toggle as unavailable rather than as failing.
 */
export class PushNotConfiguredError extends ApiError {
  constructor() {
    super('push notifications are not configured', 503)
  }
}
