import { Button, Panel, PanelBody, PanelHeader, PanelTitle, getStepOverlayPoints } from "@autonoma/blacklight";
import { ScreenshotLightbox } from "components/screenshot-lightbox";
import type { RouterOutputs } from "lib/trpc";
import { useState } from "react";
import { BugDescription } from "./bug-description";

type BugDetail = RouterOutputs["bugs"]["detail"];
type LatestOccurrence = NonNullable<BugDetail["latestOccurrence"]>;
type EvidenceMode = "images" | "video";

export function BugEvidenceScreenshot({
  latest,
  bugDescription,
}: {
  latest: LatestOccurrence | undefined;
  bugDescription: string;
}) {
  const [mode, setMode] = useState<EvidenceMode>("images");

  if (latest == null || (latest.failureScreenshotUrl == null && latest.videoUrl == null)) {
    return (
      <Panel>
        <PanelHeader>
          <PanelTitle>Latest failure</PanelTitle>
        </PanelHeader>
        <PanelBody className="p-5">
          <p className="text-sm text-text-tertiary">No run screenshot or video is available for this bug yet.</p>
        </PanelBody>
      </Panel>
    );
  }

  const activeMode = mode === "video" && latest.videoUrl != null ? "video" : "images";
  const points = getStepOverlayPoints(latest);

  return (
    <Panel>
      <PanelHeader className="flex items-center gap-3">
        <PanelTitle>Latest failure</PanelTitle>
        {latest.videoUrl != null && latest.failureScreenshotUrl != null && (
          <div className="ml-auto flex items-center border border-border-dim">
            <Button variant={activeMode === "images" ? "default" : "ghost"} size="sm" onClick={() => setMode("images")}>
              Images
            </Button>
            <Button variant={activeMode === "video" ? "default" : "ghost"} size="sm" onClick={() => setMode("video")}>
              Video
            </Button>
          </div>
        )}
      </PanelHeader>
      <PanelBody className="space-y-4 p-4">
        {activeMode === "video" && latest.videoUrl != null ? (
          <video src={latest.videoUrl} controls className="max-h-[680px] w-full border border-border-dim bg-black">
            <track kind="captions" />
          </video>
        ) : latest.failureScreenshotUrl != null ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <EvidenceImage
              label="Last successful"
              src={latest.lastPassingScreenshotUrl}
              alt="Last successful screenshot before the bug"
            />
            <EvidenceImage
              label="Bug happened"
              src={latest.failureScreenshotUrl}
              alt="Screenshot where the bug happened"
              points={points}
            />
          </div>
        ) : null}
        {bugDescription.trim() !== "" && (
          <div>
            <p className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-tertiary">
              What happened
            </p>
            <BugDescription description={bugDescription} />
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}

function EvidenceImage({
  label,
  src,
  alt,
  points,
}: {
  label: string;
  src: string | undefined;
  alt: string;
  points?: ReturnType<typeof getStepOverlayPoints>;
}) {
  return (
    <div className="min-w-0">
      <p className="mb-2 font-mono text-2xs font-semibold uppercase tracking-widest text-text-tertiary">{label}</p>
      {src != null ? (
        <ScreenshotLightbox
          src={src}
          alt={alt}
          className="max-h-[520px] w-full border border-border-dim object-contain"
          points={points}
        />
      ) : (
        <div className="flex min-h-80 items-center justify-center border border-border-dim bg-surface-void px-4 text-center text-sm text-text-tertiary">
          No screenshot captured.
        </div>
      )}
    </div>
  );
}
