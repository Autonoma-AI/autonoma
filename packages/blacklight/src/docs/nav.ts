export type PageId =
    | "introduction"
    | "installation"
    | "architecture"
    | "theming"
    | "agent-cube"
    | "braille-spinner"
    | "button"
    | "badge"
    | "card"
    | "checkbox"
    | "input"
    | "label"
    | "metric-card"
    | "panel"
    | "progress"
    | "alert"
    | "scroll-area"
    | "select"
    | "separator"
    | "skeleton"
    | "sparkline"
    | "status-dot"
    | "switch"
    | "tabs"
    | "textarea"
    | "tooltip"
    | "data-table"
    | "charts"
    | "dialog"
    | "dropdown-menu"
    | "drawer"
    | "toast"
    | "colors"
    | "typography"
    | "surfaces"
    | "borders";

export const NAV_SECTIONS: { label: string; items: { id: PageId; label: string }[] }[] = [
    {
        label: "Getting Started",
        items: [
            { id: "introduction", label: "Introduction" },
            { id: "installation", label: "Installation" },
            { id: "architecture", label: "Architecture" },
            { id: "theming", label: "Theming" },
        ],
    },
    {
        label: "Components",
        items: [
            { id: "agent-cube", label: "Agent Cube" },
            { id: "alert", label: "Alert" },
            { id: "braille-spinner", label: "Braille Spinner" },
            { id: "badge", label: "Badge" },
            { id: "button", label: "Button" },
            { id: "card", label: "Card" },
            { id: "charts", label: "Charts" },
            { id: "checkbox", label: "Checkbox" },
            { id: "data-table", label: "Data Table" },
            { id: "dialog", label: "Dialog" },
            { id: "drawer", label: "Drawer" },
            { id: "dropdown-menu", label: "Dropdown Menu" },
            { id: "input", label: "Input" },
            { id: "label", label: "Label" },
            { id: "metric-card", label: "Metric Card" },
            { id: "panel", label: "Panel" },
            { id: "progress", label: "Progress" },
            { id: "scroll-area", label: "Scroll Area" },
            { id: "select", label: "Select" },
            { id: "separator", label: "Separator" },
            { id: "skeleton", label: "Skeleton" },
            { id: "sparkline", label: "Sparkline" },
            { id: "status-dot", label: "Status Dot" },
            { id: "switch", label: "Switch" },
            { id: "tabs", label: "Tabs" },
            { id: "textarea", label: "Textarea" },
            { id: "toast", label: "Toast" },
            { id: "tooltip", label: "Tooltip" },
        ],
    },
    {
        label: "Tokens",
        items: [
            { id: "colors", label: "Colors" },
            { id: "typography", label: "Typography" },
            { id: "surfaces", label: "Surfaces" },
            { id: "borders", label: "Borders" },
        ],
    },
];
