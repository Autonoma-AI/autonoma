import { Diff } from "@/components/ui/diff";
import { CodeBlock, PreviewBox, PropRow, PropTable, SectionDesc, SectionTitle, SubTitle } from "../components/atoms";

const PLAN_BEFORE = [
  "Log in as the seeded shopper.",
  "Add two items to the cart.",
  "Assert the cart badge reads 2.",
  "Open the checkout page.",
].join("\n");

const PLAN_AFTER = [
  "Log in as the seeded shopper.",
  "Add three items to the cart.",
  "Assert the cart badge reads 3.",
  "Apply the promo code SAVE10.",
  "Open the checkout page.",
].join("\n");

const MOVE_BEFORE = ["setup fixtures", "relocated step", "run the assertion", "tear down"].join("\n");
const MOVE_AFTER = ["setup fixtures", "run the assertion", "tear down", "relocated step"].join("\n");

export function DiffSection() {
  return (
    <>
      <SectionTitle>Diff</SectionTitle>
      <SectionDesc>
        Compares two versions of a text and renders the result as a line grid. Changed lines carry a word-level
        highlight so a reworded line reads as an edit rather than a wholesale replacement. Relocated lines are tinted
        distinctly, so a reordering does not look like churn.
      </SectionDesc>

      <CodeBlock label="IMPORT">
        <span className="text-status-critical">import</span> {"{ "}
        <span className="text-chart-3">Diff</span>
        {" }"} <span className="text-status-critical">from</span>{" "}
        <span className="text-text-secondary">&quot;@autonoma/blacklight&quot;</span>
        {";"}
      </CodeBlock>

      <SubTitle>Unified</SubTitle>
      <PreviewBox>
        <Diff oldSource={PLAN_BEFORE} newSource={PLAN_AFTER} showLineNumbers={false} />
      </PreviewBox>

      <SubTitle>Split</SubTitle>
      <PreviewBox>
        <Diff oldSource={PLAN_BEFORE} newSource={PLAN_AFTER} view="split" showLineNumbers={false} />
      </PreviewBox>

      <SubTitle>Line numbers</SubTitle>
      <PreviewBox>
        <Diff oldSource={PLAN_BEFORE} newSource={PLAN_AFTER} />
      </PreviewBox>

      <SubTitle>Relocated lines</SubTitle>
      <SectionDesc>
        A line deleted in one place and re-added in another is a move, not a delete plus an add. An exact relocation is
        tinted with <span className="text-status-pending">status-pending</span>; one that also carries a small edit is a
        near-match, tinted with <span className="text-status-high">status-high</span>.
      </SectionDesc>
      <PreviewBox>
        <Diff oldSource={MOVE_BEFORE} newSource={MOVE_AFTER} showLineNumbers={false} />
      </PreviewBox>

      <SubTitle>One-sided</SubTitle>
      <SectionDesc>Pass an empty string for the side that does not exist.</SectionDesc>
      <PreviewBox>
        <Diff oldSource="" newSource={PLAN_AFTER} showLineNumbers={false} />
      </PreviewBox>

      <SubTitle>Props</SubTitle>
      <PropTable>
        <PropRow name="oldSource" type="string" def="-" desc="The text before the change; empty for a pure addition" />
        <PropRow name="newSource" type="string" def="-" desc="The text after the change; empty for a pure deletion" />
        <PropRow
          name="view"
          type='"unified" | "split"'
          def='"unified"'
          desc="One stacked column, or old on the left and new on the right"
        />
        <PropRow name="showLineNumbers" type="boolean" def="true" desc="Show the old/new line number gutter" />
        <PropRow
          name="options"
          type="DiffOptions"
          def="{}"
          desc="collapseWhitespace, detectMoves, minMovedBlockLines, nearMatchThreshold, context"
        />
      </PropTable>
    </>
  );
}

export default DiffSection;
