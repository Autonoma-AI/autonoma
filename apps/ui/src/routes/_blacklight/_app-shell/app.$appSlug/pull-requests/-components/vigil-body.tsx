import { AgentCube, Button, ReviewPipeline } from "@autonoma/blacklight";
import type { ApplicationActivity } from "@autonoma/types";
import { FlaskIcon } from "@phosphor-icons/react/Flask";
import { UsersThreeIcon } from "@phosphor-icons/react/UsersThree";
import { useApplicationRepositoryFromGitHub } from "lib/query/github.queries";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";

/** Before this, the elapsed time is not worth stating - setup finished moments ago. */
const AGE_NOTE_AFTER_DAYS = 2;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The pull-request list's body for an application that is set up and has never had a pull request. */
export function VigilBody({ activity }: { activity: ApplicationActivity }) {
  const app = useCurrentApplication();
  const repositoryQuery = useApplicationRepositoryFromGitHub(app.id);
  const repository = repositoryQuery.data?.fullName;
  const days = activity.liveSince != null ? Math.floor((Date.now() - activity.liveSince.getTime()) / MS_PER_DAY) : 0;

  return (
    <div className="flex items-start gap-4 px-4 py-6">
      <AgentCube state="idle" size={34} className="mt-0.5 shrink-0" />

      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-4xs font-semibold uppercase tracking-widest text-primary-ink">
            Live · waiting for your first run
          </span>
          <h3 className="text-base font-semibold text-text-primary">Nothing has run yet.</h3>
          <p className="max-w-xl text-sm leading-relaxed text-text-secondary">
            The next pull request you open on {repository ?? "this repository"} starts a review.
            {days >= AGE_NOTE_AFTER_DAYS && ` Nothing has run in ${days} days.`}
          </p>
        </div>

        <ReviewPipeline />

        <p className="font-mono text-3xs text-text-secondary">{caveatFor(activity.previewMode)}</p>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button variant="outline" size="sm" render={<AppLink to="/app/$appSlug/tests" />}>
            <FlaskIcon size={14} />
            Read your test suite
          </Button>
          <Button variant="outline" size="sm" render={<AppLink to="/app/$appSlug/settings/users" />}>
            <UsersThreeIcon size={14} />
            Invite your team
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The previewkit wording covers both draft policies rather than reading `previewkitBuildDraft`, which is API-only
 * today and not worth exposing for a single clause.
 */
function caveatFor(previewMode: ApplicationActivity["previewMode"]): string {
  if (previewMode === "existing_deploys") {
    return "Your pipeline reports the preview; Autonoma does not build one.";
  }
  return "Drafts are skipped unless your organization opts in.";
}
