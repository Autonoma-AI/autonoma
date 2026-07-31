import { Badge, StatusDot } from "@autonoma/blacklight";
import type { AnalysisVerdictState } from "@autonoma/types";
import type * as React from "react";

type BadgeVariant = NonNullable<React.ComponentProps<typeof Badge>["variant"]>;
type DotStatus = NonNullable<React.ComponentProps<typeof StatusDot>["status"]>;

/**
 * THE colour of each verdict state. A `Record` over the state union, so a new state is a compile error here until it
 * is given a tone; no surface may re-derive its own mapping.
 */
const VERDICT_TONE: Record<AnalysisVerdictState, { variant: BadgeVariant; dot: DotStatus }> = {
  bug_found: { variant: "critical", dot: "critical" },
  not_confirmed: { variant: "warn", dot: "warn" },
  no_tests_affected: { variant: "neutral", dot: "neutral" },
  healthy: { variant: "success", dot: "success" },
};

/**
 * Wording for the two states that describe the RUN rather than the app's bugs, and so read identically wherever they
 * appear. `no_tests_affected` shares its prose too; `not_confirmed` does not, because each surface names what it
 * could not confirm in its own terms.
 */
export const RUN_VERDICT_COPY = {
  not_confirmed: { badge: "Not confirmed", title: "Couldn't confirm this change" },
  no_tests_affected: {
    badge: "No tests affected",
    title: "No tests were affected by this change",
    prose: "Impact analysis selected no tests for this diff, so the change was not verified.",
  },
} as const;

/**
 * The shared shell every analysis verdict headline renders in: the verdict badge coloured from the state, any
 * secondary count pills, the title, and the prose beneath.
 *
 * Callers own the wording, not the presentation - the snapshot page speaks about one run's findings ("3 client bugs"),
 * the PR page about the branch's open issues ("3 open bugs") - so only the copy differs between surfaces.
 */
export function VerdictHeadline({
  state,
  badge,
  title,
  pills,
  children,
}: {
  state: AnalysisVerdictState;
  /** The verdict badge's text, in the surface's own nouns. */
  badge: string;
  title: string;
  /** Secondary count pills, rendered after the verdict badge. */
  pills?: React.ReactNode;
  /** The prose paragraph under the title. */
  children: React.ReactNode;
}) {
  const tone = VERDICT_TONE[state];

  return (
    <div className="flex flex-col gap-3 border border-border-dim bg-surface-base px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={tone.variant} className="gap-1 font-mono uppercase tracking-wider">
          <StatusDot status={tone.dot} />
          {badge}
        </Badge>
        {pills}
      </div>

      <div className="min-w-0">
        <h2 className="text-lg font-semibold tracking-tight text-text-primary">{title}</h2>
        <p className="mt-1 text-sm text-text-secondary">{children}</p>
      </div>
    </div>
  );
}
