import { useEffect, useRef, useState } from "react";
import { useStableSignedUrl } from "../../lib/use-stable-signed-url";
import { cn } from "../../lib/utils";

interface Point {
  x: number;
  y: number;
}

export type OverlayPoint = Point & { role: "click" | "drag-start" | "drag-end" };

interface OutputWithPossiblePoints {
  point?: Point;
  startPoint?: Point;
  endPoint?: Point;
}

export function getStepOverlayPoints(output: OutputWithPossiblePoints): Array<OverlayPoint> {
  const points: OverlayPoint[] = [];
  if (output.point != null) points.push({ ...output.point, role: "click" });
  if (output.startPoint != null) points.push({ ...output.startPoint, role: "drag-start" });
  if (output.endPoint != null) points.push({ ...output.endPoint, role: "drag-end" });
  return points;
}

type PixelPosition = { x: number; y: number };

function calculatePosition(
  container: HTMLDivElement,
  img: HTMLImageElement,
  point: Point,
  screenResolution: { width: number; height: number },
): PixelPosition {
  const containerWidth = container.clientWidth;
  const containerHeight = container.clientHeight;
  const imageAspect = img.naturalWidth / img.naturalHeight;
  const containerAspect = containerWidth / containerHeight;

  const renderedWidth = imageAspect > containerAspect ? containerWidth : containerHeight * imageAspect;
  const renderedHeight = imageAspect > containerAspect ? containerWidth / imageAspect : containerHeight;

  const offsetX = (containerWidth - renderedWidth) / 2;
  const offsetY = (containerHeight - renderedHeight) / 2;
  const scaleX = renderedWidth / screenResolution.width;
  const scaleY = renderedHeight / screenResolution.height;

  return {
    x: offsetX + point.x * scaleX,
    y: offsetY + point.y * scaleY,
  };
}

function useOverlayPositions(
  containerRef: React.RefObject<HTMLDivElement | null>,
  points: Array<Point>,
  screenResolution: { width: number; height: number } | undefined,
) {
  const recalculateRef = useRef<() => void>(() => {});
  const hasPoints = points.length > 0;
  const [positions, setPositions] = useState<PixelPosition[]>([]);

  useEffect(() => {
    const sync = () => {
      if (!hasPoints || containerRef.current == null) {
        setPositions([]);
        return;
      }

      const img = containerRef.current.querySelector("img");
      if (img == null || img.naturalWidth === 0 || img.naturalHeight === 0) {
        setPositions([]);
        return;
      }

      // Fall back to the image's natural dimensions when no resolution is provided.
      // This works correctly for full-screen screenshots where the image IS the screen.
      const resolution = screenResolution ?? { width: img.naturalWidth, height: img.naturalHeight };

      // biome-ignore lint/style/noNonNullAssertion: containerRef.current is checked above
      setPositions(points.map((point) => calculatePosition(containerRef.current!, img, point, resolution)));
    };

    recalculateRef.current = sync;
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [hasPoints, screenResolution, containerRef, points]);

  return { positions, hasPoints, recalculate: () => recalculateRef.current() };
}

function getMarkerColorClass(role: OverlayPoint["role"]): string {
  switch (role) {
    case "click":
      return "border-primary bg-primary/20";
    case "drag-start":
      return "border-status-success bg-status-success/20";
    case "drag-end":
      return "border-status-critical bg-status-critical/20";
  }
}

function DragLine({ start, end, size }: { start: PixelPosition; end: PixelPosition; size: "sm" | "lg" }) {
  const strokeWidth = size === "sm" ? 2 : 3;

  return (
    <svg
      className="pointer-events-none absolute inset-0"
      style={{ width: "100%", height: "100%", overflow: "visible" }}
      aria-label="Drag direction indicator"
    >
      <title>Drag direction indicator</title>
      <line
        x1={start.x}
        y1={start.y}
        x2={end.x}
        y2={end.y}
        stroke="rgba(255,255,255,0.5)"
        strokeWidth={strokeWidth + 2}
        strokeLinecap="round"
      />
      <line
        x1={start.x}
        y1={start.y}
        x2={end.x}
        y2={end.y}
        stroke="rgba(255,255,255,0.8)"
        strokeWidth={strokeWidth}
        strokeDasharray={size === "sm" ? "4 3" : "8 5"}
        strokeLinecap="round"
      />
    </svg>
  );
}

function PointMarkers({
  points,
  screenResolution,
  size,
  containerRef,
}: {
  points: Array<OverlayPoint>;
  screenResolution?: { width: number; height: number };
  size: "sm" | "lg";
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { positions } = useOverlayPositions(containerRef, points, screenResolution);

  const hasDrag = points.some((p) => p.role === "drag-start" || p.role === "drag-end");
  const dragStartPos = hasDrag ? positions[points.findIndex((p) => p.role === "drag-start")] : undefined;
  const dragEndPos = hasDrag ? positions[points.findIndex((p) => p.role === "drag-end")] : undefined;

  return (
    <>
      {hasDrag && dragStartPos != null && dragEndPos != null && (
        <DragLine start={dragStartPos} end={dragEndPos} size={size} />
      )}
      {positions.map((pos, i) => {
        const point = points[i];
        if (point == null) return null;
        const colorClass = getMarkerColorClass(point.role);
        return (
          <div
            key={`${pos.x}-${pos.y}`}
            className="pointer-events-none absolute"
            style={{ left: pos.x, top: pos.y, transform: "translate(-50%, -50%)" }}
          >
            <div className={cn("rounded-full border-2 shadow-lg", colorClass, size === "sm" ? "size-3" : "size-8")} />
          </div>
        );
      })}
    </>
  );
}

export interface ScreenshotWithOverlayProps {
  src: string;
  alt: string;
  imgClassName?: string;
  overlaySize: "sm" | "lg";
  points?: Array<OverlayPoint>;
  screenResolution?: { width: number; height: number };
  onClick?: (e: React.MouseEvent) => void;
}

export function ScreenshotWithOverlay({
  src,
  alt,
  imgClassName,
  overlaySize,
  points,
  screenResolution,
  onClick,
}: ScreenshotWithOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlay = useOverlayPositions(containerRef, points ?? [], screenResolution);
  // Pin the signed src so a re-sign does not re-fetch the frame (and drop the computed overlay) on every poll.
  const stableSrc = useStableSignedUrl(src);

  return (
    <div ref={containerRef} className="relative" onClick={onClick}>
      <img src={stableSrc} alt={alt} className={imgClassName} onLoad={overlay.recalculate} />
      {overlay.hasPoints && (
        <PointMarkers
          points={points ?? []}
          screenResolution={screenResolution}
          size={overlaySize}
          containerRef={containerRef}
        />
      )}
    </div>
  );
}
