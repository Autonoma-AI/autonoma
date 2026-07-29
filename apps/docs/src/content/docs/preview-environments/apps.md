---
title: Apps and builds
description: How Autonoma turns each app in your repo into a running container - the build method, the runtime catalog, build context, and the per-app settings.
---

<p class="lead">An app is the unit Autonoma builds and deploys: a piece of your repo that becomes a container with its own public HTTPS URL in every preview. This page covers how each app is built and the settings on its card.</p>

Most projects have one app - your web server. A repo can declare several (a frontend, an API, a worker), and each is configured the same way: pick how it builds, then fill in a few fields about how it runs.

## Build method

Every app builds one of two ways, chosen with the **Build method** toggle at the top of the app card:

| Method | Use it when | What you provide |
| --- | --- | --- |
| **Manual** | You don't have a Dockerfile, or you want a fast, transparent build. | A runtime (Node, Python, ...), a bash build script, and an entrypoint. |
| **Dockerfile** | Your repo already has a Dockerfile you trust. | The path to that Dockerfile. |

Manual is the default because it needs nothing in your repo - you pick a language and describe the build in two boxes.

### Manual builds

A manual build starts from a language image, installs your dependencies with a build script, and runs your app with an entrypoint. You pick a **runtime** from the catalog:

![The manual build editor for an app. On the left, a grid of runtime tiles with Node selected, then Version, a Build script field badged bash, and an Entrypoint field. On the right a sticky "Build spec" rail previews the result - the runtime and version, the resolved base image, the build context at the repo root, the working directory, the entrypoint, and an "installed for you" list of tool chips](/img/preview-environments/build-manual.png)

The **Build spec** rail on the right is live: it resolves the base image, context, working directory and preinstalled toolbelt as you choose, so you can see what you are about to get before you deploy.

| Runtime | Base image | Default version |
| --- | --- | --- |
| Node.js | `node:{version}-bookworm-slim` | 22 |
| Python | `python:{version}-slim-bookworm` | 3.12 |
| Go | `golang:{version}-bookworm` | 1.22 |
| Rust | `rust:{version}-slim-bookworm` | 1.77 |
| Java | `eclipse-temurin:{version}-jdk` | 21 |
| Ruby | `ruby:{version}-slim-bookworm` | 3.3 |
| PHP | `php:{version}-cli-bookworm` | 8.3 |
| C / C++ | `gcc:{version}-bookworm` | 13 |
| Debian | `debian:{version}-slim` | bookworm |

Pick **Debian** when you want a bare base image and will install everything yourself. Any published tag works in the **Version** field - the default is only a starting point, so a repo pinned to an older toolchain is never forced onto ours.

Two boxes describe the build:

- **Build script** - bash that runs at image build time, from the repo root. Selecting a runtime prefills a sensible default (for Node, `npm install` then `npm run build`). It's optional - leave it blank for an app that needs no build step.
- **Entrypoint** - the command that starts the container (for Node, `npm start`).

The **Build spec** panel on the right previews exactly what you'll get: the runtime and version, the resolved image, the build context (**the repo root**), the working directory (`/workspace/<app-name>`), and the entrypoint. Because a manual build copies the whole repo, you don't set a Path or build context for it - the build script and entrypoint define everything.

Every manual runtime also ships a common toolbelt so your scripts have what they need without an install step: `git`, `curl`, `wget`, `jq`, `rg`, `make`, `ssh`, `tmux`, `sqlite3`, `tar`, `zip`, and `unzip`, plus the language's own tools (for Node, `npm`, `pnpm`, and `yarn`).

### Dockerfile builds

If your repo already has a Dockerfile, pick **Dockerfile** and give its path. Autonoma builds it with [BuildKit](https://github.com/moby/buildkit), pushes the image to a private registry, and pulls it into the preview - you never handle registry credentials.

The Dockerfile path is resolved **relative to the build context**, which is where the two location fields below come in.

## Dockerfile build settings

These fields appear only for Dockerfile builds (a manual build always uses the repo root):

- **Path** - the directory of the app inside the repo, e.g. `apps/web`. It sets the default build context and is checked to exist in your repo. In a single-app repo, leave it blank for the root.
- **Root directory** - the Docker **build context**: the folder Docker builds from, and everything a `COPY` in your Dockerfile can read. Leave it blank to inherit **Path**; set it explicitly when a Dockerfile deeper in the repo needs to `COPY` files from higher up.
- **Start command** - overrides the container's default start command.

For a monorepo web app whose Dockerfile lives at `apps/web/Dockerfile` but copies a shared `packages/` folder from the repo root, set Path to `apps/web`, Root directory to `.` (the repo root - not blank, since blank inherits Path), and the Dockerfile path to `apps/web/Dockerfile` (it resolves relative to the build context).

## Per-app settings

A few fields apply to every app, whichever build method you pick:

| Field | What it does |
| --- | --- |
| **Name** | Lowercase identifier used in resource names and the preview URL. |
| **Port** | The port your app listens on inside the container. |

### The frontend app

When a project has more than one app, one is marked the **frontend** with a toggle. The frontend is the app Autonoma's agents open in the browser to test, and its URL becomes the preview's primary URL. Each project has exactly one frontend; the others still get their own URLs but aren't the entry point.

### Depends on

Once your project pulls in a [connected repository](/preview-environments/multirepo/), each app gets a **Depends on** control for start ordering: the app waits for the apps and services it lists before it starts. Use it when, for example, your frontend shouldn't boot until an API from another repository is reachable.

## Next steps

- [Environment variables and secrets](/preview-environments/secrets/) - wire config and credentials into each app
- [Multiple repositories](/preview-environments/multirepo/) - pull apps from more than one repository into the same preview
