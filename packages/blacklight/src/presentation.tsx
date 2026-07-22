import { Bug } from "@phosphor-icons/react/Bug";
import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { Clock } from "@phosphor-icons/react/Clock";
import { Code } from "@phosphor-icons/react/Code";
import { Eye } from "@phosphor-icons/react/Eye";
import { Gear } from "@phosphor-icons/react/Gear";
import { GitBranch } from "@phosphor-icons/react/GitBranch";
import { Globe } from "@phosphor-icons/react/Globe";
import { Layout } from "@phosphor-icons/react/Layout";
import type { Icon } from "@phosphor-icons/react/lib";
import { Lightning } from "@phosphor-icons/react/Lightning";
import { Lock } from "@phosphor-icons/react/Lock";
import { MagnifyingGlass } from "@phosphor-icons/react/MagnifyingGlass";
import { Pause } from "@phosphor-icons/react/Pause";
import { Play } from "@phosphor-icons/react/Play";
import { Pulse } from "@phosphor-icons/react/Pulse";
import { Robot } from "@phosphor-icons/react/Robot";
import { Rocket } from "@phosphor-icons/react/Rocket";
import { Shield } from "@phosphor-icons/react/Shield";
import { Terminal } from "@phosphor-icons/react/Terminal";
import { Timer } from "@phosphor-icons/react/Timer";
import { Warning } from "@phosphor-icons/react/Warning";
import { Area, AreaChart, Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import { Logo } from "@/components/logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardLabel, CardMeta, CardValue } from "@/components/ui/card";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
} from "@/components/ui/data-table";
import { MetricCard, MetricLabel, MetricTrend, MetricUnit, MetricValue } from "@/components/ui/metric-card";
import { Panel, PanelBody, PanelHeader, PanelTitle } from "@/components/ui/panel";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Sparkline } from "@/components/ui/sparkline";
import { StatusDot } from "@/components/ui/status-dot";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/* ═══════════════════════════════════════════
   Shared sub-components
   ═══════════════════════════════════════════ */

const CORNER_BASE = "absolute size-4 pointer-events-none z-20 border-border-mid";

function CornerMarks() {
  return (
    <>
      <div className={`${CORNER_BASE} top-0 left-0 border-t border-l`} />
      <div className={`${CORNER_BASE} top-0 right-0 border-t border-r`} />
      <div className={`${CORNER_BASE} bottom-0 left-0 border-b border-l`} />
      <div className={`${CORNER_BASE} bottom-0 right-0 border-b border-r`} />
    </>
  );
}

function GridOverlay({ opacity = "opacity-20" }: { opacity?: string }) {
  return (
    <div
      className={`absolute inset-0 ${opacity} pointer-events-none z-0`}
      style={{
        backgroundImage:
          "linear-gradient(to right, var(--border-dim) 1px, transparent 1px), linear-gradient(to bottom, var(--border-dim) 1px, transparent 1px)",
        backgroundSize: "32px 32px",
      }}
    />
  );
}

function SlideHeader({ title, slideNum, total }: { title: string; slideNum: number; total: number }) {
  return (
    <header className="relative z-10 mb-8 flex items-start justify-between border-b border-border-dim pb-4 font-mono text-xs uppercase tracking-widest text-text-tertiary">
      <div className="font-bold text-text-primary">{title}</div>
      <div>
        SLIDE_{String(slideNum).padStart(2, "0")}/{String(total).padStart(2, "0")}
      </div>
    </header>
  );
}

function SlideFooter({ left, right = "SCROLL_DOWN \u25BC" }: { left: string; right?: string }) {
  return (
    <footer className="relative z-10 mt-8 flex items-end justify-between font-mono text-3xs uppercase tracking-widest text-text-tertiary">
      <div>{left}</div>
      <div>{right}</div>
    </footer>
  );
}

/* ═══════════════════════════════════════════
   SLIDE 1 - Cover
   ═══════════════════════════════════════════ */

function SlideCover() {
  return (
    <section className="relative flex h-screen w-full snap-start snap-always flex-col overflow-hiddenbg-background p-8">
      <GridOverlay opacity="opacity-30" />
      <CornerMarks />
      <header className="relative z-10 flex items-start justify-between font-mono text-xs uppercase tracking-widest text-text-tertiary">
        <div className="flex flex-col gap-1">
          <span>SYS_INIT: OK</span>
          <span className="text-primary-ink">ENG: VECTOR_PRIMITIVE</span>
        </div>
        <div className="flex flex-col gap-1 text-right">
          <span>FILE: BL_ID_SYS_v2.4.obj</span>
          <span>SLIDE_01/09</span>
        </div>
      </header>
      <div className="relative z-10 mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center">
        <div className="relative mb-8" style={{ width: 400, height: 400 }}>
          {/* Construction grid overlay */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center border border-border-dim opacity-50">
            <div className="absolute top-1/2 h-px w-full -translate-y-1/2 bg-border-dim" />
            <div className="absolute left-1/2 h-full w-px -translate-x-1/2 bg-border-dim" />
            <div className="absolute h-full w-full rotate-45 scale-75 border border-border-dim" />
          </div>
          <Logo variant="full" animate />
        </div>
        <h1 className="mb-4 font-mono text-6xl font-bold tracking-tighter text-text-primary">BLACKLIGHT</h1>
        <h2 className="border-t border-border-dim px-12 pt-4 font-mono text-sm uppercase tracking-widest text-text-tertiary">
          Brand Identity System v2.4
        </h2>
      </div>
      <footer className="relative z-10 flex items-end justify-between font-mono text-3xs uppercase tracking-widest text-text-tertiary">
        <div>GEO_TOLERANCE: +/-0.000</div>
        <div>CONFIDENTIAL {"// "}INTERNAL ONLY</div>
      </footer>
    </section>
  );
}

/* ═══════════════════════════════════════════
   SLIDE 2 - Logo Variants & Showcase
   ═══════════════════════════════════════════ */

function LogoShowcaseCell({
  label,
  description,
  bgClass,
  children,
}: {
  label: string;
  description: string;
  bgClass?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className={cn(
          "relative flex size-28 items-center justify-center border border-border-dim",
          bgClass ?? "bg-surface-base",
        )}
      >
        <GridOverlay opacity="opacity-10" />
        <div className="relative z-10">{children}</div>
      </div>
      <div className="flex flex-col items-center gap-0.5 text-center">
        <span className="font-mono text-2xs font-bold uppercase tracking-wider text-text-primary">{label}</span>
        <span className="font-mono text-4xs uppercase text-text-tertiary">{description}</span>
      </div>
    </div>
  );
}

function SlideLogoShowcase() {
  return (
    <section className="relative flex h-screen w-full snap-start snap-always flex-col overflow-hidden bg-background p-8">
      <GridOverlay />
      <CornerMarks />
      <SlideHeader title="1.0 // LOGO SYSTEM" slideNum={2} total={8} />
      <div className="relative z-10 my-auto flex w-full flex-col gap-10">
        {/* Top row - primary variants */}
        <div className="flex items-start justify-center gap-5">
          <LogoShowcaseCell label="Full" description="Construction grid + rays + eye" bgClass="bg-background">
            <div className="size-24">
              <Logo variant="full" />
            </div>
          </LogoShowcaseCell>
          <LogoShowcaseCell label="Full (Animated)" description="Ray pulse animation" bgClass="bg-background">
            <div className="size-24">
              <Logo variant="full" animate />
            </div>
          </LogoShowcaseCell>
          <LogoShowcaseCell label="Symbol" description="Default - core + iris + pupil">
            <div className="size-20">
              <Logo />
            </div>
          </LogoShowcaseCell>
          <LogoShowcaseCell label="Wordmark" description="Text logotype - headings & nav">
            <Logo variant="wordmark" className="text-xs" strokeWidth={2.5} />
          </LogoShowcaseCell>
        </div>
        {/* Bottom row - secondary & surface variants */}
        <div className="flex items-start justify-center gap-5">
          <LogoShowcaseCell label="Mark" description="Core shape only - favicon use">
            <div className="size-20">
              <Logo variant="mark" />
            </div>
          </LogoShowcaseCell>
          <LogoShowcaseCell label="Spinner" description="Animated scanner / loading">
            <Logo variant="spinner" className="size-20" />
          </LogoShowcaseCell>
          <LogoShowcaseCell label="Monochrome" description="Inherits currentColor - no glow">
            <div className="size-20 text-text-secondary">
              <Logo monochrome />
            </div>
          </LogoShowcaseCell>
          <LogoShowcaseCell label="On Raised" description="Surface-raised background" bgClass="bg-surface-raised">
            <div className="size-20">
              <Logo />
            </div>
          </LogoShowcaseCell>
          <LogoShowcaseCell label="On Base" description="Surface-base background" bgClass="bg-surface-base">
            <div className="size-20">
              <Logo />
            </div>
          </LogoShowcaseCell>
        </div>
      </div>
      <SlideFooter left="COMPONENT: <Logo variant={...} />" />
    </section>
  );
}

/* ═══════════════════════════════════════════
   SLIDE 4 - Color System
   ═══════════════════════════════════════════ */

function ColorSwatch({
  name,
  cssVar,
  bgClass,
  bgStyle,
  description,
  badgeLabel,
}: {
  name: string;
  cssVar: string;
  bgClass?: string;
  bgStyle?: React.CSSProperties;
  description: string;
  badgeLabel?: string;
}) {
  return (
    <div className="group relative flex h-full flex-col overflow-hidden border border-border-mid">
      <div className={`relative flex-1 border-b border-border-mid ${bgClass ?? ""}`} style={bgStyle} />
      <div className="flex flex-col gap-2 bg-background p-4 font-mono text-xs">
        <div className="mb-2 flex items-center justify-between text-base font-bold text-text-primary">
          {name}
          {badgeLabel != null && (
            <Badge variant="outline" className="text-4xs">
              {badgeLabel}
            </Badge>
          )}
        </div>
        <div className="flex justify-between border-b border-border-dim pb-1 text-text-tertiary">
          <span>CSS VAR</span>
          <span className="text-text-primary">{cssVar}</span>
        </div>
        <div className="mt-2 text-3xs uppercase text-text-tertiary">{description}</div>
      </div>
    </div>
  );
}

function SlideColorSystem() {
  return (
    <section className="relative flex h-screen w-full snap-start snap-always flex-col overflow-hiddenbg-background p-8">
      <GridOverlay />
      <CornerMarks />
      <SlideHeader title="2.0 // COLOR SYSTEM" slideNum={3} total={8} />
      <div className="relative z-10 flex w-full flex-1 flex-col gap-4">
        <div className="grid h-3/4 grid-cols-5 gap-4">
          <ColorSwatch
            name="VOID"
            cssVar="--surface-void"
            bgClass="bg-surface-void"
            description="Primary dark background. Base surface for UI."
          />
          <ColorSwatch
            name="RAISED"
            cssVar="--surface-raised"
            bgClass="bg-surface-raised"
            description="Elevated surface. Cards, overlays, and modals."
          />
          <ColorSwatch
            name="PRIMARY"
            cssVar="--primary"
            bgClass="bg-primary"
            description="High energy call-to-actions. Success states, core branding."
            badgeLabel="ACCENT"
          />
          <ColorSwatch
            name="VIOLET"
            cssVar="--violet-accent"
            bgStyle={{ backgroundColor: "var(--violet-accent)" }}
            description="Deep violet accent. Enhanced contrast for light themes."
            badgeLabel="ACCENT"
          />
          <ColorSwatch
            name="DESTRUCTIVE"
            cssVar="--destructive"
            bgClass="bg-destructive"
            description="Error states, destructive actions, critical alerts."
            badgeLabel="STATUS"
          />
        </div>
        <div className="flex h-1/4 gap-4 border border-border-mid bg-background/50 p-4 font-mono text-xs backdrop-blur-sm">
          <div className="w-1/4 border-r border-border-dim pr-4">
            <div className="mb-2 uppercase text-text-tertiary">Contrast Ratios (WCAG 2.1)</div>
            <div className="mb-1 flex items-center justify-between">
              <span>Foreground on Background</span>
              <Badge variant="success">AAA</Badge>
            </div>
            <div className="mb-1 flex items-center justify-between">
              <span>Primary on Background</span>
              <Badge variant="success">AA+</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span>Tertiary on Background</span>
              <Badge variant="outline">AA</Badge>
            </div>
          </div>
          <div className="grid flex-1 grid-cols-2 gap-8 pl-4">
            <div>
              <div className="mb-2 border-b border-primary/20 pb-1 font-bold uppercase text-primary-ink">
                Usage Rules: DO
              </div>
              <ul className="mt-2 list-inside list-disc space-y-1 text-text-secondary marker:text-primary-ink">
                <li>Use background as the dominant surface (80% ratio).</li>
                <li>Use primary sparingly for high-priority interactive elements.</li>
                <li>Use raised surfaces for structural visual separation.</li>
              </ul>
            </div>
            <div>
              <div className="mb-2 border-b border-status-critical/20 pb-1 font-bold uppercase text-status-critical">
                Usage Rules: DON'T
              </div>
              <ul className="mt-2 list-inside list-disc space-y-1 text-text-secondary marker:text-status-critical">
                <li>Never place low-contrast text on accent backgrounds.</li>
                <li>Avoid large blocks of pure accent color (visual fatigue).</li>
                <li>Do not introduce new hues outside the theme palette.</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
      <SlideFooter left="SYSTEM_PALETTE: LOCKED" />
    </section>
  );
}

/* ═══════════════════════════════════════════
   SLIDE 4 - Typography
   ═══════════════════════════════════════════ */

function SlideTypography() {
  return (
    <section className="relative flex h-screen w-full snap-start snap-always flex-col overflow-hiddenbg-surface-raised p-8">
      <GridOverlay opacity="opacity-30" />
      <CornerMarks />
      <SlideHeader title="3.0 // TYPOGRAPHY SYSTEM" slideNum={4} total={8} />
      <div className="relative z-10 grid w-full flex-1 grid-cols-2 gap-8">
        {/* DM Sans */}
        <Card className="flex flex-col p-8">
          <Badge variant="outline" className="mb-8 w-fit">
            Communication
          </Badge>
          <div className="mb-12 border-b border-border-dim pb-8">
            <h2 className="mb-2 font-sans text-5xl font-bold tracking-tight text-text-primary">DM Sans</h2>
            <div className="flex gap-4 font-mono text-3xs uppercase text-text-tertiary">
              <span>Humanist</span>
              <span>Readable</span>
              <span>Approachable</span>
            </div>
          </div>
          <div className="flex flex-1 flex-col gap-8">
            <div>
              <div className="mb-2 border-b border-border-dim pb-1 font-mono text-3xs text-text-tertiary">
                HEADING 1 / BOLD 48PX / -2% TRACKING
              </div>
              <div className="font-sans text-5xl font-bold leading-tight tracking-tight text-text-primary">
                Illuminate the unseen elements of design.
              </div>
            </div>
            <div>
              <div className="mb-2 border-b border-border-dim pb-1 font-mono text-3xs text-text-tertiary">
                HEADING 2 / MEDIUM 24PX
              </div>
              <div className="font-sans text-2xl font-medium leading-snug text-text-primary">
                A systematic approach to brand identity, built for digital-first applications.
              </div>
            </div>
            <div>
              <div className="mb-2 border-b border-border-dim pb-1 font-mono text-3xs text-text-tertiary">
                BODY / REGULAR 16PX / 150% LINE-HEIGHT
              </div>
              <p className="max-w-md font-sans text-base leading-relaxed text-text-secondary">
                Use DM Sans for all long-form reading, marketing copy, and primary UI elements where legibility is
                paramount. Its humanist touch balances the technical aesthetic of the brand system.
              </p>
            </div>
          </div>
          <div className="mt-auto break-all font-sans text-3xl font-bold leading-none text-text-tertiary/30">
            AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz 0123456789
          </div>
        </Card>

        {/* Geist Mono */}
        <Card className="flex flex-col bg-surface-void p-8 text-foreground">
          <Badge variant="default" className="mb-8 w-fit">
            Information
          </Badge>
          <div className="mb-12 border-b border-border-dim pb-8">
            <h2 className="mb-2 font-mono text-5xl font-bold tracking-tight text-text-primary">Geist Mono</h2>
            <div className="flex gap-4 font-mono text-3xs uppercase text-text-tertiary">
              <span>Technical</span>
              <span>Precise</span>
              <span>Monospaced</span>
              <span>Tabular</span>
            </div>
          </div>
          <div className="flex flex-1 flex-col gap-8">
            <div>
              <div className="mb-2 border-b border-border-dim pb-1 font-mono text-3xs text-primary-ink">
                SPEC LABEL / BOLD 12PX / +5% TRACKING / UPPERCASE
              </div>
              <div className="font-mono text-xs font-bold uppercase tracking-widest text-text-primary">
                [METADATA_NODE_ID: 884-A]
              </div>
            </div>
            <div>
              <div className="mb-2 border-b border-border-dim pb-1 font-mono text-3xs text-primary-ink">
                DATA TABLE / REGULAR 14PX
              </div>
              <table className="w-full border-collapse text-left font-mono text-sm text-text-secondary">
                <thead>
                  <tr className="border-b border-border-mid text-xs text-text-tertiary">
                    <th className="py-2 font-normal">PARAMETER</th>
                    <th className="py-2 font-normal">VALUE</th>
                    <th className="py-2 text-right font-normal">STATUS</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-border-dim">
                    <td className="py-2">FREQUENCY</td>
                    <td className="py-2">380NM</td>
                    <td className="py-2 text-right text-primary-ink">ACTIVE</td>
                  </tr>
                  <tr>
                    <td className="py-2">LUMINOSITY</td>
                    <td className="py-2">PEAK_100</td>
                    <td className="py-2 text-right text-text-tertiary">STABLE</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div>
              <div className="mb-2 border-b border-border-dim pb-1 font-mono text-3xs text-primary-ink">
                CODE BLOCK / REGULAR 12PX
              </div>
              <pre className="border border-border-dim bg-surface-void/50 p-4 font-mono text-xs leading-loose text-text-secondary">
                <span className="text-primary-ink">const</span> system = <span className="text-primary-ink">new</span>{" "}
                <span className="text-text-primary">BlacklightCore</span>
                {"({\n"}
                {"  mode: "}
                <span className="text-primary-ink">'dark'</span>
                {",\n"}
                {"  strictGrid: "}
                <span className="text-primary-ink">true</span>
                {"\n});"}
              </pre>
            </div>
          </div>
          <div className="mt-auto break-all font-mono text-xl leading-relaxed tracking-widest text-text-tertiary/30">
            A B C D E F G H I J K L M N O P Q R S T U V W X Y Z
            <br />0 1 2 3 4 5 6 7 8 9 ! @ # $ % ^ & * ( )
          </div>
        </Card>
      </div>
      <SlideFooter left="TYPE_HIERARCHY: ENFORCED" />
    </section>
  );
}

/* ═══════════════════════════════════════════
   SLIDE 5 - Logo Usage & Integrity
   ═══════════════════════════════════════════ */

function SlideLogoUsage() {
  return (
    <section className="relative flex h-screen w-full snap-start snap-always flex-col overflow-hiddenbg-background p-8">
      <GridOverlay />
      <CornerMarks />
      <SlideHeader title="4.0 // LOGO USAGE & INTEGRITY" slideNum={5} total={8} />
      <div className="relative z-10 flex w-full flex-1 flex-col gap-6 overflow-hidden">
        {/* Clear space demo */}
        <div className="flex h-1/2 w-full border border-border-mid bg-background">
          <div className="flex w-1/3 flex-col justify-between border-r border-border-mid p-6">
            <div>
              <h3 className="mb-2 font-mono text-sm font-bold uppercase text-primary-ink">Clear Space Requirement</h3>
              <p className="text-sm text-text-secondary">
                Maintain a minimum clear space around the logo. This exclusion zone is determined by the inner iris
                height, designated as 'X'. No other elements should enter this zone.
              </p>
            </div>
            <div className="border border-border-dim bg-surface-base p-3 font-mono text-3xs text-text-tertiary">
              MINIMUM SIZES:
              <br />
              DIGITAL: 32PX (SYMBOL ONLY)
              <br />
              DIGITAL: 120PX (WITH WORDMARK)
              <br />
              PRINT: 10MM
            </div>
          </div>
          <div className="relative flex flex-1 items-center justify-center bg-surface-base p-12">
            <div className="relative flex items-center gap-6">
              {/* Clearspace border */}
              <div className="absolute -inset-8 z-0 border border-dashed border-primary/50">
                <div className="absolute -top-4 left-1/2 -translate-x-1/2 font-mono text-xs text-primary-ink">X</div>
                <div className="absolute -left-4 top-1/2 -translate-y-1/2 font-mono text-xs text-primary-ink">X</div>
                <div className="absolute -bottom-4 left-1/2 -translate-x-1/2 font-mono text-xs text-primary-ink">X</div>
                <div className="absolute -right-4 top-1/2 -translate-y-1/2 font-mono text-xs text-primary-ink">X</div>
              </div>
              <div className="relative z-10 size-24 bg-surface-base">
                <Logo />
              </div>
              <div className="relative z-10 bg-surface-base pr-2 font-mono text-4xl font-bold tracking-tighter text-text-primary">
                BLACKLIGHT
              </div>
            </div>
          </div>
        </div>

        {/* Do / Don't examples */}
        <div className="grid flex-1 grid-cols-3 gap-6">
          {/* DO */}
          <div className="flex flex-col border border-border-mid bg-background">
            <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-surface-base p-8">
              <Badge variant="success" className="absolute left-2 top-2 z-10">
                DO
              </Badge>
              <div className="flex items-center gap-4">
                <Logo className="size-12" />
                <span className="font-mono text-xl font-bold text-text-primary">BLACKLIGHT</span>
              </div>
            </div>
            <div className="border-t border-border-mid p-3 font-mono text-3xs text-text-tertiary">
              Use approved color combinations with high contrast. Maintain correct proportions.
            </div>
          </div>

          {/* DON'T - Distortion */}
          <div className="relative flex flex-col border border-status-critical/30 bg-background">
            <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-surface-base p-8">
              <Badge variant="critical" className="absolute left-2 top-2 z-10">
                DON'T
              </Badge>
              <svg
                className="pointer-events-none absolute inset-0 z-0 size-full text-status-critical/20"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <line x1="0" y1="0" x2="100" y2="100" stroke="currentColor" strokeWidth="2" />
                <line x1="100" y1="0" x2="0" y2="100" stroke="currentColor" strokeWidth="2" />
              </svg>
              <div className="flex scale-x-125 scale-y-50 items-center gap-4">
                <Logo className="size-12" />
                <span className="font-mono text-xl font-bold text-text-primary">BLACKLIGHT</span>
              </div>
            </div>
            <div className="border-t border-status-critical/30 p-3 font-mono text-3xs text-status-critical">
              Do not stretch, distort, or alter the geometric proportions of the logo.
            </div>
          </div>

          {/* DON'T - Bad contrast */}
          <div className="relative flex flex-col border border-status-critical/30 bg-background">
            <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-primary p-8">
              <Badge variant="critical" className="absolute left-2 top-2 z-10">
                DON'T
              </Badge>
              <svg
                className="pointer-events-none absolute inset-0 z-0 size-full text-status-critical/40"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <line x1="0" y1="0" x2="100" y2="100" stroke="currentColor" strokeWidth="2" />
                <line x1="100" y1="0" x2="0" y2="100" stroke="currentColor" strokeWidth="2" />
              </svg>
              <div className="logo-monochrome flex items-center gap-4 text-background">
                <Logo className="size-12" />
                <span className="font-mono text-xl font-bold">BLACKLIGHT</span>
              </div>
            </div>
            <div className="border-t border-status-critical/30 p-3 font-mono text-3xs text-status-critical">
              Do not use low-contrast color combinations or unapproved palettes.
            </div>
          </div>
        </div>
      </div>
      <SlideFooter left="INTEGRITY_CHECK: PASSED" />
    </section>
  );
}

/* ═══════════════════════════════════════════
   SLIDE 7 - Icons & Iconography
   ═══════════════════════════════════════════ */

const ICON_CATALOG: Array<{ name: string; icon: Icon }> = [
  { name: "Play", icon: Play },
  { name: "Bug", icon: Bug },
  { name: "Robot", icon: Robot },
  { name: "Terminal", icon: Terminal },
  { name: "Code", icon: Code },
  { name: "Globe", icon: Globe },
  { name: "Eye", icon: Eye },
  { name: "Shield", icon: Shield },
  { name: "Lightning", icon: Lightning },
  { name: "Rocket", icon: Rocket },
  { name: "Gear", icon: Gear },
  { name: "Lock", icon: Lock },
  { name: "Clock", icon: Clock },
  { name: "GitBranch", icon: GitBranch },
  { name: "MagnifyingGlass", icon: MagnifyingGlass },
  { name: "CheckCircle", icon: CheckCircle },
  { name: "Warning", icon: Warning },
  { name: "Pulse", icon: Pulse },
];

function SlideIcons() {
  return (
    <section className="relative flex h-screen w-full snap-start snap-always flex-col overflow-hidden bg-background p-8">
      <GridOverlay />
      <CornerMarks />
      <SlideHeader title="5.0 // ICONS & ICONOGRAPHY" slideNum={6} total={8} />
      <div className="relative z-10 flex w-full flex-1 flex-col gap-8 overflow-hidden">
        {/* Icon catalog grid */}
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-mono text-sm font-bold uppercase text-text-primary">Phosphor Icons</h3>
              <p className="mt-1 font-mono text-3xs uppercase text-text-tertiary">
                {"CONSISTENT // FLEXIBLE // MULTI-WEIGHT"}
              </p>
            </div>
            <Badge variant="outline">18 CORE ICONS</Badge>
          </div>
          <div className="grid grid-cols-9 gap-2">
            {ICON_CATALOG.map(({ name, icon: IconComponent }) => (
              <div
                key={name}
                className="flex flex-col items-center gap-2 border border-border-dim p-3 transition-colors hover:border-border-highlight hover:bg-surface-raised"
              >
                <IconComponent className="size-5 shrink-0 text-text-primary" />
                <span className="w-full truncate text-center font-mono text-4xs text-text-tertiary">{name}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Weights + Sizes row */}
        <div className="grid grid-cols-2 gap-6">
          {/* Weights */}
          <Card className="p-6">
            <h3 className="mb-4 font-mono text-3xs font-bold uppercase tracking-widest text-text-tertiary">
              Weight Variants
            </h3>
            <div className="flex items-center justify-between">
              {(["thin", "light", "regular", "bold", "fill", "duotone"] as const).map((weight) => (
                <div key={weight} className="flex flex-col items-center gap-2">
                  <Robot className="size-8 text-text-primary" weight={weight} />
                  <span className="font-mono text-4xs text-text-tertiary">{weight}</span>
                </div>
              ))}
            </div>
          </Card>

          {/* Sizes */}
          <Card className="p-6">
            <h3 className="mb-4 font-mono text-3xs font-bold uppercase tracking-widest text-text-tertiary">
              Size Scale
            </h3>
            <div className="flex items-end justify-between">
              {(
                [
                  { cls: "size-3", label: "12" },
                  { cls: "size-4", label: "16" },
                  { cls: "size-5", label: "20" },
                  { cls: "size-6", label: "24" },
                  { cls: "size-8", label: "32" },
                  { cls: "size-10", label: "40" },
                ] as const
              ).map(({ cls, label }) => (
                <div key={label} className="flex flex-col items-center gap-2">
                  <Lightning className={`${cls} text-primary-ink`} weight="fill" />
                  <span className="font-mono text-4xs text-text-tertiary">{label}px</span>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* Usage examples */}
        <div className="grid grid-cols-3 gap-4">
          <Card className="flex flex-col gap-3 p-5">
            <h4 className="font-mono text-3xs font-bold uppercase text-text-tertiary">In Buttons</h4>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm">
                <Play data-icon="inline-start" weight="fill" />
                Run Test
              </Button>
              <Button variant="accent" size="sm">
                <Rocket data-icon="inline-start" weight="fill" />
                Deploy
              </Button>
              <Button variant="outline" size="sm">
                <GitBranch data-icon="inline-start" />
                Branch
              </Button>
            </div>
          </Card>
          <Card className="flex flex-col gap-3 p-5">
            <h4 className="font-mono text-3xs font-bold uppercase text-text-tertiary">In Badges</h4>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="success">
                <CheckCircle className="size-3" weight="bold" />
                Passed
              </Badge>
              <Badge variant="critical">
                <Warning className="size-3" weight="bold" />
                Failed
              </Badge>
              <Badge variant="status-running">
                <Pulse className="size-3" weight="bold" />
                Running
              </Badge>
            </div>
          </Card>
          <Card className="flex flex-col gap-3 p-5">
            <h4 className="font-mono text-3xs font-bold uppercase text-text-tertiary">With Logo</h4>
            <div className="flex items-center gap-3">
              <Button variant="default" size="sm">
                <Logo color="black" strokeWidth={2.5} variant="wordmark" />
              </Button>
              <Button variant="outline" size="icon">
                <Logo className="size-5" />
              </Button>
            </div>
          </Card>
        </div>
      </div>
      <SlideFooter left="ICON_SYSTEM: PHOSPHOR_REACT" />
    </section>
  );
}

/* ═══════════════════════════════════════════
   SLIDE 8 - Data Components
   ═══════════════════════════════════════════ */

const NODE_DATA = [
  { id: "EU-WEST-01", status: "success" as const, cpu: 42.5, spark: [15, 12, 16, 8, 10, 4, 6] },
  { id: "US-EAST-04", status: "warn" as const, cpu: 78.2, spark: [20, 18, 10, 12, 5, 2, 4] },
  { id: "AP-SOUTH-02", status: "success" as const, cpu: 31.0, spark: [10, 12, 11, 9, 10, 11, 10] },
  { id: "US-WEST-01", status: "critical" as const, cpu: 94.8, spark: [15, 8, 10, 4, 2, 0, 1] },
  { id: "EU-CENT-03", status: "success" as const, cpu: 55.1, spark: [10, 15, 8, 12, 6, 8, 5] },
];

function cpuColor(cpu: number): string | undefined {
  if (cpu >= 90) return "var(--status-critical)";
  if (cpu >= 70) return "var(--status-warn)";
  return undefined;
}

function sparkColor(status: "success" | "warn" | "critical" | "neutral"): string {
  if (status === "critical") return "var(--status-critical)";
  if (status === "warn") return "var(--status-warn)";
  return "var(--text-secondary)";
}

/* ═══════════════════════════════════════════
   Chart data & config (used in combined slide)
   ═══════════════════════════════════════════ */

const CHART_TRAFFIC = [
  { time: "00:00", ingress: 120, egress: 150 },
  { time: "06:00", ingress: 110, egress: 160 },
  { time: "12:00", ingress: 160, egress: 130 },
  { time: "18:00", ingress: 140, egress: 140 },
  { time: "24:00", ingress: 170, egress: 120 },
];

const CHART_ERRORS = [
  { time: "T-8H", requests: 80, errors: 5 },
  { time: "T-6H", requests: 130, errors: 18 },
  { time: "T-4H", requests: 110, errors: 14 },
  { time: "T-2H", requests: 140, errors: 30 },
  { time: "NOW", requests: 125, errors: 40 },
];

const trafficConfig = {
  ingress: { label: "Ingress", color: "var(--chart-1)" },
  egress: { label: "Egress", color: "var(--chart-2)" },
} satisfies ChartConfig;

const errorConfig = {
  requests: { label: "Requests", color: "var(--border-mid)" },
  errors: { label: "Errors", color: "var(--chart-3)" },
} satisfies ChartConfig;

const AXIS_TICK = {
  fill: "var(--text-tertiary)",
  fontFamily: "var(--font-mono)",
  fontSize: 9,
};

function SlideDataAndCharts() {
  return (
    <section className="relative flex h-screen w-full snap-start snap-always flex-col overflow-hidden bg-background p-8">
      <GridOverlay />
      <CornerMarks />
      <SlideHeader title="6.0 // DATA & CHARTS" slideNum={7} total={8} />
      <div className="relative z-10 flex w-full flex-1 flex-col gap-4 overflow-hidden">
        {/* Metric cards row */}
        <div className="grid grid-cols-4 gap-4">
          <MetricCard>
            <MetricLabel>
              <span>Total Throughput</span>
              <MetricTrend direction="up" value="14.2%" />
            </MetricLabel>
            <MetricValue>
              842,091
              <MetricUnit>REQ</MetricUnit>
            </MetricValue>
          </MetricCard>
          <MetricCard>
            <MetricLabel>
              <span>Avg Latency (P99)</span>
              <MetricTrend direction="down" value="2.1%" />
            </MetricLabel>
            <MetricValue className="text-status-critical">
              124
              <MetricUnit>MS</MetricUnit>
            </MetricValue>
          </MetricCard>
          <MetricCard>
            <MetricLabel>
              <span>Active Nodes</span>
              <MetricTrend direction="neutral" value="0.0%" />
            </MetricLabel>
            <MetricValue>
              48
              <MetricUnit>/50</MetricUnit>
            </MetricValue>
          </MetricCard>
          <MetricCard>
            <MetricLabel>
              <span>Error Rate</span>
              <MetricTrend direction="up" value="3.8%" />
            </MetricLabel>
            <MetricValue className="text-status-warn">
              2.4
              <MetricUnit>%</MetricUnit>
            </MetricValue>
          </MetricCard>
        </div>

        {/* Middle row: Area chart + DataTable */}
        <div className="grid flex-1 grid-cols-12 gap-4">
          <Panel className="col-span-7">
            <PanelHeader>
              <PanelTitle>Network Ingress/Egress</PanelTitle>
              <Tabs defaultValue="24h">
                <TabsList variant="line">
                  <TabsTrigger value="1h">1H</TabsTrigger>
                  <TabsTrigger value="24h">24H</TabsTrigger>
                  <TabsTrigger value="7d">7D</TabsTrigger>
                </TabsList>
              </Tabs>
            </PanelHeader>
            <PanelBody>
              <ChartContainer config={trafficConfig} className="aspect-auto h-40 w-full">
                <AreaChart data={CHART_TRAFFIC} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="pres-grad-ingress" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-ingress)" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="var(--color-ingress)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="2 4" stroke="var(--border-dim)" vertical={false} />
                  <XAxis dataKey="time" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                  <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={32} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Area
                    type="monotone"
                    dataKey="ingress"
                    stroke="var(--color-ingress)"
                    strokeWidth={2}
                    fill="url(#pres-grad-ingress)"
                  />
                  <Area
                    type="monotone"
                    dataKey="egress"
                    stroke="var(--color-egress)"
                    strokeWidth={1.5}
                    strokeDasharray="4 4"
                    fill="none"
                  />
                </AreaChart>
              </ChartContainer>
            </PanelBody>
          </Panel>

          <Panel className="col-span-5">
            <PanelHeader>
              <PanelTitle>Node Status</PanelTitle>
              <span className="font-mono text-4xs uppercase tracking-widest text-text-tertiary">TOP 5 BY LOAD</span>
            </PanelHeader>
            <PanelBody className="pt-0">
              <DataTable>
                <DataTableHead>
                  <tr>
                    <DataTableHeaderCell>Status</DataTableHeaderCell>
                    <DataTableHeaderCell>Node_ID</DataTableHeaderCell>
                    <DataTableHeaderCell>CPU_%</DataTableHeaderCell>
                    <DataTableHeaderCell align="right">Trend</DataTableHeaderCell>
                  </tr>
                </DataTableHead>
                <DataTableBody>
                  {NODE_DATA.map((node) => (
                    <DataTableRow key={node.id}>
                      <DataTableCell>
                        <StatusDot status={node.status} />
                      </DataTableCell>
                      <DataTableCell>{node.id}</DataTableCell>
                      <DataTableCell style={cpuColor(node.cpu) != null ? { color: cpuColor(node.cpu) } : undefined}>
                        {node.cpu.toFixed(1)}
                      </DataTableCell>
                      <DataTableCell align="right">
                        <Sparkline data={node.spark} color={sparkColor(node.status)} />
                      </DataTableCell>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>
            </PanelBody>
          </Panel>
        </div>

        {/* Bottom row: Composed chart + chart tokens + component inventory */}
        <div className="grid grid-cols-12 gap-4">
          <Panel className="col-span-6">
            <PanelHeader>
              <PanelTitle>Errors vs Requests</PanelTitle>
              <div className="flex items-center gap-4 font-mono text-3xs uppercase text-text-secondary">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-1 bg-border-mid" />
                  Req
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-0.5 w-2 bg-status-high" />
                  Err
                </span>
              </div>
            </PanelHeader>
            <PanelBody>
              <ChartContainer config={errorConfig} className="aspect-auto h-32 w-full">
                <ComposedChart data={CHART_ERRORS} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke="var(--border-dim)" vertical={false} />
                  <XAxis dataKey="time" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                  <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={32} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar
                    dataKey="requests"
                    fill="var(--color-requests)"
                    opacity={0.5}
                    activeBar={{ opacity: 0.8 }}
                    radius={0}
                    barSize={10}
                  />
                  <Line
                    type="monotone"
                    dataKey="errors"
                    stroke="var(--color-errors)"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 3, stroke: "var(--color-errors)", fill: "var(--surface-void)" }}
                  />
                </ComposedChart>
              </ChartContainer>
            </PanelBody>
          </Panel>

          <div className="col-span-3 flex flex-col gap-4">
            <Card className="flex-1 p-4">
              <h4 className="mb-3 font-mono text-3xs font-bold uppercase tracking-widest text-text-tertiary">
                Chart Color Tokens
              </h4>
              <div className="flex flex-col gap-2">
                {[1, 2, 3, 4, 5].map((n) => (
                  <div key={n} className="flex items-center gap-2">
                    <div className="size-3" style={{ backgroundColor: `var(--chart-${n})` }} />
                    <span className="font-mono text-3xs text-text-secondary">--chart-{n}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <div className="col-span-3 flex flex-col gap-4">
            <Card className="flex-1 p-4">
              <h4 className="mb-3 font-mono text-3xs font-bold uppercase tracking-widest text-text-tertiary">
                Components Used
              </h4>
              <div className="flex flex-col gap-1.5 font-mono text-3xs text-text-secondary">
                <div className="flex items-center gap-2">
                  <StatusDot status="success" />
                  <span>StatusDot + Sparkline</span>
                </div>
                <div className="flex items-center gap-2">
                  <StatusDot status="warn" />
                  <span>MetricCard + Panel</span>
                </div>
                <div className="flex items-center gap-2">
                  <StatusDot status="neutral" />
                  <span>DataTable + Chart</span>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-3">
                <Sparkline data={[4, 7, 3, 8, 5, 9, 6]} color="var(--primary)" filled className="h-4 w-12" />
                <Sparkline data={[8, 6, 4, 3, 2, 1, 0]} color="var(--status-critical)" className="h-4 w-12" />
              </div>
            </Card>
          </div>
        </div>
      </div>
      <SlideFooter left="DATA_STACK: RECHARTS + SHADCN/UI + BLACKLIGHT" />
    </section>
  );
}

/* ═══════════════════════════════════════════
   SLIDE 10 - UI in the Wild
   ═══════════════════════════════════════════ */

function SlideUIFragments() {
  return (
    <section className="relative flex h-screen w-full snap-start snap-always flex-col overflow-hiddenbg-background p-8">
      <GridOverlay />
      <CornerMarks />
      <SlideHeader title="7.0 // SYSTEM IN THE WILD - UI FRAGMENTS" slideNum={8} total={8} />
      <div className="relative z-10 grid w-full flex-1 grid-cols-12 grid-rows-5 gap-3 overflow-hidden">
        {/* NAV SIDEBAR */}
        <div className="col-span-2 row-span-5 flex flex-col overflow-hidden border border-border-mid bg-surface-base">
          <div className="p-2 font-mono text-4xs uppercase text-text-tertiary">Nav {"// "}Sidebar</div>
          <div className="flex h-full flex-col pt-2">
            <div className="flex h-full w-10 flex-col items-center gap-4 border-r border-border-dim py-4">
              <div className="size-6">
                <Logo />
              </div>
              <Layout className="mt-4 size-4 text-primary-ink" />
              <Timer className="size-4 text-text-tertiary" />
              <Gear className="size-4 text-text-tertiary" />
            </div>
          </div>
        </div>

        {/* STAT CARDS */}
        <div className="col-span-5 row-span-2 overflow-hidden border border-border-mid bg-surface-base">
          <div className="p-2 font-mono text-4xs uppercase text-text-tertiary">KPI Cards {"// "}Stats Grid</div>
          <div className="grid h-full grid-cols-4 gap-0 pt-2">
            <Card variant="stat" size="compact" className="border-x-0 border-y-0 border-r border-border-dim">
              <CardContent className="flex flex-col justify-between p-3">
                <CardLabel>Bugs Found</CardLabel>
                <CardValue>142</CardValue>
                <CardMeta className="text-status-success">+12%</CardMeta>
              </CardContent>
            </Card>
            <Card variant="stat" size="compact" className="border-x-0 border-y-0 border-r border-border-dim">
              <CardContent className="flex flex-col justify-between p-3">
                <CardLabel>Tests Gen</CardLabel>
                <CardValue>4,096</CardValue>
                <CardMeta>94.2% cov.</CardMeta>
              </CardContent>
            </Card>
            <Card variant="stat" size="compact" className="border-x-0 border-y-0 border-r border-border-dim">
              <CardContent className="flex flex-col justify-between p-3">
                <CardLabel>Files</CardLabel>
                <CardValue>892</CardValue>
                <CardMeta>/src</CardMeta>
              </CardContent>
            </Card>
            <Card variant="stat" size="compact" className="border-x-0 border-y-0">
              <CardContent className="flex flex-col justify-between p-3">
                <CardLabel>Avg RT</CardLabel>
                <CardValue className="text-primary-ink">1.4s</CardValue>
                <CardMeta>Optimized</CardMeta>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* WORKFLOW BAR */}
        <div className="col-span-5 row-span-1 flex items-center overflow-hidden border border-border-mid bg-surface-base px-6">
          <div className="absolute font-mono text-4xs uppercase text-text-tertiary" style={{ top: 8, left: 8 }}>
            Workflow {"// "}Step Tracker
          </div>
          <Tabs defaultValue="execute" className="mt-2">
            <TabsList variant="line">
              <TabsTrigger value="scan">01 Scan</TabsTrigger>
              <TabsTrigger value="plan">02 Plan</TabsTrigger>
              <TabsTrigger value="execute">03 Execute</TabsTrigger>
              <TabsTrigger value="results">04 Results</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button variant="cta" size="sm" className="ml-auto">
            <Pause data-icon="inline-start" weight="bold" />
            Pause Agent
          </Button>
        </div>

        {/* ANOMALY LIST */}
        <div className="col-span-5 row-span-3 flex flex-col overflow-hidden border border-border-mid bg-surface-void">
          <div className="p-2 font-mono text-4xs uppercase text-text-tertiary">Anomaly List {"// "}Bug Panel</div>
          <div className="mt-2 flex flex-col gap-0 overflow-hidden">
            <div
              className="flex flex-col border-b border-border-dim bg-surface-raised p-3"
              style={{ borderLeft: "3px solid var(--status-critical)" }}
            >
              <div className="flex justify-between">
                <span className="text-xs font-medium text-text-primary">Race condition in Auth</span>
                <span className="font-mono text-4xs text-text-tertiary">#ERR-204</span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <Badge variant="critical">CRITICAL</Badge>
                <span className="font-mono text-4xs text-text-tertiary">auth/provider.ts</span>
              </div>
            </div>
            <div
              className="flex flex-col border-b border-border-dim p-3"
              style={{ borderLeft: "3px solid var(--status-high)" }}
            >
              <div className="flex justify-between">
                <span className="text-xs font-medium text-text-secondary">Memory leak in Stream</span>
                <span className="font-mono text-4xs text-text-tertiary">#ERR-201</span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <Badge variant="high">HIGH</Badge>
                <span className="font-mono text-4xs text-text-tertiary">core/stream.ts</span>
              </div>
            </div>
            <div
              className="flex flex-col border-b border-border-dim p-3"
              style={{ borderLeft: "3px solid var(--status-warn)" }}
            >
              <div className="flex justify-between">
                <span className="text-xs text-text-tertiary">Missing prop validation</span>
                <span className="font-mono text-4xs text-text-tertiary">#WRN-105</span>
              </div>
              <div className="mt-1 flex gap-2">
                <Badge variant="warn">WARN</Badge>
                <span className="font-mono text-4xs text-text-tertiary">ui/button.tsx</span>
              </div>
            </div>
            <div className="flex items-center justify-between border-b border-border-dim p-3">
              <span className="font-mono text-4xs uppercase text-text-tertiary">+ 11 more anomalies</span>
              <Button variant="ghost" size="xs">
                VIEW ALL
              </Button>
            </div>
          </div>
        </div>

        {/* CODE PANEL */}
        <div className="col-span-5 row-span-3 flex flex-col overflow-hidden border border-border-mid bg-surface-void font-mono text-xs">
          <div className="p-2 font-mono text-4xs uppercase text-text-tertiary">Code View {"// "}Error Highlight</div>
          <div className="flex items-center gap-2 border-b border-border-dim bg-surface-base px-4 py-2">
            <span className="text-3xs text-text-tertiary">src/auth/provider.ts</span>
            <Separator orientation="vertical" className="h-3" />
            <span className="text-3xs text-text-tertiary">TypeScript</span>
          </div>
          <pre className="flex flex-col gap-0 overflow-hidden p-0" style={{ fontSize: 10, lineHeight: 1.8 }}>
            <div className="flex px-4 py-0.5 hover:bg-surface-raised/50">
              <span className="mr-4 w-6 text-right text-text-tertiary">41</span>
              <span>
                <span className="text-primary-ink">async function</span>{" "}
                <span className="text-text-primary">validateSession</span>(token:{" "}
                <span className="text-status-success">string</span>) {"{"}
              </span>
            </div>
            <div className="flex px-4 py-0.5">
              <span className="mr-4 w-6 text-right text-text-tertiary">42</span>
              <span className="text-text-secondary">
                {"  "}
                <span className="text-primary-ink">const</span> cache = <span className="text-primary-ink">await</span>{" "}
                db.getCache(token);
              </span>
            </div>
            <div className="flex px-4 py-0.5">
              <span className="mr-4 w-6 text-right text-text-tertiary">43</span>
              <span className="italic text-text-tertiary">{"  // Potential race condition if cache clears here"}</span>
            </div>
            <div
              className="flex px-4 py-0.5"
              style={{
                background: "color-mix(in srgb, var(--status-critical) 10%, transparent)",
                borderLeft: "2px solid var(--status-critical)",
              }}
            >
              <span className="mr-4 w-6 text-right text-text-tertiary">44</span>
              <span className="text-text-primary">
                {"  "}
                <span className="text-primary-ink">if</span> (cache.isValid() && !globalState.isLocked) {"{"}
              </span>
            </div>
            <div className="flex px-4 py-0.5">
              <span className="mr-4 w-6 text-right text-text-tertiary">45</span>
              <span className="text-text-secondary">
                {"    "}
                <span className="text-primary-ink">return true</span>
                {";"}
              </span>
            </div>
            <div className="flex px-4 py-0.5">
              <span className="mr-4 w-6 text-right text-text-tertiary">46</span>
              <span className="text-text-secondary">{"  }"}</span>
            </div>
            <div className="flex px-4 py-0.5">
              <span className="mr-4 w-6 text-right text-text-tertiary">47</span>
              <span className="text-text-secondary">
                {"  "}
                <span className="text-primary-ink">return false</span>
                {";"}
              </span>
            </div>
          </pre>
        </div>

        {/* ACTIVITY FEED */}
        <div className="col-span-3 row-span-5 flex flex-col overflow-hidden border border-border-mid bg-surface-void p-4">
          <div className="mb-4 font-mono text-4xs uppercase text-text-tertiary">Activity Feed {"// "}Live</div>
          <div className="relative flex flex-col gap-0">
            <div className="absolute bottom-0 left-1 top-3 w-px bg-border-dim" />
            <div className="relative mb-5 flex gap-3">
              <div
                className="z-10 mt-0.5 size-2.5 shrink-0 bg-primary"
                style={{ boxShadow: "0 0 6px var(--accent-glow)" }}
              />
              <div>
                <div className="text-2xs leading-snug text-text-primary">
                  Agent identified critical path failure in auth module.
                </div>
                <div className="mt-1 font-mono text-4xs text-text-tertiary">10:42:05 AM</div>
              </div>
            </div>
            <div className="relative mb-5 flex gap-3">
              <div className="z-10 mt-0.5 size-2.5 shrink-0 border-2 border-status-high" />
              <div>
                <div className="text-2xs leading-snug text-text-secondary">
                  Test suite generated. 45% coverage increase potential.
                </div>
                <div className="mt-1 font-mono text-4xs text-text-tertiary">10:41:12 AM</div>
              </div>
            </div>
            <div className="relative mb-5 flex gap-3">
              <div className="z-10 mt-0.5 size-2.5 shrink-0 border-2 border-border-highlight" />
              <div>
                <div className="text-2xs leading-snug text-text-tertiary">
                  Scanning filesystem for dependency graphs...
                </div>
                <div className="mt-1 font-mono text-4xs text-text-tertiary">10:40:55 AM</div>
              </div>
            </div>
            <div className="relative flex gap-3">
              <div className="z-10 mt-0.5 size-2.5 shrink-0 border-2 border-border-mid" />
              <div>
                <div className="text-2xs leading-snug text-text-tertiary/60">
                  Agent initialized. Loading context from git history.
                </div>
                <div className="mt-1 font-mono text-4xs text-text-tertiary">10:40:00 AM</div>
              </div>
            </div>
          </div>
          <div className="mt-auto border-t border-border-dim pt-3">
            <div className="flex items-center justify-center py-4">
              <Logo variant="spinner" />
            </div>
            <div className="mb-2 font-mono text-4xs uppercase text-text-tertiary">System Resources</div>
            <Progress value={75}>
              <ProgressLabel>CPU</ProgressLabel>
              <ProgressValue />
            </Progress>
            <div className="mt-2" />
            <Progress value={60}>
              <ProgressLabel>MEM</ProgressLabel>
              <ProgressValue />
            </Progress>
          </div>
        </div>
      </div>
      <SlideFooter left="STATUS: WIP / COMPONENTS_SUBJECT_TO_CHANGE" />
    </section>
  );
}

/* ═══════════════════════════════════════════
   Main Presentation Component
   ═══════════════════════════════════════════ */

export function Presentation() {
  return (
    <main className="h-screen w-screen overflow-y-auto scroll-smooth snap-y snap-mandatory">
      <SlideCover />
      <SlideLogoShowcase />
      <SlideColorSystem />
      <SlideTypography />
      <SlideLogoUsage />
      <SlideIcons />
      <SlideDataAndCharts />
      <SlideUIFragments />
    </main>
  );
}

export default Presentation;
