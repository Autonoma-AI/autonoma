import { Area, AreaChart, Bar, BarChart, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
} from "@/components/ui/data-table";
import { MetricCard, MetricLabel, MetricTrend, MetricUnit, MetricValue } from "@/components/ui/metric-card";
import { Panel, PanelBody, PanelHeader, PanelTitle } from "@/components/ui/panel";
import { Sparkline } from "@/components/ui/sparkline";
import { StatusDot } from "@/components/ui/status-dot";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

/* ═══════════════════════════════════════════
   Mock data
   ═══════════════════════════════════════════ */

const TRAFFIC_DATA = [
  { time: "00:00", ingress: 120, egress: 150 },
  { time: "03:00", ingress: 90, egress: 140 },
  { time: "06:00", ingress: 110, egress: 160 },
  { time: "09:00", ingress: 180, egress: 120 },
  { time: "12:00", ingress: 160, egress: 130 },
  { time: "15:00", ingress: 200, egress: 100 },
  { time: "18:00", ingress: 140, egress: 140 },
  { time: "21:00", ingress: 190, egress: 110 },
  { time: "24:00", ingress: 170, egress: 120 },
];

const HISTOGRAM_DATA = [
  { bin: "0", count: 30 },
  { bin: "64", count: 60 },
  { bin: "128", count: 100 },
  { bin: "256", count: 130 },
  { bin: "384", count: 110 },
  { bin: "512", count: 80 },
  { bin: "640", count: 50 },
  { bin: "768", count: 35 },
  { bin: "896", count: 20 },
  { bin: "1024", count: 10 },
  { bin: "1024+", count: 5 },
];

const ERROR_RATE_DATA = [
  { time: "T-12H", requests: 100, errors: 8 },
  { time: "T-10H", requests: 120, errors: 12 },
  { time: "T-8H", requests: 80, errors: 5 },
  { time: "T-6H", requests: 130, errors: 18 },
  { time: "T-4H", requests: 110, errors: 14 },
  { time: "T-2H", requests: 140, errors: 30 },
  { time: "T-1H", requests: 115, errors: 20 },
  { time: "T-30M", requests: 90, errors: 12 },
  { time: "NOW", requests: 125, errors: 40 },
];

const NODE_DATA = [
  { id: "EU-WEST-01", status: "success" as const, cpu: 42.5, spark: [15, 12, 16, 8, 10, 4, 6] },
  { id: "US-EAST-04", status: "warn" as const, cpu: 78.2, spark: [20, 18, 10, 12, 5, 2, 4] },
  { id: "AP-SOUTH-02", status: "success" as const, cpu: 31.0, spark: [10, 12, 11, 9, 10, 11, 10] },
  { id: "US-WEST-01", status: "critical" as const, cpu: 94.8, spark: [15, 8, 10, 4, 2, 0, 1] },
  { id: "EU-CENT-03", status: "success" as const, cpu: 55.1, spark: [10, 15, 8, 12, 6, 8, 5] },
];

/* ═══════════════════════════════════════════
   Chart configs
   ═══════════════════════════════════════════ */

const trafficConfig = {
  ingress: { label: "Ingress", color: "var(--chart-1)" },
  egress: { label: "Egress", color: "var(--chart-2)" },
} satisfies ChartConfig;

const histogramConfig = {
  count: { label: "Frequency", color: "var(--chart-1)" },
} satisfies ChartConfig;

const errorConfig = {
  requests: { label: "Requests", color: "var(--border-mid)" },
  errors: { label: "Errors", color: "var(--chart-3)" },
} satisfies ChartConfig;

/* ═══════════════════════════════════════════
   Helper: CPU color
   ═══════════════════════════════════════════ */

function cpuColor(cpu: number): string | undefined {
  if (cpu >= 90) return "var(--status-critical)";
  if (cpu >= 70) return "var(--status-warn)";
  return undefined;
}

function sparkColor(status: "success" | "warn" | "critical" | "neutral"): string {
  if (status === "critical") return "var(--status-critical)";
  if (status === "warn") return "var(--status-warn)";
  return "var(--text-secondary)";
}

/* ═══════════════════════════════════════════
   Axis tick styles
   ═══════════════════════════════════════════ */

const AXIS_TICK = {
  fill: "var(--text-tertiary)",
  fontFamily: "var(--font-mono)",
  fontSize: 9,
};

/* ═══════════════════════════════════════════
   Page component
   ═══════════════════════════════════════════ */

export function TelemetryPage() {
  return (
    <div className="min-h-screen bg-surface-void p-6 text-foreground">
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        {/* Header */}
        <header className="flex items-end justify-between border-b border-border-dim pb-5 font-mono text-4xs uppercase tracking-widest text-text-tertiary">
          <div>
            <div className="mb-1 text-text-secondary">FILE_REF: ANL_SYS_V3.1.OBJ</div>
            <div className="text-sm font-bold tracking-wider text-text-primary">TELEMETRY_DASHBOARD</div>
          </div>
          <span>{"FREQ: 550NM // STAT: ACTIVE"}</span>
        </header>

        {/* Metrics row */}
        <Panel>
          <PanelBody className="px-8 py-6">
            <div className="grid grid-cols-3 gap-8">
              <MetricCard>
                <MetricLabel>
                  <span>Total Throughput</span>
                  <MetricTrend direction="up" value="14.2%" />
                </MetricLabel>
                <MetricValue>
                  842,091
                  <MetricUnit>REQ</MetricUnit>
                </MetricValue>
              </MetricCard>
              <MetricCard>
                <MetricLabel>
                  <span>Avg Latency (P99)</span>
                  <MetricTrend direction="down" value="2.1%" />
                </MetricLabel>
                <MetricValue className="text-status-critical">
                  124
                  <MetricUnit>MS</MetricUnit>
                </MetricValue>
              </MetricCard>
              <MetricCard>
                <MetricLabel>
                  <span>Active Nodes</span>
                  <MetricTrend direction="neutral" value="0.0%" />
                </MetricLabel>
                <MetricValue>
                  48
                  <MetricUnit>/50</MetricUnit>
                </MetricValue>
              </MetricCard>
            </div>
          </PanelBody>
        </Panel>

        {/* Charts row */}
        <div className="grid grid-cols-12 gap-6">
          {/* Area chart */}
          <Panel className="col-span-8">
            <PanelHeader>
              <PanelTitle>Network Ingress/Egress</PanelTitle>
              <Tabs defaultValue="24h">
                <TabsList variant="line">
                  <TabsTrigger value="1h">1H</TabsTrigger>
                  <TabsTrigger value="24h">24H</TabsTrigger>
                  <TabsTrigger value="7d">7D</TabsTrigger>
                  <TabsTrigger value="30d">30D</TabsTrigger>
                </TabsList>
              </Tabs>
            </PanelHeader>
            <PanelBody>
              <ChartContainer config={trafficConfig} className="aspect-auto h-52 w-full">
                <AreaChart data={TRAFFIC_DATA} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="grad-ingress" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-ingress)" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="var(--color-ingress)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="2 4" stroke="var(--border-dim)" vertical={false} />
                  <XAxis dataKey="time" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                  <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={32} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Area
                    type="monotone"
                    dataKey="ingress"
                    stroke="var(--color-ingress)"
                    strokeWidth={2}
                    fill="url(#grad-ingress)"
                  />
                  <Area
                    type="monotone"
                    dataKey="egress"
                    stroke="var(--color-egress)"
                    strokeWidth={1.5}
                    strokeDasharray="4 4"
                    fill="none"
                  />
                </AreaChart>
              </ChartContainer>
            </PanelBody>
          </Panel>

          {/* Histogram */}
          <Panel className="col-span-4">
            <PanelHeader>
              <PanelTitle>Payload Distribution</PanelTitle>
            </PanelHeader>
            <PanelBody className="flex flex-col">
              <div className="mb-3 flex justify-between font-mono text-4xs uppercase text-text-secondary">
                <span>
                  Freq: <span className="text-text-primary">Count</span>
                </span>
                <span>
                  Bin: <span className="text-text-primary">Size (KB)</span>
                </span>
              </div>
              <ChartContainer config={histogramConfig} className="aspect-auto h-44 w-full">
                <BarChart data={HISTOGRAM_DATA} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke="var(--border-dim)" vertical={false} />
                  <XAxis dataKey="bin" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="count" fill="var(--color-count)" opacity={0.6} activeBar={{ opacity: 1 }} radius={0} />
                </BarChart>
              </ChartContainer>
            </PanelBody>
          </Panel>
        </div>

        {/* Bottom row */}
        <div className="grid grid-cols-12 gap-6">
          {/* Data table */}
          <Panel className="col-span-6">
            <PanelHeader>
              <PanelTitle>Active Node Telemetry</PanelTitle>
              <span className="font-mono text-4xs uppercase tracking-widest text-text-tertiary">TOP 5 BY LOAD</span>
            </PanelHeader>
            <PanelBody className="pt-0">
              <DataTable>
                <DataTableHead>
                  <tr>
                    <DataTableHeaderCell>Status</DataTableHeaderCell>
                    <DataTableHeaderCell>Node_ID</DataTableHeaderCell>
                    <DataTableHeaderCell>CPU_%</DataTableHeaderCell>
                    <DataTableHeaderCell align="right">Trend (1H)</DataTableHeaderCell>
                  </tr>
                </DataTableHead>
                <DataTableBody>
                  {NODE_DATA.map((node) => {
                    const cpuCellColor = cpuColor(node.cpu);
                    return (
                      <DataTableRow key={node.id}>
                        <DataTableCell>
                          <StatusDot status={node.status} />
                        </DataTableCell>
                        <DataTableCell>{node.id}</DataTableCell>
                        <DataTableCell style={cpuCellColor != null ? { color: cpuCellColor } : undefined}>
                          {node.cpu.toFixed(1)}
                        </DataTableCell>
                        <DataTableCell align="right">
                          <Sparkline data={node.spark} color={sparkColor(node.status)} />
                        </DataTableCell>
                      </DataTableRow>
                    );
                  })}
                </DataTableBody>
              </DataTable>
            </PanelBody>
          </Panel>

          {/* Combo chart: bars + line */}
          <Panel className="col-span-6">
            <PanelHeader>
              <PanelTitle>Error Rates vs Requests</PanelTitle>
              <div className="flex items-center gap-4 font-mono text-3xs uppercase text-text-secondary">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-1 bg-border-mid" />
                  Req
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-0.5 w-2 bg-status-high" />
                  Err
                </span>
              </div>
            </PanelHeader>
            <PanelBody>
              <ChartContainer config={errorConfig} className="aspect-auto h-52 w-full">
                <ComposedChart data={ERROR_RATE_DATA} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke="var(--border-dim)" vertical={false} />
                  <XAxis dataKey="time" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                  <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={32} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar
                    dataKey="requests"
                    fill="var(--color-requests)"
                    opacity={0.5}
                    activeBar={{ opacity: 0.8 }}
                    radius={0}
                    barSize={10}
                  />
                  <Line
                    type="monotone"
                    dataKey="errors"
                    stroke="var(--color-errors)"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 3, stroke: "var(--color-errors)", fill: "var(--surface-void)" }}
                  />
                </ComposedChart>
              </ChartContainer>
            </PanelBody>
          </Panel>
        </div>

        {/* Footer */}
        <footer className="mt-auto flex justify-between border-t border-border-dim pt-5 font-mono text-4xs uppercase tracking-widest text-text-tertiary">
          <span>CONFIDENTIAL & PROPRIETARY</span>
          <span className="text-primary-ink">SYS_RDY</span>
        </footer>
      </div>
    </div>
  );
}

export default TelemetryPage;
