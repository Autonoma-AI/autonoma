import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { Link, createFileRoute, useRouteContext } from "@tanstack/react-router";
import { ApiKeysPanel } from "components/api-keys/api-keys-panel";

export const Route = createFileRoute("/_blacklight/_app-shell/settings/api-keys/")({
  component: OrgApiKeysPage,
});

function OrgApiKeysPage() {
  const organizationName = useRouteContext({
    from: "/_blacklight/_app-shell",
    select: (ctx) => ctx.activeOrganization.name,
  });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
      <Link
        to="/"
        className="flex w-fit items-center gap-1.5 font-mono text-2xs uppercase tracking-widest text-text-secondary transition-colors hover:text-text-primary"
      >
        <ArrowLeftIcon size={14} />
        Back to home
      </Link>

      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium tracking-tight text-text-primary">API Keys</h1>
        <p className="max-w-2xl text-sm text-text-secondary">
          Organization-wide keys for authenticating the Autonoma CLI and API requests for{" "}
          <span className="font-medium text-text-primary">{organizationName}</span>. Keys work across every application
          in this organization.
        </p>
      </header>

      <ApiKeysPanel />
    </div>
  );
}
