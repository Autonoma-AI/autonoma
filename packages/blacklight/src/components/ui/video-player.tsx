"use client";

import { useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { Button } from "./button";

const PLAYBACK_RATES = [1, 2, 4, 8] as const;

/** Default playback rate for each mode. Optimized recordings are ~one distinct frame per state, so a slower
 *  rate reads better; original recordings are mostly dead time, so they default fast. */
const DEFAULT_OPTIMIZED_RATE = 2;
const DEFAULT_ORIGINAL_RATE = 8;

type Mode = "optimized" | "original";

export interface VideoPlayerProps {
  /** The full run recording. */
  src: string;
  /** The dead-time-stripped recording. When provided, an Optimized/Original toggle is shown and Optimized is
   *  the default; when omitted, only the original plays and no toggle renders. */
  optimizedSrc?: string;
  /** Optional poster frame shown before playback. */
  poster?: string;
  /** Caption under the player (e.g. "Run recording"). */
  label?: string;
  /** Overrides the default rate the optimized recording starts at. */
  optimizedRate?: number;
  /** Overrides the default rate the original recording starts at. */
  originalRate?: number;
  className?: string;
  /** Extra classes for the `<video>` element itself (e.g. a max-height cap). */
  videoClassName?: string;
}

/**
 * The single run-recording player used everywhere a test recording is shown. Wraps a native `<video>` with a
 * playback-speed selector and, when an optimized recording is available, an Optimized/Original toggle -
 * Optimized plays the dead-time-stripped recording (one frame per meaningful state), Original the full capture.
 */
export function VideoPlayer({
  src,
  optimizedSrc,
  poster,
  label = "Run recording",
  optimizedRate = DEFAULT_OPTIMIZED_RATE,
  originalRate = DEFAULT_ORIGINAL_RATE,
  className,
  videoClassName,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hasOptimized = optimizedSrc != null;
  const [mode, setMode] = useState<Mode>(hasOptimized ? "optimized" : "original");
  const [speed, setSpeed] = useState(hasOptimized ? optimizedRate : originalRate);

  // The element resets playbackRate whenever a new source loads, so it is reapplied on loadedmetadata.
  const applySpeed = (rate: number) => {
    setSpeed(rate);
    if (videoRef.current != null) videoRef.current.playbackRate = rate;
  };

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    setSpeed(next === "optimized" ? optimizedRate : originalRate);
  };

  const currentSrc = mode === "optimized" && optimizedSrc != null ? optimizedSrc : src;

  // Selected controls read as a quiet lime outline rather than a bright filled pill, so the video stays the
  // focus; unselected controls fade to the muted border/text.
  const pillClass = (selected: boolean) => cn(selected ? "border-primary text-primary" : "text-text-secondary");

  return (
    <figure className={cn("flex flex-col gap-1", className)}>
      {/* biome-ignore lint/a11y/useMediaCaption: agent run recording, no captions exist */}
      <video
        ref={videoRef}
        key={currentSrc}
        src={currentSrc}
        poster={poster}
        controls
        playsInline
        onLoadedMetadata={() => applySpeed(speed)}
        className={cn("w-full rounded-lg border border-border-dim", videoClassName)}
      />
      <div className="flex flex-wrap items-center gap-2">
        {hasOptimized ? (
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="xs"
              className={pillClass(mode === "optimized")}
              onClick={() => switchMode("optimized")}
            >
              Optimized
            </Button>
            <Button
              variant="outline"
              size="xs"
              className={pillClass(mode === "original")}
              onClick={() => switchMode("original")}
            >
              Original
            </Button>
          </div>
        ) : (
          <figcaption className="font-mono text-3xs uppercase tracking-widest text-text-secondary">{label}</figcaption>
        )}
        <div className="ml-auto flex items-center gap-1">
          {PLAYBACK_RATES.map((rate) => (
            <Button
              key={rate}
              variant="outline"
              size="xs"
              className={pillClass(rate === speed)}
              onClick={() => applySpeed(rate)}
            >
              {rate}×
            </Button>
          ))}
        </div>
      </div>
    </figure>
  );
}
