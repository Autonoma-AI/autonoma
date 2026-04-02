import { describe, expect, test } from "vitest";
import { shouldLogRequestBody } from "../../src/should-log-request-body";

describe("shouldLogRequestBody", () => {
    test("skips JSON body logging for streamed package uploads", () => {
        expect(
            shouldLogRequestBody({
                method: "PUT",
                path: "/v1/upload/package",
                contentType: "application/octet-stream",
            }),
        ).toBe(false);
    });

    test("skips multipart uploads", () => {
        expect(
            shouldLogRequestBody({
                method: "POST",
                path: "/v1/upload/anything",
                contentType: "multipart/form-data; boundary=abc123",
            }),
        ).toBe(false);
    });

    test("logs ordinary JSON mutation requests", () => {
        expect(
            shouldLogRequestBody({
                method: "POST",
                path: "/v1/trpc/test.create",
                contentType: "application/json",
            }),
        ).toBe(true);
    });
});
