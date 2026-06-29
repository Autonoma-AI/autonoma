import { Button, cn } from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { BracketsCurlyIcon } from "@phosphor-icons/react/BracketsCurly";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CubeIcon } from "@phosphor-icons/react/Cube";
import { DatabaseIcon } from "@phosphor-icons/react/Database";
import { GitBranchIcon } from "@phosphor-icons/react/GitBranch";
import { GlobeIcon } from "@phosphor-icons/react/Globe";
import type { Icon } from "@phosphor-icons/react/lib";
import { LightningIcon } from "@phosphor-icons/react/Lightning";
import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useSelectPreviewEnvironmentMode } from "lib/onboarding/onboarding-api";
import { buildOnboardingSearch } from "lib/onboarding/onboarding-search";
import { useApplicationRepositoryFromGitHub } from "lib/query/github.queries";
import { OnboardingPageHeader } from "./-components/onboarding-page-header";

export const Route = createFileRoute("/_blacklight/onboarding/preview-environment")({
  component: () => <Navigate to="/onboarding" search={buildOnboardingSearch("preview-environment")} />,
});

const PREVIEWKIT_BULLETS = [
  "An isolated preview environment for every pull request - your apps and the services they depend on",
  "Prebuilt recipes - Postgres, Redis, Valkey, Temporal",
  "Built, deployed to a live URL, and torn down when the PR merges - no infrastructure for you to run",
];

export function PreviewEnvironmentPage({ appId }: { appId?: string }) {
  const navigate = useNavigate();
  const selectMode = useSelectPreviewEnvironmentMode();
  const { data: repo } = useApplicationRepositoryFromGitHub(appId ?? "");

  function choose(mode: "previewkit" | "existing_deploys") {
    if (appId == null) return;
    selectMode.mutate(
      { applicationId: appId, mode },
      {
        onSuccess: () => {
          void navigate({
            to: "/onboarding",
            search: buildOnboardingSearch(mode === "previewkit" ? "previewkit-config" : "existing-deploys", appId),
          });
        },
      },
    );
  }

  if (appId == null) {
    return <p className="font-mono text-sm text-text-secondary">No application found. Please start from setup.</p>;
  }

  const repoName = repo?.name ?? "your-repo";

  return (
    <>
      <OnboardingPageHeader
        title="Set up your preview environment"
        description={
          <p className="max-w-3xl">
            Autonoma drives a real browser against a live URL for every pull request. We'll spin one up for you - or
            point us at deploys you already run.
          </p>
        }
      />

      <div className="relative">
        <div className="grid overflow-hidden border border-primary-ink shadow-[0_0_24px_var(--accent-glow)] lg:grid-cols-[1.1fr_0.9fr]">
          <div className="flex flex-col p-8">
            <div className="mb-7 flex size-12 items-center justify-center border border-primary-ink text-primary-ink">
              <CubeIcon size={26} weight="duotone" />
            </div>

            <h2 className="text-2xl font-medium text-text-primary">Build with Autonoma PreviewKit</h2>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-text-secondary">
              We deploy your whole stack for every PR - apps, databases, and services included. No infra to run, and
              it's seamless with the Autonoma SDK.
            </p>

            <div className="mt-7 space-y-3">
              {PREVIEWKIT_BULLETS.map((bullet) => (
                <div key={bullet} className="flex items-start gap-2.5">
                  <CheckIcon size={14} weight="bold" className="mt-0.5 shrink-0 text-primary-ink" />
                  <span className="text-sm text-text-secondary">{bullet}</span>
                </div>
              ))}
            </div>

            <Button
              variant="accent"
              className="mt-8 w-fit gap-2 px-6 py-3 font-mono text-sm font-bold uppercase"
              onClick={() => choose("previewkit")}
              disabled={selectMode.isPending}
              aria-label="onboarding-build-with-previewkit"
            >
              Build with PreviewKit
              <ArrowRightIcon size={16} weight="bold" />
            </Button>
          </div>

          <div className="flex flex-col border-t border-border-dim bg-surface-void lg:border-l lg:border-t-0">
            <div className="flex items-center gap-2 border-b border-border-dim px-4 py-2.5">
              <span className="size-1.5 shrink-0 rounded-full bg-primary-ink shadow-[0_0_6px_var(--accent-glow)]" />
              <span className="font-mono text-3xs uppercase tracking-widest text-text-secondary">
                Your stack, per pull request
              </span>
            </div>
            <PreviewTopology repoName={repoName} />
          </div>
        </div>
      </div>

      <div className="mt-6 text-right">
        <p className="font-mono text-2xs text-text-secondary">
          Already have per-branch previews?{" "}
          <button
            type="button"
            onClick={() => choose("existing_deploys")}
            disabled={selectMode.isPending}
            className="text-primary-ink underline underline-offset-4 transition-colors hover:text-primary-ink/80 disabled:opacity-50"
          >
            Continue with custom
          </button>
        </p>
      </div>
    </>
  );
}

interface TopoNode {
  cx: number;
  cy: number;
  icon: Icon;
  title: string;
  subtitle: string;
  accent?: boolean;
  delayMs: number;
  width?: number;
}

const NODE_WIDTH = 150;
const NODE_HEIGHT = 48;
const NODE_MAX_WIDTH = 244;

// Grow the first node for longer repo names, but cap it so it stays tidy.
function repoNodeWidth(title: string): number {
  return Math.min(NODE_MAX_WIDTH, Math.max(NODE_WIDTH, title.length * 7 + 52));
}

// All edges of the graph; the ones flagged `packet` also carry a traveling dot.
const TOPO_EDGES = [
  { path: "M190,71 C190,128 96,118 96,158", packet: 0 },
  { path: "M190,71 C190,128 284,118 284,158", packet: 350 },
  { path: "M96,206 L96,282", packet: 800 },
  { path: "M284,206 L284,282", packet: 1100 },
  { path: "M96,206 C96,255 284,250 284,282" },
  { path: "M284,206 C284,255 96,250 96,282" },
  { path: "M96,330 C96,388 190,388 190,399", packet: 1500 },
  { path: "M284,330 C284,388 190,388 190,399", packet: 1800 },
];

/**
 * SVG/CSS illustration of what PreviewKit spins up for each PR: the repo's PR
 * fans out into app nodes (web, api), each backed by a service (db, cache),
 * meshed and converging into a live preview URL. Nodes are richer cards (icon +
 * title + subtitle) rendered via foreignObject so the SVG connectors still
 * align. Connectors flow and the live node glows; all animation is disabled
 * under prefers-reduced-motion.
 */
function PreviewTopology({ repoName }: { repoName: string }) {
  const nodes: TopoNode[] = [
    {
      cx: 190,
      cy: 46,
      icon: GitBranchIcon,
      title: repoName,
      subtitle: "pull request #12",
      accent: true,
      delayMs: 0,
      width: repoNodeWidth(repoName),
    },
    { cx: 96, cy: 182, icon: GlobeIcon, title: "web", subtitle: "app · :3000", delayMs: 120 },
    { cx: 284, cy: 182, icon: BracketsCurlyIcon, title: "api", subtitle: "app · :4000", delayMs: 180 },
    { cx: 96, cy: 306, icon: DatabaseIcon, title: "db", subtitle: "service · postgres", delayMs: 260 },
    { cx: 284, cy: 306, icon: LightningIcon, title: "cache", subtitle: "service · redis", delayMs: 320 },
  ];

  return (
    <div
      className="flex flex-1 items-center justify-center p-6"
      style={{
        backgroundImage: "radial-gradient(circle at center, rgba(255,255,255,0.04) 1px, transparent 1px)",
        backgroundSize: "16px 16px",
      }}
    >
      <style>{`
        @keyframes topoFlow { to { stroke-dashoffset: -14; } }
        @keyframes topoTravel { from { offset-distance: 0%; opacity: 0; } 12% { opacity: 1; } 88% { opacity: 1; } to { offset-distance: 100%; opacity: 0; } }
        @keyframes topoIn { from { opacity: 0; transform: scale(0.94); } to { opacity: 1; transform: none; } }
        @keyframes topoGlow { 0%, 100% { opacity: 0.1; } 50% { opacity: 0.26; } }
        @keyframes topoDot { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
        .topo-edge { stroke-dasharray: 3 5; animation: topoFlow 1.1s linear infinite; }
        .topo-node { animation: topoIn 0.45s ease-out both; transform-box: fill-box; transform-origin: center; }
        .topo-packet { animation: topoTravel 1.9s linear infinite; }
        .topo-glow { animation: topoGlow 2.4s ease-in-out 0.75s infinite; }
        .topo-dot { animation: topoDot 2s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .topo-edge, .topo-node, .topo-packet, .topo-glow, .topo-dot { animation: none; }
          .topo-packet { display: none; }
        }
      `}</style>
      <svg
        viewBox="0 0 380 472"
        className="h-full max-h-[32rem] w-full"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="PreviewKit deploys this repository's apps and services for every pull request"
      >
        <defs>
          <filter id="topoGlowBlur" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="7" />
          </filter>
        </defs>
        <g fill="none" stroke="var(--primary-ink)" strokeWidth={1.2} opacity={0.5}>
          {TOPO_EDGES.map((edge) => (
            <path key={edge.path} className="topo-edge" d={edge.path} />
          ))}
        </g>

        <g>
          {TOPO_EDGES.filter((edge) => edge.packet != null).map((edge) => (
            <circle
              key={edge.path}
              className="topo-packet"
              r={2.6}
              fill="var(--primary-ink)"
              style={{ offsetPath: `path('${edge.path}')`, animationDelay: `${edge.packet}ms` }}
            />
          ))}
        </g>

        {nodes.map((node) => (
          <TopoCard key={node.title} {...node} />
        ))}

        {/* Live preview URL - the payoff node, with a soft pulsing glow halo. */}
        <rect
          className="topo-glow"
          x={72}
          y={401}
          width={236}
          height={50}
          rx={8}
          fill="var(--primary-ink)"
          filter="url(#topoGlowBlur)"
        />
        <foreignObject
          x={190 - 118}
          y={426 - 25}
          width={236}
          height={50}
          className="topo-node"
          style={{ animationDelay: "400ms", overflow: "visible" }}
        >
          <div className="flex h-full w-full items-center gap-2.5 rounded-md border border-primary-ink bg-surface-base px-3">
            <span className="topo-dot size-2 shrink-0 rounded-full bg-primary-ink shadow-[0_0_6px_var(--accent-glow)]" />
            <div className="flex min-w-0 flex-col">
              <span className="truncate font-mono text-2xs font-medium leading-tight text-primary-ink">
                pr-12.preview.autonoma.app
              </span>
              <span className="truncate font-mono text-3xs leading-tight text-text-secondary">preview live</span>
            </div>
          </div>
        </foreignObject>
      </svg>
    </div>
  );
}

function TopoCard({ cx, cy, icon: NodeIcon, title, subtitle, accent, delayMs, width = NODE_WIDTH }: TopoNode) {
  return (
    <foreignObject
      x={cx - width / 2}
      y={cy - NODE_HEIGHT / 2}
      width={width}
      height={NODE_HEIGHT}
      className="topo-node"
      style={{ animationDelay: `${delayMs}ms`, overflow: "visible" }}
    >
      <div
        className={cn(
          "flex h-full w-full items-center gap-2.5 rounded-md border bg-surface-base px-3",
          accent ? "border-primary-ink" : "border-border-mid",
        )}
      >
        <NodeIcon
          size={16}
          weight="duotone"
          className={cn("shrink-0", accent ? "text-primary-ink" : "text-text-secondary")}
        />
        <div className="flex min-w-0 flex-col">
          <span
            className={cn(
              "truncate font-mono text-xs font-medium leading-tight",
              accent ? "text-primary-ink" : "text-text-primary",
            )}
          >
            {title}
          </span>
          <span className="truncate font-mono text-3xs leading-tight text-text-secondary">{subtitle}</span>
        </div>
      </div>
    </foreignObject>
  );
}
