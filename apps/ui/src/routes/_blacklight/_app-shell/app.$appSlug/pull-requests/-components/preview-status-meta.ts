import { BracketsCurlyIcon } from "@phosphor-icons/react/BracketsCurly";
import { CloudIcon } from "@phosphor-icons/react/Cloud";
import { CubeIcon } from "@phosphor-icons/react/Cube";
import { DatabaseIcon } from "@phosphor-icons/react/Database";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { GlobeIcon } from "@phosphor-icons/react/Globe";
import { NetworkIcon } from "@phosphor-icons/react/Network";
import { PackageIcon } from "@phosphor-icons/react/Package";
import { StackIcon } from "@phosphor-icons/react/Stack";
import { TreeStructureIcon } from "@phosphor-icons/react/TreeStructure";
import { WarningDiamondIcon } from "@phosphor-icons/react/WarningDiamond";

// Shared status/icon metadata for the preview-environment UI. Used by the PR-header entry-point
// button (PreviewEnvironmentHeaderButton) and the dedicated preview environment detail page.

export const PREVIEW_STATUS_META = {
    ready: { label: "Ready", dot: "success", badge: "success", className: "" },
    building: { label: "Building", dot: "warn", badge: "status-running", className: "" },
    degraded: { label: "Degraded", dot: "warn", badge: "warn", className: "" },
    failed: { label: "Failed", dot: "critical", badge: "status-failed", className: "" },
    stopped: { label: "Stopped", dot: "neutral", badge: "outline", className: "text-text-secondary" },
    missing: { label: "Missing", dot: "neutral", badge: "outline", className: "text-text-secondary" },
    stale: { label: "Stale", dot: "warn", badge: "warn", className: "" },
    unknown: { label: "Unknown", dot: "neutral", badge: "outline", className: "text-text-secondary" },
} as const;

export const SERVICE_STATUS_META = {
    ready: { label: "Ready", dot: "success", badge: "success", className: "" },
    building: { label: "Building", dot: "warn", badge: "status-running", className: "" },
    failed: { label: "Failed", dot: "critical", badge: "status-failed", className: "" },
    fallback: { label: "Fallback", dot: "warn", badge: "warn", className: "" },
    stopped: { label: "Stopped", dot: "neutral", badge: "outline", className: "text-text-secondary" },
    unknown: { label: "Unknown", dot: "neutral", badge: "outline", className: "text-text-secondary" },
} as const;

export const SERVICE_ICON_BY_KEY = {
    web: GlobeIcon,
    api: NetworkIcon,
    worker: GearSixIcon,
    node: BracketsCurlyIcon,
    postgres: DatabaseIcon,
    redis: StackIcon,
    valkey: StackIcon,
    mongodb: DatabaseIcon,
    temporal: TreeStructureIcon,
    "api-gateway": NetworkIcon,
    aws: CloudIcon,
    "docker-image": PackageIcon,
    upstash: StackIcon,
    database: DatabaseIcon,
    cache: StackIcon,
    service: CubeIcon,
    unknown: WarningDiamondIcon,
} as const;
