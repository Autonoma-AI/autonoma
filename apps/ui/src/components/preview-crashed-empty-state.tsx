import { EmptyState, cn } from "@autonoma/blacklight";
import type { DeployFailureExplanation } from "@autonoma/types";
import { WarningOctagonIcon } from "@phosphor-icons/react/WarningOctagon";

/**
 * Matches {@link PreviewIdleEmptyState}: the shared empty state is a bordered card, which reads as a
 * card floating inside the already-bordered terminal panel.
 */
const PANEL_CLASS = "h-full border-0 bg-transparent font-sans";

/**
 * How far the app got, which decides whether "it stopped" is even true.
 *
 * A crashloop DID run, so an empty stream means it died before reaching its own logger. A container
 * that failed to be created never ran at all, and telling that reader their app "exited" sends them
 * looking for a runtime bug that does not exist.
 */
const COPY_BY_SOURCE: Record<DeployFailureExplanation["lookIn"], { title: string; describe: (app: string) => string }> =
  {
    app_logs: {
      title: "No output before it stopped",
      describe: (app) =>
        `${app} exited before it logged anything, so there is nothing to show here. A crash this early is usually ` +
        "configuration the app reads at startup - a database URL, a required environment variable - rather than " +
        "anything it got far enough to report.",
    },
    config: {
      title: "The app never ran",
      describe: (app) =>
        `The container for ${app} could not be created, so it produced no logs at all. The cause is in its ` +
        "configuration rather than in its output - check its secrets and environment variables.",
    },
    build_logs: {
      title: "The app never ran",
      describe: (app) =>
        `No image was available for ${app}, so nothing started and there are no runtime logs. The Build logs tab ` +
        "has the failure.",
    },
  };

/**
 * What a runtime log panel shows when its app failed before producing output.
 *
 * The panel's "waiting for application output…" spinner waits for a line that is never coming, and on
 * the one screen where the reader has just been told where to look, an indefinite spinner reads as
 * "still loading, wait" - the opposite of what is true.
 *
 * Deliberately offers no action. Restart and Rebuild already sit on the detail strip directly above
 * this panel, and a second copy here would be the same button twice on one screen.
 */
export function PreviewCrashedEmptyState({
  appName,
  lookIn,
  className,
}: {
  appName: string;
  lookIn: DeployFailureExplanation["lookIn"];
  className?: string;
}) {
  const copy = COPY_BY_SOURCE[lookIn];

  return (
    <EmptyState
      icon={<WarningOctagonIcon size={28} />}
      title={copy.title}
      description={copy.describe(appName)}
      className={cn(PANEL_CLASS, className)}
    />
  );
}
