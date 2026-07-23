import { VideoPlayer } from "@autonoma/blacklight";
import { ScreenshotLightbox } from "components/screenshot-lightbox";
import type { RouterOutputs } from "lib/trpc";

type BugDetail = RouterOutputs["bugs"]["detail"];
type Hero = BugDetail["hero"];

// The adaptive hero: the failure screenshot (with its pin + click-to-zoom) and the
// run video, side by side. Collapses to a single full-width panel when only one
// exists, and shows a small placeholder when neither does - never a broken image
// or an empty half-panel. The video does not autoplay and does not auto-seek.
export function BugHeroMedia({ hero }: { hero: Hero }) {
  const { screenshot, video } = hero;

  if (screenshot == null && video == null) return <HeroPlaceholder />;

  const sideBySide = screenshot != null && video != null;

  return (
    <section className={sideBySide ? "grid gap-4 lg:grid-cols-2" : "grid gap-4"}>
      {screenshot != null && (
        <figure className="flex min-w-0 flex-col gap-2">
          <figcaption className="font-mono text-2xs uppercase tracking-widest text-text-secondary">
            Failure screenshot
          </figcaption>
          <ScreenshotLightbox
            src={screenshot.url}
            alt="Screenshot of the failure"
            className="max-h-[520px] w-full border border-border-dim bg-surface-void object-contain"
            points={screenshot.points}
          />
        </figure>
      )}
      {video != null && (
        <VideoPlayer
          src={video.url}
          label="Run recording"
          videoClassName="max-h-[520px] bg-black"
          className="min-w-0"
        />
      )}
    </section>
  );
}

function HeroPlaceholder() {
  return (
    <div className="flex items-center justify-center border border-dashed border-border-dim bg-surface-base px-4 py-8 text-sm text-text-secondary">
      No media captured for this bug.
    </div>
  );
}
