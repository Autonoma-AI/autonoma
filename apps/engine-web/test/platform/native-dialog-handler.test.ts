import path from "node:path";
import { DialogObserver } from "@autonoma/engine";
import { type Browser, type BrowserContext, type Page, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attachNativeDialogHandler } from "../../src/platform/native-dialog-handler";

const FIXTURES_DIR = path.join(import.meta.dirname, "fixtures");
const FIXTURE_URL = `file://${path.join(FIXTURES_DIR, "native-dialogs.html")}`;

/**
 * End-to-end coverage of the native-dialog handler against a real Chromium page loaded from an
 * HTML fixture. The fixture's buttons raise real alert/confirm/prompt dialogs and only mutate the
 * DOM once the dialog is handled, so these tests prove both that the gated flow proceeds and that
 * the click does not hang waiting on the dialog.
 */
describe("attachNativeDialogHandler (e2e)", { timeout: 30000 }, () => {
    let browser: Browser;
    let browserContext: BrowserContext;

    beforeAll(async () => {
        browser = await chromium.launch({ headless: true });
        browserContext = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    });

    afterAll(async () => {
        await browserContext?.close();
        await browser?.close();
    });

    async function loadFixture(): Promise<Page> {
        const page = await browserContext.newPage();
        await page.goto(FIXTURE_URL);
        await page.waitForLoadState("domcontentloaded");
        return page;
    }

    it("accepts an alert() and records it, letting the flow continue", async () => {
        const page = await loadFixture();
        const observer = new DialogObserver();
        attachNativeDialogHandler(page, observer);

        try {
            // If the alert blocked, this click would time out instead of resolving.
            await page.click("#alert-btn");

            expect(await page.textContent("#alert-status")).toBe("after-alert");

            const pending = observer.takePending();
            expect(pending).toHaveLength(1);
            expect(pending[0]?.type).toBe("alert");
            expect(pending[0]?.message).toBe("Your changes have been saved.");
            expect(pending[0]?.outcome).toBe("accepted");
        } finally {
            await page.close();
        }
    });

    it("accepts a confirm() so the delete proceeds, and records the dialog", async () => {
        const page = await loadFixture();
        const observer = new DialogObserver();
        attachNativeDialogHandler(page, observer);

        try {
            await page.click("#confirm-btn");

            expect(await page.textContent("#confirm-status")).toBe("deleted");

            const pending = observer.takePending();
            expect(pending).toHaveLength(1);
            expect(pending[0]?.type).toBe("confirm");
            expect(pending[0]?.message).toBe("Delete invoice #42? This cannot be undone.");
            expect(pending[0]?.outcome).toBe("accepted");
        } finally {
            await page.close();
        }
    });

    it("accepts a prompt() with the dialog's default value", async () => {
        const page = await loadFixture();
        const observer = new DialogObserver();
        attachNativeDialogHandler(page, observer);

        try {
            await page.click("#prompt-btn");

            expect(await page.textContent("#prompt-status")).toBe("invoice-default");

            const pending = observer.takePending();
            expect(pending).toHaveLength(1);
            expect(pending[0]?.type).toBe("prompt");
            expect(pending[0]?.promptValue).toBe("invoice-default");
        } finally {
            await page.close();
        }
    });

    it("drains the observer so a dialog is reported only once", async () => {
        const page = await loadFixture();
        const observer = new DialogObserver();
        attachNativeDialogHandler(page, observer);

        try {
            await page.click("#confirm-btn");

            expect(observer.takePending()).toHaveLength(1);
            expect(observer.takePending()).toHaveLength(0);
        } finally {
            await page.close();
        }
    });

    it("without the handler, Playwright auto-dismisses the confirm and the delete is cancelled (the bug)", async () => {
        // Control case: reproduces the original false-positive cause - no handler means the
        // confirm is auto-dismissed, confirm() returns false, and the delete never happens.
        const page = await loadFixture();

        try {
            await page.click("#confirm-btn");
            expect(await page.textContent("#confirm-status")).toBe("present");
        } finally {
            await page.close();
        }
    });
});
