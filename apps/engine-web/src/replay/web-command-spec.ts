import type {
    AssertCommandSpec,
    ClickCommandSpec,
    HoverCommandSpec,
    NavigateCommandSpec,
    RefreshCommandSpec,
    ScrollCommandSpec,
    TypeCommandSpec,
} from "@autonoma/engine";

/** The possible commands that the web replay engine can execute. */
export type ReplayWebCommandSpec =
    | ClickCommandSpec
    | HoverCommandSpec
    | NavigateCommandSpec
    | TypeCommandSpec
    | AssertCommandSpec
    | ScrollCommandSpec
    | RefreshCommandSpec;

/** Tuple of all valid interaction names for `z.enum` validation at case-load time. */
export const REPLAY_WEB_INTERACTIONS = [
    "click",
    "hover",
    "navigate",
    "type",
    "assert",
    "scroll",
    "refresh",
] as const satisfies ReadonlyArray<ReplayWebCommandSpec["interaction"]>;
