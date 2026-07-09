import { GithubLogoIcon } from "@phosphor-icons/react/GithubLogo";
import { useApplications, useRenameApplication } from "lib/query/applications.queries";
import { useApplicationRepositoryFromGitHub } from "lib/query/github.queries";
import { EditableText } from "./editable-text";

export interface OnboardingAppHeaderProps {
  appId: string;
}

/**
 * Compact identity strip for the app being onboarded: the app name (inline-editable)
 * with an org/repo subheading. Renders nothing until the app is known.
 */
export function OnboardingAppHeader({ appId }: OnboardingAppHeaderProps) {
  const applications = useApplications();
  const repositoryQuery = useApplicationRepositoryFromGitHub(appId);
  const renameApp = useRenameApplication();

  const app = applications.data.find((candidate) => candidate.id === appId);
  if (app == null) return undefined;

  const repoFullName = repositoryQuery.data?.fullName;

  function handleRename(name: string) {
    if (app == null) return;
    // updateData is a discriminated union on architecture - narrow so the branch is well-typed.
    if (app.architecture === "WEB") {
      renameApp.mutate({ id: appId, name, architecture: "WEB" });
      return;
    }
    renameApp.mutate({ id: appId, name, architecture: app.architecture });
  }

  return (
    <div className="mb-4 flex flex-col gap-1">
      <EditableText
        value={app.name}
        onSave={handleRename}
        isPending={renameApp.isPending}
        ariaLabel="application name"
        className="text-xl font-medium text-text-primary"
        inputClassName="font-sans text-xl font-medium text-text-primary"
      />
      {repoFullName != null ? (
        <div className="flex items-center gap-1.5 font-mono text-2xs text-text-secondary">
          <GithubLogoIcon size={12} weight="duotone" />
          <span className="truncate">{repoFullName}</span>
        </div>
      ) : undefined}
    </div>
  );
}
