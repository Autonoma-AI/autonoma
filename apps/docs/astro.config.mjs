import mdx from "@astrojs/mdx"
import react from "@astrojs/react"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "astro/config"
import expressiveCode from "astro-expressive-code"
import remarkDirective from "remark-directive"
import remarkGfm from "remark-gfm"
import { remarkCallouts } from "./src/lib/remark-callouts.mjs"

export default defineConfig({
    site: "https://docs.autonoma.app",
    vite: {
        plugins: [tailwindcss()],
    },
    integrations: [
        expressiveCode({
            themes: ["github-dark", "github-light"],
            defaultProps: {
                overridesByLang: {},
            },
            styleOverrides: {
                borderRadius: "0",
                borderColor: "var(--border-dim)",
                codeBackground: "#050505",
                frames: {
                    editorBackground: "#050505",
                    terminalBackground: "#050505",
                    editorTabBarBackground: "#040404",
                    terminalTitlebarBackground: "#040404",
                },
            },
        }),
        mdx(),
        react(),
    ],
    markdown: {
        remarkPlugins: [remarkGfm, remarkDirective, remarkCallouts],
    },
})
