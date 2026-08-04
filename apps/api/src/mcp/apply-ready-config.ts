import { type AuthorableDocument, type PreviewConfig, toAuthorableDocument } from "@autonoma/types";

/**
 * The send-back-ready twin of a stored config, for an agent that read a document
 * and means to save it again.
 *
 * `apply_config` accepts only the two authorable build methods, so a document
 * saved before the framework presets were retired reads back carrying a build
 * block it cannot itself save - and an agent asked to add a service is rejected
 * over an app it never touched. This carries the converted document so the agent
 * sends THIS one instead of hand-converting, plus what changed, so it can tell
 * the user what saving will do.
 */
export interface ApplyReadyConfig {
    /** The document to send to `apply_config`: the read document with every convertible preset rewritten. */
    document: PreviewConfig;
    /** Per app, the retired preset that was rewritten and the commands it became. */
    converted: AuthorableDocument["converted"];
    /** Apps whose preset has no expressible equivalent - the document cannot be saved until a human resolves these. */
    unconvertible: AuthorableDocument["unconvertible"];
    /** What the agent should do, in the order it should do it. */
    guidance: string;
}

/**
 * The apply-ready twin of `document`, or undefined when the document is already
 * authorable - so a modern config carries no noise.
 */
export function applyReadyConfig(document: PreviewConfig): ApplyReadyConfig | undefined {
    const authorable = toAuthorableDocument(document);
    if (authorable.converted.length === 0 && authorable.unconvertible.length === 0) return undefined;

    return {
        document: authorable.document,
        converted: authorable.converted,
        unconvertible: authorable.unconvertible,
        guidance: guidanceFor(authorable),
    };
}

function guidanceFor(authorable: AuthorableDocument): string {
    if (authorable.unconvertible.length > 0) {
        const blocked = authorable.unconvertible.map((entry) => `${entry.app} (${entry.framework})`).join(", ");
        return (
            `This app's stored config predates the current build methods, and ${blocked} cannot be expressed with ` +
            `them - so nothing in this config can be saved until that is resolved (each entry carries its reason). ` +
            `Do not guess a build for it: tell the user what is blocking and what you would need from them. Even an ` +
            `unrelated change has to wait for that app to be fixed.`
        );
    }
    const converted = authorable.converted.map((entry) => `${entry.app} (${entry.from})`).join(", ");
    return (
        `This app's stored config predates the current build methods: ${converted}. The document here is that same ` +
        `config with those apps expressed as "runtime" builds running the same install / build / start commands - ` +
        `edit and send THIS one to apply_config, because the stored document would be rejected. The change is ` +
        `one-way and the preview keeps deploying as it is until you save, so tell the user their app's build method ` +
        `is changing before you save it.`
    );
}
