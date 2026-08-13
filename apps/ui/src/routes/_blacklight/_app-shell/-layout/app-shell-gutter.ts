/**
 * The one place the app shell's horizontal gutter is decided.
 *
 * It has to be one place because three things depend on it and two of them break silently if they drift: the top
 * bar's inner row and the page content must share a left edge or the logo and the page's `<h1>` sit a few pixels
 * apart, and the full-bleed pages cancel the padding with a negative margin that has to match it exactly.
 *
 * Tailwind needs literal class strings, so each option spells its own out rather than composing a number.
 *
 * ---
 *
 * **Four options are being chosen between on this pull request. The losers come out with this comment.**
 *
 * The rail used to be the left anchor; with it gone the content floated 24px from both edges of a 1440px screen
 * and 24px from both edges of a 2560px one. And the bar was `px-4` against the content's `p-6`, so nothing lined
 * up with anything - invisible while a 200px column sat beside it, obvious now the bar's border runs the full
 * width.
 *
 * `align` keeps today's 24px and only fixes the mismatch.
 * `roomy` widens the shared gutter to 32px so the page has air.
 * `contained` adds a maximum width on top, so a 292-row table stops stretching to 2560px on a big monitor.
 * `bleed-chrome` lets the bar span the viewport with its own small gutter while the content is centred - the two
 * deliberately do not align, which is common elsewhere and, in this dense bordered aesthetic, reads as an
 * accident.
 */
interface AppShellGutter {
    /** The bar's inner row and the page content, so the two share a left edge. */
    bar: string;
    content: string;
    /** Cancels `content` for a page that lays out its own full-height chrome. Must mirror it exactly. */
    bleed: string;
    /** Wraps the bar's row and the content when the option caps how wide either may get. */
    container: string;
}

const GUTTER_OPTIONS = {
    align: {
        bar: "px-6",
        content: "px-6 py-6",
        bleed: "-mx-6 -my-6 h-[calc(100%+3rem)]",
        container: "",
    },
    roomy: {
        bar: "px-8",
        content: "px-8 py-6",
        bleed: "-mx-8 -my-6 h-[calc(100%+3rem)]",
        container: "",
    },
    contained: {
        bar: "px-8",
        content: "px-8 py-6",
        bleed: "-mx-8 -my-6 h-[calc(100%+3rem)]",
        // Becomes a theme token if this option wins; an arbitrary value only while it is a candidate.
        container: "mx-auto w-full max-w-[100rem]",
    },
    "bleed-chrome": {
        bar: "px-4",
        content: "px-8 py-6",
        bleed: "-mx-8 -my-6 h-[calc(100%+3rem)]",
        container: "mx-auto w-full max-w-[96rem]",
    },
} as const satisfies Record<string, AppShellGutter>;

/** The option being proposed. */
const ACTIVE_GUTTER: keyof typeof GUTTER_OPTIONS = "contained";

export const APP_SHELL_GUTTER: AppShellGutter = GUTTER_OPTIONS[ACTIVE_GUTTER];
