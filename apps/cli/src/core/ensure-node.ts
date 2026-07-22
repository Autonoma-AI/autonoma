// Side-effect entry guard: verify the Node runtime before anything else loads.
// This module is imported first in index.ts (ahead of ink/react) so the
// version check runs before any dependency can touch `util.styleText`. ESM
// evaluates imports in order and before the module body, so a bare
// `ensureSupportedNode()` call in the entry body would still run AFTER their
// import side-effects - defeating the fail-fast guarantee if a future dependency (or
// other dep) ever touched `styleText` at import time.
import { ensureSupportedNode } from "./node-version";

ensureSupportedNode();
