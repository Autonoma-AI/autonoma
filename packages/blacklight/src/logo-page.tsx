import { useCallback, useRef, useState } from "react";
import { Logo } from "@/components/logo";

/* ═══════════════════════════════════════════
   Logo Page - 6 variant grid with copy-to-clipboard
   ═══════════════════════════════════════════ */

type VariantConfig = {
  label: string;
  sublabel: string;
  variant: "full" | "symbol" | "mark" | "spinner";
  animate?: boolean;
  monochrome?: boolean;
  logoClass?: string;
  wrapperClass?: string;
};

const VARIANTS: VariantConfig[] = [
  {
    label: "Full",
    sublabel: "Grid + Rays + Eye",
    variant: "full",
    logoClass: "size-48",
  },
  {
    label: "Full Animated",
    sublabel: "With ray pulse",
    variant: "full",
    animate: true,
    logoClass: "size-48",
  },
  {
    label: "Symbol",
    sublabel: "Core + Iris + Pupil",
    variant: "symbol",
    logoClass: "size-40",
  },
  {
    label: "Mark",
    sublabel: "Core shape only",
    variant: "mark",
    logoClass: "size-40",
  },
  {
    label: "Spinner",
    sublabel: "Scanner / Loading",
    variant: "spinner",
    logoClass: "size-40",
  },
  {
    label: "Monochrome",
    sublabel: "Inherits currentColor",
    variant: "symbol",
    monochrome: true,
    logoClass: "size-40",
    wrapperClass: "text-text-secondary",
  },
];

function LogoCard({ config }: { config: VariantConfig }) {
  const svgRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    const container = svgRef.current;
    if (container == null) return;

    const svg = container.querySelector("svg");
    if (svg == null) return;

    const svgMarkup = svg.outerHTML;
    void navigator.clipboard.writeText(svgMarkup).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, []);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="group relative flex cursor-pointer flex-col overflow-hidden border border-border-dim bg-surface-base transition-all hover:border-primary hover:shadow-lg hover:shadow-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      {/* Logo display */}
      <div className="relative flex flex-1 items-center justify-center p-8">
        <div className="pres-grid-bg absolute inset-0 opacity-10 pointer-events-none" />
        <div ref={svgRef} className={config.wrapperClass}>
          {config.variant === "spinner" ? (
            <Logo variant="spinner" className={config.logoClass} />
          ) : (
            <div className={config.logoClass}>
              <Logo variant={config.variant} animate={config.animate} monochrome={config.monochrome} />
            </div>
          )}
        </div>

        {/* Hover overlay */}
        <div className="absolute inset-0 flex items-center justify-center bg-background/60 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
          <div className="flex flex-col items-center gap-2">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-primary-ink"
              aria-hidden="true"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            <span className="font-mono text-3xs uppercase tracking-wider text-text-primary">
              {copied ? "Copied!" : "Click to copy SVG"}
            </span>
          </div>
        </div>
      </div>

      {/* Label bar */}
      <div className="flex items-center justify-between border-t border-border-dim bg-background px-5 py-3">
        <div className="flex flex-col items-start gap-0.5">
          <span className="font-mono text-sm font-bold uppercase tracking-wider text-text-primary">{config.label}</span>
          <span className="font-mono text-3xs uppercase text-text-tertiary">{config.sublabel}</span>
        </div>
        <div className="font-mono text-4xs uppercase text-text-tertiary opacity-0 transition-opacity group-hover:opacity-100">
          {copied ? <span className="text-primary-ink">SVG Copied</span> : "Copy SVG"}
        </div>
      </div>
    </button>
  );
}

export function LogoPage() {
  return (
    <main className="relative min-h-screen bg-background">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-8 py-16">
        {/* Header */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-4">
            <div className="size-8">
              <Logo />
            </div>
            <h1 className="font-mono text-2xl font-bold uppercase tracking-wider text-text-primary">Logo Variants</h1>
          </div>
          <p className="font-mono text-xs uppercase tracking-wider text-text-tertiary">
            Click any variant to copy its SVG markup to clipboard
          </p>
          <div className="mt-2 h-px bg-border-dim" />
        </div>

        {/* Grid */}
        <div className="grid grid-cols-3 gap-px border border-border-mid bg-border-mid">
          {VARIANTS.map((v) => (
            <LogoCard key={`${v.variant}-${v.label}`} config={v} />
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between font-mono text-4xs uppercase tracking-widest text-text-tertiary">
          <span>BLACKLIGHT DESIGN SYSTEM</span>
          <span>LOGO_EXPORT_TOOLKIT</span>
        </div>
      </div>
    </main>
  );
}

export default LogoPage;
