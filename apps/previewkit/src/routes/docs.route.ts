import { swaggerUI } from "@hono/swagger-ui";
import { Hono } from "hono";
import { openApiSpec } from "./openapi-spec";

export const docsRoute = new Hono()
    .get("/openapi.json", (c) => c.json(openApiSpec))
    .get("/docs", swaggerUI({ url: "/v1/openapi.json" }));
