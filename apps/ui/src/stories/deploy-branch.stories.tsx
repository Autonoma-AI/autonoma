import {
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@autonoma/blacklight";
import { previewConfigSchema } from "@autonoma/types";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { trpcHandler, type TrpcFixtures } from "lib/storybook/trpc-handler";
import { DeployBranchField } from "../routes/_blacklight/onboarding/-components/previewkit/deploy-branch-field";
import { ReviewSection } from "../routes/_blacklight/onboarding/-components/previewkit/review-section";
import { draftFromConfig } from "../routes/_blacklight/onboarding/-components/previewkit/topology-draft";

// A dockerfile-built app with a Postgres database - the manual "review + deploy"
// step's topology. Parsed through the real schema so the draft matches production.
const dockerfileConfig = previewConfigSchema.parse({
  version: 1,
  apps: [
    {
      name: "web",
      path: ".",
      port: 3000,
      primary: true,
      dockerfile: "Dockerfile",
      connections: [{ key: "DATABASE_URL", value: "{{db.url}}" }],
    },
  ],
  services: [{ name: "db", recipe: "postgres", version: "16" }],
});

const reviewDraft = draftFromConfig(dockerfileConfig, [], "saved");

function branchFixtures(currentBranch: string): TrpcFixtures {
  return {
    onboarding: {
      listDeployBranches: {
        branches: ["master", "develop", "autonoma", "release/2026-01", "hotfix/login"],
        defaultBranch: "master",
        currentBranch,
        truncated: false,
      },
    },
  };
}

/**
 * The onboarding Review step around the new Deploy branch selector: the branch
 * dropdown on top, the lifecycle/topology summary below.
 */
function ReviewStep({ currentBranch, defaultBranch }: { currentBranch: string; defaultBranch: string }) {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 bg-surface-void p-6">
      <DeployBranchField applicationId="app_fixture_01" currentBranch={currentBranch} defaultBranch={defaultBranch} />
      <ReviewSection draft={reviewDraft} repoName="acme/web" />
    </div>
  );
}

const meta = {
  title: "Onboarding/DeployBranch",
  component: ReviewStep,
} satisfies Meta<typeof ReviewStep>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Manual flow: the review + deploy step for a dockerfile-built app. The Deploy
 * branch selector defaults to the repo's real default branch (here `master`) - the
 * scenario that used to deploy from a hardcoded, non-existent branch.
 */
export const ManualDockerfile: Story = {
  args: { currentBranch: "master", defaultBranch: "master" },
  parameters: { msw: { handlers: [trpcHandler(branchFixtures("master"))] } },
};

/**
 * Not steering to the default: when the user works on a different branch (e.g. a
 * coding agent over MCP finds the checkout on `autonoma` and sets it), the selector
 * shows that chosen branch, with the repo default flagged in the dropdown.
 */
export const FeatureBranch: Story = {
  args: { currentBranch: "autonoma", defaultBranch: "master" },
  parameters: { msw: { handlers: [trpcHandler(branchFixtures("autonoma"))] } },
};

/**
 * The branch selector opened: the repo's branches (default flagged). Above the
 * search threshold the dropdown grows a filter box that doubles as free-text entry
 * for a branch not in the listed page.
 */
export const BranchDropdownOpen: Story = {
  args: { currentBranch: "master", defaultBranch: "master" },
  render: () => (
    <div className="min-h-[520px] bg-surface-void p-6">
      <div className="max-w-md">
        <Label htmlFor="pk-deploy-branch-open">Branch</Label>
        <Select defaultValue="master" defaultOpen>
          <SelectTrigger id="pk-deploy-branch-open" className="font-mono">
            <SelectValue placeholder="Select a branch" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="master" className="font-mono">
              master <span className="ml-1.5 font-sans text-text-secondary">- default</span>
            </SelectItem>
            <SelectItem value="develop" className="font-mono">
              develop
            </SelectItem>
            <SelectItem value="autonoma" className="font-mono">
              autonoma
            </SelectItem>
            <SelectSeparator />
            <SelectItem value="release/2026-01" className="font-mono">
              release/2026-01
            </SelectItem>
            <SelectItem value="hotfix/login" className="font-mono">
              hotfix/login
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  ),
};
