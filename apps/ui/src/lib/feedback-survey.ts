import * as Sentry from "@sentry/react";
import posthog, {
    SurveyEventName,
    SurveyEventProperties,
    SurveyQuestionType,
    type BasicSurveyQuestion,
    type LinkSurveyQuestion,
    type MultipleSurveyQuestion,
    type Properties,
    type RatingSurveyQuestion,
    type Survey,
    type SurveyQuestion,
    type SurveyResponseValue,
} from "lib/posthog";

// We render our own feedback modal instead of PostHog's popover widget: ad-block
// cosmetic filters hide the widget's `.PostHogSurvey*` DOM, while our neutral markup
// slips through. Responses are still posted to PostHog via `capture`, which travels
// over the `/rs` reverse proxy, so the network path is never blocked either.
const FEEDBACK_SURVEY_ID = "019d4b13-3363-0000-8cce-47d6b098a42e";

// PostHog is disabled in dev (see main.tsx), so `getSurveys` never resolves there.
// This lets the modal render and be styled locally; captures no-op without an instance.
const DEV_FEEDBACK_SURVEY: FeedbackSurvey = {
    id: FEEDBACK_SURVEY_ID,
    name: "Feedback",
    current_iteration: null,
    current_iteration_start_date: null,
    questions: [
        {
            type: SurveyQuestionType.Rating,
            id: "dev-rating",
            question: "How would you rate your experience so far?",
            display: "number",
            scale: 5,
            lowerBoundLabel: "Poor",
            upperBoundLabel: "Great",
        },
        {
            type: SurveyQuestionType.Open,
            id: "dev-open",
            question: "What could we do better?",
            optional: true,
        },
    ],
};

/** The subset of a PostHog {@link Survey} our modal reads. */
export type FeedbackSurvey = Pick<
    Survey,
    "id" | "name" | "questions" | "current_iteration" | "current_iteration_start_date"
>;

export type FeedbackResponses = Record<string, SurveyResponseValue>;

export {
    SurveyQuestionType,
    type SurveyResponseValue,
    type SurveyQuestion,
    type BasicSurveyQuestion,
    type RatingSurveyQuestion,
    type MultipleSurveyQuestion,
    type LinkSurveyQuestion,
};

/**
 * Fetch the feedback survey definition so the modal renders the exact questions
 * (and question IDs) configured in PostHog - matching IDs are what let responses
 * map back to the survey in PostHog's results view.
 */
export function loadFeedbackSurvey(): Promise<FeedbackSurvey | undefined> {
    if (import.meta.env.DEV) return Promise.resolve(DEV_FEEDBACK_SURVEY);

    return new Promise((resolve) => {
        try {
            posthog.getSurveys((surveys) => {
                resolve(surveys.find((survey) => survey.id === FEEDBACK_SURVEY_ID));
            });
        } catch (err) {
            Sentry.captureException(err);
            resolve(undefined);
        }
    });
}

/** Record that the modal was opened - the denominator for survey completion rate. */
export function captureFeedbackShown(survey: FeedbackSurvey): void {
    posthog.capture(SurveyEventName.SHOWN, baseSurveyProperties(survey));
}

/** Record that the modal was closed without submitting. */
export function captureFeedbackDismissed(survey: FeedbackSurvey): void {
    posthog.capture(SurveyEventName.DISMISSED, baseSurveyProperties(survey));
}

/** Post the collected responses to PostHog as a `survey sent` event. */
export function submitFeedback(survey: FeedbackSurvey, responses: FeedbackResponses): void {
    posthog.capture(SurveyEventName.SENT, buildSentProperties(survey, responses));
}

function baseSurveyProperties(survey: FeedbackSurvey): Properties {
    return {
        [SurveyEventProperties.SURVEY_ID]: survey.id,
        [SurveyEventProperties.SURVEY_NAME]: survey.name,
        [SurveyEventProperties.SURVEY_ITERATION]: survey.current_iteration,
        [SurveyEventProperties.SURVEY_ITERATION_START_DATE]: survey.current_iteration_start_date,
    };
}

export function buildSentProperties(survey: FeedbackSurvey, responses: FeedbackResponses): Properties {
    const responsesByKey: FeedbackResponses = {};
    for (const question of survey.questions) {
        if (question.id == null) continue;
        responsesByKey[`${SurveyEventProperties.SURVEY_RESPONSE}_${question.id}`] = responses[question.id] ?? null;
    }

    const properties: Properties = {
        ...baseSurveyProperties(survey),
        [SurveyEventProperties.SURVEY_QUESTIONS]: survey.questions.map((question) => ({
            id: question.id,
            question: question.question,
            response: question.id != null ? (responses[question.id] ?? null) : null,
        })),
        [SurveyEventProperties.SURVEY_COMPLETED]: true,
        ...responsesByKey,
        $set: { [respondedPropertyKey(survey)]: true },
    };
    return properties;
}

function respondedPropertyKey(survey: FeedbackSurvey): string {
    const iteration = survey.current_iteration;
    if (iteration != null && iteration > 0) return `$survey_responded/${survey.id}/${iteration}`;
    return `$survey_responded/${survey.id}`;
}
