import { cn } from "../../lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AgentIndicatorState = "idle" | "processing" | "analyzing" | "working" | "success" | "failed";

export interface AgentIndicatorProps {
  /** Visual state driving animation speed, color and brightness. @default "idle" */
  state?: AgentIndicatorState;
  /** Pixel size (width = height). @default 20 */
  size?: number;
  className?: string;
}

// ─── State config ─────────────────────────────────────────────────────────────

const STATE_DURATION: Record<AgentIndicatorState, number> = {
  idle: 22,
  processing: 7,
  analyzing: 4.5,
  working: 4,
  success: 5,
  failed: 18,
};

const STATE_COLOR: Record<AgentIndicatorState, string> = {
  idle: "var(--primary-ink)",
  processing: "var(--status-pending)",
  analyzing: "var(--status-warn)",
  working: "var(--primary-ink)",
  success: "var(--status-success)",
  failed: "var(--status-critical)",
};

const STATE_OPACITY: Record<AgentIndicatorState, number> = {
  idle: 0.5,
  processing: 0.7,
  analyzing: 0.8,
  working: 0.9,
  success: 0.75,
  failed: 0.75,
};

/** Human-readable label for each state */
export const AGENT_INDICATOR_STATE_LABEL: Record<AgentIndicatorState, string> = {
  idle: "Standby",
  processing: "Processing",
  analyzing: "Analyzing",
  working: "Working",
  success: "Done",
  failed: "Error",
};

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * SVG-based agent indicator. Two concentric squares rotating in opposite
 * directions. Fully contained within the SVG viewport - no DOM compositing
 * layer issues.
 */
export function AgentIndicator({ state = "idle", size = 20, className }: AgentIndicatorProps) {
  const color = STATE_COLOR[state];
  const dur = STATE_DURATION[state];
  const opacity = STATE_OPACITY[state];

  const center = size / 2;
  const outerHalf = size / 2 - 0.5;
  const innerHalf = outerHalf * 0.6;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn("shrink-0", className)}
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Outer square */}
      <rect
        x={center - outerHalf}
        y={center - outerHalf}
        width={outerHalf * 2}
        height={outerHalf * 2}
        fill="none"
        strokeWidth={1}
        style={{ stroke: color, opacity }}
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from={`0 ${center} ${center}`}
          to={`360 ${center} ${center}`}
          dur={`${dur}s`}
          repeatCount="indefinite"
        />
      </rect>

      {/* Inner square */}
      <rect
        x={center - innerHalf}
        y={center - innerHalf}
        width={innerHalf * 2}
        height={innerHalf * 2}
        fill="none"
        strokeWidth={1}
        style={{ stroke: color, opacity: opacity * 0.45 }}
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from={`360 ${center} ${center}`}
          to={`0 ${center} ${center}`}
          dur={`${dur}s`}
          repeatCount="indefinite"
        />
      </rect>
    </svg>
  );
}
