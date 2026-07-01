export class APIError extends Error {}

/**
 * Thrown when a resource is not found.
 */
export class NotFoundError extends APIError {
    constructor(message = "Not found") {
        super(message);
    }
}

/**
 * Thrown when a uniqueness constraint is violated.
 */
export class ConflictError extends APIError {
    constructor(message = "Conflict") {
        super(message);
    }
}

/**
 * Thrown when a request contains invalid data.
 */
export class BadRequestError extends APIError {
    constructor(message = "Bad request") {
        super(message);
    }
}

/**
 * Thrown when the server encounters an unexpected internal state.
 */
export class InternalError extends APIError {
    constructor(message = "Internal server error") {
        super(message);
    }
}

/**
 * Thrown when an organization has insufficient credits to perform an action.
 */
export class InsufficientCreditsError extends APIError {
    constructor(message = "Insufficient credits") {
        super(message);
    }
}

/**
 * Thrown when a subscription is overdue and grace period has expired.
 */
export class SubscriptionGracePeriodExpiredError extends APIError {
    constructor(message = "Subscription payment overdue: grace period expired") {
        super(message);
    }
}
