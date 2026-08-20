import type { Meta, StoryObj } from "@storybook/react-vite";
import { FixPromptPanel } from "components/analysis/fix/fix-prompt-panel";

const SAMPLE_PROMPT = `You are fixing bugs found in pull request #482 (acme/storefront).

Autonoma found 1 bug in this PR: checkout is broken - the Place order button never enables, so no customer can buy.

## Issues to fix

1. [bug · critical] Place order button never enables on checkout
   Expected: filling every required field enables Place order.
   Actual: the button stays disabled, so the order can never be submitted.
   Suspected cause: apps/web/src/checkout/PlaceOrder.tsx:88 - the form validity
   effect reads \`billingSame\` before it is set, so \`canSubmit\` never flips true.

2. [environment · high] The preview has no SMTP key, so invoice email cannot be checked.

3. [scenario · medium] The checkout scenario seeds no coupon codes.

Reproduce each against the preview, fix the root cause, and keep the existing tests green.`;

const meta = {
  title: "Components/FixPromptPanel",
  component: FixPromptPanel,
} satisfies Meta<typeof FixPromptPanel>;
export default meta;

type Story = StoryObj<typeof meta>;

// `border-b` reinstates the bottom edge the component drops (it normally joins the action bar below it),
// so the panel reads as a framed box on its own in the catalog.
export const Default: Story = {
  args: { prompt: SAMPLE_PROMPT, condensed: true, truncated: false, className: "border-b" },
};

// What the reader sees when condensing was not enough and the deep-link brief lost its last issues.
export const Truncated: Story = {
  args: { prompt: SAMPLE_PROMPT, condensed: true, truncated: true, className: "border-b" },
};
