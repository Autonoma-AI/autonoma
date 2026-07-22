import { Bug } from "@phosphor-icons/react/Bug";
import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { Clock } from "@phosphor-icons/react/Clock";
import { Code } from "@phosphor-icons/react/Code";
import { Copy } from "@phosphor-icons/react/Copy";
import { Eye } from "@phosphor-icons/react/Eye";
import { FileCode } from "@phosphor-icons/react/FileCode";
import { Gear } from "@phosphor-icons/react/Gear";
import { GitBranch } from "@phosphor-icons/react/GitBranch";
import { Globe } from "@phosphor-icons/react/Globe";
import { Heartbeat } from "@phosphor-icons/react/Heartbeat";
import type { Icon } from "@phosphor-icons/react/lib";
import { Lightning } from "@phosphor-icons/react/Lightning";
import { Lock } from "@phosphor-icons/react/Lock";
import { MagnifyingGlass } from "@phosphor-icons/react/MagnifyingGlass";
import { Play } from "@phosphor-icons/react/Play";
import { Pulse } from "@phosphor-icons/react/Pulse";
import { Robot } from "@phosphor-icons/react/Robot";
import { Rocket } from "@phosphor-icons/react/Rocket";
import { Shield } from "@phosphor-icons/react/Shield";
import { Terminal } from "@phosphor-icons/react/Terminal";
import { Trash } from "@phosphor-icons/react/Trash";
import { Upload } from "@phosphor-icons/react/Upload";
import { Warning } from "@phosphor-icons/react/Warning";
import { XCircle } from "@phosphor-icons/react/XCircle";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardLabel,
  CardMeta,
  CardTitle,
  CardValue,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Logo } from "./components/logo";

const ICON_CATALOG: Array<{ name: string; icon: Icon }> = [
  { name: "Play", icon: Play },
  { name: "Bug", icon: Bug },
  { name: "Robot", icon: Robot },
  { name: "Terminal", icon: Terminal },
  { name: "Code", icon: Code },
  { name: "Globe", icon: Globe },
  { name: "Eye", icon: Eye },
  { name: "Shield", icon: Shield },
  { name: "Lightning", icon: Lightning },
  { name: "Rocket", icon: Rocket },
  { name: "Gear", icon: Gear },
  { name: "Lock", icon: Lock },
  { name: "Clock", icon: Clock },
  { name: "GitBranch", icon: GitBranch },
  { name: "MagnifyingGlass", icon: MagnifyingGlass },
  { name: "Copy", icon: Copy },
  { name: "Upload", icon: Upload },
  { name: "Trash", icon: Trash },
  { name: "CheckCircle", icon: CheckCircle },
  { name: "XCircle", icon: XCircle },
  { name: "Warning", icon: Warning },
  { name: "Heartbeat", icon: Heartbeat },
  { name: "Pulse", icon: Pulse },
  { name: "FileCode", icon: FileCode },
];

export function App() {
  return (
    <TooltipProvider>
      <div className="min-h-screen bg-background p-8 text-foreground">
        <div className="mx-auto flex max-w-4xl flex-col gap-10">
          {/* Header */}
          <div>
            <h1 className="text-lg font-semibold">Blacklight Design System</h1>
            <p className="text-sm text-muted-foreground">Styled primitives for the Command Center dashboard</p>
          </div>

          <Separator />

          {/* ── Buttons ── */}
          <section className="flex flex-col gap-4">
            <h2 className="text-2xs font-semibold uppercase tracking-widest text-text-tertiary">Buttons</h2>
            <div className="flex flex-wrap items-center gap-3">
              <Button>Default</Button>
              <Button variant="accent">Accent</Button>
              <Button variant="cta" size="lg">
                Pause Agent
              </Button>
              <Button variant="outline">Outline</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="destructive">Destructive</Button>
              <Button variant="link">Link</Button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="xs">XS</Button>
              <Button size="sm">SM</Button>
              <Button size="default">Default</Button>
              <Button size="lg">LG</Button>
            </div>
          </section>

          <Separator />

          {/* ── Badges ── */}
          <section className="flex flex-col gap-4">
            <h2 className="text-2xs font-semibold uppercase tracking-widest text-text-tertiary">Badges</h2>
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-24 text-xs text-text-secondary">Base:</span>
                <Badge>Default</Badge>
                <Badge variant="secondary">Secondary</Badge>
                <Badge variant="destructive">Destructive</Badge>
                <Badge variant="outline">Outline</Badge>
                <Badge variant="ghost">Ghost</Badge>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-24 text-xs text-text-secondary">Severity:</span>
                <Badge variant="critical">Critical</Badge>
                <Badge variant="high">High</Badge>
                <Badge variant="warn">Warn</Badge>
                <Badge variant="success">Success</Badge>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-24 text-xs text-text-secondary">Status:</span>
                <Badge variant="status-passed">Passed</Badge>
                <Badge variant="status-failed">Failed</Badge>
                <Badge variant="status-running">Running</Badge>
                <Badge variant="status-pending">Pending</Badge>
              </div>
            </div>
          </section>

          <Separator />

          {/* ── Cards ── */}
          <section className="flex flex-col gap-4">
            <h2 className="text-2xs font-semibold uppercase tracking-widest text-text-tertiary">Cards</h2>
            <div className="grid grid-cols-3 gap-4">
              <Card variant="default">
                <CardHeader>
                  <CardTitle>Default Card</CardTitle>
                  <CardDescription>Surface base background</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground">Content area with standard padding.</p>
                </CardContent>
              </Card>

              <Card variant="glass">
                <CardHeader>
                  <CardTitle>Glass Card</CardTitle>
                  <CardDescription>Backdrop blur for HUD overlays</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground">Semi-transparent with blur.</p>
                </CardContent>
              </Card>

              <Card variant="raised">
                <CardHeader>
                  <CardTitle>Raised Card</CardTitle>
                  <CardDescription>Elevated surface</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground">Higher contrast background.</p>
                </CardContent>
              </Card>
            </div>

            {/* Stat cards */}
            <h3 className="text-3xs font-semibold uppercase tracking-widest text-text-tertiary">Stat Cards</h3>
            <div className="grid grid-cols-4 gap-4">
              <Card variant="stat" size="compact">
                <CardContent className="p-4">
                  <CardLabel>Bugs Found</CardLabel>
                  <CardValue>142</CardValue>
                  <CardMeta className="text-status-success">+12% vs last run</CardMeta>
                </CardContent>
              </Card>
              <Card variant="stat" size="compact">
                <CardContent className="p-4">
                  <CardLabel>Tests Gen</CardLabel>
                  <CardValue>4,096</CardValue>
                  <CardMeta>Coverage: 94.2%</CardMeta>
                </CardContent>
              </Card>
              <Card variant="stat" size="compact">
                <CardContent className="p-4">
                  <CardLabel>Files Scanned</CardLabel>
                  <CardValue>892</CardValue>
                  <CardMeta>/src/components</CardMeta>
                </CardContent>
              </Card>
              <Card variant="stat" size="compact">
                <CardContent className="p-4">
                  <CardLabel>Avg Runtime</CardLabel>
                  <CardValue>1.4s</CardValue>
                  <CardMeta className="text-status-warn">Optimized</CardMeta>
                </CardContent>
              </Card>
            </div>

            {/* Card with footer */}
            <Card>
              <CardHeader>
                <CardTitle>Card with Footer</CardTitle>
                <CardDescription>Demonstrating all sub-components</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">Main content area.</p>
              </CardContent>
              <CardFooter>
                <Button variant="ghost" size="sm">
                  Cancel
                </Button>
                <Button size="sm" className="ml-auto">
                  Save
                </Button>
              </CardFooter>
            </Card>
          </section>

          <Separator />

          {/* ── Input ── */}
          <section className="flex flex-col gap-4">
            <h2 className="text-2xs font-semibold uppercase tracking-widest text-text-tertiary">Input</h2>
            <div className="grid max-w-md grid-cols-1 gap-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="repository-endpoint" className="text-3xs uppercase text-text-secondary">
                  Repository Endpoint
                </label>
                <Input placeholder="autonoma-ai/core-engine" />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="access-token" className="text-3xs uppercase text-text-secondary">
                  Access Token (Encrypted)
                </label>
                <Input type="password" defaultValue="secrettoken123456" />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="branch-filters" className="text-3xs uppercase text-text-secondary">
                  Branch Filters (Regex)
                </label>
                <Input defaultValue="^(feat|fix|hotfix)/.*" />
              </div>
            </div>
          </section>

          <Separator />

          {/* ── Progress ── */}
          <section className="flex flex-col gap-4">
            <h2 className="text-2xs font-semibold uppercase tracking-widest text-text-tertiary">Progress</h2>
            <div className="flex max-w-md flex-col gap-4">
              <Progress value={75}>
                <ProgressLabel>CPU Usage</ProgressLabel>
                <ProgressValue />
              </Progress>
              <Progress value={48}>
                <ProgressLabel>Memory</ProgressLabel>
                <ProgressValue />
              </Progress>
              <Progress value={94}>
                <ProgressLabel>Coverage</ProgressLabel>
                <ProgressValue />
              </Progress>
            </div>
          </section>

          <Separator />

          {/* ── Tabs ── */}
          <section className="flex flex-col gap-4">
            <h2 className="text-2xs font-semibold uppercase tracking-widest text-text-tertiary">Tabs</h2>

            <div className="flex flex-col gap-6">
              <div>
                <p className="mb-2 text-3xs uppercase text-text-secondary">Line variant (workflow track style)</p>
                <Tabs defaultValue="execute">
                  <TabsList variant="line">
                    <TabsTrigger value="scan">01 Scan</TabsTrigger>
                    <TabsTrigger value="plan">02 Plan</TabsTrigger>
                    <TabsTrigger value="execute">03 Execute</TabsTrigger>
                    <TabsTrigger value="results">04 Results</TabsTrigger>
                  </TabsList>
                  <TabsContent value="scan">
                    <p className="pt-4 text-xs text-muted-foreground">Scanning phase content...</p>
                  </TabsContent>
                  <TabsContent value="plan">
                    <p className="pt-4 text-xs text-muted-foreground">Planning phase content...</p>
                  </TabsContent>
                  <TabsContent value="execute">
                    <p className="pt-4 text-xs text-muted-foreground">Execution phase content...</p>
                  </TabsContent>
                  <TabsContent value="results">
                    <p className="pt-4 text-xs text-muted-foreground">Results phase content...</p>
                  </TabsContent>
                </Tabs>
              </div>

              <div>
                <p className="mb-2 text-3xs uppercase text-text-secondary">Default variant</p>
                <Tabs defaultValue="dashboard">
                  <TabsList>
                    <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
                    <TabsTrigger value="settings">Settings</TabsTrigger>
                    <TabsTrigger value="logs">Logs</TabsTrigger>
                  </TabsList>
                  <TabsContent value="dashboard">
                    <p className="pt-4 text-xs text-muted-foreground">Dashboard content...</p>
                  </TabsContent>
                  <TabsContent value="settings">
                    <p className="pt-4 text-xs text-muted-foreground">Settings content...</p>
                  </TabsContent>
                  <TabsContent value="logs">
                    <p className="pt-4 text-xs text-muted-foreground">Logs content...</p>
                  </TabsContent>
                </Tabs>
              </div>
            </div>
          </section>

          <Separator />

          {/* ── Switch ── */}
          <section className="flex flex-col gap-4">
            <h2 className="text-2xs font-semibold uppercase tracking-widest text-text-tertiary">Switch</h2>
            <div className="flex max-w-md flex-col gap-4">
              <div className="flex items-center justify-between border-b border-border-dim pb-3">
                <div>
                  <div className="text-sm font-medium">Push to Main</div>
                  <div className="text-2xs text-text-tertiary">Execute scan on every merge</div>
                </div>
                <Switch defaultChecked />
              </div>
              <div className="flex items-center justify-between border-b border-border-dim pb-3">
                <div>
                  <div className="text-sm font-medium">Pull Request Sync</div>
                  <div className="text-2xs text-text-tertiary">Scan PRs before merge approval</div>
                </div>
                <Switch defaultChecked />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">Notifications</div>
                  <div className="text-2xs text-text-tertiary">Send alerts on failure</div>
                </div>
                <Switch />
              </div>
            </div>
          </section>

          <Separator />

          {/* ── Tooltip ── */}
          <section className="flex flex-col gap-4">
            <h2 className="text-2xs font-semibold uppercase tracking-widest text-text-tertiary">Tooltip</h2>
            <div className="flex gap-4">
              <Tooltip>
                <TooltipTrigger className={buttonVariants({ variant: "outline", size: "sm" })}>Hover me</TooltipTrigger>
                <TooltipContent>Mono-font tooltip with dark surface</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger className={buttonVariants({ variant: "ghost", size: "icon" })}>?</TooltipTrigger>
                <TooltipContent>PID: 9942-X</TooltipContent>
              </Tooltip>
            </div>
          </section>

          <Separator />

          {/* ── Color Palette ── */}
          <section className="flex flex-col gap-4">
            <h2 className="text-2xs font-semibold uppercase tracking-widest text-text-tertiary">Color Palette</h2>
            <div className="flex flex-col gap-3">
              <div className="flex gap-2">
                <div className="flex flex-col items-center gap-1">
                  <div className="size-10 border border-border-dim bg-surface-void" />
                  <span className="font-mono text-4xs text-text-tertiary">void</span>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <div className="size-10 border border-border-dim bg-surface-base" />
                  <span className="font-mono text-4xs text-text-tertiary">base</span>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <div className="size-10 border border-border-dim bg-surface-raised" />
                  <span className="font-mono text-4xs text-text-tertiary">raised</span>
                </div>
                <div className="mx-2" />
                <div className="flex flex-col items-center gap-1">
                  <div className="size-10 border border-border-dim bg-border-dim" />
                  <span className="font-mono text-4xs text-text-tertiary">dim</span>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <div className="size-10 border border-border-dim bg-border-mid" />
                  <span className="font-mono text-4xs text-text-tertiary">mid</span>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <div className="size-10 border border-border-dim bg-border-highlight" />
                  <span className="font-mono text-4xs text-text-tertiary">highlight</span>
                </div>
                <div className="mx-2" />
                <div className="flex flex-col items-center gap-1">
                  <div className="size-10 bg-primary" />
                  <span className="font-mono text-4xs text-text-tertiary">accent</span>
                </div>
              </div>
              <div className="flex gap-2">
                <div className="flex flex-col items-center gap-1">
                  <div className="size-10 bg-status-critical" />
                  <span className="font-mono text-4xs text-text-tertiary">critical</span>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <div className="size-10 bg-status-high" />
                  <span className="font-mono text-4xs text-text-tertiary">high</span>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <div className="size-10 bg-status-warn" />
                  <span className="font-mono text-4xs text-text-tertiary">warn</span>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <div className="size-10 bg-status-success" />
                  <span className="font-mono text-4xs text-text-tertiary">success</span>
                </div>
              </div>
            </div>
          </section>

          <Separator />

          {/* ── Typography ── */}
          <section className="flex flex-col gap-4">
            <h2 className="text-2xs font-semibold uppercase tracking-widest text-text-tertiary">Typography</h2>
            <div className="flex flex-col gap-2">
              <p className="text-text-primary">Primary text - DM Sans (body content)</p>
              <p className="text-text-secondary">Secondary text - DM Sans (descriptions)</p>
              <p className="text-text-tertiary">Tertiary text - DM Sans (muted labels)</p>
              <p className="font-mono text-text-primary">Mono text - Geist Mono (data values, code)</p>
              <p className="font-mono text-2xl text-text-primary">4,096</p>
              <p className="font-mono text-3xs text-text-tertiary">10:42:05 AM - PID: 9942-X</p>
            </div>
          </section>

          <Separator />

          {/* ── Icons (Phosphor) ── */}
          <section className="flex flex-col gap-4">
            <div>
              <h2 className="text-2xs font-semibold uppercase tracking-widest text-text-tertiary">Icons</h2>
              <p className="mt-1 text-xs text-text-secondary">Phosphor Icons - consistent, flexible icon set</p>
            </div>

            {/* Icon grid */}
            <div className="grid grid-cols-6 gap-3">
              {ICON_CATALOG.map(({ name, icon: IconComponent }) => (
                <Tooltip key={name}>
                  <TooltipTrigger>
                    <div className="flex flex-col items-center gap-2 overflow-hidden border border-border-dim p-3 transition-colors hover:border-border-highlight hover:bg-surface-raised">
                      <IconComponent className="size-5 shrink-0 text-text-primary" />
                      <span className="w-full truncate text-center font-mono text-4xs text-text-tertiary">{name}</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>{name}</TooltipContent>
                </Tooltip>
              ))}
            </div>

            {/* Icon weights */}
            <h3 className="text-3xs font-semibold uppercase tracking-widest text-text-tertiary">Weights</h3>
            <div className="flex items-center gap-6">
              {(["thin", "light", "regular", "bold", "fill", "duotone"] as const).map((weight) => (
                <div key={weight} className="flex flex-col items-center gap-2">
                  <Robot className="size-6 text-text-primary" weight={weight} />
                  <span className="font-mono text-4xs text-text-tertiary">{weight}</span>
                </div>
              ))}
            </div>

            {/* Icon sizes */}
            <h3 className="text-3xs font-semibold uppercase tracking-widest text-text-tertiary">Sizes</h3>
            <div className="flex items-end gap-6">
              {(
                [
                  { cls: "size-3", label: "12" },
                  { cls: "size-4", label: "16" },
                  { cls: "size-5", label: "20" },
                  { cls: "size-6", label: "24" },
                  { cls: "size-8", label: "32" },
                ] as const
              ).map(({ cls, label }) => (
                <div key={label} className="flex flex-col items-center gap-2">
                  <Lightning className={`${cls} text-primary-ink`} weight="fill" />
                  <span className="font-mono text-4xs text-text-tertiary">{label}</span>
                </div>
              ))}
            </div>
          </section>

          <Separator />

          {/* ── Logo Variants ── */}
          <section className="flex flex-col gap-4">
            <h2 className="text-2xs font-semibold uppercase tracking-widest text-text-tertiary">Logo Variants</h2>

            <h3 className="text-3xs font-semibold uppercase tracking-widest text-text-tertiary">Wordmark</h3>
            <div className="flex flex-wrap items-center gap-6">
              <Logo variant="wordmark" className="text-lg" strokeWidth={2} />
              <Logo variant="wordmark" color="var(--primary)" className="text-lg" strokeWidth={2} />
              <Logo variant="wordmark" color="white" className="text-sm" strokeWidth={3} />
            </div>

            <h3 className="text-3xs font-semibold uppercase tracking-widest text-text-tertiary">Stroke Width</h3>
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex flex-col items-center gap-1">
                <Logo className="size-10" />
                <span className="font-mono text-4xs text-text-tertiary">1x</span>
              </div>
              <div className="flex flex-col items-center gap-1">
                <Logo className="size-10" strokeWidth={1.5} />
                <span className="font-mono text-4xs text-text-tertiary">1.5x</span>
              </div>
              <div className="flex flex-col items-center gap-1">
                <Logo className="size-10" strokeWidth={2} />
                <span className="font-mono text-4xs text-text-tertiary">2x</span>
              </div>
              <div className="flex flex-col items-center gap-1">
                <Logo className="size-10" strokeWidth={3} />
                <span className="font-mono text-4xs text-text-tertiary">3x</span>
              </div>
            </div>
          </section>

          <Separator />

          {/* ── Buttons with Icons ── */}
          <section className="flex flex-col gap-4">
            <h2 className="text-2xs font-semibold uppercase tracking-widest text-text-tertiary">Buttons with Icons</h2>

            {/* Leading icon */}
            <h3 className="text-3xs font-semibold uppercase tracking-widest text-text-tertiary">Leading Icon</h3>
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="default">
                <Logo color="black" strokeWidth={2.5} variant="wordmark" />
              </Button>
              <Button>
                <Play data-icon="inline-start" weight="fill" />
                Run Test
              </Button>
              <Button variant="accent">
                <Rocket data-icon="inline-start" weight="fill" />
                Deploy
              </Button>
              <Button variant="outline">
                <GitBranch data-icon="inline-start" />
                Branch
              </Button>
              <Button variant="secondary">
                <Gear data-icon="inline-start" />
                Settings
              </Button>
              <Button variant="ghost">
                <Eye data-icon="inline-start" />
                Preview
              </Button>
              <Button variant="destructive">
                <Trash data-icon="inline-start" />
                Delete
              </Button>
            </div>

            {/* Trailing icon */}
            <h3 className="text-3xs font-semibold uppercase tracking-widest text-text-tertiary">Trailing Icon</h3>
            <div className="flex flex-wrap items-center gap-3">
              <Button>
                Upload
                <Upload data-icon="inline-end" />
              </Button>
              <Button variant="outline">
                Copy
                <Copy data-icon="inline-end" />
              </Button>
              <Button variant="secondary">
                Terminal
                <Terminal data-icon="inline-end" />
              </Button>
            </div>

            {/* Icon-only buttons */}
            <h3 className="text-3xs font-semibold uppercase tracking-widest text-text-tertiary">Icon Only</h3>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="icon-xs" variant="ghost">
                <Copy />
              </Button>
              <Button size="icon-sm" variant="ghost">
                <MagnifyingGlass />
              </Button>
              <Button size="icon" variant="outline">
                <Gear />
              </Button>
              <Button size="icon-lg" variant="default">
                <Play weight="fill" />
              </Button>
              <Button size="icon" variant="destructive">
                <Trash />
              </Button>
              <Button size="icon" variant="accent">
                <Lightning weight="fill" />
              </Button>
            </div>

            {/* Size variants with icons */}
            <h3 className="text-3xs font-semibold uppercase tracking-widest text-text-tertiary">Sizes with Icons</h3>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="xs">
                <Bug data-icon="inline-start" />
                XS
              </Button>
              <Button size="sm">
                <Bug data-icon="inline-start" />
                SM
              </Button>
              <Button size="default">
                <Bug data-icon="inline-start" />
                Default
              </Button>
              <Button size="lg">
                <Bug data-icon="inline-start" />
                LG
              </Button>
            </div>
          </section>

          <div className="h-16" />
        </div>
      </div>
    </TooltipProvider>
  );
}

export default App;
