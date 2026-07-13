export const BUILD_MESSAGES = {
    infrastructureUnavailable:
        "The build service was temporarily unavailable and could not start your build. " +
        "This is a platform issue on our side, not a problem with your app or its configuration. " +
        "Please retry the deploy; if it keeps happening, contact support.",
    capacityUnavailable:
        "The build service could not obtain compute capacity in time, so your build did not start. " +
        "This is a temporary platform capacity issue, not a problem with your app or its configuration. " +
        "Please retry the deploy; if it keeps happening, contact support.",
} as const;
