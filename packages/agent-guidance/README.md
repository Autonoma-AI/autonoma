# @autonoma/agent-guidance

One source of truth for the guidance Autonoma gives when a request cannot proceed.

An agent handed a bare Autonoma URL - which is how people actually introduce us to their coding
agent - has no way to discover how to authenticate. Before this package the MCP surface answered
with `{"error":"Unauthorized"}` and nothing else, so an agent with no browser retried an OAuth flow
it could never complete.

The guidance lives here, as data, so every surface renders the same facts without re-writing them:
the API in a JSON body, and later the CLI and the UI error boundary. Change the wording once and
every surface follows.

## Usage

```ts
import { unauthorizedGuidance } from "@autonoma/agent-guidance";

return c.json(unauthorizedGuidance({ appUrl, docsUrl, surface: "mcp" }), 401);
```

## The discovery catalog

`aiCatalog()` builds the [Agentic Resource Discovery](https://agenticresourcediscovery.org/) document
served at `/.well-known/ai-catalog.json`: one fetch that tells an agent every surface we offer it, so
it does not have to already know our URLs to find them.

It is generated rather than checked in as a static file because the URLs are environment-specific - a
per-PR alpha deployment has to advertise its own endpoints, not production's. The UI's nginx proxies
the path through to the API so the brand domain answers it too, since an agent looking for us tries
`autonoma.app`, not `api.autonoma.app`.

The spec is a v0.9 draft, so the envelope may move. `packages/agent-guidance/test/ai-catalog.test.ts`
pins the required fields.

## What this is not

It does not decide status codes or headers. The MCP 401 keeps its `WWW-Authenticate` challenge
because clients discover the authorization server from it - that is a protocol contract. This only
fills the response body, which was previously wasted.
