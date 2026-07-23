import type { ApplicationDriver } from "@autonoma/engine";
import { sleep } from "@autonoma/utils/sleep";

export class AppiumApplicationDriver implements ApplicationDriver {
    async waitUntilStable(timeout = 3000): Promise<void> {
        await sleep(timeout);
    }
}
