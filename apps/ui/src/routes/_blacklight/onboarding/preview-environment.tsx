import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import { agentMcpPrompt } from "components/agent-mcp-prompt";
import { ONBOARDING_MCP_SERVER_NAME } from "components/connect-agent-dialog";
import { useSelectPreviewEnvironmentMode } from "lib/onboarding/onboarding-api";
import {
  type OnboardingOrigin,
  type OnboardingSignalProvider,
  buildOnboardingSearch,
} from "lib/onboarding/onboarding-search";
import { useAgentSession } from "lib/query/onboarding.queries";
import { PreviewRouterQuiz } from "./-components/preview-router-quiz";
import { McpFirstConfigView, type McpFirstCopy } from "./-components/previewkit/mcp-first-config-view";

export const Route = createFileRoute("/_blacklight/onboarding/preview-environment")({
  component: () => <Navigate to="/onboarding" search={buildOnboardingSearch("preview-environment")} />,
});

/** What the user hands their agent here: the whole preview setup, path choice included. */
const SETUP_INSTRUCTION = `set up my preview environments with the ${ONBOARDING_MCP_SERVER_NAME} MCP`;

function agentSetupCopy(appId: string, origin?: OnboardingOrigin): McpFirstCopy {
  return {
    heading: "Set up with a coding agent",
    blurb:
      "Install the Autonoma MCP from your terminal, authorize it when your agent asks, then give your agent the pairing code. It reads your repo, works out how your previews and test data should work, and sets it up while you watch here.",
    manualLabel: "Answer a few questions instead",
    // Keep the origin on the escape hatch: the questionnaire uses it to skip the
    // questions arriving from that marketplace already answers.
    manualSearch: buildOnboardingSearch("preview-environment", appId, { manual: true, origin }),
    prompt: (code) => agentMcpPrompt(SETUP_INSTRUCTION, code),
  };
}

/**
 * The preview-environment step, with a coding agent as the headline.
 *
 * The questionnaire asks the user to self-assess - "is all your data
 * tenant-scoped?" is a question people get wrong about their own app. An agent
 * sitting in the repo can read the schema and the deploy config and answer it
 * from evidence, so it picks the path itself (`select_preview_path` over MCP)
 * and goes straight to the work.
 *
 * The questionnaire becomes the opt-out rather than a step the agent path passes
 * through - for every entry point, marketplace origins included. A Vercel origin
 * only shortens the questionnaire (it already answers where the previews come
 * from), it does not decide that the user wants the questionnaire at all.
 */
export function PreviewEnvironmentPage({
  appId,
  origin,
  manual,
}: {
  appId?: string;
  origin?: OnboardingOrigin;
  manual?: boolean;
}) {
  const navigate = useNavigate();
  const selectMode = useSelectPreviewEnvironmentMode();
  const { data: agentSession, isLoading } = useAgentSession(appId ?? "");

  function choose(mode: "previewkit" | "existing_deploys", provider?: OnboardingSignalProvider) {
    if (appId == null) return;
    selectMode.mutate(
      { applicationId: appId, mode },
      {
        onSuccess: () => {
          void navigate({
            to: "/onboarding",
            search: buildOnboardingSearch(mode === "previewkit" ? "previewkit-config" : "existing-deploys", appId, {
              provider,
              // Carry the manual intent. Answering the questionnaire IS declining
              // the agent, and the config step reads a missing `configStep` as
              // "no manual intent" and leads with the pairing screen - so without
              // this the user is offered the agent again immediately after
              // turning it down.
              configStep: mode === "previewkit" ? "apps" : undefined,
            }),
          });
        },
      },
    );
  }

  function backToRepo() {
    void navigate({ to: "/onboarding", search: buildOnboardingSearch("add-app", appId, { origin }) });
  }

  if (appId == null) {
    return <p className="font-mono text-sm text-text-secondary">No application found. Please start from setup.</p>;
  }

  if (manual === true) {
    return (
      <PreviewRouterQuiz
        appId={appId}
        startProvider={origin === "vercel" ? "vercel" : undefined}
        onChoose={choose}
        onBack={backToRepo}
      />
    );
  }

  // Hold the frame until the first agent-session poll settles, so someone
  // returning mid-setup doesn't see the pairing screen flash before the live one.
  if (isLoading) return undefined;

  return (
    <McpFirstConfigView
      appId={appId}
      agentHeld={agentSession?.effectiveHolder === "agent"}
      copy={agentSetupCopy(appId, origin)}
    />
  );
}
