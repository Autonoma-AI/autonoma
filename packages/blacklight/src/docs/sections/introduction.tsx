import { Paragraph, SectionDesc, SectionTitle, SubTitle } from "../components/atoms";

export function IntroductionSection() {
  return (
    <>
      <SectionTitle>Introduction</SectionTitle>
      <SectionDesc>
        Blacklight is a high-density design system built for data-rich interfaces, telemetry dashboards, and developer
        tools. It prioritizes information density, sharp geometry, and multi-theme adaptability.
      </SectionDesc>

      <SubTitle>Design Philosophy</SubTitle>
      <Paragraph>
        Blacklight is opinionated. Zero border radius everywhere - no rounded corners. Monospace typography for data,
        sans-serif for body. Surface tiers instead of shadows. Status colors instead of semantic colors. Every pixel
        serves a purpose.
      </Paragraph>

      <div className="my-6 grid grid-cols-2 gap-4">
        <div className="border border-border-dim bg-surface-base p-5">
          <div className="mb-2 font-mono text-3xs font-bold uppercase tracking-wider text-primary-ink">
            Sharp Geometry
          </div>
          <div className="font-mono text-2xs text-text-secondary">
            Zero border-radius on all components. Square corners, bracket decorations, grid-aligned layouts.
          </div>
        </div>
        <div className="border border-border-dim bg-surface-base p-5">
          <div className="mb-2 font-mono text-3xs font-bold uppercase tracking-wider text-primary-ink">
            Dual Theme System
          </div>
          <div className="font-mono text-2xs text-text-secondary">
            Blacklight (lime on lavender) and Blacklight-Dark (lime on void). Press D to cycle.
          </div>
        </div>
        <div className="border border-border-dim bg-surface-base p-5">
          <div className="mb-2 font-mono text-3xs font-bold uppercase tracking-wider text-primary-ink">
            Information Density
          </div>
          <div className="font-mono text-2xs text-text-secondary">
            Compact spacing, small type scales (down to 9px), multi-tier text hierarchy. Built for dashboards, not
            marketing sites.
          </div>
        </div>
        <div className="border border-border-dim bg-surface-base p-5">
          <div className="mb-2 font-mono text-3xs font-bold uppercase tracking-wider text-primary-ink">
            Token-Driven
          </div>
          <div className="font-mono text-2xs text-text-secondary">
            42 CSS custom properties per theme. Surface tiers, border tiers, text tiers, status colors, chart palette.
            No hardcoded values.
          </div>
        </div>
      </div>

      <SubTitle>Tech Stack</SubTitle>
      <div className="my-4 grid grid-cols-3 gap-3">
        {[
          { label: "Foundation", value: "React 18+ / Vite" },
          { label: "Styling", value: "Tailwind CSS v4" },
          { label: "Primitives", value: "Base UI (Radix)" },
          { label: "Variants", value: "CVA" },
          { label: "Icons", value: "Phosphor Icons" },
          { label: "Fonts", value: "DM Sans + Geist Mono" },
          { label: "Module", value: "ESM-only" },
          { label: "TypeScript", value: "Strict mode" },
        ].map((item) => (
          <div key={item.label} className="flex items-center justify-between border border-border-dim p-3">
            <span className="font-mono text-4xs uppercase tracking-wider text-text-tertiary">{item.label}</span>
            <span className="font-mono text-2xs font-bold text-foreground">{item.value}</span>
          </div>
        ))}
      </div>

      <SubTitle>Component Inventory</SubTitle>
      <Paragraph>
        Blacklight ships 16 production-ready components. Every component uses CVA for variant management and CSS custom
        properties for theme-aware styling.
      </Paragraph>
      <div className="my-4 flex flex-wrap gap-2">
        {[
          "Button",
          "Badge",
          "Card",
          "Panel",
          "Alert",
          "Tabs",
          "Input",
          "Switch",
          "Progress",
          "Tooltip",
          "Separator",
          "Scroll Area",
          "Data Table",
          "Metric Card",
          "Sparkline",
          "Status Dot",
        ].map((c) => (
          <span
            key={c}
            className="border border-border-dim bg-surface-base px-2.5 py-1 font-mono text-3xs uppercase tracking-wider text-text-secondary"
          >
            {c}
          </span>
        ))}
      </div>
    </>
  );
}

export default IntroductionSection;
