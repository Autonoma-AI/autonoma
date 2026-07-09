import { LightningIcon } from "@phosphor-icons/react/Lightning";
import { createFileRoute } from "@tanstack/react-router";
import { AppLink } from "../../-app-link";
import { useCurrentApplication } from "../../-use-current-application";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/admin/")({
  component: AppAdminPage,
});

function AppAdminPage() {
  const app = useCurrentApplication();

  return (
    <div className="flex flex-col gap-6 p-6 lg:p-8">
      <header>
        <h1 className="text-2xl font-medium tracking-tight text-text-primary">App admin</h1>
        <p className="mt-1 font-mono text-xs text-text-secondary">
          Internal tools for {app.name}. Temporary - will move into the regular UI as proper scoped views land.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <AdminCard
          to="/app/$appSlug/admin/generations"
          icon={<LightningIcon size={18} className="text-text-tertiary" />}
          title="Generations"
          description="Every test generation for this app."
        />
      </div>
    </div>
  );
}

interface AdminCardProps {
  to: "/app/$appSlug/admin/generations";
  icon: React.ReactNode;
  title: string;
  description: string;
}

function AdminCard({ to, icon, title, description }: AdminCardProps) {
  return (
    <AppLink
      to={to}
      className="flex flex-col gap-2 border border-border-dim bg-surface-base p-4 transition-colors hover:bg-surface-raised"
    >
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-sm font-medium text-text-primary">{title}</span>
      </div>
      <span className="text-xs text-text-secondary">{description}</span>
    </AppLink>
  );
}
