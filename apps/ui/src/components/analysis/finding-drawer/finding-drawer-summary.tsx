import { Skeleton, StableImage, VideoPlayer, cn } from "@autonoma/blacklight";
import {
  ClassificationErrorBlock,
  ObservedAppIssuesNote,
  ProseSection,
  VerdictEvidence,
} from "components/analysis/verdict-story";
import { type ReactNode, useState } from "react";
import type { FindingDetailClassification, FindingDetailGeneration } from "./finding-drawer-types";

/**
 * The drawer's summary tab: one media frame (recording by default, toggling to the classifier's key frame via
 * the control-row slot) followed by the verdict story - the same sections the finding evidence page renders,
 * driven by whichever fields this verdict carries.
 */
export function FindingDrawerSummary({
  classification,
  generation,
}: {
  classification: FindingDetailClassification;
  generation?: FindingDetailGeneration;
}) {
  return (
    <div className="flex flex-col gap-5">
      <MediaPanel classification={classification} generation={generation} />

      <ProseSection title="Expected">{classification.expectedBehavior}</ProseSection>
      <ProseSection title="Actual">{classification.actualBehavior}</ProseSection>
      <ProseSection title="What happened">{classification.whatHappened}</ProseSection>
      <ProseSection title="Why it could not be stabilized">{classification.planMismatchNote}</ProseSection>
      <ProseSection title="Why this test was removed">{classification.invalidTestNote}</ProseSection>
      <ProseSection title="Remediation">{classification.remediation}</ProseSection>

      <ObservedAppIssuesNote>{classification.observedAppIssues}</ObservedAppIssuesNote>

      <VerdictEvidence evidence={classification.evidence} />

      <ProseSection title="Root cause" tone="secondary">
        {classification.rootCause}
      </ProseSection>
      <ProseSection title="False-positive check" tone="secondary">
        {classification.falsePositiveRisk}
      </ProseSection>

      {classification.error != null && <ClassificationErrorBlock error={classification.error} />}
    </div>
  );
}

type MediaMode = "recording" | "keyframe";

function MediaPanel({
  classification,
  generation,
}: {
  classification: FindingDetailClassification;
  generation?: FindingDetailGeneration;
}) {
  const videoUrl = generation?.videoUrl;
  const keyScreenshotUrl = classification.keyScreenshotUrl;
  const [mode, setMode] = useState<MediaMode>(videoUrl != null ? "recording" : "keyframe");
  if (videoUrl == null && keyScreenshotUrl == null) return undefined;

  const toggle =
    videoUrl != null && keyScreenshotUrl != null ? (
      <div className="flex items-center gap-1">
        <ModePill selected={mode === "recording"} onClick={() => setMode("recording")}>
          Recording
        </ModePill>
        <ModePill selected={mode === "keyframe"} onClick={() => setMode("keyframe")}>
          Key frame
        </ModePill>
      </div>
    ) : undefined;

  if (mode === "recording" && videoUrl != null) {
    return (
      <VideoPlayer
        src={videoUrl}
        optimizedSrc={generation?.optimizedVideoUrl}
        actions={toggle}
        videoClassName="aspect-video bg-surface-void object-contain"
      />
    );
  }
  if (keyScreenshotUrl == null) return undefined;
  return (
    <figure className="flex flex-col gap-1">
      <KeyFrameImage src={keyScreenshotUrl} alt="The key frame the classifier chose" />
      <div className="flex items-center justify-between gap-2">
        <figcaption className="font-mono text-3xs uppercase tracking-widest text-text-secondary">Key frame</figcaption>
        {toggle}
      </div>
    </figure>
  );
}

/**
 * The classifier's key frame in a fixed `aspect-video` frame: the space is reserved up front and a pulsing skeleton
 * fills it until the image decodes, so the panel does not jump when the media (or a Recording/Key frame toggle)
 * loads. Uses {@link StableImage} so a re-signed URL from polling does not reload the frame.
 */
function KeyFrameImage({ src, alt }: { src: string; alt: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-border-dim bg-surface-void">
      {!loaded && <Skeleton className="absolute inset-0 size-full rounded-none" />}
      <StableImage
        src={src}
        alt={alt}
        onLoad={() => setLoaded(true)}
        className={cn("size-full object-contain transition-opacity duration-200", loaded ? "opacity-100" : "opacity-0")}
      />
    </div>
  );
}

function ModePill({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md border border-border-mid px-2 py-0.5 font-mono text-3xs transition-colors",
        selected ? "border-primary text-primary" : "text-text-secondary hover:text-text-primary",
      )}
    >
      {children}
    </button>
  );
}
