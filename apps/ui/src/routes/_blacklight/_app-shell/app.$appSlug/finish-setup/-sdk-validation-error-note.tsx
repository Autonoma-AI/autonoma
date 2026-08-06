import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { Link } from "@tanstack/react-router";
import { MCP_SERVER_NAME, mcpEndpointUrl } from "components/connect-agent-dialog";
import { FixWithAgentButton } from "components/fix-with-agent-button";
import { sdkFixInstruction } from "lib/onboarding/agent-instructions";
import { buildSdkFixPrompt } from "lib/onboarding/sdk-fix-prompt";
import { classifySdkValidationError } from "lib/onboarding/sdk-validation-error";

export interface SdkValidationErrorNoteProps {
  /** The failure as the API persisted it (`lastDiscoveryError`). */
  error: string;
  applicationId: string;
  applicationName: string;
  /** The dry-run target the validation ran against, so the brief can name it to the MCP tools. */
  targetId?: string;
  sdkUrl?: string;
  previewUrl?: string;
  targetLabel?: string;
  pullRequestUrl?: string;
  repoFullName?: string;
}

/**
 * Why the last SDK validation failed, and what to do about it.
 *
 * The two answers are genuinely different jobs, so the note splits on which one this is. A handler
 * that answered wrongly is a change in the user's repo, and the agent gets the whole failure to
 * work from. A preview that never answered is nobody's bug - offering an agent there sends someone
 * off to debug code that is fine.
 *
 * Shared by both validation paths (Vercel-linked and bring-your-own preview), which report the
 * same errors from the same discover call and should not explain them two different ways.
 */
export function SdkValidationErrorNote(props: SdkValidationErrorNoteProps) {
  if (classifySdkValidationError(props.error) === "transient") {
    return <UnresponsivePreviewNote error={props.error} previewUrl={props.previewUrl} />;
  }
  return <FixableErrorNote {...props} />;
}

function UnresponsivePreviewNote({ error, previewUrl }: { error: string; previewUrl?: string }) {
  return (
    <div className="flex items-start gap-2 border border-status-warn/30 bg-status-warn/5 px-3 py-2.5">
      <WarningCircleIcon size={16} weight="fill" className="mt-0.5 shrink-0 text-status-warn" />
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="text-sm text-text-primary">
          The preview didn't answer - it's likely still waking up, not broken.
        </p>
        <p className="text-sm text-text-secondary">
          {previewUrl != null ? (
            <>
              <Link
                to="/preview-waiting"
                search={{ to: previewUrl }}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-text-primary underline"
              >
                Open it
              </Link>
              , wait until it loads, then validate again.
            </>
          ) : (
            "Wait for it to finish deploying, then validate again."
          )}
        </p>
        <p className="whitespace-pre-wrap break-words font-mono text-2xs text-text-secondary">{error}</p>
      </div>
    </div>
  );
}

function FixableErrorNote({
  error,
  applicationId,
  applicationName,
  targetId,
  sdkUrl,
  previewUrl,
  targetLabel,
  pullRequestUrl,
  repoFullName,
}: SdkValidationErrorNoteProps) {
  const prompt = buildSdkFixPrompt({
    applicationId,
    applicationName,
    error,
    targetId,
    sdkUrl,
    previewUrl,
    targetLabel,
    pullRequestUrl,
    repoFullName,
    mcpUrl: mcpEndpointUrl(),
    mcpServerName: MCP_SERVER_NAME,
  });

  return (
    <div className="flex items-start gap-2 border border-status-critical/30 bg-status-critical/5 px-3 py-2.5">
      <WarningCircleIcon size={16} weight="fill" className="mt-0.5 shrink-0 text-status-critical" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="whitespace-pre-wrap break-words font-mono text-2xs text-status-critical">{error}</p>
        <p className="text-2xs text-text-secondary">
          Your endpoint answered, so this is a change in your repo. Hand the whole failure to your coding agent - it
          gets the error, the endpoint, and what the handler has to return.
        </p>
        <FixWithAgentButton
          // Named after the failure, not "fix it if it fails": the launch command is all an agent
          // gets on a client with no room for the brief, and sending it to reproduce something we
          // already have the answer to wastes the first half of the session.
          instruction={sdkFixInstruction(error)}
          prompt={prompt}
          repoFullName={repoFullName}
          // Only an Autonoma-hosted preview has logs we can serve, so only that copy promises them.
          capabilities={
            repoFullName != null
              ? "From your repo it validates the endpoint against this preview, reads that preview's runtime logs, and fixes the handler."
              : "From your repo it validates the endpoint against this preview and fixes the handler."
          }
        />
      </div>
    </div>
  );
}
