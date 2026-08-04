import type { PlaywrightCookie } from "./scenario-auth";

export interface WebApplicationData {
    /** The URL to navigate to before executing the test */
    url: string;

    /** The file to upload. Optional - not all tests require file upload. */
    file?: string;

    /** Optional cookies to be injected in the browser context before navigation */
    cookies?: PlaywrightCookie[];

    /** Optional HTTP headers to be injected in the browser context before navigation */
    headers?: Record<string, string>;
}
