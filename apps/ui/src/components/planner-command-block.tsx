import { Button, Skeleton } from "@autonoma/blacklight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { getApiOrigin } from "lib/api-origin";
import { useAuth } from "lib/auth";
import {
  buildPlannerCommand,
  buildPlannerCommandForCopy,
  PLANNER_DOCS_URL,
  type PlannerCommandEnv,
} from "lib/onboarding/planner-command";
import { useCliSetupId, useMintCliToken } from "lib/query/app-generations.queries";
import { useApplicationSharedSecret } from "lib/query/applications.queries";
import { toastManager } from "lib/toast-manager";
import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";

/** How long the button holds its confirmation before offering to copy again. */
const COPIED_RESET_MS = 2000;

/**
 * The single command that sets an application up: paste it into a terminal and the
 * planner takes it from there - preview environment, test suite, the lot.
 *
 * The CLI is not an agent session, so it can register the MCP server itself and then
 * spawn a fresh agent that picks it up - an agent cannot register a server it will
 * then use, since a client only loads its server list at startup.
 *
 * Nothing here mints a credential. The setup id is resolved on render because it is
 * shown in full and so has to be real; the API token beside it is masked, and exists
 * only once the command is actually copied.
 */
export function PlannerCommandBlock({ applicationId }: { applicationId: string }) {
  // The boundary lives HERE, not on the route, because only this subtree suspends -
  // every sibling query on these screens is a plain `useQuery`. Put it on the route
  // and a cold load blanks the whole onboarding shell (sidebar, heading, cube) for the
  // round trip; put it here and the frame stays up with a skeleton where the command
  // will be. It also has to be inside the component rather than at the call site,
  // because two routes render this and only one of them has a boundary of its own.
  return (
    <Suspense fallback={<CommandSkeleton />}>
      <ResolvedCommand applicationId={applicationId} />
    </Suspense>
  );
}

/** The command block's own shape while the setup id resolves. */
function CommandSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-4 w-40" />
    </div>
  );
}

function ResolvedCommand({ applicationId }: { applicationId: string }) {
  const { user } = useAuth();
  const { data: sharedSecretData } = useApplicationSharedSecret(applicationId);
  const { data: setup } = useCliSetupId(applicationId);

  return (
    <CopyableCommand
      applicationId={applicationId}
      generationId={setup.setupId}
      sharedSecret={sharedSecretData?.sharedSecret}
      distinctId={user?.id}
    />
  );
}

interface CopyableCommandProps {
  applicationId: string;
  generationId: string;
  sharedSecret?: string;
  distinctId?: string;
}

function CopyableCommand({ applicationId, generationId, sharedSecret, distinctId }: CopyableCommandProps) {
  const [copied, setCopied] = useState(false);
  const mintToken = useMintCliToken();
  const mintAsync = mintToken.mutateAsync;
  // Holds the PROMISE, not the resolved key. Caching the key would only dedupe copies
  // made after the first mint returns; two clicks inside that round trip would each
  // create a live credential. One key per visit, however many times it is copied.
  const minting = useRef<Promise<string> | undefined>(undefined);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  // What is rendered and what is copied differ on purpose, and by more than masking:
  // on screen the token does not exist yet. It is minted by `copy` below.
  const shown = buildPlannerCommand(
    { apiUrl: getApiOrigin(), apiToken: "", generationId, applicationId, sharedSecret, distinctId },
    { masked: true },
  );

  function copy() {
    if (navigator.clipboard == null) {
      console.warn("Clipboard API unavailable; cannot copy the planner command");
      return;
    }
    minting.current ??= mintAsync({ applicationId })
      .then((minted) => minted.apiKey)
      // A failed mint must not poison the ref, or every later copy replays a failure
      // against a key that was never created.
      .catch((err: unknown) => {
        minting.current = undefined;
        throw err;
      });

    minting.current
      .then((apiToken) => {
        const env: PlannerCommandEnv = {
          apiUrl: getApiOrigin(),
          apiToken,
          generationId,
          applicationId,
          sharedSecret,
          distinctId,
        };
        return navigator.clipboard.writeText(buildPlannerCommandForCopy(env));
      })
      .then(() => {
        setCopied(true);
        toastManager.add({
          type: "success",
          title: "Command copied",
          description: "Paste it into a terminal, from your repo's root directory.",
        });
      })
      .catch((err) => {
        console.warn("Failed to copy the planner command", err);
        toastManager.add({ type: "critical", title: "Couldn't copy the command", description: "Try again." });
      });
  }

  return (
    <div className="flex flex-col gap-3">
      <CommandFrame>
        {/* The whole block is a copy target, not just the icon - people click the text
            they are trying to take. The icon is what makes that discoverable. */}
        <button
          type="button"
          onClick={copy}
          className="block w-full cursor-pointer text-left"
          aria-label="Copy command"
        >
          <pre className="whitespace-pre-wrap p-4 pr-12 font-mono text-2xs leading-relaxed text-text-primary [overflow-wrap:anywhere]">
            {shown}
          </pre>
        </button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="absolute right-2 top-2 bg-surface-void"
          onClick={copy}
          disabled={mintToken.isPending}
          aria-label="Copy command"
        >
          {copied ? <CheckIcon className="text-status-success" /> : <CopyIcon />}
        </Button>
      </CommandFrame>

      <a
        href={PLANNER_DOCS_URL}
        target="_blank"
        rel="noreferrer"
        className="inline-flex w-fit items-center gap-1.5 text-2xs text-primary hover:underline"
      >
        <ArrowSquareOutIcon weight="bold" />
        What this command does
      </a>
    </div>
  );
}

function CommandFrame({ children }: { children: ReactNode }) {
  return <div className="relative border border-border-dim bg-surface-void">{children}</div>;
}
