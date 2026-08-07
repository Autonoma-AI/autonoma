import { EmptyState, buttonVariants, cn } from "@autonoma/blacklight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { MoonIcon } from "@phosphor-icons/react/Moon";
import { PreviewLink } from "components/preview-link";
import { PREVIEW_STATUS_HELP } from "components/preview-status-badge";

/**
 * `cn` here is load-bearing rather than decoration: the button base sets `border-transparent` and the
 * outline variant sets `border-border-mid`, so without tailwind-merge dropping the loser both survive
 * and stylesheet order decides - which renders a button with no visible border at all.
 */
const START_BUTTON_CLASS = cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5");

/**
 * The shared empty state is a bordered card by default, which reads as a card floating inside the
 * already-bordered terminal panel. Stripped back to bare content that fills the panel and centres in
 * it, plus `font-sans` because the log body sets `font-mono` and only the title wants to keep it.
 */
const PANEL_CLASS = "h-full border-0 bg-transparent font-sans";

/**
 * What a runtime log panel shows when its preview has scaled to zero.
 *
 * A sleeping preview emits no output, so a panel waiting for a first line waits
 * forever and reads as loading - the one thing that is definitely not happening.
 * This says the environment is off instead, and hands over the only affordance that
 * changes that. "Idle" and its explanation come from the shared status registry, so
 * this panel and the liveness badge above it say the same word for the same state.
 *
 * The start action is a plain {@link PreviewLink}: visiting a preview is what wakes
 * it, and that component already routes an Autonoma preview through the
 * `/preview-waiting` screen, which polls until the environment is serving and then
 * forwards. There is no separate wake call to make.
 */
export function PreviewIdleEmptyState({ url, className }: { url?: string | undefined; className?: string }) {
  return (
    <EmptyState
      icon={<MoonIcon size={28} />}
      title="Preview is idle"
      description={PREVIEW_STATUS_HELP.Idle}
      action={
        url == null ? undefined : (
          <PreviewLink url={url} className={START_BUTTON_CLASS}>
            Start the preview
            <ArrowSquareOutIcon size={14} />
          </PreviewLink>
        )
      }
      className={cn(PANEL_CLASS, className)}
    />
  );
}
