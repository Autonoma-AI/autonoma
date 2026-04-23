import { Badge, Card, CardContent } from "@autonoma/blacklight";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

export type GenerationCardStatus = "pending" | "queued" | "running" | "success" | "failed";

const STATUS_BADGE_VARIANT = {
  pending: "status-pending",
  queued: "status-pending",
  running: "status-running",
  success: "status-passed",
  failed: "status-failed",
} as const;

interface GenerationCardProps {
  generationId: string;
  testCaseName: string;
  status: GenerationCardStatus;
}

export function GenerationCard({ generationId, testCaseName, status }: GenerationCardProps) {
  return (
    <AppLink to="/app/$appSlug/generations/$generationId" params={{ generationId }}>
      <Card variant="raised" size="default" className="transition-colors hover:bg-surface-base">
        <CardContent className="flex items-center justify-between gap-2">
          <span className="truncate font-mono text-sm text-text-primary">{testCaseName}</span>
          <Badge variant={STATUS_BADGE_VARIANT[status]} className="shrink-0">
            {status}
          </Badge>
        </CardContent>
      </Card>
    </AppLink>
  );
}
