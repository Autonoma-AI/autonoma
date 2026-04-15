import type * as React from "react";
import type { PageId } from "../nav";
import { AgentCubeSection } from "./agent-cube";
import { AlertSection } from "./alert";
import { ArchitectureSection } from "./architecture";
import { BadgeSection } from "./badge";
import { BordersSection } from "./borders";
import { BrailleSpinnerSection } from "./braille-spinner";
import { ButtonSection } from "./button";
import { CardSection } from "./card";
import { ChartsSection } from "./charts";
import { CheckboxSection } from "./checkbox";
import { ColorsSection } from "./colors";
import { DataTableSection } from "./data-table";
import { DialogSection } from "./dialog";
import { DrawerSection } from "./drawer";
import { DropdownMenuSection } from "./dropdown-menu";
import { InputSection } from "./input";
import { InstallationSection } from "./installation";
import { IntroductionSection } from "./introduction";
import { LabelSection } from "./label";
import { MetricCardSection } from "./metric-card";
import { PanelSection } from "./panel";
import { ProgressSection } from "./progress";
import { ScrollAreaSection } from "./scroll-area";
import { SelectSection } from "./select";
import { SeparatorSection } from "./separator";
import { SkeletonSection } from "./skeleton";
import { SparklineSection } from "./sparkline";
import { StatusDotSection } from "./status-dot";
import { SurfacesSection } from "./surfaces";
import { SwitchSection } from "./switch";
import { TabsSection } from "./tabs";
import { TextareaSection } from "./textarea";
import { ThemingSection } from "./theming";
import { ToastSection } from "./toast";
import { TooltipSection } from "./tooltip";
import { TypographySection } from "./typography";

export const PAGE_COMPONENTS: Record<PageId, () => React.JSX.Element> = {
    introduction: IntroductionSection,
    installation: InstallationSection,
    architecture: ArchitectureSection,
    theming: ThemingSection,
    "agent-cube": AgentCubeSection,
    alert: AlertSection,
    "braille-spinner": BrailleSpinnerSection,
    badge: BadgeSection,
    button: ButtonSection,
    card: CardSection,
    charts: ChartsSection,
    checkbox: CheckboxSection,
    "data-table": DataTableSection,
    dialog: DialogSection,
    drawer: DrawerSection,
    "dropdown-menu": DropdownMenuSection,
    input: InputSection,
    label: LabelSection,
    "metric-card": MetricCardSection,
    panel: PanelSection,
    progress: ProgressSection,
    "scroll-area": ScrollAreaSection,
    select: SelectSection,
    separator: SeparatorSection,
    skeleton: SkeletonSection,
    sparkline: SparklineSection,
    "status-dot": StatusDotSection,
    switch: SwitchSection,
    tabs: TabsSection,
    textarea: TextareaSection,
    toast: ToastSection,
    tooltip: TooltipSection,
    colors: ColorsSection,
    typography: TypographySection,
    surfaces: SurfacesSection,
    borders: BordersSection,
};
