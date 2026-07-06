import { Badge, BrailleSpinner, Button, cn } from "@autonoma/blacklight";
import type {
  DiagnosePreviewkitDeployResult,
  PreviewDiagnosisCategory,
  PreviewDiagnosisFinding,
} from "@autonoma/types";
import { KeyIcon } from "@phosphor-icons/react/Key";
import { LifebuoyIcon } from "@phosphor-icons/react/Lifebuoy";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { SparkleIcon } from "@phosphor-icons/react/Sparkle";
import { WrenchIcon } from "@phosphor-icons/react/Wrench";

interface AiDiagnosisPanelProps {
  diagnosis?: DiagnosePreviewkitDeployResult;
  isPending: boolean;
  /** Apply a `missing_env_var` finding's suggested vars via the config env-accept flow. */
  onApplyFix: (finding: PreviewDiagnosisFinding) => void;
  onEditConfig: (finding: PreviewDiagnosisFinding) => void;
  onEditSecrets: (finding: PreviewDiagnosisFinding) => void;
  onCopyForSupport: () => void;
}

const CATEGORY_META: Record<
  PreviewDiagnosisCategory,
  { label: string; Icon: typeof SparkleIcon; badge: "warn" | "critical" | "high" | "secondary" }
> = {
  missing_env_var: { label: "Missing env var", Icon: KeyIcon, badge: "warn" },
  user_setup: { label: "Setup issue", Icon: WrenchIcon, badge: "high" },
  autonoma_error: { label: "Autonoma platform issue", Icon: LifebuoyIcon, badge: "critical" },
  unknown: { label: "Needs investigation", Icon: SparkleIcon, badge: "secondary" },
};

export function AiDiagnosisPanel({
  diagnosis,
  isPending,
  onApplyFix,
  onEditConfig,
  onEditSecrets,
  onCopyForSupport,
}: AiDiagnosisPanelProps) {
  if (isPending) {
    return (
      <div className="mt-5 flex items-center gap-3 border border-border-dim bg-surface-raised px-4 py-3">
        <BrailleSpinner animation="orbit" size="md" />
        <div>
          <p className="text-sm font-medium text-text-primary">Analyzing this failure with AI</p>
          <p className="mt-1 text-xs text-text-secondary">Reading the deploy state and logs to find the cause.</p>
        </div>
      </div>
    );
  }

  const findings = diagnosis?.status === "ok" ? diagnosis.findings : [];
  if (findings.length === 0) return undefined;

  return (
    <div className="mt-5 space-y-3">
      <div className="flex items-center gap-2">
        <SparkleIcon size={15} weight="duotone" className="text-primary-ink" />
        <p className="font-mono text-2xs uppercase tracking-widest text-text-secondary">AI diagnosis</p>
      </div>
      {diagnosis?.summary != null ? <p className="text-sm text-text-secondary">{diagnosis.summary}</p> : undefined}
      {findings.map((finding, index) => (
        <FindingCard
          key={`${finding.category}:${finding.appName ?? ""}:${finding.title}:${index}`}
          finding={finding}
          onApplyFix={() => onApplyFix(finding)}
          onEditConfig={() => onEditConfig(finding)}
          onEditSecrets={() => onEditSecrets(finding)}
          onCopyForSupport={onCopyForSupport}
        />
      ))}
    </div>
  );
}

function FindingCard({
  finding,
  onApplyFix,
  onEditConfig,
  onEditSecrets,
  onCopyForSupport,
}: {
  finding: PreviewDiagnosisFinding;
  onApplyFix: () => void;
  onEditConfig: () => void;
  onEditSecrets: () => void;
  onCopyForSupport: () => void;
}) {
  const meta = CATEGORY_META[finding.category];
  const canApplyFix = finding.category === "missing_env_var" && (finding.suggestedEnv?.length ?? 0) > 0;

  return (
    <div
      className={cn(
        "border-l-2 bg-surface-raised px-4 py-3",
        finding.category === "autonoma_error" ? "border-status-critical" : "border-primary-ink/40",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={meta.badge} className="gap-1">
          <meta.Icon size={11} weight="bold" />
          {meta.label}
        </Badge>
        {finding.appName != null ? (
          <span className="font-mono text-2xs text-text-secondary">{finding.appName}</span>
        ) : undefined}
        <span className="ml-auto font-mono text-3xs uppercase tracking-wider text-text-secondary">
          {finding.confidence} confidence
        </span>
      </div>

      <p className="mt-2 text-sm font-medium text-text-primary">{finding.title}</p>
      <p className="mt-1 text-sm text-text-secondary">{finding.explanation}</p>

      {finding.fixSteps.length > 0 ? (
        <ol className="mt-3 list-decimal space-y-1 pl-5">
          {finding.fixSteps.map((step, index) => (
            <li key={index} className="text-xs text-text-secondary">
              {step}
            </li>
          ))}
        </ol>
      ) : undefined}

      {finding.category === "missing_env_var" && (finding.suggestedEnv?.length ?? 0) > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {finding.suggestedEnv?.map((envVar) => (
            <Badge key={envVar.key} variant="outline" className="font-mono">
              {envVar.key}
            </Badge>
          ))}
        </div>
      ) : undefined}

      <div className="mt-3 flex flex-wrap gap-2">
        {canApplyFix ? (
          <Button variant="accent" size="xs" className="gap-1" onClick={onApplyFix}>
            <SparkleIcon size={12} weight="bold" />
            Apply fix
          </Button>
        ) : undefined}
        {finding.category === "missing_env_var" ? (
          <Button variant="outline" size="xs" className="gap-1" onClick={onEditSecrets}>
            <KeyIcon size={12} />
            Edit secrets
          </Button>
        ) : undefined}
        {finding.category === "user_setup" && finding.appName != null ? (
          <Button variant="outline" size="xs" className="gap-1" onClick={onEditConfig}>
            <PencilSimpleIcon size={12} />
            Fix in config
          </Button>
        ) : undefined}
        {finding.category === "autonoma_error" ? (
          <Button variant="outline" size="xs" className="gap-1" onClick={onCopyForSupport}>
            <LifebuoyIcon size={12} />
            Copy for support
          </Button>
        ) : undefined}
      </div>
    </div>
  );
}
