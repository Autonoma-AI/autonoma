# @autonoma/environment-factory

Installable customer-side runtime for the Autonoma Environment Factory protocol.

This package removes the repeated boilerplate from app integrations:

- Verifies HMAC-signed webhook requests
- Discovers named scenarios automatically
- Signs and verifies `refsToken` for teardown
- Routes `down` calls back to the correct scenario
- Exposes both a raw handler and a `Request` -> `Response` handler

## Usage

```ts
import { EnvironmentFactoryServer } from "@autonoma/environment-factory";

const factory = new EnvironmentFactoryServer({
    sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
    internalSecret: process.env.AUTONOMA_INTERNAL_SECRET!,
    environment: process.env.NODE_ENV,
    scenarios: [
        {
            name: "standard",
            description: "Seed a default organization and user",
            async up({ testRunId }) {
                return {
                    auth: {
                        headers: {
                            Authorization: `Bearer ${testRunId}`,
                        },
                    },
                    refs: { organizationId: "org_123" },
                };
            },
            async down({ refs }) {
                // Delete only the rows created during up()
                void refs;
            },
        },
    ],
});

export async function POST(request: Request): Promise<Response> {
    return factory.handleRequest(request);
}
```

## Framework notes

- Fetch-native frameworks such as Next.js, TanStack Start, Hono, and Remix can use `handleRequest()`.
- Express, Fastify, and Nest can use `handle()` with their raw body and headers.

```ts
const result = await factory.handle({
    method: req.method,
    headers: req.headers,
    rawBody,
});

res.status(result.status).set(result.headers).send(result.body);
```
