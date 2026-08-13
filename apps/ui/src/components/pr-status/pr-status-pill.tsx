import { Badge, cn } from "@autonoma/blacklight";
import type { PrPipelineStatus } from "@autonoma/types";
import { prStatusPresentation } from "./pr-status-presentation";
import { type PrStatusWeight, prStatusToneClasses } from "./pr-status-tone";

/**
 * `compact` is the row-level treatment: list cells, the main-branch chip, checkpoint rail rows.
 * `comfortable` is the page's headline verdict, which earns more weight than a row.
 */
const DENSITY_CLASS = {
  compact: "gap-1.5",
  comfortable: "h-6 gap-2 px-2.5 text-2xs tracking-widest",
} as const;

type PrStatusDensity = keyof typeof DENSITY_CLASS;

/** A row is one line among many; a headline is the only thing on screen. See `PrStatusWeight`. */
const DENSITY_WEIGHT: Record<PrStatusDensity, PrStatusWeight> = {
  compact: "row",
  comfortable: "verdict",
};

/**
 * What a `none` status renders. The PR and main headers say nothing rather than claim a verdict they do not
 * have; the list keeps a dash so the column does not collapse to an empty cell that reads as a loading state.
 */
type PrStatusEmpty = "hide" | "dash";

interface PrStatusPillProps {
  status: PrPipelineStatus;
  density?: PrStatusDensity;
  empty?: PrStatusEmpty;
  className?: string;
}

/**
 * The single rendering of a pull request's pipeline status. Every surface that shows one uses this, so a PR
 * reads identically wherever you meet it.
 *
 * Fitting a variable-length label into a fixed table column is the whole of the layout here. `Badge` already
 * clips (`overflow-hidden`), but it is also `w-fit shrink-0`, so it has to be told it may shrink before that
 * clipping can ever engage. Inside, the reason is `basis-0`: flexbox distributes negative free space in
 * proportion to each item's base size, so a zero base means the reason gives up all of its width before the
 * label loses a single character, and the label only ellipsises once the reason is gone. The full text stays
 * on `title` either way.
 */
export function PrStatusPill({ status, density = "compact", empty = "hide", className }: PrStatusPillProps) {
  const presentation = prStatusPresentation(status);

  if (presentation == null) {
    if (empty === "hide") return undefined;
    return (
      <Badge
        variant="outline"
        className={cn(
          "border-transparent font-mono text-3xs uppercase text-text-secondary",
          DENSITY_CLASS[density],
          className,
        )}
      >
        -
      </Badge>
    );
  }

  const tone = prStatusToneClasses(presentation.tone, DENSITY_WEIGHT[density]);
  const title = presentation.reason != null ? `${presentation.label} · ${presentation.reason}` : presentation.label;

  return (
    <Badge
      title={title}
      variant="outline"
      className={cn(
        "min-w-0 max-w-full shrink justify-start font-mono text-3xs font-bold uppercase",
        tone.pill,
        DENSITY_CLASS[density],
        className,
      )}
    >
      {tone.dot != null && <span className={cn("size-1.5 shrink-0", tone.dot)} />}
      <span className="min-w-0 truncate">{presentation.label}</span>
      {presentation.reason != null && (
        <span className="min-w-0 flex-1 basis-0 truncate font-normal normal-case opacity-70">
          · {presentation.reason}
        </span>
      )}
    </Badge>
  );
}
