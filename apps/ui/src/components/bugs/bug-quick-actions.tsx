import { Button, Panel, PanelBody, PanelHeader, PanelTitle } from "@autonoma/blacklight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import type { RouterOutputs } from "lib/trpc";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

type BugDetail = RouterOutputs["bugs"]["detail"];

export function BugQuickActions({ bug }: { bug: BugDetail }) {
  const latest = bug.latestOccurrence;
  const testSlug = latest?.testSlug ?? bug.testCases[0]?.slug;
  if (testSlug == null && latest == null) return null;

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Quick actions</PanelTitle>
      </PanelHeader>
      <PanelBody className="flex flex-col gap-2 p-4">
        {testSlug != null && (
          <Button
            variant="ghost"
            size="sm"
            render={<AppLink to="/app/$appSlug/tests/$testSlug" params={{ testSlug }} />}
          >
            View test
            <ArrowSquareOutIcon size={14} />
          </Button>
        )}
        {latest?.runId != null && (
          <Button
            variant="ghost"
            size="sm"
            render={<AppLink to="/app/$appSlug/runs/$runId" params={{ runId: latest.runId }} />}
          >
            View latest run
            <ArrowSquareOutIcon size={14} />
          </Button>
        )}
        {latest?.generationId != null && (
          <Button
            variant="ghost"
            size="sm"
            render={
              <AppLink to="/app/$appSlug/generations/$generationId" params={{ generationId: latest.generationId }} />
            }
          >
            View latest generation
            <ArrowSquareOutIcon size={14} />
          </Button>
        )}
      </PanelBody>
    </Panel>
  );
}
