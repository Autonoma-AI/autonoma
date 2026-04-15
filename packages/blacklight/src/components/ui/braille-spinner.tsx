import { cva, type VariantProps } from "class-variance-authority";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

export type BrailleSpinnerAnimation =
  | "braille"
  | "braillewave"
  | "dna"
  | "scan"
  | "rain"
  | "scanline"
  | "pulse"
  | "snake"
  | "sparkle"
  | "cascade"
  | "columns"
  | "orbit"
  | "breathe"
  | "waverows"
  | "checkerboard"
  | "helix"
  | "fillsweep"
  | "diagswipe";

interface SpinnerData {
  readonly frames: readonly string[];
  readonly interval: number;
}

export interface BrailleSpinnerProps extends VariantProps<typeof brailleSpinnerVariants> {
  /** Which animation to play. @default "braille" */
  animation?: BrailleSpinnerAnimation;
  /** Override the default interval (ms) for the animation. */
  interval?: number;
  className?: string;
}

// ─── Variants ─────────────────────────────────────────────────────────────────

const brailleSpinnerVariants = cva("inline-block font-mono leading-none select-none", {
  variants: {
    size: {
      sm: "text-sm",
      md: "text-base",
      lg: "text-lg",
      xl: "text-2xl",
    },
  },
  defaultVariants: {
    size: "md",
  },
});

// ─── Pre-computed frames ──────────────────────────────────────────────────────

const SPINNERS: Record<BrailleSpinnerAnimation, SpinnerData> = {
  braille: {
    frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    interval: 80,
  },
  braillewave: {
    frames: ["⠁⠂⠄⡀", "⠂⠄⡀⢀", "⠄⡀⢀⠠", "⡀⢀⠠⠐", "⢀⠠⠐⠈", "⠠⠐⠈⠁", "⠐⠈⠁⠂", "⠈⠁⠂⠄"],
    interval: 100,
  },
  dna: {
    frames: ["⠋⠉⠙⠚", "⠉⠙⠚⠒", "⠙⠚⠒⠂", "⠚⠒⠂⠂", "⠒⠂⠂⠒", "⠂⠂⠒⠲", "⠂⠒⠲⠴", "⠒⠲⠴⠤", "⠲⠴⠤⠄", "⠴⠤⠄⠋", "⠤⠄⠋⠉", "⠄⠋⠉⠙"],
    interval: 80,
  },
  scan: {
    frames: ["⠀⠀⠀⠀", "⡇⠀⠀⠀", "⣿⠀⠀⠀", "⢸⡇⠀⠀", "⠀⣿⠀⠀", "⠀⢸⡇⠀", "⠀⠀⣿⠀", "⠀⠀⢸⡇", "⠀⠀⠀⣿", "⠀⠀⠀⢸"],
    interval: 70,
  },
  rain: {
    frames: ["⢁⠂⠔⠈", "⠂⠌⡠⠐", "⠄⡐⢀⠡", "⡈⠠⠀⢂", "⠐⢀⠁⠄", "⠠⠁⠊⡀", "⢁⠂⠔⠈", "⠂⠌⡠⠐", "⠄⡐⢀⠡", "⡈⠠⠀⢂", "⠐⢀⠁⠄", "⠠⠁⠊⡀"],
    interval: 100,
  },
  scanline: {
    frames: ["⠉⠉⠉", "⠓⠓⠓", "⠦⠦⠦", "⣄⣄⣄", "⠦⠦⠦", "⠓⠓⠓"],
    interval: 120,
  },
  pulse: {
    frames: ["⠀⠶⠀", "⠰⣿⠆", "⢾⣉⡷", "⣏⠀⣹", "⡁⠀⢈"],
    interval: 180,
  },
  snake: {
    frames: ["⣁⡀", "⣉⠀", "⡉⠁", "⠉⠉", "⠈⠙", "⠀⠛", "⠐⠚", "⠒⠒", "⠖⠂", "⠶⠀", "⠦⠄", "⠤⠤", "⠠⢤", "⠀⣤", "⢀⣠", "⣀⣀"],
    interval: 80,
  },
  sparkle: {
    frames: ["⡡⠊⢔⠡", "⠊⡰⡡⡘", "⢔⢅⠈⢢", "⡁⢂⠆⡍", "⢔⠨⢑⢐", "⠨⡑⡠⠊"],
    interval: 150,
  },
  cascade: {
    frames: [
      "⠀⠀⠀⠀",
      "⠀⠀⠀⠀",
      "⠁⠀⠀⠀",
      "⠋⠀⠀⠀",
      "⠞⠁⠀⠀",
      "⡴⠋⠀⠀",
      "⣠⠞⠁⠀",
      "⢀⡴⠋⠀",
      "⠀⣠⠞⠁",
      "⠀⢀⡴⠋",
      "⠀⠀⣠⠞",
      "⠀⠀⢀⡴",
      "⠀⠀⠀⣠",
      "⠀⠀⠀⢀",
    ],
    interval: 60,
  },
  columns: {
    frames: [
      "⡀⠀⠀",
      "⡄⠀⠀",
      "⡆⠀⠀",
      "⡇⠀⠀",
      "⣇⠀⠀",
      "⣧⠀⠀",
      "⣷⠀⠀",
      "⣿⠀⠀",
      "⣿⡀⠀",
      "⣿⡄⠀",
      "⣿⡆⠀",
      "⣿⡇⠀",
      "⣿⣇⠀",
      "⣿⣧⠀",
      "⣿⣷⠀",
      "⣿⣿⠀",
      "⣿⣿⡀",
      "⣿⣿⡄",
      "⣿⣿⡆",
      "⣿⣿⡇",
      "⣿⣿⣇",
      "⣿⣿⣧",
      "⣿⣿⣷",
      "⣿⣿⣿",
      "⣿⣿⣿",
      "⠀⠀⠀",
    ],
    interval: 60,
  },
  orbit: {
    frames: ["⠃", "⠉", "⠘", "⠰", "⢠", "⣀", "⡄", "⠆"],
    interval: 100,
  },
  breathe: {
    frames: ["⠀", "⠂", "⠌", "⡑", "⢕", "⢝", "⣫", "⣟", "⣿", "⣟", "⣫", "⢝", "⢕", "⡑", "⠌", "⠂", "⠀"],
    interval: 100,
  },
  waverows: {
    frames: [
      "⠖⠉⠉⠑",
      "⡠⠖⠉⠉",
      "⣠⡠⠖⠉",
      "⣄⣠⡠⠖",
      "⠢⣄⣠⡠",
      "⠙⠢⣄⣠",
      "⠉⠙⠢⣄",
      "⠊⠉⠙⠢",
      "⠜⠊⠉⠙",
      "⡤⠜⠊⠉",
      "⣀⡤⠜⠊",
      "⢤⣀⡤⠜",
      "⠣⢤⣀⡤",
      "⠑⠣⢤⣀",
      "⠉⠑⠣⢤",
      "⠋⠉⠑⠣",
    ],
    interval: 90,
  },
  checkerboard: {
    frames: ["⢕⢕⢕", "⡪⡪⡪", "⢊⠔⡡", "⡡⢊⠔"],
    interval: 250,
  },
  helix: {
    frames: [
      "⢌⣉⢎⣉",
      "⣉⡱⣉⡱",
      "⣉⢎⣉⢎",
      "⡱⣉⡱⣉",
      "⢎⣉⢎⣉",
      "⣉⡱⣉⡱",
      "⣉⢎⣉⢎",
      "⡱⣉⡱⣉",
      "⢎⣉⢎⣉",
      "⣉⡱⣉⡱",
      "⣉⢎⣉⢎",
      "⡱⣉⡱⣉",
      "⢎⣉⢎⣉",
      "⣉⡱⣉⡱",
      "⣉⢎⣉⢎",
      "⡱⣉⡱⣉",
    ],
    interval: 80,
  },
  fillsweep: {
    frames: ["⣀⣀", "⣤⣤", "⣶⣶", "⣿⣿", "⣿⣿", "⣿⣿", "⣶⣶", "⣤⣤", "⣀⣀", "⠀⠀", "⠀⠀"],
    interval: 100,
  },
  diagswipe: {
    frames: ["⠁⠀", "⠋⠀", "⠟⠁", "⡿⠋", "⣿⠟", "⣿⡿", "⣿⣿", "⣿⣿", "⣾⣿", "⣴⣿", "⣠⣾", "⢀⣴", "⠀⣠", "⠀⢀", "⠀⠀", "⠀⠀"],
    interval: 60,
  },
};

/** All available animation names */
export const BRAILLE_SPINNER_ANIMATIONS = Object.keys(SPINNERS) as BrailleSpinnerAnimation[];

// ─── Component ────────────────────────────────────────────────────────────────

export function BrailleSpinner({
  animation = "braille",
  interval: intervalOverride,
  size,
  className,
}: BrailleSpinnerProps) {
  const spinner = SPINNERS[animation];
  const ms = intervalOverride ?? spinner.interval;
  const [frame, setFrame] = useState(0);
  const frameRef = useRef(0);

  useEffect(() => {
    frameRef.current = 0;
    setFrame(0);

    const id = setInterval(() => {
      frameRef.current = (frameRef.current + 1) % spinner.frames.length;
      setFrame(frameRef.current);
    }, ms);

    return () => clearInterval(id);
  }, [animation, ms, spinner.frames.length]);

  return (
    <span
      data-slot="braille-spinner"
      role="status"
      aria-label="Loading"
      className={cn(brailleSpinnerVariants({ size }), className)}
    >
      {spinner.frames[frame]}
    </span>
  );
}

export { brailleSpinnerVariants };
