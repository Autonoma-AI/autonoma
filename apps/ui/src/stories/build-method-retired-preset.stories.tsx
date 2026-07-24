import { authoringPreviewConfigSchema, previewConfigSchema, zodIssuesToConfigIssues } from "@autonoma/types";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { BuildModeSection } from "../routes/_blacklight/onboarding/-components/previewkit/build-mode-section";
import {
  documentsFromDraft,
  draftFromConfig,
  emptyDraftIssues,
  mapIssuesToDraft,
  type AppDraft,
  type DraftIssues,
} from "../routes/_blacklight/onboarding/-components/previewkit/topology-draft";

// An app stored before the framework presets were retired - the shape ~15 live
// configs still carry. Parsed through the read schema (which still accepts a
// preset) so the draft matches what the editor really loads.
const storedPresetConfig = previewConfigSchema.parse({
  version: 1,
  apps: [
    {
      name: "northwind-bank",
      path: ".",
      port: 3000,
      primary: true,
      build: { framework: "next", package_manager: "pnpm", node_version: "22" },
    },
  ],
});

/**
 * Runs the draft through the real validation pipeline - compile, parse against the
 * authoring contract, map the Zod issues onto draft fields - so the story shows the
 * message the editor actually renders rather than a hand-written copy of it.
 */
function issuesFor(app: AppDraft): DraftIssues {
  const compiled = documentsFromDraft({ ...baseDraft, apps: [app] }).primary;
  const parsed = authoringPreviewConfigSchema.safeParse(compiled.document);
  if (parsed.success) return emptyDraftIssues();
  return mapIssuesToDraft(zodIssuesToConfigIssues(parsed.error), compiled.indexToDraftId);
}

const baseDraft = draftFromConfig(storedPresetConfig, [], "saved");

function BuildMethodEditor({ initial }: { initial: AppDraft }) {
  const [app, setApp] = useState(initial);
  return (
    <div className="mx-auto max-w-4xl bg-surface-void p-6">
      <BuildModeSection
        app={app}
        applicationId="app_fixture_01"
        issues={issuesFor(app)}
        onChange={(_id, patch) => setApp((current) => ({ ...current, ...patch }))}
      />
    </div>
  );
}

const meta = {
  title: "Onboarding/BuildMethod",
  component: BuildMethodEditor,
} satisfies Meta<typeof BuildMethodEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * An app still on the retired `next` preset. Neither method is selected because
 * the preset is not one of them: the toggle is outlined as invalid, the schema's
 * error names the two methods that do work, and the copy says the current preview
 * keeps deploying but the config cannot be saved again until a method is picked.
 */
export const RetiredPreset: Story = {
  args: { initial: baseDraft.apps[0]! },
};

/**
 * The same app after picking Manual: the runtime editor takes over with the build
 * script and entrypoint seeded from the runtime's defaults, the error clears, and
 * the config saves.
 */
export const ConvertedToManual: Story = {
  args: {
    initial: {
      ...baseDraft.apps[0]!,
      buildMode: "runtime",
      buildPassthrough: undefined,
      buildScript: "pnpm install --frozen-lockfile\npnpm run build",
      entrypoint: "pnpm start",
    },
  },
};
