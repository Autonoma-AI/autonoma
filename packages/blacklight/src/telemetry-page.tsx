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

/* ═══════════════════════════════════════════
   Mock data
   ═══════════════════════════════════════════ */

const NODE_DATA = [
  { id: "EU-WEST-01", status: "success" as const, cpu: 42.5, spark: [15, 12, 16, 8, 10, 4, 6] },
  { id: "US-EAST-04", status: "warn" as const, cpu: 78.2, spark: [20, 18, 10, 12, 5, 2, 4] },
  { id: "AP-SOUTH-02", status: "success" as const, cpu: 31.0, spark: [10, 12, 11, 9, 10, 11, 10] },
  { id: "US-WEST-01", status: "critical" as const, cpu: 94.8, spark: [15, 8, 10, 4, 2, 0, 1] },
  { id: "EU-CENT-03", status: "success" as const, cpu: 55.1, spark: [10, 15, 8, 12, 6, 8, 5] },
];

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

        {/* Data table */}
        <Panel>
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
