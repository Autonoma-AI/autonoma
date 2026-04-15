import {
  BrailleSpinner,
  BRAILLE_SPINNER_ANIMATIONS,
  type BrailleSpinnerAnimation,
} from "@/components/ui/braille-spinner";
import { CodeBlock, PreviewBox, SectionDesc, SectionTitle, SubTitle } from "../components/atoms";

const GRID_ANIMATIONS: BrailleSpinnerAnimation[] = [
  "scan",
  "rain",
  "scanline",
  "pulse",
  "snake",
  "sparkle",
  "cascade",
  "columns",
  "orbit",
  "breathe",
  "waverows",
  "checkerboard",
  "helix",
  "fillsweep",
  "diagswipe",
];

const CLASSIC_ANIMATIONS: BrailleSpinnerAnimation[] = ["braille", "braillewave", "dna"];

export function BrailleSpinnerSection() {
  return (
    <>
      <SectionTitle>Braille Spinner</SectionTitle>
      <SectionDesc>
        Animated loading indicators built on Unicode braille characters (U+2800 block). 18 animations ranging from
        classic single-char spinners to multi-character grid patterns.
      </SectionDesc>

      <CodeBlock label="IMPORT">
        <span className="text-status-critical">import</span> {"{ "}
        <span className="text-chart-3">BrailleSpinner</span>
        {" }"} <span className="text-status-critical">from</span>{" "}
        <span className="text-text-secondary">&quot;@autonoma/blacklight&quot;</span>
        {";"}
      </CodeBlock>

      <SubTitle>Classic Spinners</SubTitle>
      <PreviewBox>
        <div className="flex flex-wrap items-center gap-8">
          {CLASSIC_ANIMATIONS.map((name) => (
            <div key={name} className="flex flex-col items-center gap-3">
              <BrailleSpinner animation={name} size="xl" />
              <span className="font-mono text-3xs text-text-tertiary">{name}</span>
            </div>
          ))}
        </div>
      </PreviewBox>

      <SubTitle>Grid Animations</SubTitle>
      <PreviewBox>
        <div className="grid grid-cols-5 gap-8">
          {GRID_ANIMATIONS.map((name) => (
            <div key={name} className="flex flex-col items-center gap-3">
              <BrailleSpinner animation={name} size="xl" />
              <span className="font-mono text-3xs text-text-tertiary">{name}</span>
            </div>
          ))}
        </div>
      </PreviewBox>

      <SubTitle>Sizes</SubTitle>
      <PreviewBox>
        <div className="flex items-end gap-8">
          {(["sm", "md", "lg", "xl"] as const).map((size) => (
            <div key={size} className="flex flex-col items-center gap-3">
              <BrailleSpinner animation="helix" size={size} />
              <span className="font-mono text-3xs text-text-tertiary">{size}</span>
            </div>
          ))}
        </div>
      </PreviewBox>

      <SubTitle>Inline Usage</SubTitle>
      <PreviewBox>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-secondary">
            <BrailleSpinner animation="braille" size="sm" className="mr-2 text-primary" />
            Loading test results...
          </p>
          <p className="text-sm text-text-secondary">
            <BrailleSpinner animation="orbit" size="sm" className="mr-2 text-status-warn" />
            Analyzing screenshots...
          </p>
          <p className="text-sm text-text-secondary">
            <BrailleSpinner animation="breathe" size="sm" className="mr-2 text-status-success" />
            Agent processing...
          </p>
        </div>
      </PreviewBox>

      <SubTitle>All Animations ({BRAILLE_SPINNER_ANIMATIONS.length})</SubTitle>
      <PreviewBox>
        <div className="grid grid-cols-6 gap-6">
          {BRAILLE_SPINNER_ANIMATIONS.map((name) => (
            <div key={name} className="flex flex-col items-center gap-2 border border-border-dim p-3">
              <BrailleSpinner animation={name} size="lg" />
              <span className="font-mono text-4xs text-text-tertiary">{name}</span>
            </div>
          ))}
        </div>
      </PreviewBox>
    </>
  );
}

export default BrailleSpinnerSection;
