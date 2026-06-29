import { DialogObserver, Installer } from "@autonoma/engine";
import { getScreenshotConfig } from "@autonoma/image";
import type { Browser, BrowserContext, Page } from "playwright";
import z from "zod";
import { ActivePageManager } from "./active-page-manager";
import { PlaywrightApplicationDriver } from "./drivers/playwright-application.driver";
import { PlaywrightClipboardDriver } from "./drivers/playwright-clipboard.driver";
import { PlaywrightKeyboardDriver } from "./drivers/playwright-keyboard.driver";
import { PlaywrightMouseDriver } from "./drivers/playwright-mouse.driver";
import { PlaywrightNavigationDriver } from "./drivers/playwright-navigation.driver";
import { PlaywrightScreenDriver } from "./drivers/playwright-screen.driver";
import { attachNativeDialogHandler } from "./native-dialog-handler";
import { PlaywrightImageStream } from "./playwright-image-stream";
import type { WebApplicationData } from "./web-application-data";
import type { WebContext } from "./web-context";
import { WebVideoRecorder } from "./web-video-recorder";

export class WebInstaller extends Installer<WebApplicationData, WebContext> {
    readonly paramsSchema = z.object({
        url: z.string(),
        file: z.string().optional(),
        cookies: z
            .array(
                z.object({
                    name: z.string(),
                    value: z.string(),
                    url: z.string().optional(),
                    domain: z.string().optional(),
                    path: z.string().optional(),
                    expires: z.number().optional(),
                    httpOnly: z.boolean().optional(),
                    secure: z.boolean().optional(),
                    sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
                    partitionKey: z.string().optional(),
                }),
            )
            .optional(),
        headers: z.record(z.string(), z.string()).optional(),
    });

    constructor(
        private readonly browser: Browser,
        private readonly context: BrowserContext,
        /**
         * When true, native browser dialogs (alert / confirm / prompt) are auto-accepted and
         * recorded. Enabled for both generation and replay: auto-accept is a deterministic policy
         * (no agent decision), so replay resolves dialogs exactly as generation did - keeping a
         * confirm()-gated delete/save consistent across both. The recorded dialogs are only read
         * by the generation agent; in replay the observer is simply not drained.
         */
        private readonly handleNativeDialogs: boolean = false,
    ) {
        super();
    }

    protected async buildContext({ url, file, cookies, headers }: WebApplicationData) {
        this.logger.info("Building web context for test case", { url });

        if (cookies != null && cookies.length > 0) {
            this.logger.info("Applying scenario auth cookies", {
                cookieCount: cookies.length,
                shapes: cookies.map((c) => ({
                    name: c.name,
                    url: c.url,
                    domain: c.domain,
                    path: c.path,
                    sameSite: c.sameSite,
                    httpOnly: c.httpOnly,
                    secure: c.secure,
                })),
            });
            await this.context.addCookies(cookies);
            const storedBeforeNavigation = await this.context.cookies();
            this.logger.info("Scenario auth cookies applied", {
                requestedCount: cookies.length,
                storedCount: storedBeforeNavigation.length,
                storedNames: storedBeforeNavigation.map((c) => c.name),
                storedDomains: storedBeforeNavigation.map((c) => c.domain),
            });
        }

        const page = await this.context.newPage();
        const pageManager = new ActivePageManager(page, this.context);

        if (headers != null && Object.keys(headers).length > 0) {
            const targetOrigin = this.safeOrigin(url);
            this.attachHeaderRoute(page, headers, targetOrigin);
            pageManager.onPageChange((newPage) => this.attachHeaderRoute(newPage, headers, targetOrigin));
            this.logger.info("Scenario auth headers applied via route interception", {
                headerCount: Object.keys(headers).length,
                targetOrigin,
            });
        }

        this.attachAuthDebugListeners(page, url);

        const dialogObserver = this.handleNativeDialogs ? new DialogObserver() : undefined;
        if (dialogObserver != null) {
            this.logger.info("Native dialog handling enabled");
            attachNativeDialogHandler(page, dialogObserver);
            pageManager.onPageChange((newPage) => attachNativeDialogHandler(newPage, dialogObserver));
        }

        if (file != null) {
            this.attachUploadListener(page, file);
            pageManager.onPageChange((newPage) => this.attachUploadListener(newPage, file));
        }

        const { screenResolution } = getScreenshotConfig();
        if (screenResolution == null) throw new Error("Screen resolution not found");

        const context = {
            screen: new PlaywrightScreenDriver(pageManager),
            mouse: new PlaywrightMouseDriver(pageManager, screenResolution),
            keyboard: new PlaywrightKeyboardDriver(pageManager),
            clipboard: new PlaywrightClipboardDriver(pageManager),
            application: new PlaywrightApplicationDriver(pageManager),
            navigation: new PlaywrightNavigationDriver(pageManager),
            dialogs: dialogObserver,
        };

        // Navigate to the URL
        await context.navigation.navigate(url);

        if (cookies != null && cookies.length > 0) {
            const storedAfterNavigation = await this.context.cookies(url);
            this.logger.info("Cookies visible to target URL after navigation", {
                url,
                storedCount: storedAfterNavigation.length,
                storedNames: storedAfterNavigation.map((c) => c.name),
                storedDomains: storedAfterNavigation.map((c) => c.domain),
                storedPaths: storedAfterNavigation.map((c) => c.path),
                storedSameSite: storedAfterNavigation.map((c) => c.sameSite),
                storedSecure: storedAfterNavigation.map((c) => c.secure),
                storedHttpOnly: storedAfterNavigation.map((c) => c.httpOnly),
            });

            try {
                const currentUrl = page.url();
                const pageCookieHeader = await page.evaluate(() => document.cookie);
                this.logger.info("document.cookie after navigation", {
                    currentUrl,
                    documentCookieNames: pageCookieHeader
                        .split(";")
                        .map((p) => p.trim().split("=")[0])
                        .filter((n) => n != null && n.length > 0),
                });
            } catch (error) {
                this.logger.warn("Failed to read document.cookie", { error });
            }
        }

        return {
            context,
            imageStream: new PlaywrightImageStream(pageManager),
            // Note: WebVideoRecorder is tied to the initial page because Playwright's video
            // API records per-page. New tabs opened during the test are not included in
            // this recording. Supporting multi-tab video would require FFmpeg screen capture.
            videoRecorder: new WebVideoRecorder(page),
        };
    }

    private attachHeaderRoute(page: Page, headers: Record<string, string>, targetOrigin?: string) {
        page.route("**/*", async (route, request) => {
            if (targetOrigin != null && this.safeOrigin(request.url()) !== targetOrigin) {
                await route.continue();
                return;
            }
            await route.continue({ headers: { ...request.headers(), ...headers } });
        });
    }

    private attachUploadListener(page: Page, file: string) {
        page.on("filechooser", async (fileChooser) => {
            await fileChooser.setFiles(file);
        });
    }

    /**
     * Logs request/response cookie headers for the first N document/xhr/fetch requests
     * to the target origin. Used to debug whether scenario auth cookies are actually
     * sent on outgoing requests and whether the app rotates/clears them via Set-Cookie.
     */
    private attachAuthDebugListeners(page: Page, targetUrl: string) {
        const targetOrigin = this.safeOrigin(targetUrl);
        if (targetOrigin == null) return;

        const maxLogs = 10;
        let requestCount = 0;
        let responseCount = 0;

        page.on("request", async (request) => {
            if (requestCount >= maxLogs) return;
            const reqUrl = request.url();
            if (this.safeOrigin(reqUrl) !== targetOrigin) return;
            const resourceType = request.resourceType();
            if (resourceType !== "document" && resourceType !== "xhr" && resourceType !== "fetch") return;
            requestCount++;

            try {
                // `request.headers()` strips cookie/authorization headers.
                // `request.allHeaders()` (async) includes them.
                const headers = await request.allHeaders();
                const cookieHeader = headers.cookie ?? headers.Cookie;
                this.logger.info("Outgoing request to target origin", {
                    url: reqUrl,
                    method: request.method(),
                    resourceType,
                    hasCookieHeader: cookieHeader != null,
                    cookieNames:
                        cookieHeader == null
                            ? []
                            : cookieHeader
                                  .split(";")
                                  .map((p) => p.trim().split("=")[0])
                                  .filter((n) => n != null && n.length > 0),
                });
            } catch (error) {
                this.logger.warn("Failed to read request headers", { url: reqUrl, error });
            }
        });

        page.on("response", async (response) => {
            if (responseCount >= maxLogs) return;
            const resUrl = response.url();
            if (this.safeOrigin(resUrl) !== targetOrigin) return;
            const resourceType = response.request().resourceType();
            if (resourceType !== "document" && resourceType !== "xhr" && resourceType !== "fetch") return;
            responseCount++;

            try {
                const headers = await response.allHeaders();
                const setCookie = headers["set-cookie"];
                const setCookieNames =
                    setCookie == null
                        ? []
                        : setCookie
                              .split("\n")
                              .map((line) => line.split(";")[0]?.split("=")[0]?.trim())
                              .filter((n): n is string => n != null && n.length > 0);
                this.logger.info("Incoming response from target origin", {
                    url: resUrl,
                    status: response.status(),
                    resourceType,
                    hasSetCookie: setCookie != null,
                    setCookieNames,
                });
            } catch (error) {
                this.logger.warn("Failed to read response headers", { url: resUrl, error });
            }
        });
    }

    private safeOrigin(url: string): string | undefined {
        try {
            return new URL(url).origin;
        } catch {
            return undefined;
        }
    }

    async cleanup(): Promise<void> {
        try {
            this.logger.info("Cleaning up browser context");
            await this.context.close();
        } catch (error) {
            this.logger.fatal("Error closing browser context", error);
        }

        try {
            this.logger.info("Cleaning up browser");
            await this.browser.close();
        } catch (error) {
            this.logger.fatal("Error closing browser", error);
        }
    }
}
