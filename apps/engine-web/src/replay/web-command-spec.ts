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
