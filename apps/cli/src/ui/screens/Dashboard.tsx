import { Box, Text } from "ink";
import { drawDashboard } from "../draw/dashboard";
import { Grid } from "../grid";
import type { RunState } from "../types";

/**
 * Paint the frame and emit it as one Text per row, all inline. The Grid must
 * NEVER be passed as a prop to a child component: React retains prop objects
 * per render, and a ~2MB grid retained at repaint rate leaks hundreds of
 * MB/min (measured - this exact shape OOMed real runs).
 */
export function Dashboard({ state, width, rows }: { state: RunState; width: number; rows: number }) {
  const g = new Grid(width, rows);
  drawDashboard(g, state);
  return (
    <Box flexDirection="column" width={width} height={rows}>
      {g.ansiRows().map((row, y) => (
        <Text key={y}>{row}</Text>
      ))}
    </Box>
  );
}
