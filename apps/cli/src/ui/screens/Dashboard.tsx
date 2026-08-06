import { Box, Text } from "ink";
import { useRef } from "react";
import { drawDashboard } from "../draw/dashboard";
import { Grid } from "../grid";
import type { RunState } from "../types";

/**
 * Paint the frame and emit it as one Text per row, all inline. The Grid must
 * NEVER be passed as a prop to a child component: React retains prop objects
 * per render, and a ~2MB grid retained at repaint rate leaks hundreds of
 * MB/min (measured - this exact shape OOMed real runs).
 *
 * The Grid is reused across renders via a ref: clearing it in place avoids
 * allocating 3000+ Cell objects per frame (the clock ticks 10x/second, so
 * that was ~30k objects/second of short-lived garbage driving V8's GC hard
 * enough to starve the pipeline).
 */
export function Dashboard({ state, width, rows }: { state: RunState; width: number; rows: number }) {
  const gridRef = useRef<Grid | undefined>(undefined);
  if (gridRef.current == null || gridRef.current.w !== width || gridRef.current.h !== rows) {
    gridRef.current = new Grid(width, rows);
  }
  const g = gridRef.current;
  g.clear();
  drawDashboard(g, state);
  return (
    <Box flexDirection="column" width={width} height={rows}>
      {g.ansiRows().map((row, y) => (
        <Text key={y}>{row}</Text>
      ))}
    </Box>
  );
}
