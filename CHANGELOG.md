# Changelog

## [1.260808.2](https://github.com/Autonoma-AI/agent/compare/v1.260808.1...v1.260808.2) (2026-08-08)


### Bug Fixes

* **karpenter:** drop over-provisioned IOPS/throughput on buildkit volumes ([#2342](https://github.com/Autonoma-AI/agent/issues/2342)) ([f79dc36](https://github.com/Autonoma-AI/agent/commit/f79dc3685130c7b44ee4527adf4f427b52347d52))

## [1.260808.1](https://github.com/Autonoma-AI/agent/compare/v1.260807.4...v1.260808.1) (2026-08-08)


### Bug Fixes

* **ui:** stop nginx 502-ing the OAuth callback redirect ([#2338](https://github.com/Autonoma-AI/agent/issues/2338)) ([55313df](https://github.com/Autonoma-AI/agent/commit/55313dfc0dc569b682124c16b4a94f349bfef6bf))

## [1.260807.4](https://github.com/Autonoma-AI/agent/compare/v1.260807.3...v1.260807.4) (2026-08-07)


### Features

* catch and stop recipes seeding dates that expire ([#2238](https://github.com/Autonoma-AI/agent/issues/2238)) ([e23e515](https://github.com/Autonoma-AI/agent/commit/e23e5158be00a117b66fb99d27f5498e86a72d4b))
* **onboarding:** emit onboarding.dry_run_passed so a finished setup is measurable ([#2334](https://github.com/Autonoma-AI/agent/issues/2334)) ([c4db958](https://github.com/Autonoma-AI/agent/commit/c4db95844b52cb5f537314cda06de591cb678a1d))


### Bug Fixes

* **analysis:** build the classifier baseline from analysis verdicts ([#2272](https://github.com/Autonoma-AI/agent/issues/2272)) ([72cdf4e](https://github.com/Autonoma-AI/agent/commit/72cdf4e211766b7ceead3c43e307840f861fbc56))
* **docker-compose:** postgres:18 boot + temporal healthcheck ([#2302](https://github.com/Autonoma-AI/agent/issues/2302)) ([ec947bc](https://github.com/Autonoma-AI/agent/commit/ec947bcbccf6acb09e506a1aecde3130ce1904f9))
* **github:** refuse a second GitHub account instead of silently repointing the first ([#2167](https://github.com/Autonoma-AI/agent/issues/2167)) ([e46a96e](https://github.com/Autonoma-AI/agent/commit/e46a96e4ed22c6617783fa3197e55596e83ce00a))

## [1.260807.3](https://github.com/Autonoma-AI/agent/compare/v1.260807.2...v1.260807.3) (2026-08-07)


### Features

* **analysis:** freeze the classifier's preview app-log window ([#2186](https://github.com/Autonoma-AI/agent/issues/2186)) ([68c696b](https://github.com/Autonoma-AI/agent/commit/68c696b5a5cd2ae6f94b5a312743e7f0572bdb6f))
* **diffs:** make main-branch runs correct - retire the PR-0 sentinel ([#2018](https://github.com/Autonoma-AI/agent/issues/2018)) ([530036a](https://github.com/Autonoma-AI/agent/commit/530036adf66a1745ec3d90f377241f3124bb44ce))
* **platform:** build the CI runner fleet on Auto Scaling groups ([#2280](https://github.com/Autonoma-AI/agent/issues/2280)) ([72044e1](https://github.com/Autonoma-AI/agent/commit/72044e1bfb7ae110d7e8e9ceb0c397ca88b6d312))
* **previewkit:** right-size runner Job resources and instrument memory via Sentry spans ([#2286](https://github.com/Autonoma-AI/agent/issues/2286)) ([db603c9](https://github.com/Autonoma-AI/agent/commit/db603c989c5e0491b71136c56056c4bf55235087))
* **prometheus:** scrape Loki metrics and alert on WAL disk usage ([#2306](https://github.com/Autonoma-AI/agent/issues/2306)) ([347c654](https://github.com/Autonoma-AI/agent/commit/347c6548357d6c9bd552f03255775fede73bc767))
* re-add per-snapshot dependency-manifest pinning to the analysis pipeline ([#2227](https://github.com/Autonoma-AI/agent/issues/2227)) ([77752ef](https://github.com/Autonoma-AI/agent/commit/77752efb44e01ba12fbd9279d5cd755111d9d481))
* record usage ([#2143](https://github.com/Autonoma-AI/agent/issues/2143)) ([395dc23](https://github.com/Autonoma-AI/agent/commit/395dc236df8dfb07dd4b4812deac7cc1f0e3cc95))
* **ui:** empty state when a preview has scaled to zero ([#2121](https://github.com/Autonoma-AI/agent/issues/2121)) ([c7f60fa](https://github.com/Autonoma-AI/agent/commit/c7f60fab2e65d207ad0775dc38b44d12d0299473))
* **ui:** settings redesign - four destinations, a section rail, and visible scope ([#2130](https://github.com/Autonoma-AI/agent/issues/2130)) ([fdcab98](https://github.com/Autonoma-AI/agent/commit/fdcab98df08685fca94481ceb68d7a65ea8e3535))


### Bug Fixes

* **analysis:** a run that needs no tests is a confident verdict, not a failure ([#2246](https://github.com/Autonoma-AI/agent/issues/2246)) ([08502f0](https://github.com/Autonoma-AI/agent/commit/08502f01d64561381a4c65bf8b253e333f605052))
* **analytics:** split PostHog proxy off the "/ingest" path to dodge ad blockers ([#2318](https://github.com/Autonoma-AI/agent/issues/2318)) ([dbc41e6](https://github.com/Autonoma-AI/agent/commit/dbc41e64e0625780a60e91831d020e0bb475c98e))
* **api:** a superseded edit session no longer adopts or cancels the analysis run's snapshot ([#2274](https://github.com/Autonoma-AI/agent/issues/2274)) ([253fff0](https://github.com/Autonoma-AI/agent/commit/253fff0bc7cc4b4178d799ec75d98ee5fb221140))
* **cli:** upgrade js-yaml to 5.2.3 ([#2317](https://github.com/Autonoma-AI/agent/issues/2317)) ([5eb8e84](https://github.com/Autonoma-AI/agent/commit/5eb8e84ff7928b5eb923632a49d2b9d6673d0f26))
* **db:** remove the ai_cost_record organization_id migration until its writers ship ([#2326](https://github.com/Autonoma-AI/agent/issues/2326)) ([0c2d020](https://github.com/Autonoma-AI/agent/commit/0c2d020816cc0d14b9d05a0bc1b3326758a1cbfe))
* make org id nullable ([#2328](https://github.com/Autonoma-AI/agent/issues/2328)) ([14ee753](https://github.com/Autonoma-AI/agent/commit/14ee753b199977cf37496c0d18d30207f5a26303))
* **previewkit:** reduce default gatekeeper idle timeout to 15m ([#2307](https://github.com/Autonoma-AI/agent/issues/2307)) ([1477298](https://github.com/Autonoma-AI/agent/commit/147729875ad423c3ee7cef957b058d697209d8cf))
* **ui:** keep the old billing URL answering after the settings move ([#2319](https://github.com/Autonoma-AI/agent/issues/2319)) ([63d919e](https://github.com/Autonoma-AI/agent/commit/63d919e1da823eceea33002a18766346c55a5986))
* **ui:** statically bundle PostHog extensions to stop ad blockers catching the lazy-load fetch ([#2320](https://github.com/Autonoma-AI/agent/issues/2320)) ([c970ef6](https://github.com/Autonoma-AI/agent/commit/c970ef6102d84f9f6156837804defd9c898ec5c9))
* **workflow:** stop the analysis-run tests leaking executions into each other ([#2292](https://github.com/Autonoma-AI/agent/issues/2292)) ([5cf22a9](https://github.com/Autonoma-AI/agent/commit/5cf22a9642d030ef6b00935abdff84305aacd87a))


### Performance Improvements

* **db:** index every unindexed cascade foreign key ([#2312](https://github.com/Autonoma-AI/agent/issues/2312)) ([f3fe5be](https://github.com/Autonoma-AI/agent/commit/f3fe5be247aee5ebd0c9a7eb86305b2c7cad5b7d))

## [1.260807.2](https://github.com/Autonoma-AI/agent/compare/v1.260807.1...v1.260807.2) (2026-08-07)


### Bug Fixes

* **cli:** stop naming a command nobody has ([#2296](https://github.com/Autonoma-AI/agent/issues/2296)) ([d4979ce](https://github.com/Autonoma-AI/agent/commit/d4979ce5a2b0e9d20f06cc6bce67b0affddb33ae))

## [1.260807.1](https://github.com/Autonoma-AI/agent/compare/v1.260806.2...v1.260807.1) (2026-08-07)


### Features

* **analysis:** freeze the classifier's preview env-var names ([#2184](https://github.com/Autonoma-AI/agent/issues/2184)) ([3ee59fc](https://github.com/Autonoma-AI/agent/commit/3ee59fca0909f26076d57f54697ad2b7a47dd5ef))
* **api:** carry the browser's PostHog session id into server events ([#2235](https://github.com/Autonoma-AI/agent/issues/2235)) ([ed1af49](https://github.com/Autonoma-AI/agent/commit/ed1af49849dc112b6ed6d0456bd8fc6f8b765df8))
* **cli:** make the test review pass visible in the TUI ([#2225](https://github.com/Autonoma-AI/agent/issues/2225)) ([41e43fb](https://github.com/Autonoma-AI/agent/commit/41e43fbd5b74b456fc031a0439a5518d1275abda))
* **cli:** record the environment a run happened in, and dump it to a file ([#2278](https://github.com/Autonoma-AI/agent/issues/2278)) ([32ed8f0](https://github.com/Autonoma-AI/agent/commit/32ed8f0b21371f126af3eac47154ef79efda515d))
* **cli:** stop asking questions that have only one answer ([#2223](https://github.com/Autonoma-AI/agent/issues/2223)) ([e41006b](https://github.com/Autonoma-AI/agent/commit/e41006b0be21171b3586a0ca06cf1a53bb8735bf))
* **platform:** bake the CI runner AMI ([#2237](https://github.com/Autonoma-AI/agent/issues/2237)) ([cc9599b](https://github.com/Autonoma-AI/agent/commit/cc9599b5d903cff7a96ac715abd75e486b236bfe))
* **platform:** build the self-hosted runner image, and let Tailscale reach the cluster ([#2221](https://github.com/Autonoma-AI/agent/issues/2221)) ([7a5f7a6](https://github.com/Autonoma-AI/agent/commit/7a5f7a64d27563caa4630e41eaf07f47d2fa9d37))
* **ui:** hand SDK validation failures to a coding agent ([#2170](https://github.com/Autonoma-AI/agent/issues/2170)) ([f3fbd52](https://github.com/Autonoma-AI/agent/commit/f3fbd52891ffc3025bcc32e78c5d2fd0e99b9285))


### Bug Fixes

* **analysis:** never silently discard intended test work ([#2200](https://github.com/Autonoma-AI/agent/issues/2200)) ([4af66c7](https://github.com/Autonoma-AI/agent/commit/4af66c7fcc73167cc37949a9b3e5e2e7f3337bcb))
* **analysis:** put Impact Analysis back on Gemini and let list_tests show intent ([#2249](https://github.com/Autonoma-AI/agent/issues/2249)) ([06d4444](https://github.com/Autonoma-AI/agent/commit/06d4444254774cb4709f37565c0a829e8df4e3d7))
* **api:** drop the delete-generation endpoint ([#2271](https://github.com/Autonoma-AI/agent/issues/2271)) ([9544d45](https://github.com/Autonoma-AI/agent/commit/9544d451bb32d22594333da71651dbb298fc51fa))
* **api:** let an explicit deploy request build without asking impact analysis ([#2244](https://github.com/Autonoma-AI/agent/issues/2244)) ([3da8bc2](https://github.com/Autonoma-AI/agent/commit/3da8bc239241634eed1eaf782935aa651b89368f))
* **cli:** ask about autonomy once per run, not at every handoff ([#2294](https://github.com/Autonoma-AI/agent/issues/2294)) ([ed32f6b](https://github.com/Autonoma-AI/agent/commit/ed32f6b94d6b62fc4d3ca7dec01ba4a3606f5e58))
* **cli:** blame the missing coding agent, not the missing recipe.json ([#2276](https://github.com/Autonoma-AI/agent/issues/2276)) ([27adeb6](https://github.com/Autonoma-AI/agent/commit/27adeb6c1714aa819cdcdfa05da88121bdd1301d))
* **cli:** stop the TUI from leaking ~2.6 MB/s of short-lived Grid allocations ([#2226](https://github.com/Autonoma-AI/agent/issues/2226)) ([a29bead](https://github.com/Autonoma-AI/agent/commit/a29beadd9de462f616de091867d5c48e9c7b73cb))
* **engine:** stop the generation persister from writing test-case assignments ([#2270](https://github.com/Autonoma-AI/agent/issues/2270)) ([66fd3d7](https://github.com/Autonoma-AI/agent/commit/66fd3d72d4a192a75e3f1d552f305214929111c5))
* **previewkit:** do not judge a commit on a suite that does not exist yet ([#2245](https://github.com/Autonoma-AI/agent/issues/2245)) ([a3fe245](https://github.com/Autonoma-AI/agent/commit/a3fe245ede3835556095f7a0488ac6547f37fc98))
* **ui:** attach the organization group to browser events ([#2234](https://github.com/Autonoma-AI/agent/issues/2234)) ([8732997](https://github.com/Autonoma-AI/agent/commit/8732997219430197e9c10ae9940dbf30d0340be8))
* **ui:** give every route a pending and an error state ([#2131](https://github.com/Autonoma-AI/agent/issues/2131)) ([693c34b](https://github.com/Autonoma-AI/agent/commit/693c34b754a52bf85b5ee4edeb1739ddd64e8921))
* **ui:** leave finish setup when the setup is actually finished ([#2293](https://github.com/Autonoma-AI/agent/issues/2293)) ([d3e9bbe](https://github.com/Autonoma-AI/agent/commit/d3e9bbef54304f1b19ee8ffdc6bb3455e725ceea))
* **ui:** reach previewkit config in one click from a PR's Preview tab ([#2120](https://github.com/Autonoma-AI/agent/issues/2120)) ([60dae7c](https://github.com/Autonoma-AI/agent/commit/60dae7cb909126c135e6587b9eee60b36ea2dc81))

## [1.260806.2](https://github.com/Autonoma-AI/agent/compare/v1.260806.1...v1.260806.2) (2026-08-06)


### Bug Fixes

* **previewkit:** stop a skipped analysis run from cancelling its own preview build ([#2228](https://github.com/Autonoma-AI/agent/issues/2228)) ([d39037c](https://github.com/Autonoma-AI/agent/commit/d39037cc39763e1a540b290d94dff9ea704bd37f))

## [1.260806.1](https://github.com/Autonoma-AI/agent/compare/v1.260805.2...v1.260806.1) (2026-08-06)


### Features

* **api:** instrument the Vercel onboarding funnel in PostHog ([#2181](https://github.com/Autonoma-AI/agent/issues/2181)) ([3527c96](https://github.com/Autonoma-AI/agent/commit/3527c96d52f9ebdfa68f9d73e39c7631614d6f5c))
* **cli:** hand the SDK and dry run back to an agent when they do not pass ([#2222](https://github.com/Autonoma-AI/agent/issues/2222)) ([6f3e41f](https://github.com/Autonoma-AI/agent/commit/6f3e41fab6cf11c661e491e68779c1e724ca51d3))
* **cli:** let the agent check its recipe and prove it survives concurrent runs ([#2191](https://github.com/Autonoma-AI/agent/issues/2191)) ([446aead](https://github.com/Autonoma-AI/agent/commit/446aead437fd2ebe87b12838aa560e3013369971))
* **cli:** make the unattended path expressible and legible ([#2176](https://github.com/Autonoma-AI/agent/issues/2176)) ([d2d1443](https://github.com/Autonoma-AI/agent/commit/d2d144307fade3e106f1d841a7ec60ef4ecd627c))
* **cli:** the run proves the scenarios before it calls itself done ([#2175](https://github.com/Autonoma-AI/agent/issues/2175)) ([8a31784](https://github.com/Autonoma-AI/agent/commit/8a317844f4b8926a56ca9fe508d238e626972412))
* **deployment:** Karpenter, External Secrets and ARC for the cluster ([#2162](https://github.com/Autonoma-AI/agent/issues/2162)) ([7f6a34e](https://github.com/Autonoma-AI/agent/commit/7f6a34ee5b6d7a5b2b1c301d80f55feca8a4a23e))
* **ui:** hand finish setup to the agent that is doing it ([#2177](https://github.com/Autonoma-AI/agent/issues/2177)) ([c8f6ed2](https://github.com/Autonoma-AI/agent/commit/c8f6ed2827e425aee4be99dfe1064478e99cd39d))


### Bug Fixes

* **analysis:** don't open a run for a preview the customer has not deployed ([#2215](https://github.com/Autonoma-AI/agent/issues/2215)) ([ec0fab5](https://github.com/Autonoma-AI/agent/commit/ec0fab53a0a7ff5888a8387cc32deabdf0a93f2f))
* **api:** don't skip an unlinked repo's preview when gating on onboarding choice ([#2219](https://github.com/Autonoma-AI/agent/issues/2219)) ([105455d](https://github.com/Autonoma-AI/agent/commit/105455d940488aa50bc3f24a2984279791ee4017))
* **cli:** choose an agent headlessly instead of skipping the preview ([#2209](https://github.com/Autonoma-AI/agent/issues/2209)) ([3d7cf21](https://github.com/Autonoma-AI/agent/commit/3d7cf214f712ab8bc29bf7319927495306dec960))
* **cli:** pick the dry-run preview by the branch the repo is on ([#2208](https://github.com/Autonoma-AI/agent/issues/2208)) ([97f6484](https://github.com/Autonoma-AI/agent/commit/97f6484cc98269b9c17d6c70cd55013d25704e31))
* **cli:** take the app live itself instead of leaving it to the agent ([#2218](https://github.com/Autonoma-AI/agent/issues/2218)) ([f860f42](https://github.com/Autonoma-AI/agent/commit/f860f4202e5fed13fdad394508f9ae83a274bf8b))
* **platform:** allow previewkit VPC ingress to Loki ([#2188](https://github.com/Autonoma-AI/agent/issues/2188)) ([a99a52f](https://github.com/Autonoma-AI/agent/commit/a99a52f313f22782af89f4e2f4441c13727b321a))
* **ui:** address the right Autonoma, and the right application ([#2216](https://github.com/Autonoma-AI/agent/issues/2216)) ([57dcbdc](https://github.com/Autonoma-AI/agent/commit/57dcbdc8570dd9fd3152282962d9f6177a03a5c6))
* **ui:** let the agent advance onboarding instead of asking the user to ([#2212](https://github.com/Autonoma-AI/agent/issues/2212)) ([aa6a03c](https://github.com/Autonoma-AI/agent/commit/aa6a03c95d65656ed58c2603db88785623ab2f4f))
* **ui:** make the copied command paste safely into any shell ([#2220](https://github.com/Autonoma-AI/agent/issues/2220)) ([44a06df](https://github.com/Autonoma-AI/agent/commit/44a06dfc8bb10b3cc9c22ac5ec3f8d83c80667e0))
* **ui:** spin the outstanding rows on the agent finish-setup screen ([#2211](https://github.com/Autonoma-AI/agent/issues/2211)) ([9c2dffb](https://github.com/Autonoma-AI/agent/commit/9c2dffb7ff7c85e32bcfb3ace14afeae58b0ce4b))

## [1.260805.2](https://github.com/Autonoma-AI/agent/compare/v1.260805.1...v1.260805.2) (2026-08-05)


### Features

* **analysis:** classifier capture-to-replay eval harness ([#2149](https://github.com/Autonoma-AI/agent/issues/2149)) ([571d8d1](https://github.com/Autonoma-AI/agent/commit/571d8d1e5b78c17435b524d7c784b712d17c61ce))
* **ui:** the connect screen hands out one command ([#2173](https://github.com/Autonoma-AI/agent/issues/2173)) ([005be90](https://github.com/Autonoma-AI/agent/commit/005be9001b0f115e764b771ce4abb58d2305cb85))


### Bug Fixes

* **cli:** make the completion-watch cleanup test deterministic ([#2190](https://github.com/Autonoma-AI/agent/issues/2190)) ([fb40807](https://github.com/Autonoma-AI/agent/commit/fb408072bea3884a337114941aa25264d8a4028b))
* **deployment:** raise worker-general memory to 2Gi to stop OOMKills ([#2180](https://github.com/Autonoma-AI/agent/issues/2180)) ([89781ca](https://github.com/Autonoma-AI/agent/commit/89781ca0c962f40d63356cfd9fe3abeb30d343b9))
* **previewkit:** fail a declined preview build in seconds, not 30 minutes ([#2187](https://github.com/Autonoma-AI/agent/issues/2187)) ([6678bc5](https://github.com/Autonoma-AI/agent/commit/6678bc52246dd5d4ac14622379f2900816475d72))
* **secrets:** skip the write when a secret is re-asserted unchanged ([#2168](https://github.com/Autonoma-AI/agent/issues/2168)) ([c3f9329](https://github.com/Autonoma-AI/agent/commit/c3f9329e909f8406c9e45ba2a529584dd68178ff))
* **workflow:** cap the workflow cache instead of deriving it from the heap ([#2182](https://github.com/Autonoma-AI/agent/issues/2182)) ([35aa04f](https://github.com/Autonoma-AI/agent/commit/35aa04fee15b269bf41065a32d8fa6cc8b8fbffe))

## [1.260805.1](https://github.com/Autonoma-AI/agent/compare/v1.260804.1...v1.260805.1) (2026-08-05)


### Features

* **cli:** read onboarding state and mint pairing codes ([#2160](https://github.com/Autonoma-AI/agent/issues/2160)) ([52786d8](https://github.com/Autonoma-AI/agent/commit/52786d8dc9c335f1b15ea776086d44cd147eb059))
* **cli:** register the onboarding MCP with the agent it spawns ([#2161](https://github.com/Autonoma-AI/agent/issues/2161)) ([8951d46](https://github.com/Autonoma-AI/agent/commit/8951d464ff423c85fa6dcb28f1b74e0a6ddd71c0))
* **cli:** set up the preview environment before the pipeline ([#2169](https://github.com/Autonoma-AI/agent/issues/2169)) ([7b26a25](https://github.com/Autonoma-AI/agent/commit/7b26a25ecdfec60652a6ce225d2330d7bf69bb07))
* **mcp:** serve every tool at /v1/mcp and keep the old paths as aliases ([#2159](https://github.com/Autonoma-AI/agent/issues/2159)) ([e0c9379](https://github.com/Autonoma-AI/agent/commit/e0c9379fc27d1f642a7841189069396b98101838))
* **previewkit:** add the additive blueprint (preset-based) deploy model ([#1544](https://github.com/Autonoma-AI/agent/issues/1544)) ([aea162a](https://github.com/Autonoma-AI/agent/commit/aea162a37c28c85fe925f1395c1cdc5fb23023a0))
* **previewkit:** gate the preview build on impact analysis ([#1937](https://github.com/Autonoma-AI/agent/issues/1937)) ([3dfca6e](https://github.com/Autonoma-AI/agent/commit/3dfca6eb0d02f1e378ada2b319971fb55b2ce880))


### Bug Fixes

* **api:** scope the onboarding reads to the caller's organization ([#2166](https://github.com/Autonoma-AI/agent/issues/2166)) ([505d4ce](https://github.com/Autonoma-AI/agent/commit/505d4cef9b2de6b069ab610c1f3833d9a5346898))
* **api:** stop stale onboarding pairing codes from pairing an agent ([#2172](https://github.com/Autonoma-AI/agent/issues/2172)) ([f10f296](https://github.com/Autonoma-AI/agent/commit/f10f2962d1e42f75f36dd1be6d5a303fb1bc5691))
* **cli:** make the preview handoff survive a real run ([#2171](https://github.com/Autonoma-AI/agent/issues/2171)) ([daf554a](https://github.com/Autonoma-AI/agent/commit/daf554ab56dc3eabd2638f861252875a2b1e7508))
* **mcp:** attribute the either-form tools to the org they resolve ([#2165](https://github.com/Autonoma-AI/agent/issues/2165)) ([3294130](https://github.com/Autonoma-AI/agent/commit/329413026ee8529445415ccc9dfe146272c57cb8))
* **ui:** drop the redundant finish-setup takeover on Home ([#2157](https://github.com/Autonoma-AI/agent/issues/2157)) ([217294b](https://github.com/Autonoma-AI/agent/commit/217294bf6b9f3368161f74c0bdd63576d4402ae1))

## [1.260804.1](https://github.com/Autonoma-AI/agent/compare/v1.260803.3...v1.260804.1) (2026-08-04)


### Features

* **analysis:** run impact analysis on gpt-5.6-luna ([#2085](https://github.com/Autonoma-AI/agent/issues/2085)) ([8fa4caf](https://github.com/Autonoma-AI/agent/commit/8fa4cafc2cfafe59dbc34d739fe62a644f762f9a))
* **api:** let an agent drive the GitHub connection ([#2098](https://github.com/Autonoma-AI/agent/issues/2098)) ([39dc235](https://github.com/Autonoma-AI/agent/commit/39dc235a715b1e597fb35f457c3471d6c77bd717))
* **api:** let an agent finish onboarding ([#2133](https://github.com/Autonoma-AI/agent/issues/2133)) ([a55bc47](https://github.com/Autonoma-AI/agent/commit/a55bc4784b8b4c051a0471153a1c7cab9c2a5de9))
* **api:** support the Vercel path in the onboarding MCP ([#2107](https://github.com/Autonoma-AI/agent/issues/2107)) ([551da45](https://github.com/Autonoma-AI/agent/commit/551da455314a84b8f3f0138d4e10c4169dccfa6b))
* **deployment:** pin alpha-build.yml workloads to a spot-only Karpenter pool ([#2132](https://github.com/Autonoma-AI/agent/issues/2132)) ([7584599](https://github.com/Autonoma-AI/agent/commit/7584599f92af04e18d7668e7ae178c163ce83343))
* **previewkit:** all-or-nothing previews + scale failed environments to zero ([#2138](https://github.com/Autonoma-AI/agent/issues/2138)) ([920779e](https://github.com/Autonoma-AI/agent/commit/920779e5143fb9a297b5d44070268fc720a9f104))
* **terraform:** declare the runners EKS cluster ([#2134](https://github.com/Autonoma-AI/agent/issues/2134)) ([8bf5117](https://github.com/Autonoma-AI/agent/commit/8bf51170e86ba68e941588ce476abed38f884b13))
* **terraform:** move state to S3 and add plan-on-PR CI ([#2096](https://github.com/Autonoma-AI/agent/issues/2096)) ([bd5a949](https://github.com/Autonoma-AI/agent/commit/bd5a949f9a2335ef7655a3763e7b6f57fc61b724))
* **ui:** let an agent on another machine authenticate ([#2137](https://github.com/Autonoma-AI/agent/issues/2137)) ([8d7c1ff](https://github.com/Autonoma-AI/agent/commit/8d7c1fffd1b9ebaeddbd7db4abbfd17678b35bfd))
* **ui:** page the pull-request lists 25 at a time ([#2108](https://github.com/Autonoma-AI/agent/issues/2108)) ([31e403f](https://github.com/Autonoma-AI/agent/commit/31e403ff56eda479f905b6514855cfeffa7d47ef))
* vercel demo app ([#2023](https://github.com/Autonoma-AI/agent/issues/2023)) ([10e24c8](https://github.com/Autonoma-AI/agent/commit/10e24c82cc72e5e874cad77a21223f35949f3c92))


### Bug Fixes

* **api:** make the discovery catalog pass an ARD validator ([#2101](https://github.com/Autonoma-AI/agent/issues/2101)) ([7c4b4c1](https://github.com/Autonoma-AI/agent/commit/7c4b4c10fef49505bb07682fedcbcf4be8e74dcf))
* **engine-web:** make WebDeployment.file nullable and ignore it when absent ([#2153](https://github.com/Autonoma-AI/agent/issues/2153)) ([c24a5ca](https://github.com/Autonoma-AI/agent/commit/c24a5ca70bfbaec2a3386025413e3deb8fd64e4e))
* **monitoring:** require 10m of NotReady before NodeNotReady pages ([#2118](https://github.com/Autonoma-AI/agent/issues/2118)) ([7f3310a](https://github.com/Autonoma-AI/agent/commit/7f3310ad1c174be175f04077d9a20f3ae709d3c6))
* **onboarding:** lead with the coding agent for Vercel-origin users ([#2104](https://github.com/Autonoma-AI/agent/issues/2104)) ([4fcde6e](https://github.com/Autonoma-AI/agent/commit/4fcde6e1e8a81ba4053d8bf55938004d7a3a7f2c))
* **terraform:** harden main-vpc security groups, reconcile with concurrent AWS changes ([#2097](https://github.com/Autonoma-AI/agent/issues/2097)) ([5708831](https://github.com/Autonoma-AI/agent/commit/57088310d0b3461869d63016e109707061a3d532))
* **terraform:** plan as a read-only role so CI can refresh state ([#2135](https://github.com/Autonoma-AI/agent/issues/2135)) ([846dba4](https://github.com/Autonoma-AI/agent/commit/846dba427156f7c6f24813fcfec57ecb58a9a1e1))
* **terraform:** stop main-vpc route tables from showing spurious plan diffs ([#2117](https://github.com/Autonoma-AI/agent/issues/2117)) ([b75ba0b](https://github.com/Autonoma-AI/agent/commit/b75ba0b8947008c908c38ccf3d79fa3909a7ac67))
* **ui:** collapse the Claude Code MCP block to one command ([#2110](https://github.com/Autonoma-AI/agent/issues/2110)) ([e637782](https://github.com/Autonoma-AI/agent/commit/e637782dae69fc843ca65c23f76088797245d3d2))
* **ui:** hide the app sidebar on the finish-setup flow ([#2152](https://github.com/Autonoma-AI/agent/issues/2152)) ([630b130](https://github.com/Autonoma-AI/agent/commit/630b130149894b9e628a1c2cdd15ac9adafa4286))
* **ui:** make the MCP install block install, authorize, and launch ([#2105](https://github.com/Autonoma-AI/agent/issues/2105)) ([c640b98](https://github.com/Autonoma-AI/agent/commit/c640b9888a1573d2a75d93a62e5594fb55f8564d))
* **ui:** surface an empty Vercel deployment list as a blocker with a retry ([#2006](https://github.com/Autonoma-AI/agent/issues/2006)) ([4e4dd31](https://github.com/Autonoma-AI/agent/commit/4e4dd318a201ac7198a2a072841651ace75262c3))


### Performance Improvements

* **api:** count assigned tests instead of listing them ([#2103](https://github.com/Autonoma-AI/agent/issues/2103)) ([5aad2c2](https://github.com/Autonoma-AI/agent/commit/5aad2c2805afa8eb495360a06169c95612308ad3))
* **ui:** collapse the app-shell query waterfall from three waves to two ([#2128](https://github.com/Autonoma-AI/agent/issues/2128)) ([38c3f42](https://github.com/Autonoma-AI/agent/commit/38c3f4241f8da4940c7dce236003bdd26014d190))

## [1.260803.3](https://github.com/Autonoma-AI/agent/compare/v1.260803.2...v1.260803.3) (2026-08-03)


### Features

* **activation:** trigger-config settings page and run-from-Autonoma button ([#2017](https://github.com/Autonoma-AI/agent/issues/2017)) ([f4902c4](https://github.com/Autonoma-AI/agent/commit/f4902c4c550d8df025d32d0757813cec4c15c748))
* **api:** make an unauthorized response teach how to authenticate ([#2091](https://github.com/Autonoma-AI/agent/issues/2091)) ([79a9f6c](https://github.com/Autonoma-AI/agent/commit/79a9f6c19492aa2a3f8d3c55386eef59790c1b05))
* **api:** publish an agent discovery catalog ([#2093](https://github.com/Autonoma-AI/agent/issues/2093)) ([ff268cf](https://github.com/Autonoma-AI/agent/commit/ff268cf3230c553c8e1579f8881b1db57154b7a7))
* **api:** serve llms.txt and advertise the catalog on every response ([#2095](https://github.com/Autonoma-AI/agent/issues/2095)) ([24ec9ea](https://github.com/Autonoma-AI/agent/commit/24ec9ea489605d01021eea1f155088668333c6f9))
* **terraform:** import security groups and rules for main-vpc and previewkit-vpc ([#2089](https://github.com/Autonoma-AI/agent/issues/2089)) ([6996527](https://github.com/Autonoma-AI/agent/commit/699652757b6cb4dd0e5b26b6e3dce472c0d10f7f))


### Bug Fixes

* **ui:** key preview liveness and investigation presence by application ([#2094](https://github.com/Autonoma-AI/agent/issues/2094)) ([56e0aea](https://github.com/Autonoma-AI/agent/commit/56e0aeabd67bfb46fcab18040ddc7efc3fe96029))

## [1.260803.2](https://github.com/Autonoma-AI/agent/compare/v1.260803.1...v1.260803.2) (2026-08-03)


### Features

* **analysis:** owner-grouped PR comment body + confidence-first Reporter contract ([#2014](https://github.com/Autonoma-AI/agent/issues/2014)) ([ef5c004](https://github.com/Autonoma-AI/agent/commit/ef5c00456c30b2ab9d96adf6c3d0b045ff8a9572))
* **api:** accept an API key on the MCP surface ([#2086](https://github.com/Autonoma-AI/agent/issues/2086)) ([2302f7f](https://github.com/Autonoma-AI/agent/commit/2302f7f95d6020cd56751e27aebfae49319a2ce6))
* **api:** resolve repo names via the GitHub App in migrate-preview-config-v2 ([#2077](https://github.com/Autonoma-AI/agent/issues/2077)) ([e51613f](https://github.com/Autonoma-AI/agent/commit/e51613fb719cfe77478b16836496980219df48ba))
* **cli:** formbricks SDK-integration eval case ([#2033](https://github.com/Autonoma-AI/agent/issues/2033)) ([88465d2](https://github.com/Autonoma-AI/agent/commit/88465d28aae25f1935fcd3d59f5c0a2373050986))
* **diffs:** re-verify the branch's open bugs so a fixed one can resolve ([#2009](https://github.com/Autonoma-AI/agent/issues/2009)) ([e1de2a3](https://github.com/Autonoma-AI/agent/commit/e1de2a37ae43a48303eba2d1c10209a194ee2591))
* **terraform:** import subnets, route tables, gateways, and VPC endpoints ([#2075](https://github.com/Autonoma-AI/agent/issues/2075)) ([8d0d99f](https://github.com/Autonoma-AI/agent/commit/8d0d99fd3d600e295677a6815ae30d3e7dbfab8f))
* **ui:** one presenter for main's open problems (legacy Bug vs AnalysisIssue) ([#2025](https://github.com/Autonoma-AI/agent/issues/2025)) ([b1ccc59](https://github.com/Autonoma-AI/agent/commit/b1ccc595de36176766df1b8822fd01146b5fa8fa))
* **ui:** warn before deleting a colleague's API key ([#2088](https://github.com/Autonoma-AI/agent/issues/2088)) ([4b690bd](https://github.com/Autonoma-AI/agent/commit/4b690bd21a38b452c43ba2d80c6f43fec4355466))


### Bug Fixes

* **analysis:** decline model-filled fields with null, never an empty string ([#2055](https://github.com/Autonoma-AI/agent/issues/2055)) ([e3e3891](https://github.com/Autonoma-AI/agent/commit/e3e3891e43cb39e50a8cf1b7ba6d37fac7e1ac74))
* **api:** delete an application's config rows on delete ([#2079](https://github.com/Autonoma-AI/agent/issues/2079)) ([d03472d](https://github.com/Autonoma-AI/agent/commit/d03472d3756977cf133776a12e2c991dda345545))
* **ci:** supersede in-flight per-app builds on new commits ([#2087](https://github.com/Autonoma-AI/agent/issues/2087)) ([656f0ad](https://github.com/Autonoma-AI/agent/commit/656f0ada1ee444a4d5e9ad9e51637e972e49df8c))
* **terraform:** remove the retired AMP (aps-workspaces) VPC endpoints ([#2083](https://github.com/Autonoma-AI/agent/issues/2083)) ([3360b54](https://github.com/Autonoma-AI/agent/commit/3360b548e1593dfabafa8ad7953e9c380f3432c9))
* **ui:** agent-configured apps can finish onboarding ([#2082](https://github.com/Autonoma-AI/agent/issues/2082)) ([9a318ef](https://github.com/Autonoma-AI/agent/commit/9a318ef3f7d857a4c66bbd9d7d2955503d42475b))


### Performance Improvements

* **ci:** stop deploy-services test jobs re-testing the whole dependency graph ([#2081](https://github.com/Autonoma-AI/agent/issues/2081)) ([a97ad56](https://github.com/Autonoma-AI/agent/commit/a97ad5677497dce741f956facd6b410ab14add04))

## [1.260803.1](https://github.com/Autonoma-AI/agent/compare/v1.260801.2...v1.260803.1) (2026-08-03)


### Features

* **previewkit:** merge dependency documents into one repository-tagged config (v2) ([#2058](https://github.com/Autonoma-AI/agent/issues/2058)) ([8a7aec4](https://github.com/Autonoma-AI/agent/commit/8a7aec439a4cb1028614056bcd11f64b4e8c1d8d))
* **secrets:** add operator script to encrypt/decrypt one previewkit secret ([#2048](https://github.com/Autonoma-AI/agent/issues/2048)) ([c032890](https://github.com/Autonoma-AI/agent/commit/c032890bccf1cd19ee36a047024ed57c28a149ff))
* **terraform:** decommission utility-vpc and legacy-vpc ([#2074](https://github.com/Autonoma-AI/agent/issues/2074)) ([07c0a07](https://github.com/Autonoma-AI/agent/commit/07c0a079cd5eda61d579af375ce7b4a0559dc960))
* **terraform:** import us-east-1 VPCs as the first Terraform migration slice ([#2066](https://github.com/Autonoma-AI/agent/issues/2066)) ([afc5a7b](https://github.com/Autonoma-AI/agent/commit/afc5a7b358bb84f86d749d7f3fa25d78c15749d0))


### Bug Fixes

* **agent-core:** a duplicate result-tool call no longer kills the run ([#2061](https://github.com/Autonoma-AI/agent/issues/2061)) ([bd85796](https://github.com/Autonoma-AI/agent/commit/bd85796398b719ccc6b10e0d3b60f2d6ddc4ab8d))
* **analysis:** persist Impact Analysis conversation and cost record ([#2057](https://github.com/Autonoma-AI/agent/issues/2057)) ([2736284](https://github.com/Autonoma-AI/agent/commit/273628459aeda55ebe5ba300716411bb6581386d))
* **monitoring:** change NodeNotReady alert duration from 2m to 5m ([#2064](https://github.com/Autonoma-AI/agent/issues/2064)) ([9389a2e](https://github.com/Autonoma-AI/agent/commit/9389a2ec9b173c5707ceb0ecbbc3c3622d66bfd5))
* **ui:** show "Impact analysis" to clients on the analysis snapshot page ([#2073](https://github.com/Autonoma-AI/agent/issues/2073)) ([47ba619](https://github.com/Autonoma-AI/agent/commit/47ba6193095e098107b9bcf2c817a85e129ea5f6))

## [1.260801.2](https://github.com/Autonoma-AI/agent/compare/v1.260801.1...v1.260801.2) (2026-08-01)


### Features

* **previewkit:** drop org-level secrets and addon provisioning ([#2046](https://github.com/Autonoma-AI/agent/issues/2046)) ([4db6bf3](https://github.com/Autonoma-AI/agent/commit/4db6bf3f77ad2e80991a553f508517711daca31e))

## [1.260801.1](https://github.com/Autonoma-AI/agent/compare/v1.260731.2...v1.260801.1) (2026-08-01)


### Features

* **analysis:** confidence-first PR verdict SSOT ([#1983](https://github.com/Autonoma-AI/agent/issues/1983)) ([496c62a](https://github.com/Autonoma-AI/agent/commit/496c62a2b29bb6017fbf94960e71e83b18fc4c8d))
* **api:** gate analysis runs behind label and ready-for-review activation triggers ([#1963](https://github.com/Autonoma-AI/agent/issues/1963)) ([9e61884](https://github.com/Autonoma-AI/agent/commit/9e6188402101bc3c31ffe3ad4d8e52e8f8c22c90))
* **api:** onboarding MCP support for the bring-your-own-deploys path ([#2031](https://github.com/Autonoma-AI/agent/issues/2031)) ([cebe172](https://github.com/Autonoma-AI/agent/commit/cebe17230c67f378a455e20b884163f0b296368e))
* billing usage vercel ([#1890](https://github.com/Autonoma-AI/agent/issues/1890)) ([414393e](https://github.com/Autonoma-AI/agent/commit/414393e7cc873ba64f8801e91a06e35f1d926960))
* **diffs:** absorb merged branches' plan work on main-branch analysis runs ([#2004](https://github.com/Autonoma-AI/agent/issues/2004)) ([39c8725](https://github.com/Autonoma-AI/agent/commit/39c87253d7adbbdf5c9ac8d24a96129ff7ae410a))
* **previewkit:** drop awsSecretArn and retire the backfill script ([#2015](https://github.com/Autonoma-AI/agent/issues/2015)) ([6a777d3](https://github.com/Autonoma-AI/agent/commit/6a777d3696415c8376f3aeb59debcd6c40f4096b))
* **ui:** ask about tenant isolation before database branching ([#2028](https://github.com/Autonoma-AI/agent/issues/2028)) ([9ec1067](https://github.com/Autonoma-AI/agent/commit/9ec1067eb7b6fffd9271a1498edc5f6ea298599c))
* **ui:** present the deploy signal as a template, not a required workflow ([#2027](https://github.com/Autonoma-AI/agent/issues/2027)) ([8c389f5](https://github.com/Autonoma-AI/agent/commit/8c389f5ad72ec3b78e740d78496f37fbf90d7513))


### Bug Fixes

* **analysis:** give every agent the PR's real commit range ([#1999](https://github.com/Autonoma-AI/agent/issues/1999)) ([0a0dd2d](https://github.com/Autonoma-AI/agent/commit/0a0dd2d6f266c0666ef2e1b13a43ef323a48d4cb))
* **analysis:** migrate the classifier onto AgentLoop and correct the evidence it reasons from ([#1958](https://github.com/Autonoma-AI/agent/issues/1958)) ([d4c5ee9](https://github.com/Autonoma-AI/agent/commit/d4c5ee97104fdaddfc85766964eb8732d4df8bdb))
* **analysis:** name the open bug issues in the blocking merge-gate check ([#2026](https://github.com/Autonoma-AI/agent/issues/2026)) ([67402d8](https://github.com/Autonoma-AI/agent/commit/67402d8b762231427ec9e736cf75d7475eaee3d0))
* **engine:** stop the execution agent when the model narrates instead of acting ([#2032](https://github.com/Autonoma-AI/agent/issues/2032)) ([480a971](https://github.com/Autonoma-AI/agent/commit/480a9718e571e05e4863af409eb0ad3ab87fdad5))
* **ui:** drop the dead "I've installed it - refresh" button from onboarding ([#2037](https://github.com/Autonoma-AI/agent/issues/2037)) ([60788c9](https://github.com/Autonoma-AI/agent/commit/60788c97aac4f9e5f73004a1815eadcf63ec64f3))
* **ui:** gate the connect-your-deploys step on a real signal ([#2021](https://github.com/Autonoma-AI/agent/issues/2021)) ([1663efc](https://github.com/Autonoma-AI/agent/commit/1663efcbddc5b4c101f14a53c5e59ea44af3f0c5))
* **ui:** use the braille spinner on the MCP configuring screen ([#2038](https://github.com/Autonoma-AI/agent/issues/2038)) ([67f43fe](https://github.com/Autonoma-AI/agent/commit/67f43fee60a174dfc17f7c9a6a9e1cb290aa0150))

## [1.260731.2](https://github.com/Autonoma-AI/agent/compare/v1.260731.1...v1.260731.2) (2026-07-31)


### Features

* **api:** make Postgres the only store for previewkit secret values ([#2007](https://github.com/Autonoma-AI/agent/issues/2007)) ([4b27eec](https://github.com/Autonoma-AI/agent/commit/4b27eecc07f959941990c5e2fcf9e0b41368a25f))
* **previewkit:** read build-time and addon secrets from Postgres only ([#2010](https://github.com/Autonoma-AI/agent/issues/2010)) ([57afdfe](https://github.com/Autonoma-AI/agent/commit/57afdfe66be8a776a4a6c49b6cb81bb321211ddc))
* **previewkit:** write every preview's runtime Secret from Postgres ([#2011](https://github.com/Autonoma-AI/agent/issues/2011)) ([e4f119e](https://github.com/Autonoma-AI/agent/commit/e4f119e18c52c3311550067fab1543eff8bb375d))


### Bug Fixes

* **ai:** take video capability from the registry, not the provider string ([#2002](https://github.com/Autonoma-AI/agent/issues/2002)) ([c0dafa3](https://github.com/Autonoma-AI/agent/commit/c0dafa33c3aa8d01527a7d4554f8368bc33fb159))
* **api:** restore the demo visitor's real session on exit ([#2012](https://github.com/Autonoma-AI/agent/issues/2012)) ([69d4737](https://github.com/Autonoma-AI/agent/commit/69d47374bc0568ddddc11b39a94019a33a4e0494))
* **blacklight:** type chart tooltip/legend payloads explicitly for TS7 + React 19 ([#2005](https://github.com/Autonoma-AI/agent/issues/2005)) ([3e77581](https://github.com/Autonoma-AI/agent/commit/3e775818839ba36b25ee624dc8bbccbfab982fc2))
* **ci:** stop extra alpha labels from cancelling the in-flight deploy ([#1976](https://github.com/Autonoma-AI/agent/issues/1976)) ([42c0d0e](https://github.com/Autonoma-AI/agent/commit/42c0d0e5bb1f430c1f5ef04c706743d8c09131f3))
* **previewkit:** stop naming AWS as the secret store in UI copy and docs ([#2013](https://github.com/Autonoma-AI/agent/issues/2013)) ([0ca09bb](https://github.com/Autonoma-AI/agent/commit/0ca09bbe1502ced9170b886728db256ac383646d))

## [1.260731.1](https://github.com/Autonoma-AI/agent/compare/v1.260730.4...v1.260731.1) (2026-07-31)


### Features

* **cli:** make the coding agent branch and open a PR for its integration ([#1994](https://github.com/Autonoma-AI/agent/issues/1994)) ([3406c9d](https://github.com/Autonoma-AI/agent/commit/3406c9debe0f8a64ee0f337c29686dda85c48acd))
* **diffs:** generation-review video reviewer on Gemini-3.5-flash-lite ([#1995](https://github.com/Autonoma-AI/agent/issues/1995)) ([c9b68d0](https://github.com/Autonoma-AI/agent/commit/c9b68d0edcf7f8c383ba43b00b62ecc9fa8c8877))
* **engine-web:** Qwen grounding pointer + Flash-lite agent loop ([#1992](https://github.com/Autonoma-AI/agent/issues/1992)) ([ef38ebc](https://github.com/Autonoma-AI/agent/commit/ef38ebc8f3c941bf3f80fdbaf26485b721ac2521))


### Bug Fixes

* **cli:** let the integration agent finish when it genuinely cannot push ([#1996](https://github.com/Autonoma-AI/agent/issues/1996)) ([f731541](https://github.com/Autonoma-AI/agent/commit/f7315417cc9335d74d0c9491346201a29715e77c))
* **cli:** make the test-generator step converge, ground its data, and enforce its own rules ([#1998](https://github.com/Autonoma-AI/agent/issues/1998)) ([c8daf82](https://github.com/Autonoma-AI/agent/commit/c8daf8208f1ea678a14feb993f7f0e0048dad849))

## [1.260730.4](https://github.com/Autonoma-AI/agent/compare/v1.260730.3...v1.260730.4) (2026-07-30)


### Features

* **previewkit:** write preview runtime secrets from Postgres ([#1970](https://github.com/Autonoma-AI/agent/issues/1970)) ([92f127b](https://github.com/Autonoma-AI/agent/commit/92f127b68801c788152547d67c12b90344504c45))
* **secrets:** read a preview's env by repo from Postgres ([#1979](https://github.com/Autonoma-AI/agent/issues/1979)) ([34ce54c](https://github.com/Autonoma-AI/agent/commit/34ce54c3679844df9b1d9e49ccf7e731d4536a3c))
* **ui:** move the test-user action beside the preview URL ([#1971](https://github.com/Autonoma-AI/agent/issues/1971)) ([5e07590](https://github.com/Autonoma-AI/agent/commit/5e075902442b8e23fd19c63158d7948a4953d990))
* **ui:** offer the coding agent on every SDK failure, not just finish-setup ([#1977](https://github.com/Autonoma-AI/agent/issues/1977)) ([b95cb46](https://github.com/Autonoma-AI/agent/commit/b95cb4685824b079d075bf973cf561d3e317e9b6))


### Bug Fixes

* **agent-core:** stop the run on fatal tool errors and always carry the transcript ([#1966](https://github.com/Autonoma-AI/agent/issues/1966)) ([57bde28](https://github.com/Autonoma-AI/agent/commit/57bde28531d94b916e7a41223807a79d5b8aef5c))
* **api:** fail a secret write the mirror could not land, once Postgres serves reads ([#1980](https://github.com/Autonoma-AI/agent/issues/1980)) ([01703e3](https://github.com/Autonoma-AI/agent/commit/01703e33b54b513b35131e10bc8e37fd70457bfb))
* **cli:** reserve budget to act on what the review finds ([#1969](https://github.com/Autonoma-AI/agent/issues/1969)) ([b2ff84d](https://github.com/Autonoma-AI/agent/commit/b2ff84db7f403d8eee3925bbbbef7781c2c75ae8))
* **cli:** stop capping how much a run may log ([#1978](https://github.com/Autonoma-AI/agent/issues/1978)) ([4ae85aa](https://github.com/Autonoma-AI/agent/commit/4ae85aaab2fee0290bb45ab0d4b7179aede65247))
* **cli:** tell the journey agent which node its tests belong to ([#1975](https://github.com/Autonoma-AI/agent/issues/1975)) ([0448a27](https://github.com/Autonoma-AI/agent/commit/0448a27df2d46ac670cc3f18a874f174fa57f32b))

## [1.260730.3](https://github.com/Autonoma-AI/agent/compare/v1.260730.2...v1.260730.3) (2026-07-30)


### Features

* **engine-web:** draw a synthetic cursor into run recordings ([#1968](https://github.com/Autonoma-AI/agent/issues/1968)) ([227ac04](https://github.com/Autonoma-AI/agent/commit/227ac04dc5de4bdeb8f09ddfd5d7004bbea8f8b7))
* lease gh app label ([#1949](https://github.com/Autonoma-AI/agent/issues/1949)) ([e903fdd](https://github.com/Autonoma-AI/agent/commit/e903fdd091566731a73fe8a61a7878246826f61b))
* **mcp:** serve a PR's analysis to a coding agent via get_analysis ([#1942](https://github.com/Autonoma-AI/agent/issues/1942)) ([ef23f4d](https://github.com/Autonoma-AI/agent/commit/ef23f4dc1834b38cb16aaedc14194cb3f4c46111))
* **onboarding:** add a "View demo" button beside the GitHub install ([#1936](https://github.com/Autonoma-AI/agent/issues/1936)) ([60806f8](https://github.com/Autonoma-AI/agent/commit/60806f82b7db2b9ac146e11655d7571c0199b6e9))
* **previewkit:** read build-time secret values from Postgres ([#1967](https://github.com/Autonoma-AI/agent/issues/1967)) ([c0b1e5b](https://github.com/Autonoma-AI/agent/commit/c0b1e5b388b0e65ce2e1d9da5cf74e866b30f437))
* **preview:** title preview PR status comments "Preview Environment" ([#1964](https://github.com/Autonoma-AI/agent/issues/1964)) ([ee28721](https://github.com/Autonoma-AI/agent/commit/ee28721adecca1a76498a908488b398d9a655a8e))
* **skill:** add a client-weekly-report skill ([#1965](https://github.com/Autonoma-AI/agent/issues/1965)) ([b89fae3](https://github.com/Autonoma-AI/agent/commit/b89fae3e6ab128bc7f26fcd865841010eba0f714))
* **worker-web:** move S3 access to an IRSA service account ([#1960](https://github.com/Autonoma-AI/agent/issues/1960)) ([41d5dd5](https://github.com/Autonoma-AI/agent/commit/41d5dd5b6c862fc62fe2ff4240a32469f0ff9b98))
* **workers:** move diffs and investigation AWS access to IRSA ([#1961](https://github.com/Autonoma-AI/agent/issues/1961)) ([3d6e30e](https://github.com/Autonoma-AI/agent/commit/3d6e30e9b9b34eb4092cf9f708a486b610ae22da))

## [1.260730.2](https://github.com/Autonoma-AI/agent/compare/v1.260730.1...v1.260730.2) (2026-07-30)


### Features

* **api:** gate analysis behind activation with a /start analysis trigger ([#1859](https://github.com/Autonoma-AI/agent/issues/1859)) ([d18d4c1](https://github.com/Autonoma-AI/agent/commit/d18d4c11b1fc39a4f6b896fc9c0e1a35baa228d4))
* **api:** move AWS access to an IRSA service account ([#1848](https://github.com/Autonoma-AI/agent/issues/1848)) ([e0c23d2](https://github.com/Autonoma-AI/agent/commit/e0c23d2710766a2ec80f6fa1ab3fb20d62afeb65))
* **ci:** delete Slack PR-ready notification on merge ([#1953](https://github.com/Autonoma-AI/agent/issues/1953)) ([b84cf69](https://github.com/Autonoma-AI/agent/commit/b84cf69d57e169471e4145781563c078a176c9ab))
* cleanup stale gh app assignments on alphas ([#1956](https://github.com/Autonoma-AI/agent/issues/1956)) ([519fd59](https://github.com/Autonoma-AI/agent/commit/519fd59ace919b8355996c10fbc138423cc89c0e))
* **preview-config:** default a new variable to build-time injection ([#1938](https://github.com/Autonoma-AI/agent/issues/1938)) ([05003aa](https://github.com/Autonoma-AI/agent/commit/05003aa44157a761353a56dac95c4c1a4edd3ec4))
* **preview-config:** save secret changes without the config ([#1927](https://github.com/Autonoma-AI/agent/issues/1927)) ([acac9d6](https://github.com/Autonoma-AI/agent/commit/acac9d63abef6612769eb22c683261e4b5c6d22e))
* **previewkit:** add the Secrets Manager backfill and verifier ([#1943](https://github.com/Autonoma-AI/agent/issues/1943)) ([b3223a4](https://github.com/Autonoma-AI/agent/commit/b3223a451a7eb6fbb5c83790fb8ce92146c9165d))
* **previewkit:** serve previewkit secret reads from Postgres ([#1950](https://github.com/Autonoma-AI/agent/issues/1950)) ([220bc08](https://github.com/Autonoma-AI/agent/commit/220bc0826c7cdce004eda0f3fc31885756043d2d))
* **previewkit:** shadow-read the Postgres secret mirror against AWS ([#1948](https://github.com/Autonoma-AI/agent/issues/1948)) ([de4ebdc](https://github.com/Autonoma-AI/agent/commit/de4ebdc0c2d6686dd112c89b6c2a6740fbe14cfb))
* **skill:** resolve cross-fix docking to the PR, not the person ([#1933](https://github.com/Autonoma-AI/agent/issues/1933)) ([96a9d37](https://github.com/Autonoma-AI/agent/commit/96a9d3794682036dd5d9283f37b22799be9bb872))


### Bug Fixes

* **billing:** stop writing zero-usage previewkit usage windows ([#1954](https://github.com/Autonoma-AI/agent/issues/1954)) ([f33ead0](https://github.com/Autonoma-AI/agent/commit/f33ead0d63c097f81947d2ba17b17b402ce064fe))
* **ci:** react instead of delete on the merged-PR Slack notification ([#1957](https://github.com/Autonoma-AI/agent/issues/1957)) ([9021cf2](https://github.com/Autonoma-AI/agent/commit/9021cf255e92e34ba26ae624fb1ad3c34d67b3bb))
* **previewkit:** send scenario up to the SDK app even in a connected repo ([#1935](https://github.com/Autonoma-AI/agent/issues/1935)) ([6773290](https://github.com/Autonoma-AI/agent/commit/677329066cde06027f88390d3665bef1bf98b9bd))

## [1.260730.1](https://github.com/Autonoma-AI/agent/compare/v1.260729.3...v1.260730.1) (2026-07-30)


### Features

* **cli:** record the planner dashboard as a session replay ([#1871](https://github.com/Autonoma-AI/agent/issues/1871)) ([6c581fc](https://github.com/Autonoma-AI/agent/commit/6c581fc6e7722f0c62a89a28c708870f24441ecc))
* **cli:** say what the tests step is doing after the nodes are done ([#1926](https://github.com/Autonoma-AI/agent/issues/1926)) ([fd032e9](https://github.com/Autonoma-AI/agent/commit/fd032e971385608dfd7448782f59387928ea49b5))
* **demo:** read-only demo UX - banner + global write-block modal ([#1869](https://github.com/Autonoma-AI/agent/issues/1869)) ([037b40b](https://github.com/Autonoma-AI/agent/commit/037b40b93b867f1b0b48dfb6b54b3102325b2db2))
* **previewkit:** report preview power/health from the cluster k8s API ([#1867](https://github.com/Autonoma-AI/agent/issues/1867)) ([a114bea](https://github.com/Autonoma-AI/agent/commit/a114bea2852b6b907e428721b1f8d7ad5b7ef4e3))
* **ui:** declutter preview status onto one runtime badge ([#1928](https://github.com/Autonoma-AI/agent/issues/1928)) ([488da6a](https://github.com/Autonoma-AI/agent/commit/488da6ad6dd3e64341cb93aea639c2a401fcc1fa))
* **ui:** honest preview runtime badges (Idle/Waking/Live/Crashing) ([#1916](https://github.com/Autonoma-AI/agent/issues/1916)) ([5cb627c](https://github.com/Autonoma-AI/agent/commit/5cb627ca72bb4e6ed53e792bdba0f54c16ccfaad))
* **ui:** route in-app preview links through the waiting screen ([#1911](https://github.com/Autonoma-AI/agent/issues/1911)) ([81ac2b8](https://github.com/Autonoma-AI/agent/commit/81ac2b864f60f02387bea9b12e8701a9233b7e81))


### Bug Fixes

* **cli:** a step that is still running never reads finished ([#1925](https://github.com/Autonoma-AI/agent/issues/1925)) ([0186478](https://github.com/Autonoma-AI/agent/commit/018647849e3764718513e87b916f0257a9a5e1a3))
* **cli:** bound the review pass so it cannot stall a run for hours ([#1876](https://github.com/Autonoma-AI/agent/issues/1876)) ([f613363](https://github.com/Autonoma-AI/agent/commit/f613363f466f2b06a4fba76de45bb305035130b2))
* **cli:** build INDEX.md from disk, last ([#1875](https://github.com/Autonoma-AI/agent/issues/1875)) ([6854cd7](https://github.com/Autonoma-AI/agent/commit/6854cd7fd7d2856a3ab77ae0623c41399f7eb822))
* **cli:** let journey generation write its tests again ([#1913](https://github.com/Autonoma-AI/agent/issues/1913)) ([2c51d53](https://github.com/Autonoma-AI/agent/commit/2c51d5383e1879b24ba7c127617c2fe1ec839972))
* **cli:** make a refused write_test countable ([#1923](https://github.com/Autonoma-AI/agent/issues/1923)) ([1ef5837](https://github.com/Autonoma-AI/agent/commit/1ef58375f8c2331f86fb5b468fadc0df1321aa3b))
* **cli:** make starting over actually start over ([#1922](https://github.com/Autonoma-AI/agent/issues/1922)) ([5759b06](https://github.com/Autonoma-AI/agent/commit/5759b0634f858fb45c787f0e23c2aa890402e5b9))
* **cli:** report the real suite index and re-budget the recipe handoff ([#1883](https://github.com/Autonoma-AI/agent/issues/1883)) ([c2b4c33](https://github.com/Autonoma-AI/agent/commit/c2b4c337943dbb41a8b6a31b267dd3c8d173f675))
* **cli:** stop invented nodeIds inflating the planner's test count ([#1872](https://github.com/Autonoma-AI/agent/issues/1872)) ([84d2abf](https://github.com/Autonoma-AI/agent/commit/84d2abf90dd17c48208b0a561843695644333ec3))
* **cli:** stop the journey pass resetting the tests step's progress ([#1924](https://github.com/Autonoma-AI/agent/issues/1924)) ([d5705c0](https://github.com/Autonoma-AI/agent/commit/d5705c04fcee89cfdc45faab4bd3a135809be446))
* **cli:** stop the review pass losing tests it deleted ([#1873](https://github.com/Autonoma-AI/agent/issues/1873)) ([0c6871b](https://github.com/Autonoma-AI/agent/commit/0c6871b08694f47153b77dabad75ab74e38bd3fc))
* **cli:** stop uploading quarantined tests ([#1877](https://github.com/Autonoma-AI/agent/issues/1877)) ([d1d44fc](https://github.com/Autonoma-AI/agent/commit/d1d44fce4f75a0d9bb76f362d69e66b0fa4b7667))
* **demo:** connect-agent buttons raise the sign-up modal in the demo ([#1931](https://github.com/Autonoma-AI/agent/issues/1931)) ([e0d13a3](https://github.com/Autonoma-AI/agent/commit/e0d13a3752c8d9b66807acd70db4b53051605795))
* **demo:** hide the onboarding GitHub-config link in the demo ([#1910](https://github.com/Autonoma-AI/agent/issues/1910)) ([6fb3137](https://github.com/Autonoma-AI/agent/commit/6fb3137e14e8738cc32588c149a6ebaf3d5922fd))
* **mcp:** lock the read-only demo org out of the MCP surface ([#1930](https://github.com/Autonoma-AI/agent/issues/1930)) ([252d336](https://github.com/Autonoma-AI/agent/commit/252d336193b2955668538af3cb7782d611c8ae10))
* **preview-config:** say why the save bar refuses a save ([#1912](https://github.com/Autonoma-AI/agent/issues/1912)) ([c378569](https://github.com/Autonoma-AI/agent/commit/c37856903a4712be572c0b0e1a0ad327786824ea))
* **scenario:** write recipe edits to main's live snapshot ([#1914](https://github.com/Autonoma-AI/agent/issues/1914)) ([5815421](https://github.com/Autonoma-AI/agent/commit/5815421b2b25d350f307d37c948626b23e31a663))
* **ui:** stop the stored-secret merge duplicating a key being typed ([#1918](https://github.com/Autonoma-AI/agent/issues/1918)) ([a3844d6](https://github.com/Autonoma-AI/agent/commit/a3844d641ee0e1d521ca5741f5281c1d0ebcf348))
* vercel response add product and metadata ([#1895](https://github.com/Autonoma-AI/agent/issues/1895)) ([c6700dd](https://github.com/Autonoma-AI/agent/commit/c6700dd64e004696d8a730d5b382c094e813aa08))


### Performance Improvements

* de-waterfall the snapshot analysis page load ([#1904](https://github.com/Autonoma-AI/agent/issues/1904)) ([f585b0e](https://github.com/Autonoma-AI/agent/commit/f585b0ea7bf909bffd86a713eb8f8fb6420e7fc1))

## [1.260729.3](https://github.com/Autonoma-AI/agent/compare/v1.260729.2...v1.260729.3) (2026-07-29)


### Features

* **api:** record bug-fixed-before-merge outcomes on PR merge ([#1862](https://github.com/Autonoma-AI/agent/issues/1862)) ([22d7740](https://github.com/Autonoma-AI/agent/commit/22d7740fe59cd315aed91a89a89f1b8820dbe406))
* **cli:** ship the run narrative to PostHog logs, indexed by generation id ([#1884](https://github.com/Autonoma-AI/agent/issues/1884)) ([8270863](https://github.com/Autonoma-AI/agent/commit/827086335bd86ca1c32f23c521c077e70c2dacbb))
* **previewkit:** add a mint-key script for the secret encryption key ([#1891](https://github.com/Autonoma-AI/agent/issues/1891)) ([e9aed4a](https://github.com/Autonoma-AI/agent/commit/e9aed4a4775f1f50119ef5785307ed10f72604bb))
* **previewkit:** mirror secret writes into encrypted Postgres tables ([#1835](https://github.com/Autonoma-AI/agent/issues/1835)) ([2d47df1](https://github.com/Autonoma-AI/agent/commit/2d47df1dbc701ac7cee0824ec8b59c93c81c24de))
* **previewkit:** route scenario up to the app implementing the SDK ([#1847](https://github.com/Autonoma-AI/agent/issues/1847)) ([f74c1eb](https://github.com/Autonoma-AI/agent/commit/f74c1eb236809723fac84fbbd4a9e03809a1a0a2))


### Bug Fixes

* **analysis:** a checkpoint that confirmed nothing must not read 'Passing' ([#1893](https://github.com/Autonoma-AI/agent/issues/1893)) ([6f5d56f](https://github.com/Autonoma-AI/agent/commit/6f5d56fb9a1a4ae3cc658e4f19b55f56acb3f01f))
* **analysis:** mark a generation failed when the run never happens ([#1892](https://github.com/Autonoma-AI/agent/issues/1892)) ([794ccd5](https://github.com/Autonoma-AI/agent/commit/794ccd5a78b6243d3fa891cc208d5d28d9609ab5))
* **cli:** make the generated-test file contract explicit ([#1868](https://github.com/Autonoma-AI/agent/issues/1868)) ([676bc91](https://github.com/Autonoma-AI/agent/commit/676bc91555465653522239efb476382320e2e778))

## [1.260729.2](https://github.com/Autonoma-AI/agent/compare/v1.260729.1...v1.260729.2) (2026-07-29)


### Features

* add invalid_test verdict to remove irreparably-broken tests ([#1853](https://github.com/Autonoma-AI/agent/issues/1853)) ([653232a](https://github.com/Autonoma-AI/agent/commit/653232a96632b007843413839b68df538376a9f8))
* **api:** add Autonoma SDK test-data endpoint for self-hosted E2E ([#1759](https://github.com/Autonoma-AI/agent/issues/1759)) ([1e5aa7d](https://github.com/Autonoma-AI/agent/commit/1e5aa7daf7552e85d70c15c74c18a7f7f1b1ef4b))
* **api:** public 'See the demo' entry that mints a read-only session ([#1857](https://github.com/Autonoma-AI/agent/issues/1857)) ([5fde257](https://github.com/Autonoma-AI/agent/commit/5fde257e97d32a1d2fbe2dcd48276af0f6896354))
* **cli:** end the run with a summary you can act on ([#1866](https://github.com/Autonoma-AI/agent/issues/1866)) ([9fa9e17](https://github.com/Autonoma-AI/agent/commit/9fa9e1736e4dcd0e7ea321307b9b8382ac890547))
* **db:** drop previewkit_usage_window.degraded ([#1879](https://github.com/Autonoma-AI/agent/issues/1879)) ([1062d6b](https://github.com/Autonoma-AI/agent/commit/1062d6bb33bf2b9f7cab5e61133ef179d1371c53))
* **deployment:** alert when the previewkit usage meter stops completing ([#1870](https://github.com/Autonoma-AI/agent/issues/1870)) ([f10e79f](https://github.com/Autonoma-AI/agent/commit/f10e79f3e10cdb7dd2f0c4be5c8f96dd21367028))
* **ui:** show a wait state while the onboarding preview builds ([#1863](https://github.com/Autonoma-AI/agent/issues/1863)) ([bf1a98f](https://github.com/Autonoma-AI/agent/commit/bf1a98fa38da3e18be1266dcd3a865222dddc1d5))


### Bug Fixes

* **cli:** resolve recipe tokens in the planner's own sdk up ([#1842](https://github.com/Autonoma-AI/agent/issues/1842)) ([7c48e75](https://github.com/Autonoma-AI/agent/commit/7c48e7590d953cd252f3e0b5d5bb398fb0a736f5))
* **cli:** stop the ETA extrapolating a linear per-page cost ([#1858](https://github.com/Autonoma-AI/agent/issues/1858)) ([361cddc](https://github.com/Autonoma-AI/agent/commit/361cddcfac272422df390670f54a6fab7fb602a6))
* map vercel installation status response ([#1874](https://github.com/Autonoma-AI/agent/issues/1874)) ([930f978](https://github.com/Autonoma-AI/agent/commit/930f978b97ec5f8531c656e41fcdac54a26e7886))
* **ui:** make multirepo dependency repos editable in the preview config ([#1817](https://github.com/Autonoma-AI/agent/issues/1817)) ([ed3ad18](https://github.com/Autonoma-AI/agent/commit/ed3ad1804ebf9a32c4b11d681deae3a2f4cec9dc))
* **ui:** make the onboarding planner command obviously copy-and-run ([#1861](https://github.com/Autonoma-AI/agent/issues/1861)) ([7f86f28](https://github.com/Autonoma-AI/agent/commit/7f86f285f41281ce99bc39296a425f138bd36e69))
* **workers:** bound general worker activity concurrency to stop OOMKills ([#1880](https://github.com/Autonoma-AI/agent/issues/1880)) ([f91e8c2](https://github.com/Autonoma-AI/agent/commit/f91e8c2e8a56284f60639b36cc29f88b32ab7469))

## [1.260729.1](https://github.com/Autonoma-AI/agent/compare/v1.260728.2...v1.260729.1) (2026-07-29)


### Features

* **api:** attribute PRs to all contributors for the stickiness merge-gate ([#1846](https://github.com/Autonoma-AI/agent/issues/1846)) ([d6407b6](https://github.com/Autonoma-AI/agent/commit/d6407b6ec96b7bd567bdf3686c47a462cc4e94db))
* **api:** emit platform_signup for Vercel marketplace users ([#1852](https://github.com/Autonoma-AI/agent/issues/1852)) ([bec2512](https://github.com/Autonoma-AI/agent/commit/bec251222d6d9142b7205f0d7f8222602456ff02))
* **api:** make the DEMO_ORG organization read-only at the API layer ([#1843](https://github.com/Autonoma-AI/agent/issues/1843)) ([eb8c5c6](https://github.com/Autonoma-AI/agent/commit/eb8c5c6d906499b2074c6d4a6d050efac2b26d13))
* **blacklight:** add a Diff component and use it for test-plan changes ([#1836](https://github.com/Autonoma-AI/agent/issues/1836)) ([b018487](https://github.com/Autonoma-AI/agent/commit/b018487c160b6ef02598f8d68b878e04deb2d012))
* **preview:** point GitHub-comment preview links at the front door ([#1831](https://github.com/Autonoma-AI/agent/issues/1831)) ([43d7d1a](https://github.com/Autonoma-AI/agent/commit/43d7d1a41699f0557226b1d67c9a75ba4e696025))
* **preview:** route in-app preview links through the waiting page ([#1856](https://github.com/Autonoma-AI/agent/issues/1856)) ([4c654b3](https://github.com/Autonoma-AI/agent/commit/4c654b365736b17deb7a5061cb5a4884f74f1505))
* replace the analysis delete verdict with a kept plan_mismatch ([#1838](https://github.com/Autonoma-AI/agent/issues/1838)) ([b101175](https://github.com/Autonoma-AI/agent/commit/b1011757968f4134822451cadcf2a975bd8abbe7))


### Bug Fixes

* **analytics:** close the activation-funnel instrumentation gaps ([#1746](https://github.com/Autonoma-AI/agent/issues/1746)) ([865350c](https://github.com/Autonoma-AI/agent/commit/865350c980f0a235ec046b0172a9958320ddcb92))
* **ci:** stop the public-mirror sync failing on a broken pipe ([#1854](https://github.com/Autonoma-AI/agent/issues/1854)) ([9676dc3](https://github.com/Autonoma-AI/agent/commit/9676dc3c6ca8607b8e8e76bf5239b696e9305450))
* **deployment:** restore kube-state-metrics RBAC and probe informer health ([#1849](https://github.com/Autonoma-AI/agent/issues/1849)) ([83eff47](https://github.com/Autonoma-AI/agent/commit/83eff479b5555d27eb6c3501a47b3d7fd106fb0b))
* **onboarding:** keep the whole of onboarding on the onboarding MCP ([#1841](https://github.com/Autonoma-AI/agent/issues/1841)) ([6476675](https://github.com/Autonoma-AI/agent/commit/6476675816cd1e688463303ffed044008dfa1b72))
* orphan ingress entries for gh app ([#1850](https://github.com/Autonoma-AI/agent/issues/1850)) ([a0e9cc1](https://github.com/Autonoma-AI/agent/commit/a0e9cc15d7b45e102c8dae0694e51b4ff2286984))

## [1.260728.2](https://github.com/Autonoma-AI/agent/compare/v1.260728.1...v1.260728.2) (2026-07-28)


### Features

* **api:** capture false-positive candidates from the debug MCP tool and skip reasons ([#1801](https://github.com/Autonoma-AI/agent/issues/1801)) ([f60df47](https://github.com/Autonoma-AI/agent/commit/f60df47cb28d4e7ba26e28be85e160fbd108263c))
* **diffs:** switch the investigation analyze_video tool to MiniMax M3 ([#1821](https://github.com/Autonoma-AI/agent/issues/1821)) ([598b20a](https://github.com/Autonoma-AI/agent/commit/598b20a473d7650c52e766de88db846c05fde5c8))
* **platform:** add a previewkit cost dashboard, next to the instance runbook ([#1824](https://github.com/Autonoma-AI/agent/issues/1824)) ([2d94769](https://github.com/Autonoma-AI/agent/commit/2d94769361854ab2f1380ae697b0a2d568f9f824))
* **previewkit:** add KMS-backed key management for database-stored secrets ([#1812](https://github.com/Autonoma-AI/agent/issues/1812)) ([a12e12f](https://github.com/Autonoma-AI/agent/commit/a12e12f8700b5ed4b9dfe48c23f27268070fde6b))


### Bug Fixes

* **analysis:** persist a classification per self-heal iteration ([#1807](https://github.com/Autonoma-AI/agent/issues/1807)) ([04a6063](https://github.com/Autonoma-AI/agent/commit/04a6063242a9c76b1efa9b5e5087e587ae411c21))
* **ci:** delete ECR images by last-pull age instead of archive status ([#1825](https://github.com/Autonoma-AI/agent/issues/1825)) ([10032d7](https://github.com/Autonoma-AI/agent/commit/10032d7c4bf1836518d9f216ab1deb684f514ad7))
* **ci:** unbreak the typecheck and make it invalidate on upstream changes ([#1840](https://github.com/Autonoma-AI/agent/issues/1840)) ([081b16c](https://github.com/Autonoma-AI/agent/commit/081b16c0c21914c72e0c8ea5dd2760f137f22260))
* **deployment:** scope the prod agent's per-node jobs and size it for the cluster ([#1830](https://github.com/Autonoma-AI/agent/issues/1830)) ([3e3f6bf](https://github.com/Autonoma-AI/agent/commit/3e3f6bf9d24d49bee3173f37e62afcaaa0ff6ab0))
* **deployment:** stop the kubelet killing busy verdaccio replicas ([#1829](https://github.com/Autonoma-AI/agent/issues/1829)) ([be6e351](https://github.com/Autonoma-AI/agent/commit/be6e3516d2bab49346732fc6c2af13732a6e9dc7))
* **previewkit:** raise deploy hook timeout from 5 to 15 minutes ([#1832](https://github.com/Autonoma-AI/agent/issues/1832)) ([29aa785](https://github.com/Autonoma-AI/agent/commit/29aa7859ee77df1dda9e155da42bbf5c166c1dab))
* **ui:** keep a failed dry run's reason on screen ([#1837](https://github.com/Autonoma-AI/agent/issues/1837)) ([48c5ec0](https://github.com/Autonoma-AI/agent/commit/48c5ec0e53beb0f947a3c8ebf8625c1c61b3463e))

## [1.260728.1](https://github.com/Autonoma-AI/agent/compare/v1.260727.2...v1.260728.1) (2026-07-28)


### Features

* **mcp:** let a dry run target a specific preview ([#1813](https://github.com/Autonoma-AI/agent/issues/1813)) ([c562264](https://github.com/Autonoma-AI/agent/commit/c5622645d9c3cc80bb1c581dd34a4efa0dece38e))
* **preview:** add the preview waiting page and a shared login redirect ([#1753](https://github.com/Autonoma-AI/agent/issues/1753)) ([5b72904](https://github.com/Autonoma-AI/agent/commit/5b7290479734ac757cb149ac5666d65f198decc7))
* **scenario:** keep an append-only history of every recipe write ([#1806](https://github.com/Autonoma-AI/agent/issues/1806)) ([430baaa](https://github.com/Autonoma-AI/agent/commit/430baaa385d03e1b6d603afaefe9e3b036e1e064))
* **scenario:** reject a recipe write whose base has moved on ([#1810](https://github.com/Autonoma-AI/agent/issues/1810)) ([0af1852](https://github.com/Autonoma-AI/agent/commit/0af1852cca8b0724d68e605a802131b577cb6aae))
* **scenario:** show which recipe a run actually used ([#1811](https://github.com/Autonoma-AI/agent/issues/1811)) ([17cbcfb](https://github.com/Autonoma-AI/agent/commit/17cbcfb907e0339e4840a35908c5aaa6f4128732))


### Bug Fixes

* **cli:** stop the planner from stripping fields the recipe upload requires ([#1814](https://github.com/Autonoma-AI/agent/issues/1814)) ([b386291](https://github.com/Autonoma-AI/agent/commit/b386291e59272fe5303fa761d2235f008c555faa))
* **onboarding:** make the MCP connect steps match what people actually do ([#1815](https://github.com/Autonoma-AI/agent/issues/1815)) ([0a50b10](https://github.com/Autonoma-AI/agent/commit/0a50b10c488144595b28149a20a85cd535630d62))

## [1.260727.2](https://github.com/Autonoma-AI/agent/compare/v1.260727.1...v1.260727.2) (2026-07-27)


### Features

* **mcp:** give the debug MCP the scenario recipe tools ([#1804](https://github.com/Autonoma-AI/agent/issues/1804)) ([550b777](https://github.com/Autonoma-AI/agent/commit/550b77706c74b0c91bc7ce84aa7f3a585546b843))
* **merge-gate:** emit enriched PostHog events for check_posted and skipped ([#1780](https://github.com/Autonoma-AI/agent/issues/1780)) ([ee0a659](https://github.com/Autonoma-AI/agent/commit/ee0a65900d7a7ca75fe67b6957e7a16b3bec2095))
* **merge-gate:** require a reason for /autonoma-skip ([#1786](https://github.com/Autonoma-AI/agent/issues/1786)) ([8210c89](https://github.com/Autonoma-AI/agent/commit/8210c89c77add8d390ce1e01ce9298cc2b97da2d))
* **platform:** replace two sticky OOM alerts with a cadvisor-based rule ([#1781](https://github.com/Autonoma-AI/agent/issues/1781)) ([dd80a76](https://github.com/Autonoma-AI/agent/commit/dd80a76edf9e921735a47addf925fd03d313805e))
* **scenario:** built-in run-identity tokens + reject recipes that cannot provision ([#1799](https://github.com/Autonoma-AI/agent/issues/1799)) ([377c87e](https://github.com/Autonoma-AI/agent/commit/377c87e99f5ca0f83f2c4b9b1bee8242b630f2d9))
* **scenario:** dry-run a candidate recipe without storing it ([#1802](https://github.com/Autonoma-AI/agent/issues/1802)) ([7fc116e](https://github.com/Autonoma-AI/agent/commit/7fc116efe5503dcdedb7da5c6bcc9e4105a404d3))
* set shared secret env on resource installation ([#1779](https://github.com/Autonoma-AI/agent/issues/1779)) ([c8847d8](https://github.com/Autonoma-AI/agent/commit/c8847d8f37331f1d6e062540b5c2c0d8f58646d1))


### Bug Fixes

* **api:** fix the integration test suite ([#1789](https://github.com/Autonoma-AI/agent/issues/1789)) ([7739482](https://github.com/Autonoma-AI/agent/commit/773948262cea452267961a86d97ad569a5be5e81))
* **ci:** only delete ECR-archived images, add lifecycle policy script ([#1796](https://github.com/Autonoma-AI/agent/issues/1796)) ([25e2716](https://github.com/Autonoma-AI/agent/commit/25e2716ec223ac3d5847ef4ceeedb61677d27e4c))
* **cli:** accurate failure message when no recipe.json exists to submit ([#1784](https://github.com/Autonoma-AI/agent/issues/1784)) ([00ebb01](https://github.com/Autonoma-AI/agent/commit/00ebb019ddc06aba64d54a4496d68ac2e49545ac))
* **deployment:** make verdaccio's memory limit enforceable and spread it per zone ([#1787](https://github.com/Autonoma-AI/agent/issues/1787)) ([16e44fe](https://github.com/Autonoma-AI/agent/commit/16e44fed81bba2399dc0b81f439b842db99459bf))
* **scenario:** let the save-time recipe gate see declared variables ([#1803](https://github.com/Autonoma-AI/agent/issues/1803)) ([a045f20](https://github.com/Autonoma-AI/agent/commit/a045f20e9a644b4ca5bbd2681d794954425e8850))
* **scenarios:** scope recipe reads and writes to the application ([#1805](https://github.com/Autonoma-AI/agent/issues/1805)) ([cdfa38f](https://github.com/Autonoma-AI/agent/commit/cdfa38fb8715d36ad81b6505114683b1e3fe5c3b))
* **ui:** match the CLI's folder key on manual test-case upload ([#1785](https://github.com/Autonoma-AI/agent/issues/1785)) ([c194303](https://github.com/Autonoma-AI/agent/commit/c194303ead5136e13c8ab809ac7f5c6f13d9bfb4))


### Performance Improvements

* **api:** batch snapshot change summaries into one narrow query ([#1795](https://github.com/Autonoma-AI/agent/issues/1795)) ([6b1fbc3](https://github.com/Autonoma-AI/agent/commit/6b1fbc3b5ed3e06de200f2db654d764ebb591573))

## [1.260727.1](https://github.com/Autonoma-AI/agent/compare/v1.260724.1...v1.260727.1) (2026-07-27)


### Features

* **deployment:** add in-cluster scrape agents for AMP -&gt; self-hosted Prometheus ([#1764](https://github.com/Autonoma-AI/agent/issues/1764)) ([4ff910f](https://github.com/Autonoma-AI/agent/commit/4ff910fa537a58b76dc42754bca5ac46a522ab3a))
* **merge-gate:** skip via /autonoma-skip comment with reason and skipped state ([#1756](https://github.com/Autonoma-AI/agent/issues/1756)) ([d766b83](https://github.com/Autonoma-AI/agent/commit/d766b8373e97593d06f54a54b8802880fb347df8))
* **platform:** sync authorized_keys to self-managed EC2 instances via SSM ([#1769](https://github.com/Autonoma-AI/agent/issues/1769)) ([549b07e](https://github.com/Autonoma-AI/agent/commit/549b07eb46b1101ce77be30c01698508b08d0e56))


### Bug Fixes

* **api:** surface failed analysis runs in the PR pipeline status ([#1777](https://github.com/Autonoma-AI/agent/issues/1777)) ([2235650](https://github.com/Autonoma-AI/agent/commit/2235650321e1fba48aabd2961367c18f1ee8b74f))
* **billing:** query the self-hosted Prometheus instead of the deleted AMP workspace ([#1766](https://github.com/Autonoma-AI/agent/issues/1766)) ([df6356f](https://github.com/Autonoma-AI/agent/commit/df6356fd1d44b9165147fb3b53a91453bb5d235f))
* centralize analysis-run settlement ([#1775](https://github.com/Autonoma-AI/agent/issues/1775)) ([427f966](https://github.com/Autonoma-AI/agent/commit/427f966f9601e472e656076b5fbfe460b6c671e3))
* **deployment:** filter histogram buckets and stop double-scrapes in the prod agent ([#1772](https://github.com/Autonoma-AI/agent/issues/1772)) ([479980f](https://github.com/Autonoma-AI/agent/commit/479980fcb3a4aca9be4edf040c1011d7d617cc26))
* **platform:** scrape the central Prometheus over HTTPS and track its config ([#1771](https://github.com/Autonoma-AI/agent/issues/1771)) ([476f166](https://github.com/Autonoma-AI/agent/commit/476f1660ed78b199b5865370a2006a17cb02ab81))
* **previewkit:** end the deploy in a terminal status when a hook fails ([#1762](https://github.com/Autonoma-AI/agent/issues/1762)) ([094eb66](https://github.com/Autonoma-AI/agent/commit/094eb66a88f8776cfec612d29c3efa946c44dd53))
* **ui:** drive the authoritative suite-changes view off analysis findings ([#1761](https://github.com/Autonoma-AI/agent/issues/1761)) ([b345599](https://github.com/Autonoma-AI/agent/commit/b345599db2dca042a4154546041e91f04f88c867))
* **ui:** gate the snapshot page on the analysis job, not the report ([#1778](https://github.com/Autonoma-AI/agent/issues/1778)) ([354346f](https://github.com/Autonoma-AI/agent/commit/354346f05a73d6d7d70fe42044a947538c509114))

## [1.260724.1](https://github.com/Autonoma-AI/agent/compare/v1.260723.2...v1.260724.1) (2026-07-24)


### Features

* add Codex CLI support to the SDK-implementation handoff ([#1738](https://github.com/Autonoma-AI/agent/issues/1738)) ([30146c4](https://github.com/Autonoma-AI/agent/commit/30146c40e5544e229dcefe597cbaecbdd8e7d7ea))
* add dormant Reporter agent for branch-scoped issues and PR report ([#1744](https://github.com/Autonoma-AI/agent/issues/1744)) ([160d1ff](https://github.com/Autonoma-AI/agent/commit/160d1ff5e6d335329ecdc718ee4f63e33be04dce))
* **analysis:** surface the optimized run recording toggle on findings ([#1737](https://github.com/Autonoma-AI/agent/issues/1737)) ([0a23cff](https://github.com/Autonoma-AI/agent/commit/0a23cffd89d110cf9cf1ad289dbcaff5e0f8a675))
* **buildkit:** add Verdaccio npm proxy cache ([#1727](https://github.com/Autonoma-AI/agent/issues/1727)) ([28755b9](https://github.com/Autonoma-AI/agent/commit/28755b9ce02f92ce52211b3c3648d11ef9df1ff6))
* homa SDK-eval case + per-case agent notes/secrets support ([#1726](https://github.com/Autonoma-AI/agent/issues/1726)) ([6ff7358](https://github.com/Autonoma-AI/agent/commit/6ff73588537a377fc9f0bbd55b654d58b8ff7898))
* iac vercel secret ([#1653](https://github.com/Autonoma-AI/agent/issues/1653)) ([9b540a0](https://github.com/Autonoma-AI/agent/commit/9b540a0d43fb08f03555fa584b8b54891048550e))
* issues-first analysis UI ([#1734](https://github.com/Autonoma-AI/agent/issues/1734)) ([#1758](https://github.com/Autonoma-AI/agent/issues/1758)) ([4099a0d](https://github.com/Autonoma-AI/agent/commit/4099a0dbe7a4b5adc9376dbc727f081b1f3056e3))
* **mcp:** add scenario recipe editing to the onboarding MCP ([#1723](https://github.com/Autonoma-AI/agent/issues/1723)) ([29bea0c](https://github.com/Autonoma-AI/agent/commit/29bea0cc5022ae0c883a92941803adc5ccd3c450))
* **merge-gate:** per-org blocking PR check on client bugs with Skip button ([#1697](https://github.com/Autonoma-AI/agent/issues/1697)) ([f03af54](https://github.com/Autonoma-AI/agent/commit/f03af541a73bd37b19d6fbdffc33fcc3c2696fc5))
* per-category finding verdict with expected/actual behavior ([#1740](https://github.com/Autonoma-AI/agent/issues/1740)) ([4fa3f01](https://github.com/Autonoma-AI/agent/commit/4fa3f013d0d8d0323a7ef7f4325fd36383fb4abb))
* **preview:** front door that waits out preview cold starts ([#1747](https://github.com/Autonoma-AI/agent/issues/1747)) ([6998aa9](https://github.com/Autonoma-AI/agent/commit/6998aa9bd67910de8ecd30af8c5ddd2303238256))
* **previewkit:** overwrite the preview image tag per app+PR instead of accumulating per commit ([#1728](https://github.com/Autonoma-AI/agent/issues/1728)) ([875cebb](https://github.com/Autonoma-AI/agent/commit/875cebb03b0f4ee6d4da09b83a3de226ab27757a))
* **scenario:** ride through preview cold starts on dry-run ([#1741](https://github.com/Autonoma-AI/agent/issues/1741)) ([fd0b0a6](https://github.com/Autonoma-AI/agent/commit/fd0b0a623cfe18928989976e3a584545a3fc32b2))
* swap the analysis Reconciler for the Reporter ([#1757](https://github.com/Autonoma-AI/agent/issues/1757)) ([e98af0f](https://github.com/Autonoma-AI/agent/commit/e98af0f6c6ef8c7249fb67321eef4258cc9647c9))
* **ui:** MCP-first config-previews onboarding (experiment E3) ([#1724](https://github.com/Autonoma-AI/agent/issues/1724)) ([d65beec](https://github.com/Autonoma-AI/agent/commit/d65beec2643ff8f366e4f26f36fdea46f7a3721a))


### Bug Fixes

* **buildkit:** disable service-links env injection on Verdaccio pod ([#1732](https://github.com/Autonoma-AI/agent/issues/1732)) ([7d1d7f8](https://github.com/Autonoma-AI/agent/commit/7d1d7f8cd55d47bcec9b3ad781acdc73ed1e38e6))
* **buildkit:** raise verdaccio memory limit to 2Gi ([#1749](https://github.com/Autonoma-AI/agent/issues/1749)) ([2fb5f3b](https://github.com/Autonoma-AI/agent/commit/2fb5f3bc32fceadf7ec9f8b89991059b5db7879b))
* **cli:** always upload the recipe, even without AUTONOMA_API_URL ([#1755](https://github.com/Autonoma-AI/agent/issues/1755)) ([cac7134](https://github.com/Autonoma-AI/agent/commit/cac7134e6041c868bae96a22d16114062ae44fec))
* **onboarding:** keep the agent polling until requested env values land ([#1752](https://github.com/Autonoma-AI/agent/issues/1752)) ([1e0b3b8](https://github.com/Autonoma-AI/agent/commit/1e0b3b84e6dc3b6a06cacd8d7ef33f1bdad5a891))
* **onboarding:** make Vercel deployments first-class dry-run targets ([#1743](https://github.com/Autonoma-AI/agent/issues/1743)) ([0d0d1d5](https://github.com/Autonoma-AI/agent/commit/0d0d1d522d45c056e930509ebd79e4fd21b49abc))
* **onboarding:** stop offering retired build presets on the authoring surfaces ([#1748](https://github.com/Autonoma-AI/agent/issues/1748)) ([504cc75](https://github.com/Autonoma-AI/agent/commit/504cc756f5420002457a0c47e4fe494e98491fdb))
* **previewkit:** make the npm registry mirror best-effort ([#1750](https://github.com/Autonoma-AI/agent/issues/1750)) ([35a0b1f](https://github.com/Autonoma-AI/agent/commit/35a0b1f1acc61c0850ef1bd1e88f4cf18b9ea629))
* **ui:** keep the dry-run target in sync with the validated one across finish-setup steps ([#1742](https://github.com/Autonoma-AI/agent/issues/1742)) ([1a1de76](https://github.com/Autonoma-AI/agent/commit/1a1de76457ecd6e716b2b064066c0ab07df2113d))
* **ui:** pin resolved dry-run target so the dry run hits the validated preview ([#1739](https://github.com/Autonoma-AI/agent/issues/1739)) ([7a3da66](https://github.com/Autonoma-AI/agent/commit/7a3da664c07ece43cc670d2481cff62322e8ec11))

## [1.260723.2](https://github.com/Autonoma-AI/agent/compare/v1.260723.1...v1.260723.2) (2026-07-23)


### Features

* **cronjobs:** build with Rolldown ([#1715](https://github.com/Autonoma-AI/agent/issues/1715)) ([8e3e374](https://github.com/Autonoma-AI/agent/commit/8e3e3744fdab7d40308a64607546cbcd6be4fe89))
* **previewkit:** add BuildKit registry cache for image builds ([#1713](https://github.com/Autonoma-AI/agent/issues/1713)) ([28a5ae7](https://github.com/Autonoma-AI/agent/commit/28a5ae79a83996912856f4d473deaee7bfa5eb1f))
* support multi-repo apps in SDK-integration eval ([#1582](https://github.com/Autonoma-AI/agent/issues/1582)) ([c1d3152](https://github.com/Autonoma-AI/agent/commit/c1d31522ba97bd9dd0d97f33128d4d5f5f3e6454))


### Bug Fixes

* **cronjobs:** deploy all cronjob manifests using the shared image ([#1716](https://github.com/Autonoma-AI/agent/issues/1716)) ([84972bb](https://github.com/Autonoma-AI/agent/commit/84972bb20e80e5f68cf43f2d537ff0d58410ca1d))
* onboarding vercel issues ([#1681](https://github.com/Autonoma-AI/agent/issues/1681)) ([1b8f45e](https://github.com/Autonoma-AI/agent/commit/1b8f45e1a26c710d9921909cb6ec38e211751150))


### Performance Improvements

* **cronjobs:** optimize Docker image ([#1714](https://github.com/Autonoma-AI/agent/issues/1714)) ([8ad76e7](https://github.com/Autonoma-AI/agent/commit/8ad76e7a79e0550bdc6bd7f82225273277fe9dd9))

## [1.260723.1](https://github.com/Autonoma-AI/agent/compare/v1.8.44...v1.260723.1) (2026-07-23)


### Features

* **analysis:** mission probe - verify the test's intended outcomes occurred ([#1707](https://github.com/Autonoma-AI/agent/issues/1707)) ([d9d2578](https://github.com/Autonoma-AI/agent/commit/d9d2578c1a5316a0ee7d8f151478bc027818a91a))
* **billing:** enforce previewkit compute-billing credits at deploy time ([#1696](https://github.com/Autonoma-AI/agent/issues/1696)) ([92a6ef1](https://github.com/Autonoma-AI/agent/commit/92a6ef12773ea6e668eef72dd836689e6d0a94e9))
* **ci:** switch root release-please version to CalVer ([#1695](https://github.com/Autonoma-AI/agent/issues/1695)) ([7824dac](https://github.com/Autonoma-AI/agent/commit/7824dac1c8154d5e4ad1b6c2c3ac1fe0f951cdbb))
* **classifier:** use the optimized recording for every model video call ([#1711](https://github.com/Autonoma-AI/agent/issues/1711)) ([95e85c4](https://github.com/Autonoma-AI/agent/commit/95e85c4c3c59d3ea6783449502090e5dbcbce862))
* **cli:** live Ink TUI for the planner - dashboard, in-TUI prompts, handoff reclaim ([#1683](https://github.com/Autonoma-AI/agent/issues/1683)) ([9dc9bc7](https://github.com/Autonoma-AI/agent/commit/9dc9bc7667b1f416f0fe255daa480e903504709e))
* **cli:** TUI phase C - human file names, follow fixes, adaptive ETA ([#1704](https://github.com/Autonoma-AI/agent/issues/1704)) ([e2ddbe8](https://github.com/Autonoma-AI/agent/commit/e2ddbe81a8c4f6176744fa03f3b76b663092567e))
* **diffs:** time-compress review recordings before the video model ([#1705](https://github.com/Autonoma-AI/agent/issues/1705)) ([3912fd8](https://github.com/Autonoma-AI/agent/commit/3912fd89be6705cc3c8b4211ad9a6d0bf2b9ee60))
* hand the SDK-integration step to the user's local coding agent ([#1665](https://github.com/Autonoma-AI/agent/issues/1665)) ([0e8f461](https://github.com/Autonoma-AI/agent/commit/0e8f46167c5b46f17d816ba4ad4765f5c0c428a5))
* persist the Investigator classifier conversation on findings ([#1682](https://github.com/Autonoma-AI/agent/issues/1682)) ([2a7b855](https://github.com/Autonoma-AI/agent/commit/2a7b855ba540fc29dde1740dd670147d8aef4b27))
* **previewkit:** trigger the review for every org (remove per-org gate) ([#1703](https://github.com/Autonoma-AI/agent/issues/1703)) ([529374a](https://github.com/Autonoma-AI/agent/commit/529374a0d8355a0b91485079a2dbf71b13b8dc18))
* **ui:** centralized run-recording VideoPlayer with optimized/original toggle ([#1709](https://github.com/Autonoma-AI/agent/issues/1709)) ([6023d2d](https://github.com/Autonoma-AI/agent/commit/6023d2d0c0721ad9446b5c5aa4cc18e626894a11))


### Bug Fixes

* **analysis:** reconciler + self-heal precision fixes for the classifier ([#1706](https://github.com/Autonoma-AI/agent/issues/1706)) ([4fff94d](https://github.com/Autonoma-AI/agent/commit/4fff94db46443d7b29e4c0ea9030968156fc9c7a))
* **cli:** drop the manual SDK-handoff questions; brighter file highlight ([#1708](https://github.com/Autonoma-AI/agent/issues/1708)) ([aae35da](https://github.com/Autonoma-AI/agent/commit/aae35dae393db03392ec232ec8630f24719ac58b))
* **engine-web:** record test video at full viewport resolution ([#1710](https://github.com/Autonoma-AI/agent/issues/1710)) ([59d441e](https://github.com/Autonoma-AI/agent/commit/59d441e436a4c9a099a0507dde944e01295e5627))
* increase pvc storage ([#1693](https://github.com/Autonoma-AI/agent/issues/1693)) ([cebd184](https://github.com/Autonoma-AI/agent/commit/cebd184190ec88fdc45a81831e596904d3d6b6de))
* **previewkit:** tune PreviewKit node image garbage collection ([#1702](https://github.com/Autonoma-AI/agent/issues/1702)) ([3f115dd](https://github.com/Autonoma-AI/agent/commit/3f115ddb8ea6a92e871828c8fcf93daed3e49fa0))
* read AnalysisReport verdict for authoritative checkpoint summaries ([#1700](https://github.com/Autonoma-AI/agent/issues/1700)) ([a313e5f](https://github.com/Autonoma-AI/agent/commit/a313e5fcff110711e8a1eb93497a9c4e6ba2b91f))
* uninstall flag to avoid having a pending to uninstall integration ([#1699](https://github.com/Autonoma-AI/agent/issues/1699)) ([301619e](https://github.com/Autonoma-AI/agent/commit/301619ea77739bdd8e3bc51a13930fb12bb79ad5))


### Performance Improvements

* **previewkit:** export build images with zstd compression ([#1691](https://github.com/Autonoma-AI/agent/issues/1691)) ([5cc8889](https://github.com/Autonoma-AI/agent/commit/5cc8889af47f031dece0cd4c299e1b7af1be51aa))

## [1.8.44](https://github.com/Autonoma-AI/agent/compare/v1.8.43...v1.8.44) (2026-07-21)


### Features

* **billing:** add previewkit compute-usage billing primitives ([#1677](https://github.com/Autonoma-AI/agent/issues/1677)) ([d5f710e](https://github.com/Autonoma-AI/agent/commit/d5f710e8033a93fca0f7ce1afd8b370fb49d3430))
* **billing:** add the previewkit usage-meter sweep ([#1687](https://github.com/Autonoma-AI/agent/issues/1687)) ([05ea2e5](https://github.com/Autonoma-AI/agent/commit/05ea2e585eefb23159364fd85f522d6175d621bc))
* **monitoring:** migrate monitoring to Amazon Managed Prometheus ([#1674](https://github.com/Autonoma-AI/agent/issues/1674)) ([6e8ddf0](https://github.com/Autonoma-AI/agent/commit/6e8ddf058e62ca19967b48ca7455e6872d960d0f))
* **previewkit:** fatal Sentry alert when an app cannot be built ([#1671](https://github.com/Autonoma-AI/agent/issues/1671)) ([c18baec](https://github.com/Autonoma-AI/agent/commit/c18baeccd00d71efc6d5db36737239396b81066b))
* uninstall finalized ([#1676](https://github.com/Autonoma-AI/agent/issues/1676)) ([efe4c81](https://github.com/Autonoma-AI/agent/commit/efe4c8195575bb1cfef79ef6910902b13edf0c9a))


### Bug Fixes

* **monitoring:** cut AMP ingestion 86% and fix never-firing alert rules ([#1678](https://github.com/Autonoma-AI/agent/issues/1678)) ([b492311](https://github.com/Autonoma-AI/agent/commit/b492311526480a0943e64154ff067f1d6d84885d))

## [1.8.43](https://github.com/Autonoma-AI/agent/compare/v1.8.42...v1.8.43) (2026-07-21)


### Features

* **previewkit:** trigger the diffs/analysis run as a Temporal job on preview-ready ([#1638](https://github.com/Autonoma-AI/agent/issues/1638)) ([335facb](https://github.com/Autonoma-AI/agent/commit/335facb0efe0b3b2334c6fd05e0e6f9628109e31))

## [1.8.42](https://github.com/Autonoma-AI/agent/compare/v1.8.41...v1.8.42) (2026-07-20)


### Features

* remove env from explicit subst ([#1666](https://github.com/Autonoma-AI/agent/issues/1666)) ([25a28b6](https://github.com/Autonoma-AI/agent/commit/25a28b6352dd2de029fee321646674d21e25bed7))

## [1.8.41](https://github.com/Autonoma-AI/agent/compare/v1.8.40...v1.8.41) (2026-07-20)


### Features

* domain verification challenge ([#1663](https://github.com/Autonoma-AI/agent/issues/1663)) ([b5659ee](https://github.com/Autonoma-AI/agent/commit/b5659eece6bdea398a27e31a4c2acf52936e87a7))

## [1.8.40](https://github.com/Autonoma-AI/agent/compare/v1.8.39...v1.8.40) (2026-07-20)


### Features

* add annotations for openai ([#1661](https://github.com/Autonoma-AI/agent/issues/1661)) ([82c2331](https://github.com/Autonoma-AI/agent/commit/82c2331f891a7ccd4430da07e96d68030ab5eeb8))
* authoritative analysis PR comment (new analysis comment kind) ([#1649](https://github.com/Autonoma-AI/agent/issues/1649)) ([a5cb446](https://github.com/Autonoma-AI/agent/commit/a5cb446a398ee67b285f8fdd5b1f04acda99d1f0))
* **ui:** authoritative PR-page UI (embed latest findings + history) ([#1646](https://github.com/Autonoma-AI/agent/issues/1646)) ([#1650](https://github.com/Autonoma-AI/agent/issues/1650)) ([8093abc](https://github.com/Autonoma-AI/agent/commit/8093abc10c6d2c9c69e21e950efd281ba593977c))
* **ui:** merge PR header into two compact rows ([#1658](https://github.com/Autonoma-AI/agent/issues/1658)) ([9324aef](https://github.com/Autonoma-AI/agent/commit/9324aef1cad3e28748eef82114df43a9b8f56d7d))

## [1.8.39](https://github.com/Autonoma-AI/agent/compare/v1.8.38...v1.8.39) (2026-07-20)


### Features

* **analysis:** Investigator self-heal loop + full verdict taxonomy ([#1512](https://github.com/Autonoma-AI/agent/issues/1512), [#1513](https://github.com/Autonoma-AI/agent/issues/1513)) ([#1614](https://github.com/Autonoma-AI/agent/issues/1614)) ([0f59756](https://github.com/Autonoma-AI/agent/commit/0f59756216c79cbae6a5c65b2db6a1debc0f9e34))
* **analysis:** two-plane verdict + constrained narration ([#1516](https://github.com/Autonoma-AI/agent/issues/1516)) ([#1636](https://github.com/Autonoma-AI/agent/issues/1636)) ([e4e4e8f](https://github.com/Autonoma-AI/agent/commit/e4e4e8f9acf575dd8947487f22562ecadc0b9e72))
* merged analysis pipeline as authoritative PR analysis (behind a flag) ([#1647](https://github.com/Autonoma-AI/agent/issues/1647)) ([d7cf017](https://github.com/Autonoma-AI/agent/commit/d7cf017b466c7a89184cac05bf3382dd5ec17f7e))
* **onboarding:** add Vercel preview-environment routing quiz ([#1570](https://github.com/Autonoma-AI/agent/issues/1570)) ([1e592b0](https://github.com/Autonoma-AI/agent/commit/1e592b024e3d0ece450583fe7d367a198057f709))
* **onboarding:** configurable previewkit deploy branch, default to repo default ([#1635](https://github.com/Autonoma-AI/agent/issues/1635)) ([e148b40](https://github.com/Autonoma-AI/agent/commit/e148b40d79decf6d3cad0e658a2fa9981ae91883))
* **ui:** authoritative snapshot-page UI (findings list, FINDINGS SUMMARY, changes-tab tweaks) ([#1645](https://github.com/Autonoma-AI/agent/issues/1645)) ([#1648](https://github.com/Autonoma-AI/agent/issues/1648)) ([b909cd6](https://github.com/Autonoma-AI/agent/commit/b909cd690329be30dbee828f0d5c3547cde5476b))
* **ui:** collapse PR breadcrumb into a single Back action ([#1652](https://github.com/Autonoma-AI/agent/issues/1652)) ([858a891](https://github.com/Autonoma-AI/agent/commit/858a8914c1e5ec90040731a296891e30885672e4))
* **ui:** collapse PR metadata to essentials behind a Details toggle ([#1657](https://github.com/Autonoma-AI/agent/issues/1657)) ([d8871d2](https://github.com/Autonoma-AI/agent/commit/d8871d2d589ea0c7373cf638ef28718b3ac10dab))
* **ui:** compact app inspector strip for the Preview tab ([#1628](https://github.com/Autonoma-AI/agent/issues/1628)) ([11a82f1](https://github.com/Autonoma-AI/agent/commit/11a82f13cc58780a37d6b89cda44b7a087562054))
* **ui:** fold early-version banner into sidebar ([#1651](https://github.com/Autonoma-AI/agent/issues/1651)) ([0f3ea74](https://github.com/Autonoma-AI/agent/commit/0f3ea7403a54a0a60f93586ef1702cc3b961fb31))
* **ui:** fold PR title, status pill, and tabs into one header row ([#1655](https://github.com/Autonoma-AI/agent/issues/1655)) ([9649e1f](https://github.com/Autonoma-AI/agent/commit/9649e1f571993e6190564df2b06e0ba13514b46c))
* **ui:** reveal toggle for agent-requested env values ([#1629](https://github.com/Autonoma-AI/agent/issues/1629)) ([e74f4e1](https://github.com/Autonoma-AI/agent/commit/e74f4e109b3ceb5c7e33b490543da503046dd087))
* **ui:** trim the deployment bar and flush the Preview tab's section spacing ([#1633](https://github.com/Autonoma-AI/agent/issues/1633)) ([927929f](https://github.com/Autonoma-AI/agent/commit/927929f21dad5e7531200555ab5c3dc5027e00fb))


### Bug Fixes

* **analysis:** stop loading @autonoma/db in the workflow test (unbreaks main CI) ([#1634](https://github.com/Autonoma-AI/agent/issues/1634)) ([4c9f5bb](https://github.com/Autonoma-AI/agent/commit/4c9f5bbe43994dd8c8edf054b0d5c957683b5376))
* **api:** resolve branch name collisions deterministically in getBranchByName ([#1640](https://github.com/Autonoma-AI/agent/issues/1640)) ([db74143](https://github.com/Autonoma-AI/agent/commit/db74143a672a7c355f6df52195affbdbc8433753))
* **github:** cache-bust PR comment button SVGs to v3 ([#1639](https://github.com/Autonoma-AI/agent/issues/1639)) ([7db205c](https://github.com/Autonoma-AI/agent/commit/7db205cfd3ead93bd8ef17c629881f1ea63ab44e))
* signing path ([#1621](https://github.com/Autonoma-AI/agent/issues/1621)) ([55fb4e6](https://github.com/Autonoma-AI/agent/commit/55fb4e618e7008cf7b74b8c872c864bac33dcca5))
* **test:** tolerate benign Testcontainers teardown race in integration harnesses ([#1656](https://github.com/Autonoma-AI/agent/issues/1656)) ([8418541](https://github.com/Autonoma-AI/agent/commit/84185415b11091e99fcd955f75cfd9b4074590e1))
* **ui:** one target selection across finish-setup steps (drop the dry-run picker) ([#1637](https://github.com/Autonoma-AI/agent/issues/1637)) ([4d59c9b](https://github.com/Autonoma-AI/agent/commit/4d59c9b026556e20a409540ce36b14b4849331a2))

## [1.8.38](https://github.com/Autonoma-AI/agent/compare/v1.8.37...v1.8.38) (2026-07-17)


### Features

* add email password login form ([#1581](https://github.com/Autonoma-AI/agent/issues/1581)) ([666a9ca](https://github.com/Autonoma-AI/agent/commit/666a9ca4278b399fbc3742f0a6f3501fc51508ae))
* **analysis:** re-home the shadow pipeline into packages/diffs + Impact Analysis ([#1599](https://github.com/Autonoma-AI/agent/issues/1599), [#1510](https://github.com/Autonoma-AI/agent/issues/1510)) ([#1600](https://github.com/Autonoma-AI/agent/issues/1600)) ([de72be1](https://github.com/Autonoma-AI/agent/commit/de72be13c7ac23a02ef6069c6ffaec0ad2de41e0))
* **onboarding-mcp:** warn the agent when a ready preview is logging errors ([#1584](https://github.com/Autonoma-AI/agent/issues/1584)) ([f22e6fe](https://github.com/Autonoma-AI/agent/commit/f22e6fe4bfd4ebe494609218bf5ba9b59a58462a))
* **onboarding:** auto-switch finish-setup logs from build to app as the deploy progresses ([#1595](https://github.com/Autonoma-AI/agent/issues/1595)) ([aaf127d](https://github.com/Autonoma-AI/agent/commit/aaf127d9ae78d4c66125fe973ba5cf8f94331dd0))
* **onboarding:** debug-MCP agent entry and preview-config link on finish-setup ([#1596](https://github.com/Autonoma-AI/agent/issues/1596)) ([596e1b0](https://github.com/Autonoma-AI/agent/commit/596e1b0ea8bc2b48c425802c2158820f9403f705))
* **onboarding:** deploy/redeploy button for SDK dry-run targets ([#1592](https://github.com/Autonoma-AI/agent/issues/1592)) ([8a89a79](https://github.com/Autonoma-AI/agent/commit/8a89a796cbe337489e3fd642ecf6e7c9e70c58dd))
* **onboarding:** per-key env request form with skip - stop stranding users on keys they don't have ([#1587](https://github.com/Autonoma-AI/agent/issues/1587)) ([5dda445](https://github.com/Autonoma-AI/agent/commit/5dda4459b54cc01a35995ef757522b3e921575e0))
* **onboarding:** show the build cause (branch @ sha + commit message) on SDK targets ([#1593](https://github.com/Autonoma-AI/agent/issues/1593)) ([771460e](https://github.com/Autonoma-AI/agent/commit/771460e8fec122697b7b296fea5994d8e3fafc63))
* **onboarding:** tab/chime/browser-notification attention cues on the agent session (tRPC polling) ([#1588](https://github.com/Autonoma-AI/agent/issues/1588)) ([cf55d08](https://github.com/Autonoma-AI/agent/commit/cf55d08e2548098ac31de432d9b3f713e098c61e))
* previewkit environment on the PR page and list ([#1482](https://github.com/Autonoma-AI/agent/issues/1482)) ([82d2e6a](https://github.com/Autonoma-AI/agent/commit/82d2e6a0495aa37a73f4eb4ea8feb13433b335cf))
* **previewkit:** redeploy resolves the latest head instead of re-running the stored sha ([#1590](https://github.com/Autonoma-AI/agent/issues/1590)) ([1853734](https://github.com/Autonoma-AI/agent/commit/185373430b1ed5b769c2a7ef984db37acbe09f75))
* **ui:** environment summary strip for the Preview tab ([#1626](https://github.com/Autonoma-AI/agent/issues/1626)) ([e0cbdac](https://github.com/Autonoma-AI/agent/commit/e0cbdac2dd0f072974d33be74f0e5c9454e367c8))
* **ui:** fixed-viewport shell for the PR Preview tab ([#1617](https://github.com/Autonoma-AI/agent/issues/1617)) ([e0a1854](https://github.com/Autonoma-AI/agent/commit/e0a18544d0f2795a3d5da7ba0058f363b2a0b45c))
* **ui:** logs toolbar and footer for the Preview tab ([#1622](https://github.com/Autonoma-AI/agent/issues/1622)) ([a122622](https://github.com/Autonoma-AI/agent/commit/a1226223e66c60028fcd618880254d2edeacbccd))
* **ui:** storybook + MSW screenshot pipeline for PR UI previews ([#1594](https://github.com/Autonoma-AI/agent/issues/1594)) ([d51669b](https://github.com/Autonoma-AI/agent/commit/d51669b2c468da2ff2a296bc509d8ead3e9a6a06))


### Bug Fixes

* **ci:** vendor the OpenCode action to stop rate-limited setup flakes ([#1623](https://github.com/Autonoma-AI/agent/issues/1623)) ([f2707f3](https://github.com/Autonoma-AI/agent/commit/f2707f37588e4b796cbc7c258430e6067204e8f4))
* **ingress:** 301-redirect legacy agent.* hosts to the canonical hosts ([#1586](https://github.com/Autonoma-AI/agent/issues/1586)) ([ef46d37](https://github.com/Autonoma-AI/agent/commit/ef46d37a0ec6cdd8d4ddf696c460119e53ad6745))
* **mcp:** advertise the api.&lt;host&gt; origin as the OAuth resource ([#1625](https://github.com/Autonoma-AI/agent/issues/1625)) ([e184d8a](https://github.com/Autonoma-AI/agent/commit/e184d8a03b0ccf42ccc07c93e924b59b3f913180))
* **onboarding:** show every open PR in the SDK target dropdown with its state ([#1576](https://github.com/Autonoma-AI/agent/issues/1576)) ([5c97e32](https://github.com/Autonoma-AI/agent/commit/5c97e32760c811b2288c9842edb6a978f3af91c5))
* PR comment no longer shows green "no issues" over findings ([#1572](https://github.com/Autonoma-AI/agent/issues/1572)) ([a1c0aca](https://github.com/Autonoma-AI/agent/commit/a1c0aca6d3b4b7d7a7215756f83eb8ce167f98b5))
* **previewkit:** block buildkit metadata and control-plane access ([#1603](https://github.com/Autonoma-AI/agent/issues/1603)) ([db80651](https://github.com/Autonoma-AI/agent/commit/db80651b5f233fbcc03f28880c766be713800d70))
* **previewkit:** refresh EKS tokens before expiry ([#1604](https://github.com/Autonoma-AI/agent/issues/1604)) ([ceeb5ee](https://github.com/Autonoma-AI/agent/commit/ceeb5ee48f04f52a3d4cff0fe5bff61294836d29))
* **previewkit:** secret-path collision preflight at config save + AWS-safe owner tags ([#1585](https://github.com/Autonoma-AI/agent/issues/1585)) ([c84b66b](https://github.com/Autonoma-AI/agent/commit/c84b66bccfe16a273b8f080d0cb2a2ad36776321))


### Performance Improvements

* **ui:** defer PostHog support chat ([#1616](https://github.com/Autonoma-AI/agent/issues/1616)) ([dda9d16](https://github.com/Autonoma-AI/agent/commit/dda9d16be6ff46230f4f2da39e900a135d310603))

## [1.8.37](https://github.com/Autonoma-AI/agent/compare/v1.8.36...v1.8.37) (2026-07-16)


### Features

* **onboarding:** queued-deploy stepper on the agent configuring screen ([#1575](https://github.com/Autonoma-AI/agent/issues/1575)) ([05c25f5](https://github.com/Autonoma-AI/agent/commit/05c25f5731b00bdeb4bdc44dfd2ff66ad970f6ce))
* **previewkit:** warn when a database service has no app connection referencing it ([#1577](https://github.com/Autonoma-AI/agent/issues/1577)) ([0af5e32](https://github.com/Autonoma-AI/agent/commit/0af5e3272510f92eabe3d0868e3c98c39017e6a9))
* reconciler holistic dedup + shadow findings comparison store ([#1560](https://github.com/Autonoma-AI/agent/issues/1560)) ([55cfa64](https://github.com/Autonoma-AI/agent/commit/55cfa646c0077a2b033652c121c14a42ec3360ad))
* SDK-integration eval harness for the planner CLI ([#1500](https://github.com/Autonoma-AI/agent/issues/1500)) ([4d3a834](https://github.com/Autonoma-AI/agent/commit/4d3a8349d595bb501be43dbb59bb636aef1d259e))
* shadow analysis tracer bullet (select, run+classify, persist verdict) ([#1549](https://github.com/Autonoma-AI/agent/issues/1549)) ([78d7db3](https://github.com/Autonoma-AI/agent/commit/78d7db3ab4f1a041977298d42d633b3524d421d0))
* **ui:** custom feedback modal that dodges ad-blockers ([#1536](https://github.com/Autonoma-AI/agent/issues/1536)) ([ef70cfd](https://github.com/Autonoma-AI/agent/commit/ef70cfdb8bdf2a1ca7572d8fb5c689492cdd254a))


### Bug Fixes

* **api:** human-readable Zod validation errors over tRPC (no more raw JSON in toasts) ([#1574](https://github.com/Autonoma-AI/agent/issues/1574)) ([b9486a9](https://github.com/Autonoma-AI/agent/commit/b9486a9ee2d5c2c3808d4babba423490d1d4a915))
* **onboarding-mcp:** reject Autonoma-provided keys in request_env + stop agents parking on terminal input ([#1573](https://github.com/Autonoma-AI/agent/issues/1573)) ([63c6c4d](https://github.com/Autonoma-AI/agent/commit/63c6c4d61f66857140aa667b087faa66079d98ad))
* pass max retries to ai sdk ([#1580](https://github.com/Autonoma-AI/agent/issues/1580)) ([147eccd](https://github.com/Autonoma-AI/agent/commit/147eccd506ad4ad6c2c489644feb2d3c423de30d))

## [1.8.36](https://github.com/Autonoma-AI/agent/compare/v1.8.35...v1.8.36) (2026-07-16)


### Features

* add annotations for claude mcp plugin ([#1541](https://github.com/Autonoma-AI/agent/issues/1541)) ([5d8d7d1](https://github.com/Autonoma-AI/agent/commit/5d8d7d194f7a8efa3c2121f960f76cb45e6f7ec6))
* add tos, eula and privacy pages ([#1565](https://github.com/Autonoma-AI/agent/issues/1565)) ([096257c](https://github.com/Autonoma-AI/agent/commit/096257cb69650aed55745ce191078b691fff6523))
* build vercel cronjobs ([#1545](https://github.com/Autonoma-AI/agent/issues/1545)) ([7f75ef5](https://github.com/Autonoma-AI/agent/commit/7f75ef5f68b16cc5a113b89dcccdb61c4e2a6b52))
* cache-aware pricing for investigation classifier models ([#1547](https://github.com/Autonoma-AI/agent/issues/1547)) ([fc96b2f](https://github.com/Autonoma-AI/agent/commit/fc96b2fa73f413abed9f085b40512a652d01add8))
* set redirect uri variable per environment ([#1566](https://github.com/Autonoma-AI/agent/issues/1566)) ([0757aec](https://github.com/Autonoma-AI/agent/commit/0757aecd59d296d60fa7db167c5c983b7fe129c5))
* shadow-mode skeleton for the merged analysis pipeline ([#1526](https://github.com/Autonoma-AI/agent/issues/1526)) ([dbc65e8](https://github.com/Autonoma-AI/agent/commit/dbc65e834a444f1c7ba63788f0f2192d0e6fcf01))
* single text-first PR comment + investigation findings over MCP ([#1493](https://github.com/Autonoma-AI/agent/issues/1493)) ([5dc2aef](https://github.com/Autonoma-AI/agent/commit/5dc2aef4d5df246c123eef1c20feee41ed2a9be5))


### Bug Fixes

* **api:** recover PR investigation comments dropped mid-onboarding ([#1497](https://github.com/Autonoma-AI/agent/issues/1497)) ([b734945](https://github.com/Autonoma-AI/agent/commit/b734945a0e281879859bf4acccffa88b4060c89b))
* **db:restore:** clear jwks after restore so local auth can decrypt ([#1534](https://github.com/Autonoma-AI/agent/issues/1534)) ([f9058a5](https://github.com/Autonoma-AI/agent/commit/f9058a5db5aeab0981febb2b94e788cda0148ee6))
* **mcp:** point MCP/API host at api.autonoma.app, off CloudFront ([#1551](https://github.com/Autonoma-AI/agent/issues/1551)) ([80bf358](https://github.com/Autonoma-AI/agent/commit/80bf3584e054232a0babfdeaa8fcc82db8de766d))
* **onboarding:** activate the first uploaded suite so tests are immediately usable ([#1557](https://github.com/Autonoma-AI/agent/issues/1557)) ([3d96a7b](https://github.com/Autonoma-AI/agent/commit/3d96a7be29d9f4c4e383210fad83b6b4a9c0d20e))
* **onboarding:** hide Docker sandbox tab in CLI setup step ([#1550](https://github.com/Autonoma-AI/agent/issues/1550)) ([31cf106](https://github.com/Autonoma-AI/agent/commit/31cf106d065d4d88ff81a72b915da33186496589))
* **onboarding:** stop a rebuild demoting a verified preview back to previewkit_deploying ([#1559](https://github.com/Autonoma-AI/agent/issues/1559)) ([f7a23f3](https://github.com/Autonoma-AI/agent/commit/f7a23f3b8a91207fbe309b8cb9b99df3bdd9f078))
* **onboarding:** stop CLI-step reset on refresh, gate on recipe, harden CLI upload ([#1553](https://github.com/Autonoma-AI/agent/issues/1553)) ([c6d7923](https://github.com/Autonoma-AI/agent/commit/c6d79230fa1ae0c9507be7b6ed7f28fb3ea5627b))
* **previewkit:** show per-app build durations ([#1533](https://github.com/Autonoma-AI/agent/issues/1533)) ([142c6a0](https://github.com/Autonoma-AI/agent/commit/142c6a09259decd164d86292fa29e6c74407d3c7))
* **previewkit:** use Autonoma bun base image (bun + curl) for the bun preset ([#1564](https://github.com/Autonoma-AI/agent/issues/1564)) ([a7f0326](https://github.com/Autonoma-AI/agent/commit/a7f032619ee966d3f49038523b794d554b89e90b))
* **ui:** drop the 'Generating your tests' view on the Tests page ([#1554](https://github.com/Autonoma-AI/agent/issues/1554)) ([a1406d9](https://github.com/Autonoma-AI/agent/commit/a1406d992c6c93ba527f3768ca2374194ea51dc6))

## [1.8.35](https://github.com/Autonoma-AI/agent/compare/v1.8.34...v1.8.35) (2026-07-15)


### Features

* **debug-mcp:** add get_config/apply_config + share MCP tool-result helpers ([#1539](https://github.com/Autonoma-AI/agent/issues/1539)) ([2ded15d](https://github.com/Autonoma-AI/agent/commit/2ded15da9d86e46005180db293e887d2394a9fef))
* generate test user from preview ui ([#1522](https://github.com/Autonoma-AI/agent/issues/1522)) ([5ac750d](https://github.com/Autonoma-AI/agent/commit/5ac750da58638b9f82a8b6e2a5709dcf281c2407))
* **preview-config:** list dependency repos in the settings rail ([#1532](https://github.com/Autonoma-AI/agent/issues/1532)) ([1e7c184](https://github.com/Autonoma-AI/agent/commit/1e7c1845ec8ae674239932923407153382041d62))
* **preview:** connect-agent box on preview settings + detail link, unify UI naming ([#1528](https://github.com/Autonoma-AI/agent/issues/1528)) ([3994018](https://github.com/Autonoma-AI/agent/commit/3994018d575d04afd4bd7b361b81c056104618df))
* vercel integration v2 ([#1243](https://github.com/Autonoma-AI/agent/issues/1243)) ([1d0e5c6](https://github.com/Autonoma-AI/agent/commit/1d0e5c61a8c976109a678ec74832d9fc97b2720c))


### Bug Fixes

* **github:** accept setup_action=update on the install callback ([#1537](https://github.com/Autonoma-AI/agent/issues/1537)) ([407f86a](https://github.com/Autonoma-AI/agent/commit/407f86a2351887654a5846de627ec83eaf33e170))
* properly resolve sdk url for provisioning test user ([#1538](https://github.com/Autonoma-AI/agent/issues/1538)) ([d861bd2](https://github.com/Autonoma-AI/agent/commit/d861bd2859f8938c64a02908af42b0d620ddb1e2))

## [1.8.34](https://github.com/Autonoma-AI/agent/compare/v1.8.33...v1.8.34) (2026-07-14)


### Features

* **admin:** improve organization list controls ([#1465](https://github.com/Autonoma-AI/agent/issues/1465)) ([6f9eedb](https://github.com/Autonoma-AI/agent/commit/6f9eedb6527db215b6530e0681713fab3d6e8c82))
* **ci:** add production hotfix workflow ([#1490](https://github.com/Autonoma-AI/agent/issues/1490)) ([2dcb4d0](https://github.com/Autonoma-AI/agent/commit/2dcb4d0cb352213fdb78b294ed6c05eb121537a3))
* **cli:** monorepo-aware planner (project mapper + FE/BE scoping) ([#1472](https://github.com/Autonoma-AI/agent/issues/1472)) ([d58fd8e](https://github.com/Autonoma-AI/agent/commit/d58fd8ee48ec5e6dc44fa56e65ae144f0d67ceb0))
* explicit previewkit environment to branch relation ([#1475](https://github.com/Autonoma-AI/agent/issues/1475)) ([9292859](https://github.com/Autonoma-AI/agent/commit/9292859245d519b21b0ce72c89ddc077fab22b2f))
* **mcp:** add PostHog usage analytics per tool and customer ([#1474](https://github.com/Autonoma-AI/agent/issues/1474)) ([994ed44](https://github.com/Autonoma-AI/agent/commit/994ed4444389af4fafb2bd9a35ae46566f53c4f1))
* **onboarding:** collapse the agent screen once the preview is live + calmer phase spinner ([#1525](https://github.com/Autonoma-AI/agent/issues/1525)) ([d73abff](https://github.com/Autonoma-AI/agent/commit/d73abffb3c1ea49a0ff0eac50f6cd7563e861b77))
* **previewkit:** agentic onboarding MCP config-session foundation ([#1485](https://github.com/Autonoma-AI/agent/issues/1485)) ([6832f90](https://github.com/Autonoma-AI/agent/commit/6832f905f1e2d7db775213af86401f759efac292))
* **previewkit:** browse repo file tree to select a Dockerfile ([#1484](https://github.com/Autonoma-AI/agent/issues/1484)) ([6553bc9](https://github.com/Autonoma-AI/agent/commit/6553bc9daea8b605b60ee9464c9f9ea07ca68202))
* **previewkit:** embed pod state + events in buildkit provisioning timeouts ([#1496](https://github.com/Autonoma-AI/agent/issues/1496)) ([6c2dc57](https://github.com/Autonoma-AI/agent/commit/6c2dc57fb3739b8a73432d14cfffaabb1ef41676))
* **previewkit:** isolate runner jobs on a dedicated node pool ([#1501](https://github.com/Autonoma-AI/agent/issues/1501)) ([d66eda7](https://github.com/Autonoma-AI/agent/commit/d66eda7df649813d4b39a1be87cff4d75b9f489c))
* **previewkit:** label ephemeral buildkit Jobs with deploy identity ([#1502](https://github.com/Autonoma-AI/agent/issues/1502)) ([efe709e](https://github.com/Autonoma-AI/agent/commit/efe709e06a110fc4a10506336341afd093413517))
* **previewkit:** page on buildkit job death via Sentry issue ([#1524](https://github.com/Autonoma-AI/agent/issues/1524)) ([35d7c16](https://github.com/Autonoma-AI/agent/commit/35d7c168251e7467f4ed4baa1509566393002dcf))
* **skill:** add watch-opencode PR-review watcher ([#1491](https://github.com/Autonoma-AI/agent/issues/1491)) ([cc82bdb](https://github.com/Autonoma-AI/agent/commit/cc82bdb0d6aae41edf03d0e96601b7fd3ed357e7))
* **skill:** add weekly Feature MVP leaderboard ([#1487](https://github.com/Autonoma-AI/agent/issues/1487)) ([51b16f4](https://github.com/Autonoma-AI/agent/commit/51b16f48ba21c00bf35628332a9cb23ca0d28175))
* **ui:** add per-app preview redeploy controls ([#1479](https://github.com/Autonoma-AI/agent/issues/1479)) ([33d397b](https://github.com/Autonoma-AI/agent/commit/33d397b899cd745a91acfd0b1a8b64e4103ad792))
* **ui:** add PostHog experiment (A/B test) hook ([#1467](https://github.com/Autonoma-AI/agent/issues/1467)) ([92028b1](https://github.com/Autonoma-AI/agent/commit/92028b14e3d98eb74b123d29631f14b192018dfb))


### Bug Fixes

* **deploy:** stop alpha postgres orphaning EBS VolumeAttachments ([#1499](https://github.com/Autonoma-AI/agent/issues/1499)) ([2505860](https://github.com/Autonoma-AI/agent/commit/25058600a0dce4bab6c801f60a14da27bc06112d))
* **finish-setup:** planner sandbox image node:22 + link the planner docs ([#1527](https://github.com/Autonoma-AI/agent/issues/1527)) ([6cb4cc8](https://github.com/Autonoma-AI/agent/commit/6cb4cc866e6b7eeee1fa5902db281936d044d98a))
* **onboarding:** clearer deploy status in the agent configuring view ([#1503](https://github.com/Autonoma-AI/agent/issues/1503)) ([3c7afe4](https://github.com/Autonoma-AI/agent/commit/3c7afe4ba7de540104d0cd0848138a315a93d868))
* **onboarding:** edit config from a ready preview + agent banner placement ([#1498](https://github.com/Autonoma-AI/agent/issues/1498)) ([faf966f](https://github.com/Autonoma-AI/agent/commit/faf966f3228fd078cff091deaaa69e2f0b2942e1))
* **onboarding:** stop pre-computing generations at go-live; remove sidebar agent-status loader ([#1478](https://github.com/Autonoma-AI/agent/issues/1478)) ([4354210](https://github.com/Autonoma-AI/agent/commit/4354210f4c74da0187c211a904b2008326df3a53))
* **onboarding:** use `import type` for phosphor Icon so the UI build resolves ([#1523](https://github.com/Autonoma-AI/agent/issues/1523)) ([a7ecc96](https://github.com/Autonoma-AI/agent/commit/a7ecc963111c06d4adf1fc207c7b224389651868))
* **previewkit:** onboarding live status + prominent agent entry ([#1492](https://github.com/Autonoma-AI/agent/issues/1492)) ([a198531](https://github.com/Autonoma-AI/agent/commit/a198531113f1fca15c60dacaf46d7dd74ececbf5))
* **previewkit:** unblock redeploys wedged by orphaned ExternalSecrets + onboarding UX ([#1505](https://github.com/Autonoma-AI/agent/issues/1505)) ([4558ff8](https://github.com/Autonoma-AI/agent/commit/4558ff8a9ce5e028dea0c159a417ffe696c1dd96))
* **previewkit:** use m-family xlarge build nodes ([#1488](https://github.com/Autonoma-AI/agent/issues/1488)) ([6809d0d](https://github.com/Autonoma-AI/agent/commit/6809d0dce87a3b7d5bbc71e19ae1b37969075ba5))
* **ui:** collapse app-picker sections only past 5, add primary CTA when collapsed ([#1486](https://github.com/Autonoma-AI/agent/issues/1486)) ([7bc6390](https://github.com/Autonoma-AI/agent/commit/7bc63908898cff55755247720017347e1f3af66f))
* **ui:** only show the app picker when no app is ready, and fix its layout ([#1477](https://github.com/Autonoma-AI/agent/issues/1477)) ([40368b1](https://github.com/Autonoma-AI/agent/commit/40368b110588d9267f8ff2557ef6ddd7b3daefe0))


### Performance Improvements

* **ci:** persist turbo cache and make library builds emit-only ([#1480](https://github.com/Autonoma-AI/agent/issues/1480)) ([e7a5942](https://github.com/Autonoma-AI/agent/commit/e7a59421f5a12255dde0ae240a8b736415171fea))

## [1.8.33](https://github.com/Autonoma-AI/agent/compare/v1.8.32...v1.8.33) (2026-07-13)


### Features

* BugWhySection falls back to description + whatHappened for pre-report bugs ([#1344](https://github.com/Autonoma-AI/agent/issues/1344)) ([70359b4](https://github.com/Autonoma-AI/agent/commit/70359b48d5b260b727c0865594cb9699aff9a649))
* **ci:** add Slack approval reaction ([#1462](https://github.com/Autonoma-AI/agent/issues/1462)) ([33c8fe2](https://github.com/Autonoma-AI/agent/commit/33c8fe206a3476c4d4a0dad81d2c38469d95701a))
* **onboarding:** redesign preview-environment selection screen as two equal cards ([#1455](https://github.com/Autonoma-AI/agent/issues/1455)) ([75fec83](https://github.com/Autonoma-AI/agent/commit/75fec83b50ee0fd6cffb0e44493903be8422516a))
* **onboarding:** redesign resume screen as an application hub ([#1458](https://github.com/Autonoma-AI/agent/issues/1458)) ([032a531](https://github.com/Autonoma-AI/agent/commit/032a531b39d8e79fe1162db2ffd944ef14e7dafc))
* **previewkit:** add PR deployment history to the environment page ([#1461](https://github.com/Autonoma-AI/agent/issues/1461)) ([6f488f3](https://github.com/Autonoma-AI/agent/commit/6f488f3073e199be254f05f58fb58c0c864bac85))
* **previewkit:** explain planner CLI files + add a Docker (sandbox) tab ([#1457](https://github.com/Autonoma-AI/agent/issues/1457)) ([733e303](https://github.com/Autonoma-AI/agent/commit/733e303db401a2ca30ff008494b157eb8ca844ae))
* **previewkit:** filter turbo builds by workspace package name ([#1464](https://github.com/Autonoma-AI/agent/issues/1464)) ([2d2117e](https://github.com/Autonoma-AI/agent/commit/2d2117ea61aa5c66c5e436dca52d21e6463f0f19))
* **previewkit:** link the new onboarding steps to their docs ([#1450](https://github.com/Autonoma-AI/agent/issues/1450)) ([05b11ba](https://github.com/Autonoma-AI/agent/commit/05b11bacc2dc401d5f401a272f65ade28db31ef5))
* **previewkit:** link the Variables editor to the secrets docs ([#1452](https://github.com/Autonoma-AI/agent/issues/1452)) ([759de03](https://github.com/Autonoma-AI/agent/commit/759de035fc0982065d76a65db99d011acf4c4412))
* **previewkit:** onboarding redesign - Database step, Extra services, guided setup tasks ([#1440](https://github.com/Autonoma-AI/agent/issues/1440)) ([1e2f3a3](https://github.com/Autonoma-AI/agent/commit/1e2f3a3b83b163d502d143dafde425b8c1b236ba))
* **previewkit:** rich dropdown for connection references ([#1453](https://github.com/Autonoma-AI/agent/issues/1453)) ([2b5f6cd](https://github.com/Autonoma-AI/agent/commit/2b5f6cd7d109bfc153b5b3b66a11c111198ca388))
* **previewkit:** show runtime logs for recipe services in the env page ([#1463](https://github.com/Autonoma-AI/agent/issues/1463)) ([25f6b0c](https://github.com/Autonoma-AI/agent/commit/25f6b0cbefdbe26a9a81b3f95f10ba4d7b3bb16a))


### Bug Fixes

* **api:** restore BETTER_AUTH_URL for local login ([#1449](https://github.com/Autonoma-AI/agent/issues/1449)) ([024c006](https://github.com/Autonoma-AI/agent/commit/024c006f1892422e439b48360778f72c75e9012b))
* disable tests for cli usage cap temporary ([#1471](https://github.com/Autonoma-AI/agent/issues/1471)) ([68644f8](https://github.com/Autonoma-AI/agent/commit/68644f805ed47505a71ce8616000b75aba92eb15))
* **previewkit:** clearer, property-aware connection reference feedback ([#1456](https://github.com/Autonoma-AI/agent/issues/1456)) ([9332d04](https://github.com/Autonoma-AI/agent/commit/9332d04a17e99e9b601e0996c57e442f91355c4a))
* **previewkit:** finish lifecycle hooks + darken review stage arrows ([#1446](https://github.com/Autonoma-AI/agent/issues/1446)) ([4137930](https://github.com/Autonoma-AI/agent/commit/413793067d3092464025f55a1d21e6fba9e1a48e))
* **previewkit:** hide internal Health check field from onboarding UI ([#1429](https://github.com/Autonoma-AI/agent/issues/1429)) ([1617d12](https://github.com/Autonoma-AI/agent/commit/1617d12d3a9e0ec35f097c0297f325cfbd1c22df))
* **previewkit:** invoke turbo binary correctly for all package managers ([#1443](https://github.com/Autonoma-AI/agent/issues/1443)) ([5e6979a](https://github.com/Autonoma-AI/agent/commit/5e6979a91a8acb2a5e0ad115c0115e43e42755d6))
* **previewkit:** keep deploy log scroll position when user scrolls up ([#1430](https://github.com/Autonoma-AI/agent/issues/1430)) ([498680f](https://github.com/Autonoma-AI/agent/commit/498680fe0ee22812d0056f18e0318cc92d8d7c64))
* **previewkit:** show the database version in the card title ([#1447](https://github.com/Autonoma-AI/agent/issues/1447)) ([8faa532](https://github.com/Autonoma-AI/agent/commit/8faa532bf43643354fbb0b4cc6c815146bf894e2))
* **previewkit:** stop the app-name field flashing "already exists" on submit ([#1451](https://github.com/Autonoma-AI/agent/issues/1451)) ([b138f8e](https://github.com/Autonoma-AI/agent/commit/b138f8e06a15ab400acc8f73ebab65499a99418f))


### Reverts

* **onboarding:** restore pre-[#1455](https://github.com/Autonoma-AI/agent/issues/1455) preview-environment screen ([#1459](https://github.com/Autonoma-AI/agent/issues/1459)) ([836140e](https://github.com/Autonoma-AI/agent/commit/836140e2cbab0b97443b6d7ad6c00849df8056aa))

## [1.8.32](https://github.com/Autonoma-AI/agent/compare/v1.8.31...v1.8.32) (2026-07-10)


### Features

* **cli:** use blacklight primary color as the CLI brand accent ([#1431](https://github.com/Autonoma-AI/agent/issues/1431)) ([c1c20e1](https://github.com/Autonoma-AI/agent/commit/c1c20e1dcd091709acc0eeb532c591fa7fdb7d66))
* per-app deploy logs on previewkit onboarding ([#1395](https://github.com/Autonoma-AI/agent/issues/1395)) ([90f5125](https://github.com/Autonoma-AI/agent/commit/90f5125ed8cf9ead36333ce76e9bf61d28b2be00))
* **previewkit:** scrollable repo list + fuzzy search in the add-app modal ([#1435](https://github.com/Autonoma-AI/agent/issues/1435)) ([894d8bd](https://github.com/Autonoma-AI/agent/commit/894d8bd4a450fd1bc725de8c80f41c41d69acf7a))


### Bug Fixes

* **previewkit:** drop S3 buildkit cache, rely on warm pool's local NVMe ([#1428](https://github.com/Autonoma-AI/agent/issues/1428)) ([ac64cb5](https://github.com/Autonoma-AI/agent/commit/ac64cb53578bea8362fa6ed4c0ebe4316398b555))
* **previewkit:** normalize k8s lease timestamps read as strings in build queue ([#1422](https://github.com/Autonoma-AI/agent/issues/1422)) ([dc54591](https://github.com/Autonoma-AI/agent/commit/dc545910ef4a32e6306d7cc42f725c7a466a0e6a))

## [1.8.32](https://github.com/Autonoma-AI/agent/compare/v1.8.31...v1.8.32) (2026-07-10)


### Bug Fixes

* **previewkit:** normalize k8s lease timestamps read as strings in build queue ([#1422](https://github.com/Autonoma-AI/agent/issues/1422)) ([dc54591](https://github.com/Autonoma-AI/agent/commit/dc545910ef4a32e6306d7cc42f725c7a466a0e6a))

## [1.8.31](https://github.com/Autonoma-AI/agent/compare/v1.8.30...v1.8.31) (2026-07-10)


### Features

* **onboarding:** add apps from a dependency repo in-place (drop the "Dependency repos" band) ([#1416](https://github.com/Autonoma-AI/agent/issues/1416)) ([aea40a9](https://github.com/Autonoma-AI/agent/commit/aea40a9812942688d4ac7cea842c6cd7a9f45731))


### Bug Fixes

* **api:** teach the debug MCP that logs survive preview teardown ([#1419](https://github.com/Autonoma-AI/agent/issues/1419)) ([cfb2b6e](https://github.com/Autonoma-AI/agent/commit/cfb2b6e5bfae353e852344beee3a16f2504f1656))
* **previewkit:** read secret status from latest config (unblock beta deploy) ([#1420](https://github.com/Autonoma-AI/agent/issues/1420)) ([41a240c](https://github.com/Autonoma-AI/agent/commit/41a240c1957b8982ac58422540275561e8864807))
* **ui:** route MCP OAuth discovery (.well-known/oauth-*) to the API ([#1415](https://github.com/Autonoma-AI/agent/issues/1415)) ([0159486](https://github.com/Autonoma-AI/agent/commit/0159486fea9b471f5e36cc2fec3dfb0d0de433ee))

## [1.8.30](https://github.com/Autonoma-AI/agent/compare/v1.8.29...v1.8.30) (2026-07-10)


### Features

* **api:** client-debug MCP server + previewkit tools (Workstream B) ([#1384](https://github.com/Autonoma-AI/agent/issues/1384)) ([c0239ab](https://github.com/Autonoma-AI/agent/commit/c0239abb9a4d81ca9c504ba2103191971a82df0e))
* **onboarding:** clarify Dockerfile build fields (root directory + hints) ([#1413](https://github.com/Autonoma-AI/agent/issues/1413)) ([0afe6a8](https://github.com/Autonoma-AI/agent/commit/0afe6a8191793cdb14001fa23b1458da32427e9d))
* **onboarding:** show app (runtime) logs on the deploy page, auto-advance from build ([#1412](https://github.com/Autonoma-AI/agent/issues/1412)) ([e691d77](https://github.com/Autonoma-AI/agent/commit/e691d775454e41cfe38916a9bcf2f28a462b9e2b))
* **previewkit:** raw runtime build type + config UI (part 1) ([#1372](https://github.com/Autonoma-AI/agent/issues/1372)) ([31bee96](https://github.com/Autonoma-AI/agent/commit/31bee969aa24fa11f9630417bfbc57fcd658ad7e))
* **ui:** add Preview Environments to the app sidebar ([#1407](https://github.com/Autonoma-AI/agent/issues/1407)) ([b537be5](https://github.com/Autonoma-AI/agent/commit/b537be50c2c99da1ee49c7b5a5e8f96b5c397c32))


### Bug Fixes

* **previewkit:** pass build args as BuildKit secrets for Dockerfile … ([#1411](https://github.com/Autonoma-AI/agent/issues/1411)) ([3e219f8](https://github.com/Autonoma-AI/agent/commit/3e219f8868cb9ab16a4e352999314ed0cbf50e3d))
* **previewkit:** retry + explain buildkit-pool outages instead of leaking gRPC errors ([#1410](https://github.com/Autonoma-AI/agent/issues/1410)) ([d78d251](https://github.com/Autonoma-AI/agent/commit/d78d251ad77d5922864adf84f4b80d474eff3dee))

## [1.8.29](https://github.com/Autonoma-AI/agent/compare/v1.8.28...v1.8.29) (2026-07-09)


### Features

* **investigation:** gate previewkit tools by integration + weight logs above code ([#1403](https://github.com/Autonoma-AI/agent/issues/1403)) ([bef0187](https://github.com/Autonoma-AI/agent/commit/bef018759fcddce93c5d6be1b9fb777eb5168a1b))
* **previewkit:** bulk-import variables by pasting a .env file ([#1391](https://github.com/Autonoma-AI/agent/issues/1391)) ([a7e58ba](https://github.com/Autonoma-AI/agent/commit/a7e58ba53905e73e3eaab790c5c21963552d6fe3))
* **previewkit:** queue buildkit pool admission with per-pod slot leases ([#1382](https://github.com/Autonoma-AI/agent/issues/1382)) ([1848cc9](https://github.com/Autonoma-AI/agent/commit/1848cc9614a8d683e46fb1e13eee83837dd27132))
* **previewkit:** replace config revisions with a single latest-only config ([#1383](https://github.com/Autonoma-AI/agent/issues/1383)) ([b9d2d71](https://github.com/Autonoma-AI/agent/commit/b9d2d71b5424de424b945ffcf3d39acf44444ca8))


### Bug Fixes

* **github:** suppress PR comments until the app is fully onboarded ([#1401](https://github.com/Autonoma-AI/agent/issues/1401)) ([ff0ae8e](https://github.com/Autonoma-AI/agent/commit/ff0ae8ef5905a775bda1a3c596ed677f02ed4be3))
* **llm-proxy:** raise per-request body cap to fit a full context window ([#1400](https://github.com/Autonoma-AI/agent/issues/1400)) ([3c92252](https://github.com/Autonoma-AI/agent/commit/3c922522c2e61e33d3cb43d23947dfd74bf5e28d))

## [1.8.28](https://github.com/Autonoma-AI/agent/compare/v1.8.27...v1.8.28) (2026-07-09)


### Bug Fixes

* **cli:** raise model retries to 10 (SDK-native) ([#1396](https://github.com/Autonoma-AI/agent/issues/1396)) ([1307968](https://github.com/Autonoma-AI/agent/commit/1307968b48f8e4e0e2ae864ef80ec094873638e7))
* **previewkit:** retry buildkit session-loss failures ([#1397](https://github.com/Autonoma-AI/agent/issues/1397)) ([8d656a5](https://github.com/Autonoma-AI/agent/commit/8d656a557697cd086f88a2cbe3be1925ca8b1e0c))
* remove the replay subsystem ([#1350](https://github.com/Autonoma-AI/agent/issues/1350)) ([23983de](https://github.com/Autonoma-AI/agent/commit/23983ded3d544fc10a6379b516a923547cbe31c4))

## [1.8.27](https://github.com/Autonoma-AI/agent/compare/v1.8.26...v1.8.27) (2026-07-09)


### Features

* **investigation:** independent pre-PR catalog + strict new-test proposal bar ([#1387](https://github.com/Autonoma-AI/agent/issues/1387)) ([d4ab228](https://github.com/Autonoma-AI/agent/commit/d4ab228e45a446d657b5b4be826f8dd754be859f))
* **investigation:** run proposed new tests seeded against the standard scenario ([#1390](https://github.com/Autonoma-AI/agent/issues/1390)) ([bbd0342](https://github.com/Autonoma-AI/agent/commit/bbd03423c285e7f49af9f407ca7e7a0b7ff62cf6))
* **onboarding:** editable app-name header on PreviewKit config step ([#1380](https://github.com/Autonoma-AI/agent/issues/1380)) ([a5348e7](https://github.com/Autonoma-AI/agent/commit/a5348e76ac5a15b505f8e6f55c160777add711a3))
* **ui:** merge previewkit onboarding save + deploy into one button ([#1378](https://github.com/Autonoma-AI/agent/issues/1378)) ([4e778e8](https://github.com/Autonoma-AI/agent/commit/4e778e8fbc5bb374024948f11ed4194b70d2882c))


### Bug Fixes

* **ai:** retry model calls with capped exponential backoff (10 retries) ([#1393](https://github.com/Autonoma-AI/agent/issues/1393)) ([c139c82](https://github.com/Autonoma-AI/agent/commit/c139c82ac1ea637f5afa6c5c56a0371a2386ab85))
* **previewkit:** self-heal DB/AWS drift in the secret upsert ([#1381](https://github.com/Autonoma-AI/agent/issues/1381)) ([6bd91f9](https://github.com/Autonoma-AI/agent/commit/6bd91f963178ccee790223e8bd212ae40814e0b1))
* **test-updates:** inline plan authoring guide to unbreak API boot ([#1392](https://github.com/Autonoma-AI/agent/issues/1392)) ([2dd6510](https://github.com/Autonoma-AI/agent/commit/2dd6510f51fb76e86c2f0db5cd3b8ec637d5ea04))

## [1.8.26](https://github.com/Autonoma-AI/agent/compare/v1.8.25...v1.8.26) (2026-07-09)


### Features

* **ui:** delete a variable from its row without opening the drawer ([#1375](https://github.com/Autonoma-AI/agent/issues/1375)) ([7dbcbc2](https://github.com/Autonoma-AI/agent/commit/7dbcbc2765d117337c0f3bb406137a8401d7bf39))


### Bug Fixes

* **github:** emoji status dots and new-tab links in PR comments ([#1377](https://github.com/Autonoma-AI/agent/issues/1377)) ([fa18fce](https://github.com/Autonoma-AI/agent/commit/fa18fcedef81f9e34813b16811103c2e4fcf29a1))
* **previewkit:** exclude packages/* library workspaces from app suggestions ([#1379](https://github.com/Autonoma-AI/agent/issues/1379)) ([c2c54d0](https://github.com/Autonoma-AI/agent/commit/c2c54d08ac52a15e1a4fa201c179e3beec9d5ad9))
* **previewkit:** import sharp-free @autonoma/ai/llm to unbreak api AI ([#1363](https://github.com/Autonoma-AI/agent/issues/1363)) ([9679cdb](https://github.com/Autonoma-AI/agent/commit/9679cdb668532e1af82c3f2be73634a6d4d817af))
* **previewkit:** support config schemaVersion 2 in runner resolver ([#1385](https://github.com/Autonoma-AI/agent/issues/1385)) ([7e49a43](https://github.com/Autonoma-AI/agent/commit/7e49a4300176d98cd9df5745f8807b52b8ac310a))

## [1.8.25](https://github.com/Autonoma-AI/agent/compare/v1.8.24...v1.8.25) (2026-07-09)


### Features

* bug page adaptive hero media (screenshot + video side by side) ([#1313](https://github.com/Autonoma-AI/agent/issues/1313)) ([8bcbbaa](https://github.com/Autonoma-AI/agent/commit/8bcbbaa1632c981e99c8347bf8aab6db94e94919))
* inline evidence in bug narrative (anchor-by-id + manifest + validation) ([#1331](https://github.com/Autonoma-AI/agent/issues/1331)) ([ee6add8](https://github.com/Autonoma-AI/agent/commit/ee6add85dac7dac75ac0f15f9e6865d2ecba658f))
* **llm-proxy:** cap free-account CLI spend and per-request size to prevent abuse ([#1351](https://github.com/Autonoma-AI/agent/issues/1351)) ([1f0807f](https://github.com/Autonoma-AI/agent/commit/1f0807f1fc10123f78f71b6c941c31c18f8c23de))
* persist and surface hedged suspected cause on the bug page ([#1330](https://github.com/Autonoma-AI/agent/issues/1330)) ([cbda686](https://github.com/Autonoma-AI/agent/commit/cbda686c7aab8efb8c7f65899662eb974f1fc874))
* **ui:** preview-config section nav + redesign secrets manager ([#1242](https://github.com/Autonoma-AI/agent/issues/1242)) ([10fec27](https://github.com/Autonoma-AI/agent/commit/10fec27c772fa70a40eb330b222be40f85044913))
* **ui:** redesign Tests page with branch picker, plan view, and runs panel ([#1370](https://github.com/Autonoma-AI/agent/issues/1370)) ([db76096](https://github.com/Autonoma-AI/agent/commit/db7609644c8fc0f8ed1366239e77fad30dbfaf99))


### Bug Fixes

* **buildkit:** raise pod memory limit to 26Gi (rootless made 16Gi bind) ([#1366](https://github.com/Autonoma-AI/agent/issues/1366)) ([b7f6f7a](https://github.com/Autonoma-AI/agent/commit/b7f6f7a3492f86903cff3fcaf8cd685404573103))
* **investigation:** give the worker an IRSA SA to read previewkit secrets ([#1360](https://github.com/Autonoma-AI/agent/issues/1360)) ([9e11daa](https://github.com/Autonoma-AI/agent/commit/9e11daa58b87305560a4aa4ebd5f36212b889073))
* **investigation:** PR-comment finding deep links and replay CTA gating ([#1369](https://github.com/Autonoma-AI/agent/issues/1369)) ([498d885](https://github.com/Autonoma-AI/agent/commit/498d885ce3a64e1d46151a70ff32eade271fbbb1))
* **onboarding:** let users delete the app holding a repo so they can relink it ([#1371](https://github.com/Autonoma-AI/agent/issues/1371)) ([1ffd6c0](https://github.com/Autonoma-AI/agent/commit/1ffd6c064290ad80de7ce958eafa285cf12aa75d))
* **previewkit:** resolve preview secrets by Application, not org-wide by appName ([#1367](https://github.com/Autonoma-AI/agent/issues/1367)) ([cd68a26](https://github.com/Autonoma-AI/agent/commit/cd68a26d8c5b88a710f934fe3401029ff1937e7b))

## [1.8.24](https://github.com/Autonoma-AI/agent/compare/v1.8.23...v1.8.24) (2026-07-08)


### Features

* gate the legacy runs PR comment behind a flag ([#1352](https://github.com/Autonoma-AI/agent/issues/1352)) ([31a13bc](https://github.com/Autonoma-AI/agent/commit/31a13bc9bfd84676a43e35f58108fb4c4a28de64))
* **investigation:** wire get_app_logs to the preview's Loki stream ([#1357](https://github.com/Autonoma-AI/agent/issues/1357)) ([c69c709](https://github.com/Autonoma-AI/agent/commit/c69c709b59e7276d8e0ba9c3bb69902b15f13029))
* regenerate affected tests instead of replaying, remove manual run ([#1328](https://github.com/Autonoma-AI/agent/issues/1328)) ([00402fc](https://github.com/Autonoma-AI/agent/commit/00402fc26e40a2549be708b8e29d966dd9b25f38))
* **ui:** color stderr log lines red in the preview viewer ([#1334](https://github.com/Autonoma-AI/agent/issues/1334)) ([fe9a7c8](https://github.com/Autonoma-AI/agent/commit/fe9a7c81b64c55d8f16e413f8054128651265a4f))
* **ui:** render ANSI terminal colors in the preview log viewer ([#1346](https://github.com/Autonoma-AI/agent/issues/1346)) ([7bc4f09](https://github.com/Autonoma-AI/agent/commit/7bc4f098be79329ddd7f72337b16f69b754bea0d))


### Bug Fixes

* **app-shell:** org chooser instead of dead-ending on an ambiguous app slug ([#1347](https://github.com/Autonoma-AI/agent/issues/1347)) ([2053aa0](https://github.com/Autonoma-AI/agent/commit/2053aa0465f9bf6b782c366222a7ca129ce2a2a4))
* **buildkit:** run buildkitd rootless so the pod memory limit binds ([#1356](https://github.com/Autonoma-AI/agent/issues/1356)) ([6c26edc](https://github.com/Autonoma-AI/agent/commit/6c26edccdce051af5c63af8cc9a49f0dda8dcc8f))
* **investigation:** collapse the run trace by default with a View steps toggle ([#1343](https://github.com/Autonoma-AI/agent/issues/1343)) ([0b6e7c3](https://github.com/Autonoma-AI/agent/commit/0b6e7c3ef493b2f880c8e2cc3740ddda9197d187))
* **investigation:** move the run trace to its own section above Reproduction ([#1348](https://github.com/Autonoma-AI/agent/issues/1348)) ([ec6df9a](https://github.com/Autonoma-AI/agent/commit/ec6df9af465717722d63559b1c8aed80ffb06dd3))
* **previewkit:** cap per-pod buildkit concurrency to survive burst clients ([#1355](https://github.com/Autonoma-AI/agent/issues/1355)) ([e6033cf](https://github.com/Autonoma-AI/agent/commit/e6033cf213a8cca97631658a860d0dcea58a5e87))
* **previewkit:** strip stale preview button from runs comment on teardown ([#1337](https://github.com/Autonoma-AI/agent/issues/1337)) ([875a2a0](https://github.com/Autonoma-AI/agent/commit/875a2a03f6435b0e1afd45382484f3a40b1991c1))
* **ui:** render each log line individually in the preview viewer ([#1345](https://github.com/Autonoma-AI/agent/issues/1345)) ([f2c1c03](https://github.com/Autonoma-AI/agent/commit/f2c1c03755e094dd33f4f867524b4471e4c446c4))

## [1.8.23](https://github.com/Autonoma-AI/agent/compare/v1.8.22...v1.8.23) (2026-07-07)


### Features

* **investigation:** verifiable findings - evidence-gated verdicts + inspectable run trace ([#1335](https://github.com/Autonoma-AI/agent/issues/1335)) ([a2eb104](https://github.com/Autonoma-AI/agent/commit/a2eb1048c713c9f5de9e5d42b05417f2043d6d26))

## [1.8.22](https://github.com/Autonoma-AI/agent/compare/v1.8.21...v1.8.22) (2026-07-07)


### Features

* **docs:** add PostHog page-view analytics to the docs site ([#1322](https://github.com/Autonoma-AI/agent/issues/1322)) ([811d446](https://github.com/Autonoma-AI/agent/commit/811d4461428a8b93691602c7bb770fa845eb7d0c))
* **pr-comment:** per-bug collapsibles, evidence, and embedded failure media ([#1231](https://github.com/Autonoma-AI/agent/issues/1231)) ([25da815](https://github.com/Autonoma-AI/agent/commit/25da8150e4daaed36fbe1332600e232902830309))
* **previewkit:** server-side log search for preview environments ([#1329](https://github.com/Autonoma-AI/agent/issues/1329)) ([f8cda20](https://github.com/Autonoma-AI/agent/commit/f8cda20a04bd5752c293d167bddf36fdf9d6e1a3))
* report pending migration count in beta deploy Slack message ([#1332](https://github.com/Autonoma-AI/agent/issues/1332)) ([bdc8aec](https://github.com/Autonoma-AI/agent/commit/bdc8aec9b604aea633555543057af72d0e0ceb26))


### Bug Fixes

* **ci:** fetch git-LFS objects when deploying docs ([#1327](https://github.com/Autonoma-AI/agent/issues/1327)) ([a4fac91](https://github.com/Autonoma-AI/agent/commit/a4fac91d2aa7d70ca741a9827145842579d860bc))
* **ui:** nest the run trace inside Evidence on the investigation finding view ([#1333](https://github.com/Autonoma-AI/agent/issues/1333)) ([fec88a4](https://github.com/Autonoma-AI/agent/commit/fec88a4cb58defeb12d04c5cb6ae78b39e0b32a3))

## [1.8.21](https://github.com/Autonoma-AI/agent/compare/v1.8.20...v1.8.21) (2026-07-07)


### Bug Fixes

* **investigation:** cap shadow workflow wall-clock with a 6h execution timeout ([#1319](https://github.com/Autonoma-AI/agent/issues/1319)) ([2d2b943](https://github.com/Autonoma-AI/agent/commit/2d2b943c590b8423190dbff611567d141205a447))
* **investigation:** unblock worker throughput (per-pod concurrency + KEDA cap + unique clone dirs) ([#1323](https://github.com/Autonoma-AI/agent/issues/1323)) ([3fd4080](https://github.com/Autonoma-AI/agent/commit/3fd40808a29b2b19e6eafe96bddf4ee910eec3bf))


### Performance Improvements

* **temporal:** remove maxReplicaCount from Temporal workers ([#1324](https://github.com/Autonoma-AI/agent/issues/1324)) ([f5f3de5](https://github.com/Autonoma-AI/agent/commit/f5f3de5deffc23c2298641ab9a7d92bef291f1ae))

## [1.8.20](https://github.com/Autonoma-AI/agent/compare/v1.8.19...v1.8.20) (2026-07-06)


### Features

* bug page report spine (Issue.report + healing evidence tool) ([#1309](https://github.com/Autonoma-AI/agent/issues/1309)) ([0d3a81b](https://github.com/Autonoma-AI/agent/commit/0d3a81bdb17dfe3493dd2321e4ebd20f6e4aace6))
* **investigation:** default the run-recording video to 8x playback ([#1312](https://github.com/Autonoma-AI/agent/issues/1312)) ([87bfe76](https://github.com/Autonoma-AI/agent/commit/87bfe76bf3b851f67ef4209982184dad99464225))


### Bug Fixes

* **integration-test:** give integration cases a 30s default timeout ([#1316](https://github.com/Autonoma-AI/agent/issues/1316)) ([b8c975c](https://github.com/Autonoma-AI/agent/commit/b8c975cb850f4d94f2fe8509070de30f458ceaa0))
* **investigation:** fail fast when the workflow targets a non-pending snapshot ([#1317](https://github.com/Autonoma-AI/agent/issues/1317)) ([75924bf](https://github.com/Autonoma-AI/agent/commit/75924bf72182b9e44b1e4d972585c42d67cacab7))
* **investigation:** return null (not undefined) for a missing report so the page doesn't crash ([#1315](https://github.com/Autonoma-AI/agent/issues/1315)) ([edd1b9c](https://github.com/Autonoma-AI/agent/commit/edd1b9cfa1dc66de56f15c5bc21eb10ec6857899))

## [1.8.19](https://github.com/Autonoma-AI/agent/compare/v1.8.18...v1.8.19) (2026-07-06)


### Features

* **previewkit:** split onboarding steps and add service/env suggestions ([#1222](https://github.com/Autonoma-AI/agent/issues/1222)) ([52cf7ab](https://github.com/Autonoma-AI/agent/commit/52cf7ab7074f6785228ebcb7683390c54868e364))
* single-column bug page shell (meta strip, collapsed text repro) ([#1275](https://github.com/Autonoma-AI/agent/issues/1275)) ([d7fa699](https://github.com/Autonoma-AI/agent/commit/d7fa699684d98c8901e1725e90ccae33c85823ca))


### Bug Fixes

* **investigation:** stop flagging input-scroll as an overflow defect (false positive) ([#1308](https://github.com/Autonoma-AI/agent/issues/1308)) ([eeeb625](https://github.com/Autonoma-AI/agent/commit/eeeb625dde26f59a933f293e8199b89b22e1c07a))


### Reverts

* **investigation:** remove secondaryObservations - too FP-prone ([#1310](https://github.com/Autonoma-AI/agent/issues/1310)) ([1755c11](https://github.com/Autonoma-AI/agent/commit/1755c111a59716a8b239f10454021647f7ee1299))

## [1.8.18](https://github.com/Autonoma-AI/agent/compare/v1.8.17...v1.8.18) (2026-07-05)


### Features

* **api:** export previewkit in-flight build count for Prometheus ([#1297](https://github.com/Autonoma-AI/agent/issues/1297)) ([de87508](https://github.com/Autonoma-AI/agent/commit/de8750865a8647663e7588d2549a6b20dc3f110e))
* **deployment:** KEDA autoscaling for the warm buildkit pool ([#1302](https://github.com/Autonoma-AI/agent/issues/1302)) ([98ca056](https://github.com/Autonoma-AI/agent/commit/98ca0564062ce1e26f4073eafc88d7c4e54fd102))
* **investigation:** never-loads guard + per-defect secondary observations ([#1303](https://github.com/Autonoma-AI/agent/issues/1303)) ([1aafbb4](https://github.com/Autonoma-AI/agent/commit/1aafbb43bd28bbb2976fa0ac5b5621158682fa01))
* **previewkit:** hand previews to the central cluster-mode Gatekeeper ([#1301](https://github.com/Autonoma-AI/agent/issues/1301)) ([fa3c0a4](https://github.com/Autonoma-AI/agent/commit/fa3c0a4334e2e6fc3856d395599a71343c6ee6b6))
* **previewkit:** OpenCost + Prometheus cost monitoring on the preview cluster ([#1299](https://github.com/Autonoma-AI/agent/issues/1299)) ([cf871aa](https://github.com/Autonoma-AI/agent/commit/cf871aa76af3fdc09bac548f861a18ccecc639bd))

## [1.8.17](https://github.com/Autonoma-AI/agent/compare/v1.8.16...v1.8.17) (2026-07-04)


### Features

* **investigation:** reconcile same-issue findings into one merged finding ([#1290](https://github.com/Autonoma-AI/agent/issues/1290)) ([f0154d7](https://github.com/Autonoma-AI/agent/commit/f0154d7ef3dafbc2f98354615f47d6c327123ce4))
* **previewkit:** enable E2E previews in alpha + per-env runner DATABASE_URL ([#1277](https://github.com/Autonoma-AI/agent/issues/1277)) ([e6f65d8](https://github.com/Autonoma-AI/agent/commit/e6f65d8837c10c3deb0c6e037b344c780d8fa2d1))


### Performance Improvements

* **ui:** chunk the build for caching + revalidate the HTML shell ([#1291](https://github.com/Autonoma-AI/agent/issues/1291)) ([fe33983](https://github.com/Autonoma-AI/agent/commit/fe33983d1db03d137a229e603a664f726fe23ac1))

## [1.8.16](https://github.com/Autonoma-AI/agent/compare/v1.8.15...v1.8.16) (2026-07-04)


### Features

* **investigation:** color-code PR-list entry point by severity + loading skeletons ([#1287](https://github.com/Autonoma-AI/agent/issues/1287)) ([5450228](https://github.com/Autonoma-AI/agent/commit/5450228977f32815a619eafd2d0cba6f9a3b7e9c))
* **investigation:** surface the agent's removal recommendations in-app ([#1286](https://github.com/Autonoma-AI/agent/issues/1286)) ([6ba4ccf](https://github.com/Autonoma-AI/agent/commit/6ba4ccf40731a968a25f646187f523784fff25eb))
* **investigation:** surface the scenario-repair diagnosis as finding evidence ([#1284](https://github.com/Autonoma-AI/agent/issues/1284)) ([69e8e22](https://github.com/Autonoma-AI/agent/commit/69e8e2278637bc7fcdcbe248da0b11fb5993d0e5))


### Reverts

* **investigation:** remove the deprecated quarantine/removal surface ([#1286](https://github.com/Autonoma-AI/agent/issues/1286)) ([#1288](https://github.com/Autonoma-AI/agent/issues/1288)) ([4f55352](https://github.com/Autonoma-AI/agent/commit/4f55352553f85a9623b7f1bc7ddd55bbea97c33e))

## [1.8.15](https://github.com/Autonoma-AI/agent/compare/v1.8.14...v1.8.15) (2026-07-04)


### Features

* add client-side name filter to generations and runs lists ([#1112](https://github.com/Autonoma-AI/agent/issues/1112)) ([a5f14fa](https://github.com/Autonoma-AI/agent/commit/a5f14fa374efaf1db44d7ff2f886f0b2f4b2b6d0))
* **investigation:** agent picks the most descriptive report frame ([#1268](https://github.com/Autonoma-AI/agent/issues/1268)) ([267e662](https://github.com/Autonoma-AI/agent/commit/267e662dfb43d48c2ac21bcc4fca7fee58c8e83a))
* **investigation:** cumulative regression running across snapshots ([#1265](https://github.com/Autonoma-AI/agent/issues/1265)) ([0aaf28b](https://github.com/Autonoma-AI/agent/commit/0aaf28b72cc53350b99c48c18cbfde68bdb8f067))
* **investigation:** gate test deletion behind the org autofix flag ([#1280](https://github.com/Autonoma-AI/agent/issues/1280)) ([62764a6](https://github.com/Autonoma-AI/agent/commit/62764a67f817b3cbd6e43dcdba861aa14e977b38))
* **investigation:** persist reports to a queryable native island (replaces S3-JSON) ([#1267](https://github.com/Autonoma-AI/agent/issues/1267)) ([df4800f](https://github.com/Autonoma-AI/agent/commit/df4800ff9b64d0b230477bae96b54ef5338dba31))
* **investigation:** PR-row entry point onto the shadow report (Home + PR list) ([#1278](https://github.com/Autonoma-AI/agent/issues/1278)) ([6ecd855](https://github.com/Autonoma-AI/agent/commit/6ecd855ea760d1b9e8af5416c7882ad485d37226))
* **investigation:** render the agent's proposed new tests on the report UI ([#1276](https://github.com/Autonoma-AI/agent/issues/1276)) ([89b128d](https://github.com/Autonoma-AI/agent/commit/89b128d74aef1a95b1c42db76ac69656ba61dac1))
* **investigation:** shadow TestCase marker - unblocks proposed-new-test validation ([#1264](https://github.com/Autonoma-AI/agent/issues/1264)) ([20b1dcc](https://github.com/Autonoma-AI/agent/commit/20b1dcc894604269116459effe59f2b8b2b778ea))
* **investigation:** show the deployed-agent comparison at the bottom of the report ([#1283](https://github.com/Autonoma-AI/agent/issues/1283)) ([c04d4a1](https://github.com/Autonoma-AI/agent/commit/c04d4a1f525302c1db807857d6933ee06ed1f048))
* **investigation:** tool-using recipe-repair agent (replaces one-shot editor) ([#1261](https://github.com/Autonoma-AI/agent/issues/1261)) ([0f699b1](https://github.com/Autonoma-AI/agent/commit/0f699b10509ca103a30db47a017b0d740ba319cc))
* **investigation:** write live workflow progress (running/stage/failed) to the PR entry point ([#1279](https://github.com/Autonoma-AI/agent/issues/1279)) ([16bc885](https://github.com/Autonoma-AI/agent/commit/16bc885dbca9c5c3a0e99e46170d42b8b9cb00a9))
* record investigation orchestration AI costs ([#1260](https://github.com/Autonoma-AI/agent/issues/1260)) ([84096c0](https://github.com/Autonoma-AI/agent/commit/84096c00e873c8e36ef8a4b295b6ec78e810ac27))
* scope bug detection and storage to branch ([#1244](https://github.com/Autonoma-AI/agent/issues/1244)) ([57a886b](https://github.com/Autonoma-AI/agent/commit/57a886b6ad919f7f918a8c8bc3de58b42cd557d4))
* scope bug reads and UI to branch ([#1259](https://github.com/Autonoma-AI/agent/issues/1259)) ([18121ae](https://github.com/Autonoma-AI/agent/commit/18121aeaa99be26ff4b92615886f4256f0fbcf98))
* **signup-hooks:** disable welcome email send on signup and login ([#1118](https://github.com/Autonoma-AI/agent/issues/1118)) ([04c28d6](https://github.com/Autonoma-AI/agent/commit/04c28d6850b3587ce37306cd98855da25100bd49))


### Bug Fixes

* **checkpoint:** raise integration-test timeouts so prod deploys stop failing ([#1248](https://github.com/Autonoma-AI/agent/issues/1248)) ([f62ef54](https://github.com/Autonoma-AI/agent/commit/f62ef544165d93800b4dfdd29aeab611ecdd9a0a))
* **cli:** friendly message when the planner proxy is unreachable ([#1256](https://github.com/Autonoma-AI/agent/issues/1256)) ([87c6c3d](https://github.com/Autonoma-AI/agent/commit/87c6c3d8a22d337c4a432bb9168ab7211896a862))
* **investigation:** categorize escaped SDK/infra throws instead of null-verdict classification_error ([#1263](https://github.com/Autonoma-AI/agent/issues/1263)) ([4da498b](https://github.com/Autonoma-AI/agent/commit/4da498b961014b9e51e4c3af99ea2040d7d111ec))
* **investigation:** hide the entry point for reports the page can't render ([#1281](https://github.com/Autonoma-AI/agent/issues/1281)) ([7cb13a6](https://github.com/Autonoma-AI/agent/commit/7cb13a690602bccad2877f22508c164418718463))
* **previewkit:** hide prior attempt error while rebuilding a fresh commit ([#1233](https://github.com/Autonoma-AI/agent/issues/1233)) ([3557c13](https://github.com/Autonoma-AI/agent/commit/3557c130faf6c57cfe4c8f7d7f854a9bfd24a6e2))
* trigger generations when setup finished before go-live ([#1147](https://github.com/Autonoma-AI/agent/issues/1147)) ([1c381fe](https://github.com/Autonoma-AI/agent/commit/1c381fe070ba2bacd0f609e22dfbfa6f406fd37e))

## [1.8.14](https://github.com/Autonoma-AI/agent/compare/v1.8.13...v1.8.14) (2026-07-02)


### Features

* **previewkit:** run gatekeeper on a dedicated NodePool and enable scale-to-zero ([#1249](https://github.com/Autonoma-AI/agent/issues/1249)) ([8b5dafc](https://github.com/Autonoma-AI/agent/commit/8b5dafca9192b8dae8ab0f0811d5f830becadad6))

## [1.8.13](https://github.com/Autonoma-AI/agent/compare/v1.8.12...v1.8.13) (2026-07-02)


### Features

* **previewkit:** support a build target for multi-stage Dockerfiles ([#1205](https://github.com/Autonoma-AI/agent/issues/1205)) ([09a19d8](https://github.com/Autonoma-AI/agent/commit/09a19d8159f0f12d205fb35093299ce55ac283a6))
* **ui:** add org-level /settings/api-keys route ([#1247](https://github.com/Autonoma-AI/agent/issues/1247)) ([ad3ddfe](https://github.com/Autonoma-AI/agent/commit/ad3ddfe14b4c7ef84c64f0e6a05ede59110562fc))


### Bug Fixes

* constrain healing plan authoring for untestable behaviors and assertions ([#1246](https://github.com/Autonoma-AI/agent/issues/1246)) ([6f67a4f](https://github.com/Autonoma-AI/agent/commit/6f67a4f5d3243ae8d45d61ca5b43ccd362df4b8b))

## [1.8.12](https://github.com/Autonoma-AI/agent/compare/v1.8.11...v1.8.12) (2026-07-02)


### Features

* **investigation:** scenario auto-repair - diagnose, dry-run proposals, and org-gated autofix ([#1235](https://github.com/Autonoma-AI/agent/issues/1235)) ([13b823c](https://github.com/Autonoma-AI/agent/commit/13b823c98ef7229f0703b25c4a362d29bec86657))

## [1.8.11](https://github.com/Autonoma-AI/agent/compare/v1.8.10...v1.8.11) (2026-07-01)


### Features

* convert finish setup to paged layout ([#1192](https://github.com/Autonoma-AI/agent/issues/1192)) ([04bf39e](https://github.com/Autonoma-AI/agent/commit/04bf39e56982f31aa941ee6c8e1f55b409e049e2))
* health and reporting reflect running tests instead of quarantine ([#1219](https://github.com/Autonoma-AI/agent/issues/1219)) ([ce8e126](https://github.com/Autonoma-AI/agent/commit/ce8e126023854696168cfaff14b4ca44f9bea5b8))
* improve preview deploy loader ([#1193](https://github.com/Autonoma-AI/agent/issues/1193)) ([48f0b7c](https://github.com/Autonoma-AI/agent/commit/48f0b7c5b22bcf3e154f363645199efaba922bce))
* **investigation:** persist test edits and reconcile them into main on merge ([#1210](https://github.com/Autonoma-AI/agent/issues/1210)) ([0acbf16](https://github.com/Autonoma-AI/agent/commit/0acbf160ba75474e56fc8e7968cb7cdab46081d0))
* **investigation:** post results as a GitHub PR comment ([#1182](https://github.com/Autonoma-AI/agent/issues/1182)) ([3f6950b](https://github.com/Autonoma-AI/agent/commit/3f6950b445fed5b2a881017ef9c68519b804cbfc))
* remove the newly-quarantined UI surface ([#1223](https://github.com/Autonoma-AI/agent/issues/1223)) ([c03bfab](https://github.com/Autonoma-AI/agent/commit/c03bfab9bce58570d16e33915de6232b04d6d431))
* scenario_unsupported verdict ([#1061](https://github.com/Autonoma-AI/agent/issues/1061)) ([#1129](https://github.com/Autonoma-AI/agent/issues/1129)) ([5648c05](https://github.com/Autonoma-AI/agent/commit/5648c0598d207798f751d0a21c7878d9069c5fa1))
* stop quarantining reported tests so they re-run every snapshot ([#1216](https://github.com/Autonoma-AI/agent/issues/1216)) ([1130877](https://github.com/Autonoma-AI/agent/commit/1130877a989d517e4c9bc415f92fb6a4af8cd4a5))
* **ui:** GitHub-style settings tab bar + rename Previewkit tab to Preview Environments ([#1239](https://github.com/Autonoma-AI/agent/issues/1239)) ([565fe6b](https://github.com/Autonoma-AI/agent/commit/565fe6bd44a645302dabe8a5d924e0129213bab4))


### Bug Fixes

* **api:** alert on rejected GitHub install callbacks ([#1224](https://github.com/Autonoma-AI/agent/issues/1224)) ([396b276](https://github.com/Autonoma-AI/agent/commit/396b2765515221bf85c2dc0ae16c06af37ee300a))
* increase nginx ingress buffer size ([#1221](https://github.com/Autonoma-AI/agent/issues/1221)) ([b9ad6e6](https://github.com/Autonoma-AI/agent/commit/b9ad6e6c4f01b97dad424faae69a405fca3d0f1e))
* **investigation:** mark shadow generations so they stop polluting client UIs ([#1229](https://github.com/Autonoma-AI/agent/issues/1229)) ([abe451f](https://github.com/Autonoma-AI/agent/commit/abe451f873fb5538f1d95a50de4d2e6099b37ed4))
* **investigation:** skip run+classify when scenario up fails ([#1227](https://github.com/Autonoma-AI/agent/issues/1227)) ([94d6b86](https://github.com/Autonoma-AI/agent/commit/94d6b863016290bfe715c1b203b92d43b72d6966))
* move preview generation CTA outside cards ([#1191](https://github.com/Autonoma-AI/agent/issues/1191)) ([dcf059f](https://github.com/Autonoma-AI/agent/commit/dcf059f03534094d860bb175f791e288ff5a3eb5))
* **previewkit:** delete existing Deployment before recreate in applyDeployment ([#1220](https://github.com/Autonoma-AI/agent/issues/1220)) ([29c0ae6](https://github.com/Autonoma-AI/agent/commit/29c0ae6f51680571da218ed433f6a527f8b5d37e))
* **previewkit:** refactor hook jobs logs ([#1218](https://github.com/Autonoma-AI/agent/issues/1218)) ([6892013](https://github.com/Autonoma-AI/agent/commit/68920130bf214a1fb630905e3d9f0f653ebc74b7))
* **previewkit:** remove obsolete env vars from configmap  ([#1217](https://github.com/Autonoma-AI/agent/issues/1217)) ([4cb02d0](https://github.com/Autonoma-AI/agent/commit/4cb02d0d24f52308276c9829261c52c67040bb96))

## [1.8.10](https://github.com/Autonoma-AI/agent/compare/v1.8.9...v1.8.10) (2026-07-01)


### Bug Fixes

* **api:** resolve legacy investigation reports keyed to the PR snapshot ([#1212](https://github.com/Autonoma-AI/agent/issues/1212)) ([1f4d1c9](https://github.com/Autonoma-AI/agent/commit/1f4d1c96ffc1a1a5e368b0f60c1a860f6ad5f7ad))
* **cli:** fail fast on unsupported Node instead of a cryptic styleText crash ([#1211](https://github.com/Autonoma-AI/agent/issues/1211)) ([53dd52e](https://github.com/Autonoma-AI/agent/commit/53dd52e5b666dc63ebd6211b6ca72bccfa32303b))

## [1.8.9](https://github.com/Autonoma-AI/agent/compare/v1.8.8...v1.8.9) (2026-06-30)


### Features

* **cli:** integrate @autonoma-ai/planner into the monorepo ([#1176](https://github.com/Autonoma-AI/agent/issues/1176)) ([38bb20f](https://github.com/Autonoma-AI/agent/commit/38bb20f54f1487780893e20c3cd921932c4d214b))
* **investigation:** scope test selection to the snapshot's assigned tests ([#1180](https://github.com/Autonoma-AI/agent/issues/1180)) ([6dcef18](https://github.com/Autonoma-AI/agent/commit/6dcef1881b23f9c4a6d388083a8b8020e31922de))
* managed LLM proxy so the planner CLI runs on Autonoma credits ([#1194](https://github.com/Autonoma-AI/agent/issues/1194)) ([9e07e7a](https://github.com/Autonoma-AI/agent/commit/9e07e7ac8bccd157317ab5ea729edd7083be3717))
* opt-in TLS for the postgres recipe (options.ssl) ([#1175](https://github.com/Autonoma-AI/agent/issues/1175)) ([22a6100](https://github.com/Autonoma-AI/agent/commit/22a610091d5dd40e1de08926ef7ce0317f2a0396))
* persist dedicated description as test intent on AI-authored paths ([#1163](https://github.com/Autonoma-AI/agent/issues/1163)) ([cd03361](https://github.com/Autonoma-AI/agent/commit/cd033614df1499902d0e5a6ea63f088de9213c78))
* **previewkit:** build-speed Grafana dashboard + filterable finish marker ([#1178](https://github.com/Autonoma-AI/agent/issues/1178)) ([f1cf042](https://github.com/Autonoma-AI/agent/commit/f1cf042332eba5e3e70176b2be6aeea7900a75d3))
* remove user-facing updateDescription path for test cases ([#1161](https://github.com/Autonoma-AI/agent/issues/1161)) ([a8c1a2b](https://github.com/Autonoma-AI/agent/commit/a8c1a2b5d3dffca376798babe60f18cf47f662d1))
* require a creation-only description in the add-test dialog ([#1162](https://github.com/Autonoma-AI/agent/issues/1162)) ([320f0b2](https://github.com/Autonoma-AI/agent/commit/320f0b2a6f937e84bedafc8a07aa9b120b7be591))
* require TestCase description at the type and Zod boundary ([#1188](https://github.com/Autonoma-AI/agent/issues/1188)) ([e8939fc](https://github.com/Autonoma-AI/agent/commit/e8939fccba0718c74f91a90c7f406d7b67a1597f))
* separate snapshot for the investigation workflow ([#1204](https://github.com/Autonoma-AI/agent/issues/1204)) ([28afa83](https://github.com/Autonoma-AI/agent/commit/28afa832915406e344f3640ad35d3169cec98ec1))
* thread uploaded test description through artifact ingestion ([#1164](https://github.com/Autonoma-AI/agent/issues/1164)) ([bcd2777](https://github.com/Autonoma-AI/agent/commit/bcd27772aba131da9e6ec56418eb5cb052dd52ab))
* **ui:** move CLI artifacts step before SDK validation in finish setup ([#1183](https://github.com/Autonoma-AI/agent/issues/1183)) ([d973192](https://github.com/Autonoma-AI/agent/commit/d973192e5d3ff13e27ce58e7300fb6e49bd2b210))


### Bug Fixes

* **cli:** decouple CLI release-please from the root flow ([#1184](https://github.com/Autonoma-AI/agent/issues/1184)) ([c626482](https://github.com/Autonoma-AI/agent/commit/c62648233a5fccac7cbc9f184b3c2668daa8dc9e))
* **cli:** use CLI_NPM_TOKEN secret for npm publish ([#1189](https://github.com/Autonoma-AI/agent/issues/1189)) ([fc4f706](https://github.com/Autonoma-AI/agent/commit/fc4f706117e141fee3ddc0c61495dd91df679f82))
* gate previewkit rollout on ESO secret sync to stop managed discover 401s ([#1153](https://github.com/Autonoma-AI/agent/issues/1153)) ([ffccfb2](https://github.com/Autonoma-AI/agent/commit/ffccfb240df8ba69592b3760ce16a3611ae21b91))
* **previewkit:** make hooks optional ([#1190](https://github.com/Autonoma-AI/agent/issues/1190)) ([4b42efd](https://github.com/Autonoma-AI/agent/commit/4b42efd157d405e2f6ce57b9b71e9393f93b9416))
* tolerate missing assignment when quarantining or removing a test ([#1181](https://github.com/Autonoma-AI/agent/issues/1181)) ([cfc593b](https://github.com/Autonoma-AI/agent/commit/cfc593b1f1f7009663b2127160869fde99b7ff47))

## [1.8.8](https://github.com/Autonoma-AI/agent/compare/v1.8.7...v1.8.8) (2026-06-30)


### Bug Fixes

* **investigation:** make remediation higher-level and readable ([#1173](https://github.com/Autonoma-AI/agent/issues/1173)) ([fce8036](https://github.com/Autonoma-AI/agent/commit/fce8036a991e9705574734fa102ea7745bf2b7e0))


### Performance Improvements

* **previewkit:** warm-buildkit spike behind BUILDKIT_WARM_HOST ([#1139](https://github.com/Autonoma-AI/agent/issues/1139)) ([dfa199d](https://github.com/Autonoma-AI/agent/commit/dfa199d3dbdc082dcd75d87b5efa5d79f7ff86d8))

## [1.8.7](https://github.com/Autonoma-AI/agent/compare/v1.8.6...v1.8.7) (2026-06-29)


### Features

* **ai:** non-Google video uploaders for reviewers + minimax-m3 (+ OpenRouter provider bump) ([#1142](https://github.com/Autonoma-AI/agent/issues/1142)) ([ace77d7](https://github.com/Autonoma-AI/agent/commit/ace77d7bbf354d393d3d3e7ac6b6912397149ae2))
* **investigation:** embed the run trace in reports so findings are self-auditable ([#1170](https://github.com/Autonoma-AI/agent/issues/1170)) ([0716ce1](https://github.com/Autonoma-AI/agent/commit/0716ce1e941fb62ff86d9f7eec0c4006237cc29d))
* **investigation:** in-app investigation report UI ([#1134](https://github.com/Autonoma-AI/agent/issues/1134)) ([15d7df4](https://github.com/Autonoma-AI/agent/commit/15d7df4e97eefe9c2579fe1c19e87eb4a381e083))


### Bug Fixes

* bump number of worker-diffs replicas ([#1169](https://github.com/Autonoma-AI/agent/issues/1169)) ([ee7b797](https://github.com/Autonoma-AI/agent/commit/ee7b797c6cf59c3050bff0e22f273f3b863d22ba))
* **engine-web:** handle native browser dialogs (alert/confirm/prompt) ([#1171](https://github.com/Autonoma-AI/agent/issues/1171)) ([485655f](https://github.com/Autonoma-AI/agent/commit/485655f91bbc0fd7c2978d83f4ff52f3e804d6ae))
* **engine-web:** make run recording videos seekable in the browser ([#1136](https://github.com/Autonoma-AI/agent/issues/1136)) ([db47464](https://github.com/Autonoma-AI/agent/commit/db4746494067a72115ade9940ac85a880d3134c9))
* **investigation:** render code-evidence snippet text (was blank) ([#1167](https://github.com/Autonoma-AI/agent/issues/1167)) ([70eabf1](https://github.com/Autonoma-AI/agent/commit/70eabf10e5e0f92741f7d036e5a5ad6a13dc9186))
* **investigation:** stop the classifier fabricating bugs from automation artifacts ([#1172](https://github.com/Autonoma-AI/agent/issues/1172)) ([05f8895](https://github.com/Autonoma-AI/agent/commit/05f8895b59b2561c128d1a2b8c0034e01e258bd1))
* stop sentry alerts for 4xx API errors ([#1150](https://github.com/Autonoma-AI/agent/issues/1150)) ([d6173d9](https://github.com/Autonoma-AI/agent/commit/d6173d9a824d51c6e118588a62cf908fd7de1982))

## [1.8.6](https://github.com/Autonoma-AI/agent/compare/v1.8.5...v1.8.6) (2026-06-29)


### Features

* **previewkit:** Kubernetes Jobs execution path behind a flag (Phase 1) ([#1122](https://github.com/Autonoma-AI/agent/issues/1122)) ([187e618](https://github.com/Autonoma-AI/agent/commit/187e618273dd17e5a48535bb3d36803a211718ca))
* **previewkit:** per-env runner-image ConfigMap, Jobs in the previewkit namespace ([#1146](https://github.com/Autonoma-AI/agent/issues/1146)) ([6a18234](https://github.com/Autonoma-AI/agent/commit/6a182346a9b6a938e78f293f60f6770330bfe1a9))
* **previewkit:** route per-app redeploy through the Jobs path (Phase 3a) ([#1137](https://github.com/Autonoma-AI/agent/issues/1137)) ([408f83a](https://github.com/Autonoma-AI/agent/commit/408f83ac9ec98186c42f575af93cb6df623dcf54))
* re-sequence onboarding ([#1018](https://github.com/Autonoma-AI/agent/issues/1018)) ([833e609](https://github.com/Autonoma-AI/agent/commit/833e609df9dfe020cb7ce4a2261e0a5e02403054))


### Bug Fixes

* **ui:** keep PR health pill within its column to stop table scroll ([#1145](https://github.com/Autonoma-AI/agent/issues/1145)) ([314b79b](https://github.com/Autonoma-AI/agent/commit/314b79b6a966975fbd9891d046070cdca169988f))

## [1.8.5](https://github.com/Autonoma-AI/agent/compare/v1.8.4...v1.8.5) (2026-06-26)


### Features

* allow partial healing expected actions ([#1121](https://github.com/Autonoma-AI/agent/issues/1121)) ([e8a43a0](https://github.com/Autonoma-AI/agent/commit/e8a43a04a22b014e8634b1e10c1a343947408792))
* **previewkit:** scope build-log viewer to the latest attempt ([#1115](https://github.com/Autonoma-AI/agent/issues/1115)) ([8fb7f8b](https://github.com/Autonoma-AI/agent/commit/8fb7f8bd4c90ea65ac41aaf0baf6d3594413b0fb))
* snapshot pins the deployed dependency manifest ([#1063](https://github.com/Autonoma-AI/agent/issues/1063)) ([#1128](https://github.com/Autonoma-AI/agent/issues/1128)) ([52e2043](https://github.com/Autonoma-AI/agent/commit/52e204359de8ebbd4b989d332bf5f52cfb5deea3))


### Bug Fixes

* **investigation:** bound tool output to stop oversized-prompt failures ([#1131](https://github.com/Autonoma-AI/agent/issues/1131)) ([986b7df](https://github.com/Autonoma-AI/agent/commit/986b7df36f0aff0e1b5d39d2e07c6b7332279fad))

## [1.8.4](https://github.com/Autonoma-AI/agent/compare/v1.8.3...v1.8.4) (2026-06-26)


### Features

* forced grounding and unknown_issue lane ([#1077](https://github.com/Autonoma-AI/agent/issues/1077)) ([cdadbc0](https://github.com/Autonoma-AI/agent/commit/cdadbc02243d4f299b06fc22837a9b56127fd18b))
* **investigator:** diff-driven PR test-runner agent (prototype) ([#1007](https://github.com/Autonoma-AI/agent/issues/1007)) ([b1768ab](https://github.com/Autonoma-AI/agent/commit/b1768ab2cfc810f27ea67bbd9dfb48b23c8cfcac))
* **previewkit:** add per-app redeploy endpoint ([#1089](https://github.com/Autonoma-AI/agent/issues/1089)) ([b0822b4](https://github.com/Autonoma-AI/agent/commit/b0822b4e64ac8bb0a87235cfab3030942641ebd3))


### Bug Fixes

* **ci:** redeploy worker-investigation on deploy-manifest changes ([#1120](https://github.com/Autonoma-AI/agent/issues/1120)) ([4d1c738](https://github.com/Autonoma-AI/agent/commit/4d1c73889c6830341accd5c39120fb40985362a9))
* **deploy:** worker-investigation crashes on first deploy (DATABASE_URL undefined) ([#1119](https://github.com/Autonoma-AI/agent/issues/1119)) ([3875510](https://github.com/Autonoma-AI/agent/commit/38755106aaf8012e1dfe94e8ca658ca232b3b05d))

## [1.8.3](https://github.com/Autonoma-AI/agent/compare/v1.8.2...v1.8.3) (2026-06-26)


### Features

* **db:** add organization_settings table ([#1105](https://github.com/Autonoma-AI/agent/issues/1105)) ([b9bab5a](https://github.com/Autonoma-AI/agent/commit/b9bab5a27d4a0aa95e472dfba6105eff12cbbd58))
* **previewkit:** inject built-in env vars into preview pods ([#1092](https://github.com/Autonoma-AI/agent/issues/1092)) ([afb3383](https://github.com/Autonoma-AI/agent/commit/afb3383294b0937535a8cdcf0a61cfb01b5bf8ef))
* **previewkit:** run all deploy hooks as Kubernetes Jobs ([#1088](https://github.com/Autonoma-AI/agent/issues/1088)) ([bd7ebd7](https://github.com/Autonoma-AI/agent/commit/bd7ebd70310bdd1d62ce122d96f2c569bd4eed6c))
* **previewkit:** skip preview deploys for draft PRs unless org opts in ([#1109](https://github.com/Autonoma-AI/agent/issues/1109)) ([7939b3e](https://github.com/Autonoma-AI/agent/commit/7939b3e1c2da30f2146229ded93d636862837ab3))
* **ui,api:** fix PR/checkpoint/generation/bug UI contradictions ([#972](https://github.com/Autonoma-AI/agent/issues/972)) ([d51899f](https://github.com/Autonoma-AI/agent/commit/d51899f3c2f396d226d18a827480207c7db15e24))


### Bug Fixes

* guard snapshot report summary to prevent crash on deploy skew ([#1114](https://github.com/Autonoma-AI/agent/issues/1114)) ([7beaf92](https://github.com/Autonoma-AI/agent/commit/7beaf9294a07b896484d80f170b5337a95d2f102))
* heartbeat applyHealingActions to avoid timeout failures ([#1107](https://github.com/Autonoma-AI/agent/issues/1107)) ([eadbbb5](https://github.com/Autonoma-AI/agent/commit/eadbbb503fa8e14ad1dab54f8feb7ceb9092a69e))
* persist PR comment id and repost PR comments at the bottom ([#871](https://github.com/Autonoma-AI/agent/issues/871)) ([9c290c8](https://github.com/Autonoma-AI/agent/commit/9c290c891056bc59a2433577ddc0d2ffe14b7d9e))
* **pr-comment:** link PR comments to autonoma.app instead of agent.autonoma.app ([#1104](https://github.com/Autonoma-AI/agent/issues/1104)) ([02a628e](https://github.com/Autonoma-AI/agent/commit/02a628e0f4ce6293b20b6c080505f44abe032769))
* **previewkit:** don't fail previews when the worker is scaled down mid-build ([#1090](https://github.com/Autonoma-AI/agent/issues/1090)) ([580fec3](https://github.com/Autonoma-AI/agent/commit/580fec3dc8f8413d87787b431a204e73ab68841c))
* **scenario:** eliminate shared-file race in concurrent scenario provisioning ([#1102](https://github.com/Autonoma-AI/agent/issues/1102)) ([49d1487](https://github.com/Autonoma-AI/agent/commit/49d1487f5e5bc44a43337c34c33b78f5d3b3225b))
* **workflow:** bump temporal test server to v1.30.1 for macOS arm64 ([#1094](https://github.com/Autonoma-AI/agent/issues/1094)) ([d257156](https://github.com/Autonoma-AI/agent/commit/d257156f3c18f884c1b213b6223a9a8bda6cd08d))
* **workflow:** don't pass shutdownGraceTime: undefined to Temporal worker ([#1106](https://github.com/Autonoma-AI/agent/issues/1106)) ([30005c4](https://github.com/Autonoma-AI/agent/commit/30005c40695fefc440cabe26680342eb77018194))

## [1.8.2](https://github.com/Autonoma-AI/agent/compare/v1.8.1...v1.8.2) (2026-06-24)


### Features

* **alpha:** rename preview URLs to *.alpha.autonoma.app, off CloudFront ([#1080](https://github.com/Autonoma-AI/agent/issues/1080)) ([104e101](https://github.com/Autonoma-AI/agent/commit/104e101a30e2f16b40841356ffc9622907ac2259))
* cascade step_output on step_input delete ([#1081](https://github.com/Autonoma-AI/agent/issues/1081)) ([7540cec](https://github.com/Autonoma-AI/agent/commit/7540cecf146d6a8ecf4ce8facdf0f47a356b90ce))
* **ingress:** keep legacy domains serving (no redirect) for backwards compat ([#1084](https://github.com/Autonoma-AI/agent/issues/1084)) ([5bad46d](https://github.com/Autonoma-AI/agent/commit/5bad46da3c2d5332a30431a800d00c7e5a87d532))
* make autonoma.app the canonical UI host, redirect agent.autonoma.app ([#1078](https://github.com/Autonoma-AI/agent/issues/1078)) ([cee0864](https://github.com/Autonoma-AI/agent/commit/cee0864b6f8def3d2a1c03c5adfaccec3602e446))
* **previewkit:** surface pre/post-deploy hook output in the build-log viewer ([#1086](https://github.com/Autonoma-AI/agent/issues/1086)) ([3250325](https://github.com/Autonoma-AI/agent/commit/3250325618673b898b66aac1ef4ccbc96b0be221))
* **previewkit:** timestamp preview logs and scope them to one app ([#1075](https://github.com/Autonoma-AI/agent/issues/1075)) ([576d416](https://github.com/Autonoma-AI/agent/commit/576d416e87360416a4b8dff6c2f5180c62939dee))


### Bug Fixes

* **ui:** alpha shared-beta auth points at api.beta.&lt;domain&gt; (not dead beta.api) ([#1082](https://github.com/Autonoma-AI/agent/issues/1082)) ([8d32c9d](https://github.com/Autonoma-AI/agent/commit/8d32c9d6a108c38be6cc1e3ec6cf5ad061e6713a))
* use i18n for text assertions ([#1083](https://github.com/Autonoma-AI/agent/issues/1083)) ([5af88e8](https://github.com/Autonoma-AI/agent/commit/5af88e858446e5e8ba5979e57f73565470aeed6c))

## [1.8.1](https://github.com/Autonoma-AI/agent/compare/v1.8.0...v1.8.1) (2026-06-23)


### Features

* add generation batch metrics table ([#1013](https://github.com/Autonoma-AI/agent/issues/1013)) ([a18dc87](https://github.com/Autonoma-AI/agent/commit/a18dc875656c78b45244f7104bf1bbf421c7291a))
* add inject headers capability to api gateway recipe ([#1031](https://github.com/Autonoma-AI/agent/issues/1031)) ([6fe438d](https://github.com/Autonoma-AI/agent/commit/6fe438d426bd09212c8c43b4bfbf4ac289e644b3))
* add replay metrics ([#1041](https://github.com/Autonoma-AI/agent/issues/1041)) ([30da960](https://github.com/Autonoma-AI/agent/commit/30da96056ee2ba62f896628a82c076b950827fd0))
* **benchmark:** add generation and replay reviewers ([#1046](https://github.com/Autonoma-AI/agent/issues/1046)) ([65f6b40](https://github.com/Autonoma-AI/agent/commit/65f6b40c1b931a2dc40f276703873db6b051493f))
* **benchmark:** add replay benchmark script and BenchmarkRun evals table ([#1012](https://github.com/Autonoma-AI/agent/issues/1012)) ([594a5e6](https://github.com/Autonoma-AI/agent/commit/594a5e61cb2f8b4a80a4cccb0b7ed0faa46f1856))
* cut over the diff flow to candidate-free authoring ([#1036](https://github.com/Autonoma-AI/agent/issues/1036)) ([e392a20](https://github.com/Autonoma-AI/agent/commit/e392a203c10bef5f9eaeb6942d9f5c607439efa3))
* **evals:** always save video and results folder, even on agent timeout ([#1034](https://github.com/Autonoma-AI/agent/issues/1034)) ([f1c7da3](https://github.com/Autonoma-AI/agent/commit/f1c7da3140484ef571bc5a002f7d6910f23f5d16))
* evolve diffs + healing eval suites for the candidate-free model ([#1042](https://github.com/Autonoma-AI/agent/issues/1042)) ([a8f00ad](https://github.com/Autonoma-AI/agent/commit/a8f00addfb9d1bdac0f8eda5be6faef3f5d5b2d2))
* filter db migrate command ([#1076](https://github.com/Autonoma-AI/agent/issues/1076)) ([73bde4a](https://github.com/Autonoma-AI/agent/commit/73bde4a0c26834d794ab02c45c813855a3902986))
* harden remove_test with a required review link ([#1032](https://github.com/Autonoma-AI/agent/issues/1032)) ([ed6e12a](https://github.com/Autonoma-AI/agent/commit/ed6e12aa01c424b7e13bb01b03eb0a7dabf00b87))
* **previewkit:** add depends_on annotation for gatekeeper  ([#1021](https://github.com/Autonoma-AI/agent/issues/1021)) ([b92cef2](https://github.com/Autonoma-AI/agent/commit/b92cef2ce0ca64cfc48b71b37b0a160efe5d933a))
* **previewkit:** add runtime build option ([#1022](https://github.com/Autonoma-AI/agent/issues/1022)) ([b8770dd](https://github.com/Autonoma-AI/agent/commit/b8770dd08831032cef3f0a81255979ac996285b4))
* **previewkit:** carry the deploy branch through pipeline logs ([#1049](https://github.com/Autonoma-AI/agent/issues/1049)) ([b677cdd](https://github.com/Autonoma-AI/agent/commit/b677cddafb2eac16554925286e8330ec87cd918e))
* **previewkit:** default to app logs and persist log view in the URL ([#1074](https://github.com/Autonoma-AI/agent/issues/1074)) ([2ea3e47](https://github.com/Autonoma-AI/agent/commit/2ea3e4744f254b7f568e16df9809b907be857c1d))
* **previewkit:** fail fast on terminal pod states during deploy ([#1047](https://github.com/Autonoma-AI/agent/issues/1047)) ([da150b0](https://github.com/Autonoma-AI/agent/commit/da150b0c69575d43bb0b38a7ef1484305912135b))
* **previewkit:** log before/after every deploy + teardown step ([#1065](https://github.com/Autonoma-AI/agent/issues/1065)) ([899e2e7](https://github.com/Autonoma-AI/agent/commit/899e2e7b5bf19ad7b4160348c4321b00038e084f))
* **previewkit:** preload most common psql extensions in PostgreSQL base image ([#1040](https://github.com/Autonoma-AI/agent/issues/1040)) ([7df7726](https://github.com/Autonoma-AI/agent/commit/7df772632336892ee5fa887a891abe001d2d1f0c))
* record deployed dependency SHAs in previewkit resolvedConfig ([#1071](https://github.com/Autonoma-AI/agent/issues/1071)) ([80fbe56](https://github.com/Autonoma-AI/agent/commit/80fbe56610940a01cb0c2e5e9b0f1ffecac4352a))
* surface candidate-free diff results in the API and UI ([#1044](https://github.com/Autonoma-AI/agent/issues/1044)) ([68be3fc](https://github.com/Autonoma-AI/agent/commit/68be3fcad7a66a65a69cfb8991e2667f8b5b4720))
* triage-only final refinement round ([#1006](https://github.com/Autonoma-AI/agent/issues/1006)) ([6430558](https://github.com/Autonoma-AI/agent/commit/6430558812106669927d65b7b186e2eabf3a2fb2))
* **ui:** add previewkit config edit page ([#1001](https://github.com/Autonoma-AI/agent/issues/1001)) ([59064d5](https://github.com/Autonoma-AI/agent/commit/59064d56af62883d32ad868c6aca8e4c7b610a1d))


### Bug Fixes

* **admin:** prevent a suspended GitHub installation from breaking the repo listing ([#1067](https://github.com/Autonoma-AI/agent/issues/1067)) ([040202a](https://github.com/Autonoma-AI/agent/commit/040202a63dbfdd919eb4b25283c9035633e73673))
* **deps:** migrate gray-matter to @11ty/gray-matter for js-yaml 4 compatibility ([#1051](https://github.com/Autonoma-AI/agent/issues/1051)) ([82cd417](https://github.com/Autonoma-AI/agent/commit/82cd4173bfc88f9ee2d9f4cbf7207ca0d73629af))
* force structured tool calls in the agent loop ([#1045](https://github.com/Autonoma-AI/agent/issues/1045)) ([6cdbfd9](https://github.com/Autonoma-AI/agent/commit/6cdbfd96190bb03fdb43a2debc4df29170dbc472))
* **previewkit:** superseded preview deploy races ([#1066](https://github.com/Autonoma-AI/agent/issues/1066)) ([44c124c](https://github.com/Autonoma-AI/agent/commit/44c124c00924d038b36014f368d8e091a2850a95))
* surface setup_failed as a distinct terminal outcome ([#997](https://github.com/Autonoma-AI/agent/issues/997)) ([3f88585](https://github.com/Autonoma-AI/agent/commit/3f885858f9c0b5d0636b4694119cdfde38fec983))

## [1.8.0](https://github.com/Autonoma-AI/agent/compare/v1.7.0...v1.8.0) (2026-06-17)


### Features

* **evals:** add batch runner script and isolated evals database ([#987](https://github.com/Autonoma-AI/agent/issues/987)) ([0ae454a](https://github.com/Autonoma-AI/agent/commit/0ae454ae138c99a2b81674d103c4cf9fec7f6fee))
* fold resolution into iteration 1 of the refinement loop ([#954](https://github.com/Autonoma-AI/agent/issues/954)) ([#986](https://github.com/Autonoma-AI/agent/issues/986)) ([efefc13](https://github.com/Autonoma-AI/agent/commit/efefc139da358ae4ef727ae3ca465d2783b69521))
* PreviewKit onboarding ([#809](https://github.com/Autonoma-AI/agent/issues/809)) ([a3672b4](https://github.com/Autonoma-AI/agent/commit/a3672b440ca87f1b926dd213a8a9ad7e0f59a212))
* **previewkit:** add manual Environment Factory up/down on the admin page ([#968](https://github.com/Autonoma-AI/agent/issues/968)) ([6b436b7](https://github.com/Autonoma-AI/agent/commit/6b436b7d0fb5b321d771a1c7cbc22f105a041c4d))
* **previewkit:** honor custom resources only for DB config revisions ([#1008](https://github.com/Autonoma-AI/agent/issues/1008)) ([15e0561](https://github.com/Autonoma-AI/agent/commit/15e0561d495d388b8e4dbde7b05315cac682a468))
* route scenario_setup failures out of healable refinement buckets ([#1000](https://github.com/Autonoma-AI/agent/issues/1000)) ([16bf5cd](https://github.com/Autonoma-AI/agent/commit/16bf5cd56719ec442210cf4358e4e0c8114a44ee))
* **scenario:** preserve raw body and content type on non-JSON SDK responses ([#1015](https://github.com/Autonoma-AI/agent/issues/1015)) ([bc1f480](https://github.com/Autonoma-AI/agent/commit/bc1f4805ad0af843fac51cd95e9974dfc2d991fe))
* skip review for scenario_setup system failures ([#996](https://github.com/Autonoma-AI/agent/issues/996)) ([da7c86d](https://github.com/Autonoma-AI/agent/commit/da7c86dcf45c77c15f2d3d07c9e1c4e5703d2117))
* source snapshot reasoning from refinement iteration 1 ([#989](https://github.com/Autonoma-AI/agent/issues/989)) ([4b10523](https://github.com/Autonoma-AI/agent/commit/4b105238a895607b2fe59f9a187d86c90a949c9a))
* **ui:** per-app secret page and unified secrets service ([#991](https://github.com/Autonoma-AI/agent/issues/991)) ([dac1ffe](https://github.com/Autonoma-AI/agent/commit/dac1ffe1c07f99d3fe76fc83a9d7e59641b737ac))
* unify resolution eval-capture and eval suite into healing ([#988](https://github.com/Autonoma-AI/agent/issues/988)) ([c807461](https://github.com/Autonoma-AI/agent/commit/c807461b5e28cc54741bf8441cb655d544d026ba))


### Bug Fixes

* **api:** keep preview SDK-URL helper env-free so its unit test passes in CI ([#1016](https://github.com/Autonoma-AI/agent/issues/1016)) ([5bba3e4](https://github.com/Autonoma-AI/agent/commit/5bba3e4c4932b30867be7157d25e140147c198d1))
* **previewkit:** expose raw Redis (RESP) port on the upstash recipe ([#1017](https://github.com/Autonoma-AI/agent/issues/1017)) ([8458fbe](https://github.com/Autonoma-AI/agent/commit/8458fbe62ef601672ebd051f35c0f9a94d43e9e2))
* **previewkit:** surface real failure cause instead of synthetic stack ([#1002](https://github.com/Autonoma-AI/agent/issues/1002)) ([0ef9b8b](https://github.com/Autonoma-AI/agent/commit/0ef9b8b59218ac167663e85b5be16c0da2ba69c5))
* **previewkit:** use proper PGDATA variable for AlloyDB recipe ([#1014](https://github.com/Autonoma-AI/agent/issues/1014)) ([0b04d1e](https://github.com/Autonoma-AI/agent/commit/0b04d1e55ba14e548a970021e561f472f15eb99a))
* stop a malformed healing testCaseId from crashing refinement ([#1011](https://github.com/Autonoma-AI/agent/issues/1011)) ([fe3e437](https://github.com/Autonoma-AI/agent/commit/fe3e4378cb7c4d7e84393a6f1a3fb51a0b2e1ebe))
* **ui:** make app selection list scrollable with max height ([#1003](https://github.com/Autonoma-AI/agent/issues/1003)) ([ce6a5ba](https://github.com/Autonoma-AI/agent/commit/ce6a5ba294ffa3d48a227759681f28226f904006))
* use deployment url to build generation plan ([#999](https://github.com/Autonoma-AI/agent/issues/999)) ([1d2da37](https://github.com/Autonoma-AI/agent/commit/1d2da37bc2f34ff3da32915b0be4f844de5cf706))
* **workflow:** log cancelled activities at warn, not fatal ([#1005](https://github.com/Autonoma-AI/agent/issues/1005)) ([b984930](https://github.com/Autonoma-AI/agent/commit/b9849306efbd73966baff32daa95b7fdca4644ae))

## [1.7.0](https://github.com/Autonoma-AI/agent/compare/v1.6.0...v1.7.0) (2026-06-16)


### Features

* apply add_test in the healing apply activity ([#980](https://github.com/Autonoma-AI/agent/issues/980)) ([5c6bc90](https://github.com/Autonoma-AI/agent/commit/5c6bc90cb0d97ebef9c3c0f321869071f663b866))
* keep diffs subagent step-exhaustion from killing the job ([#983](https://github.com/Autonoma-AI/agent/issues/983)) ([e61ca96](https://github.com/Autonoma-AI/agent/commit/e61ca96a0a71f85dcc6a6c4e05d39111f277332e))
* **ui:** preview environment detail page ([#975](https://github.com/Autonoma-AI/agent/issues/975)) ([e098f45](https://github.com/Autonoma-AI/agent/commit/e098f4518729567a352adb1914f01d0a376c0ef6))
* unwrap Temporal failure cause for diffs job failure_reason ([#982](https://github.com/Autonoma-AI/agent/issues/982)) ([522604f](https://github.com/Autonoma-AI/agent/commit/522604f12dd15c24fc4a8b85cf844c35b43c33f2))

## [1.6.0](https://github.com/Autonoma-AI/agent/compare/v1.5.0...v1.6.0) (2026-06-16)


### Features

* add alloydb to postgres allowed images ([#977](https://github.com/Autonoma-AI/agent/issues/977)) ([b5c6698](https://github.com/Autonoma-AI/agent/commit/b5c6698d79fa779102ea460ca91fd832f0cc78f5))
* merge resolution capabilities into the healing agent ([#974](https://github.com/Autonoma-AI/agent/issues/974)) ([8061fcc](https://github.com/Autonoma-AI/agent/commit/8061fcc1387c92ae6bb54abd7ac28fa315d80cef))
* persist per-iteration healing reasoning ([#971](https://github.com/Autonoma-AI/agent/issues/971)) ([2707bbe](https://github.com/Autonoma-AI/agent/commit/2707bbe87a6d130df5c2ef4e4040944687fdfff8))
* **previewkit:** track per-app lifecycle status on PreviewkitAppInstance ([#961](https://github.com/Autonoma-AI/agent/issues/961)) ([cb77887](https://github.com/Autonoma-AI/agent/commit/cb77887d49a0724cf3ab843a462f817f1cd30a2d))
* relax iteration bucketer to admit replay-only outcomes ([#973](https://github.com/Autonoma-AI/agent/issues/973)) ([a09cd72](https://github.com/Autonoma-AI/agent/commit/a09cd72ae362e24bb59511780d3ae15797c77fc2))
* run generation eval and replay locally ([#970](https://github.com/Autonoma-AI/agent/issues/970)) ([9fbae09](https://github.com/Autonoma-AI/agent/commit/9fbae094c520e3d073d6d7b6a768508d31274c20))
* **skills:** add update-client-prs Notion sync skill ([#966](https://github.com/Autonoma-AI/agent/issues/966)) ([f556cf9](https://github.com/Autonoma-AI/agent/commit/f556cf9d6aedcf1969ddf99ec3de878a99a071cc))
* **ui:** auto-switch org for internal users on cross-org deep links ([#967](https://github.com/Autonoma-AI/agent/issues/967)) ([d20649a](https://github.com/Autonoma-AI/agent/commit/d20649a4eb0f81783152657b0d31757adc18b811))


### Bug Fixes

* **engine:** validate wait conditions against pre-screenshot at generation time ([#958](https://github.com/Autonoma-AI/agent/issues/958)) ([904b27f](https://github.com/Autonoma-AI/agent/commit/904b27f978f4427dd1bebecac3301b08fb28b3ab))
* remove bubblewrap isolation from diffs bash tool ([#964](https://github.com/Autonoma-AI/agent/issues/964)) ([f12181f](https://github.com/Autonoma-AI/agent/commit/f12181fd95cddc71ff7792206e1ebda75553dffb))
* validate wait conditions inline during generation ([#976](https://github.com/Autonoma-AI/agent/issues/976)) ([ad06780](https://github.com/Autonoma-AI/agent/commit/ad0678065be50ea8fd1a2e6a20fb66340716719d))

## [1.5.0](https://github.com/Autonoma-AI/agent/compare/v1.4.0...v1.5.0) (2026-06-15)


### Features

* annotate reviewer before screenshots with resolved click point ([#918](https://github.com/Autonoma-AI/agent/issues/918)) ([43b86df](https://github.com/Autonoma-AI/agent/commit/43b86dff7d0e29c00e8e2696657edb4c4af0f2bf))
* **api:** trigger previewkit workflows directly behind PREVIEWKIT_USE_TEMPORAL ([#891](https://github.com/Autonoma-AI/agent/issues/891)) ([5aa19dc](https://github.com/Autonoma-AI/agent/commit/5aa19dcfb1198aa912ee07fcfd922a8e31038667))
* bubblewrap process-isolation wrapper for the bash tool ([#875](https://github.com/Autonoma-AI/agent/issues/875)) ([37a5673](https://github.com/Autonoma-AI/agent/commit/37a5673415bf4e46db0dc6c12fca1c92a740a941))
* cache GitHub PR metadata to fix Pull Requests N+1 fanout ([#848](https://github.com/Autonoma-AI/agent/issues/848)) ([d862c04](https://github.com/Autonoma-AI/agent/commit/d862c04badc37a625b70b1391b30ab6ea8ab61c6))
* capture and live-persist all command attempts in generation ([#837](https://github.com/Autonoma-AI/agent/issues/837)) ([bedbcf2](https://github.com/Autonoma-AI/agent/commit/bedbcf26f61ba3ef5c00f32cd8959d73c61bfcb6))
* collapse diffs codebase tools into the single bash tool ([#873](https://github.com/Autonoma-AI/agent/issues/873)) ([391c04c](https://github.com/Autonoma-AI/agent/commit/391c04ce1e9742f70ae9bca354645f896d29ceef))
* consolidated bash tool with validator, truncation, and env-scrub ([#869](https://github.com/Autonoma-AI/agent/issues/869)) ([d6925df](https://github.com/Autonoma-AI/agent/commit/d6925df3d86d31da67ac30dbdf0fbaaaaf3213fd))
* db free scenario provisioner ([#878](https://github.com/Autonoma-AI/agent/issues/878)) ([73a6045](https://github.com/Autonoma-AI/agent/commit/73a604530d85a2244e1984579e52dddd0e631990))
* drop skill tables from the database schema ([#907](https://github.com/Autonoma-AI/agent/issues/907)) ([45d57a0](https://github.com/Autonoma-AI/agent/commit/45d57a039f36b276e75763db64d956eb0ad0930c))
* edit web deployment URL from app settings ([#905](https://github.com/Autonoma-AI/agent/issues/905)) ([9dfc1c9](https://github.com/Autonoma-AI/agent/commit/9dfc1c92fc0a671259b7ef3ae7dc6460cc5664b5))
* **evals:** extract @autonoma/evals package from diffs eval framework ([#876](https://github.com/Autonoma-AI/agent/issues/876)) ([3765172](https://github.com/Autonoma-AI/agent/commit/3765172a1db7dc90af01ffc7f60b4d7198e22405))
* expose scenario recipe data to the analysis agent ([#840](https://github.com/Autonoma-AI/agent/issues/840)) ([8f8de88](https://github.com/Autonoma-AI/agent/commit/8f8de88b13ccf71ac304cb0d18781c06e9883283))
* extract buildWebApplicationData shared assembler ([#888](https://github.com/Autonoma-AI/agent/issues/888)) ([e53650e](https://github.com/Autonoma-AI/agent/commit/e53650e6780629233ea68a06b468898da48d5239))
* generation eval pilot ([#903](https://github.com/Autonoma-AI/agent/issues/903)) ([9563072](https://github.com/Autonoma-AI/agent/commit/95630721d9e847a2bbebf195bb9d7f100dbaef8b))
* generation reviewer consumes scenario data (plan-vs-data check) ([#877](https://github.com/Autonoma-AI/agent/issues/877)) ([c0ede57](https://github.com/Autonoma-AI/agent/commit/c0ede57f458bac2d802f5c673604250755b81b63))
* generation reviewer on widened DiffJobContext (change facts + lineage) ([#843](https://github.com/Autonoma-AI/agent/issues/843)) ([88977ff](https://github.com/Autonoma-AI/agent/commit/88977ff24b92d44e90d88a1fcc34740d78fb7a3e))
* generation reviewer Step Summary from StepAttempt + shared renderer ([#916](https://github.com/Autonoma-AI/agent/issues/916)) ([775e715](https://github.com/Autonoma-AI/agent/commit/775e7155b6c00b2952a520315836bd3740ba1979))
* **generations-evals:** save video and per-case result.json to results folder ([#940](https://github.com/Autonoma-AI/agent/issues/940)) ([378f9d2](https://github.com/Autonoma-AI/agent/commit/378f9d24927a3069235270f062b539dda7454267))
* link runs and generations to their PR and snapshot ([#845](https://github.com/Autonoma-AI/agent/issues/845)) ([bfb6180](https://github.com/Autonoma-AI/agent/commit/bfb61803de3e1e3dbaf9cfdf354f201100befe1e))
* migrate healing agent onto the unified DiffJobContextLoader ([#819](https://github.com/Autonoma-AI/agent/issues/819)) ([#904](https://github.com/Autonoma-AI/agent/issues/904)) ([4be6261](https://github.com/Autonoma-AI/agent/commit/4be6261b972ff58ea5d081188f9f3aefce037b91))
* migrate resolution agent onto the unified DiffJobContextLoader ([#892](https://github.com/Autonoma-AI/agent/issues/892)) ([7181cfd](https://github.com/Autonoma-AI/agent/commit/7181cfdd6f204c4653040470b9a93ccdb3af92ac))
* **onboarding:** enrich Setup step with app name and test count ([#847](https://github.com/Autonoma-AI/agent/issues/847)) ([1cc3cc3](https://github.com/Autonoma-AI/agent/commit/1cc3cc34f495505fd97e08be092035424c9a7acc))
* persist errorName on failed replay steps and adopt shared renderer ([#933](https://github.com/Autonoma-AI/agent/issues/933)) ([4563fc0](https://github.com/Autonoma-AI/agent/commit/4563fc0eb2e8fd0533be52fa2bd77b809812a824))
* **previewkit:** add Gatekeeper integration ([#885](https://github.com/Autonoma-AI/agent/issues/885)) ([eee1c7d](https://github.com/Autonoma-AI/agent/commit/eee1c7d261cdc95468e4a863577bda677afe79a4))
* **previewkit:** add Grafana Loki as log backend for build and apps ([#926](https://github.com/Autonoma-AI/agent/issues/926)) ([db8500f](https://github.com/Autonoma-AI/agent/commit/db8500f294b486e30eea4c00ccdbbd7dd40b7171))
* **previewkit:** add log stream using Redis Stream ([#887](https://github.com/Autonoma-AI/agent/issues/887)) ([b6a7a4b](https://github.com/Autonoma-AI/agent/commit/b6a7a4b8737d8b4582c0c9c156dfc5c964d99167))
* **previewkit:** admin button to deploy a preview env from an application's main branch ([#902](https://github.com/Autonoma-AI/agent/issues/902)) ([bdf658e](https://github.com/Autonoma-AI/agent/commit/bdf658e47ed5634d5e8a9ea49505ea62ab09c08c))
* **previewkit:** cancel superseded deploys to release build compute ([#924](https://github.com/Autonoma-AI/agent/issues/924)) ([f5cade7](https://github.com/Autonoma-AI/agent/commit/f5cade7629d19588a5ba3b483c8550d3505b2d67))
* **previewkit:** retire the HTTP server - standalone Temporal worker ([#894](https://github.com/Autonoma-AI/agent/issues/894)) ([33be2dd](https://github.com/Autonoma-AI/agent/commit/33be2dda5365dffef636f5271dcd5ec237fe819c))
* **previewkit:** run preview deploys on Temporal (Phase 0 + 1) ([#792](https://github.com/Autonoma-AI/agent/issues/792)) ([c7a1cd2](https://github.com/Autonoma-AI/agent/commit/c7a1cd20aeabafbc4f2e560a2dcf07bd48e1c6cb))
* **previewkit:** run teardown as a Temporal workflow ([#890](https://github.com/Autonoma-AI/agent/issues/890)) ([cb6084c](https://github.com/Autonoma-AI/agent/commit/cb6084c7d1f96ee37e704828666fbc98e309a7c0))
* **previewkit:** update main-branch preview environments on push ([#948](https://github.com/Autonoma-AI/agent/issues/948)) ([480f462](https://github.com/Autonoma-AI/agent/commit/480f462880770c5d5e63a7a49e98f70d478e1d0c))
* **previewkit:** use ECR Pull through cache for recipe images ([#939](https://github.com/Autonoma-AI/agent/issues/939)) ([1a14bc1](https://github.com/Autonoma-AI/agent/commit/1a14bc1d09516d40f586f551323ade696861ed99))
* recover legacy scenario data from webhook log in eval captures ([#929](https://github.com/Autonoma-AI/agent/issues/929)) ([1888577](https://github.com/Autonoma-AI/agent/commit/188857785827e20eda31d7f6023364be43b4b47d))
* replay eval ([#944](https://github.com/Autonoma-AI/agent/issues/944)) ([f9c02fd](https://github.com/Autonoma-AI/agent/commit/f9c02fd7522dc1df27e1378e12ca50e164bfa722))
* send distinct Slack message for cancelled deploys ([#941](https://github.com/Autonoma-AI/agent/issues/941)) ([1783295](https://github.com/Autonoma-AI/agent/commit/1783295f9734648ade52a626ba671c29dba85e65))
* show full attempt timeline incl. failures in generation detail ([#854](https://github.com/Autonoma-AI/agent/issues/854)) ([b1fa472](https://github.com/Autonoma-AI/agent/commit/b1fa4726603f5efa8901199319f42b75146992ab))
* structured failure detail for scenario_setup end-to-end ([#917](https://github.com/Autonoma-AI/agent/issues/917)) ([923721b](https://github.com/Autonoma-AI/agent/commit/923721b1cc182a5bda473ef564d32d5c3fcf7bfd))
* surface rejection reasoning and "checked" tests in PR snapshots ([#879](https://github.com/Autonoma-AI/agent/issues/879)) ([7e56c2a](https://github.com/Autonoma-AI/agent/commit/7e56c2ac20381173fddcc983584625f42061aa32))
* **ui:** add preview environment entry point to PR header ([#910](https://github.com/Autonoma-AI/agent/issues/910)) ([d5df492](https://github.com/Autonoma-AI/agent/commit/d5df492a738d3b2c6cd4dcb3b2fd23a1ae3e7241))
* **ui:** default Pull Requests page to open PRs with state tabs ([#900](https://github.com/Autonoma-AI/agent/issues/900)) ([8917ee4](https://github.com/Autonoma-AI/agent/commit/8917ee460e6e3d030e7fc67ba3e17443948e551a))
* **ui:** redesign home around PRs and bugs, add main-branch view ([#849](https://github.com/Autonoma-AI/agent/issues/849)) ([c0f7290](https://github.com/Autonoma-AI/agent/commit/c0f729051a8088b1921514ceaa039a30bf4d9f91))


### Bug Fixes

* **api:** classify non-open PRs so the Open tab shows only open ones ([#909](https://github.com/Autonoma-AI/agent/issues/909)) ([47b5ee7](https://github.com/Autonoma-AI/agent/commit/47b5ee772b6be0f6d6b4a3e9950f5461374d70e9))
* **api:** gate PR cache revalidation on oldest write so webhooks don't suppress it ([#897](https://github.com/Autonoma-AI/agent/issues/897)) ([21e4bf7](https://github.com/Autonoma-AI/agent/commit/21e4bf76c49e018114a75f264eea74ff07e37124))
* **api:** only revalidate open PRs in PR metadata cache ([#895](https://github.com/Autonoma-AI/agent/issues/895)) ([41ae365](https://github.com/Autonoma-AI/agent/commit/41ae3659deca6eb972b5d8001c76c518a2c985f8))
* **branches:** resolve merged vs closed for PRs that leave the open list ([#930](https://github.com/Autonoma-AI/agent/issues/930)) ([960af93](https://github.com/Autonoma-AI/agent/commit/960af9317b5760a1ad522bac422fef1129f867fb))
* correct metrics in PR comments ([#798](https://github.com/Autonoma-AI/agent/issues/798)) ([4e0d5bb](https://github.com/Autonoma-AI/agent/commit/4e0d5bb376292ad30571f4422fc7f65cc1c02f8a))
* **deploy:** Karpenter 1.13.0 for k8s 1.36 + keep one previewkit worker warm ([#920](https://github.com/Autonoma-AI/agent/issues/920)) ([cae75f2](https://github.com/Autonoma-AI/agent/commit/cae75f2197ce72e1e43a9babeeff20e1225bb07b))
* improve TypeTool description to prevent silent focus-click failures ([#942](https://github.com/Autonoma-AI/agent/issues/942)) ([5404bf0](https://github.com/Autonoma-AI/agent/commit/5404bf095c63c50ea153ce3bde0c9ddf9961ae8c))
* increase volume size for previewkit nodes ([#945](https://github.com/Autonoma-AI/agent/issues/945)) ([5c89a3f](https://github.com/Autonoma-AI/agent/commit/5c89a3f0f7b8c23600c44966807b41cd6cd31917))
* move images to git LFS ([#931](https://github.com/Autonoma-AI/agent/issues/931)) ([3878abc](https://github.com/Autonoma-AI/agent/commit/3878abce05fcdd93b97252ed151a39abf8196e4e))
* **previewkit:** add better resource management for apps and services ([#938](https://github.com/Autonoma-AI/agent/issues/938)) ([4966d9c](https://github.com/Autonoma-AI/agent/commit/4966d9ca3cfe32b8d22b8e13e9ff8b5d75dc1f07))
* **previewkit:** add endpointslices permissions for gatekeeper ([3b685fe](https://github.com/Autonoma-AI/agent/commit/3b685fe5e1fcfed0b8ec8517c2aa970d5d7b2428))
* **previewkit:** add FK relation from Application to ConfigRevision ([#946](https://github.com/Autonoma-AI/agent/issues/946)) ([e203d8f](https://github.com/Autonoma-AI/agent/commit/e203d8f65292cc39485466311ee2287a464f5294))
* **previewkit:** add read-next-config.mjs to Rolldown build ([#893](https://github.com/Autonoma-AI/agent/issues/893)) ([4a0042a](https://github.com/Autonoma-AI/agent/commit/4a0042a1b833c1e9a4c3744a89b852cdf95facf4))
* **previewkit:** avoid Gatekeeper pods in allow-internet-egress NetworkPolicy ([742b7d4](https://github.com/Autonoma-AI/agent/commit/742b7d4f74c96296380a8de590f6d221f8f7553c))
* **previewkit:** disable docker mirror hub for buildkitd ([ed3a48f](https://github.com/Autonoma-AI/agent/commit/ed3a48fc1ef3743594b072a18aec34240c68b48e))
* **previewkit:** make nginx proxy resilient to missing upstreams ([#884](https://github.com/Autonoma-AI/agent/issues/884)) ([0b2ea6d](https://github.com/Autonoma-AI/agent/commit/0b2ea6d6f1dff9f0ee87cdc1dc781f6ed8440e34))
* **previewkit:** split buildkit readiness into provision vs startup budgets ([#881](https://github.com/Autonoma-AI/agent/issues/881)) ([717ee89](https://github.com/Autonoma-AI/agent/commit/717ee89a44a16936db7634f01bb405706fb2b545))
* **previewkit:** survive build-node scale-up and stream repo tarballs ([#874](https://github.com/Autonoma-AI/agent/issues/874)) ([4e60cb3](https://github.com/Autonoma-AI/agent/commit/4e60cb34ad506620b6735c27e325753c99be4936))
* **previewkit:** use a subdirectory for pgdata ([#936](https://github.com/Autonoma-AI/agent/issues/936)) ([57e1dcd](https://github.com/Autonoma-AI/agent/commit/57e1dcdf4b8209ea54f0c30121395cc1b0e4126f))
* show latest replay run for modified tests in snapshot changes ([#925](https://github.com/Autonoma-AI/agent/issues/925)) ([f009bf9](https://github.com/Autonoma-AI/agent/commit/f009bf9f074938b02aa8216af3f4ea2b9caea296))
* sign test-step screenshot urls in suite and edit views ([#868](https://github.com/Autonoma-AI/agent/issues/868)) ([98ce0fa](https://github.com/Autonoma-AI/agent/commit/98ce0faac0d1b368fa4d21f1dae82cd512f8d724))
* **ui:** add missing superseded option to STATUS_VARIANT ([b86b33a](https://github.com/Autonoma-AI/agent/commit/b86b33a84b3540d5ccaee3800188f433123f83fd))
* **ui:** simplify PR test run summary to passed/failed only ([#852](https://github.com/Autonoma-AI/agent/issues/852)) ([c9b8767](https://github.com/Autonoma-AI/agent/commit/c9b87677f5da7d8dfa0719dcb442f92d685ad80e))
* **ui:** skip the app chooser and land on an onboarded app ([#921](https://github.com/Autonoma-AI/agent/issues/921)) ([4d1e746](https://github.com/Autonoma-AI/agent/commit/4d1e746c66b4277e50a17c473bb36359f03745ea))
* **ui:** speed up PRs tab and show skeleton on navigation ([#922](https://github.com/Autonoma-AI/agent/issues/922)) ([a932443](https://github.com/Autonoma-AI/agent/commit/a9324433c92adff6e45aed972511a837cb914da2))
* unresolved variables error message ([#915](https://github.com/Autonoma-AI/agent/issues/915)) ([5be3484](https://github.com/Autonoma-AI/agent/commit/5be3484401a8eb03d76cf118ffd1be87b160d8f1))


### Performance Improvements

* **api:** use node-caged base image for lower runtime memory ([#928](https://github.com/Autonoma-AI/agent/issues/928)) ([da7f0a3](https://github.com/Autonoma-AI/agent/commit/da7f0a3ccf1feb27b3ac979c89c1349fdb54111f))
* **branches:** lean snapshotDetail for PR overview + query-budget tests ([#927](https://github.com/Autonoma-AI/agent/issues/927)) ([6e533d8](https://github.com/Autonoma-AI/agent/commit/6e533d87be843f128d4a43e0e7758c9d1422ad14))
* **bugs:** lean query + indexes for unresolved-bugs rail ([#923](https://github.com/Autonoma-AI/agent/issues/923)) ([c3d45a8](https://github.com/Autonoma-AI/agent/commit/c3d45a86dd2f372742e99554c351fe9ed77ed9e5))

## [1.4.0](https://github.com/Autonoma-AI/agent/compare/v1.3.0...v1.4.0) (2026-06-08)


### Features

* add command UIs for read and save-clipboard steps ([#844](https://github.com/Autonoma-AI/agent/issues/844)) ([3e8acb3](https://github.com/Autonoma-AI/agent/commit/3e8acb38c146c709202132814d8d540cbb8b0c45))
* add previewkit file config ([#718](https://github.com/Autonoma-AI/agent/issues/718)) ([e260142](https://github.com/Autonoma-AI/agent/commit/e260142aa1c594956de6c71b94cd1d8939dce581))
* add StepAttempt model + backfill ([#833](https://github.com/Autonoma-AI/agent/issues/833)) ([9f524b8](https://github.com/Autonoma-AI/agent/commit/9f524b8805a0f6da8502a5793836f05d43893598))
* fill-height snapshot changes layout with collapsible plan ([#838](https://github.com/Autonoma-AI/agent/issues/838)) ([b5eb887](https://github.com/Autonoma-AI/agent/commit/b5eb88722b33ea19f67d92636699262018caa0ee))
* increase deploy timeout ([#832](https://github.com/Autonoma-AI/agent/issues/832)) ([f7d0442](https://github.com/Autonoma-AI/agent/commit/f7d04421d4315bfa9bf8c22a7b337de4837f9912))
* **onboarding:** auto-upload planner artifacts with waiting state ([#794](https://github.com/Autonoma-AI/agent/issues/794)) ([d42248c](https://github.com/Autonoma-AI/agent/commit/d42248c918400c4fe2d8d0bc8aee46ac2f6ac0c7))
* replay review lineage + anchoring guard ([#835](https://github.com/Autonoma-AI/agent/issues/835)) ([5646efb](https://github.com/Autonoma-AI/agent/commit/5646efbdb38ad9a7a9136798e255575257b2a361))
* shared scenario-data capability for the replay reviewer ([#836](https://github.com/Autonoma-AI/agent/issues/836)) ([552ca53](https://github.com/Autonoma-AI/agent/commit/552ca531fd64c7527680dbf69d53de5475430df7))


### Bug Fixes

* exclude generated files from oxfmt to stop routetree churn ([#841](https://github.com/Autonoma-AI/agent/issues/841)) ([04d5f26](https://github.com/Autonoma-AI/agent/commit/04d5f2647626401f7162d283d89af69e1a467021))

## [1.3.0](https://github.com/Autonoma-AI/agent/compare/v1.2.0...v1.3.0) (2026-06-08)


### Features

* add checkpoint report and evidence bug detail, pr detail page retouches ([#750](https://github.com/Autonoma-AI/agent/issues/750)) ([ab814c1](https://github.com/Autonoma-AI/agent/commit/ab814c14d8b979d3c507a2e68f792eee3be2fe8c))
* decrypt bypass token ([#823](https://github.com/Autonoma-AI/agent/issues/823)) ([f183dd0](https://github.com/Autonoma-AI/agent/commit/f183dd0f464473654210bf53d55ccb1aae1f2ae6))
* DiffJobContextLoader + replay reviewer on widened change context ([#821](https://github.com/Autonoma-AI/agent/issues/821)) ([fc965a2](https://github.com/Autonoma-AI/agent/commit/fc965a28d0f2cefd0e9623cfc2db2d3beb25b8b5))
* fetch baseSha in production reviewer codebase clones ([#808](https://github.com/Autonoma-AI/agent/issues/808)) ([363c8a9](https://github.com/Autonoma-AI/agent/commit/363c8a9496ce07a6f1e55174b9f61a619db9cef0))
* message compaction + per-tool-result caps for agent loops ([#796](https://github.com/Autonoma-AI/agent/issues/796)) ([6813483](https://github.com/Autonoma-AI/agent/commit/6813483a70becc84a815f94aa4f42dabe277384d))
* persist resolved scenario create-spec on ScenarioInstance ([#822](https://github.com/Autonoma-AI/agent/issues/822)) ([804329b](https://github.com/Autonoma-AI/agent/commit/804329b9a8eab384b8327dfa75877104a761d9b4))
* **previewkit:** save previewkit repository configuration in db instead of file ([#737](https://github.com/Autonoma-AI/agent/issues/737)) ([ddec5f3](https://github.com/Autonoma-AI/agent/commit/ddec5f3bafdef9e958511259b9867c0aa9948841))
* **ui:** add previewkit environment listing to admin page ([#814](https://github.com/Autonoma-AI/agent/issues/814)) ([6fdb24a](https://github.com/Autonoma-AI/agent/commit/6fdb24a89f58e479a94d6762de64a243642768fc))
* **ui:** add redeploy button to preview envirioments ([#824](https://github.com/Autonoma-AI/agent/issues/824)) ([206efbd](https://github.com/Autonoma-AI/agent/commit/206efbdae8d2ba81e2875ef66a6ece6bb5dd7852))


### Bug Fixes

* **previewkit:** remove nginx envirioment auth ([#826](https://github.com/Autonoma-AI/agent/issues/826)) ([e4d01e2](https://github.com/Autonoma-AI/agent/commit/e4d01e24f2a85fb940bd228cdc90ea2e3747bef0))
* **ui:** improve low-contrast text with a two-tier hierarchy ([#795](https://github.com/Autonoma-AI/agent/issues/795)) ([7a32166](https://github.com/Autonoma-AI/agent/commit/7a32166b9332ab367127c0a2b7c6ec6402ea0826))
* **ui:** truncate long PR names in pull requests table ([#830](https://github.com/Autonoma-AI/agent/issues/830)) ([33294b5](https://github.com/Autonoma-AI/agent/commit/33294b5f0594d265f6a0c4eabc1755be8ec93849))
* url lookup auth previewkit ([#825](https://github.com/Autonoma-AI/agent/issues/825)) ([1fe5f6e](https://github.com/Autonoma-AI/agent/commit/1fe5f6e25d6617dfedbafa39775cf37c0bbf2d93))

## [1.2.0](https://github.com/Autonoma-AI/agent/compare/v1.1.0...v1.2.0) (2026-06-05)


### Features

* add auth previewkit agent ([#774](https://github.com/Autonoma-AI/agent/issues/774)) ([11c7e66](https://github.com/Autonoma-AI/agent/commit/11c7e6672f967c123e40328321812aebeb6cb6aa))
* diffs analysis eval framework, codebase cache, judge, and capture ([#770](https://github.com/Autonoma-AI/agent/issues/770)) ([58220cc](https://github.com/Autonoma-AI/agent/commit/58220cc3721204fe19f20ca3e86aee1873de5121))
* diffs healing eval framework, capture, and shared loaders ([#779](https://github.com/Autonoma-AI/agent/issues/779)) ([7b3de31](https://github.com/Autonoma-AI/agent/commit/7b3de31461fb1754ee3f018a179b128a691d652a))
* diffs resolution eval framework and capture ([#777](https://github.com/Autonoma-AI/agent/issues/777)) ([5cbf986](https://github.com/Autonoma-AI/agent/commit/5cbf9861e66b163f76cf70595e3f71ebf0109094))
* **github:** add PR comment orchestrator ([#713](https://github.com/Autonoma-AI/agent/issues/713)) ([943f3f4](https://github.com/Autonoma-AI/agent/commit/943f3f4947d81f4faef6654e4845a90b94b821a8))
* improve logging for hook jobs ([#790](https://github.com/Autonoma-AI/agent/issues/790)) ([12596f9](https://github.com/Autonoma-AI/agent/commit/12596f96f420379c8a63f647582d20480f64fab6))
* move diffs eval cases to a private repo (configurable cases root) ([#793](https://github.com/Autonoma-AI/agent/issues/793)) ([aec25e7](https://github.com/Autonoma-AI/agent/commit/aec25e7e0dde85e0bb5ef90901fa9faaf5a2c935))
* preserve interrupted diffs snapshots instead of deleting them ([#771](https://github.com/Autonoma-AI/agent/issues/771)) ([8d69c99](https://github.com/Autonoma-AI/agent/commit/8d69c99a4a21897bc07db1c4ebc00fadb62729b0))
* **previewkit:** add signed URL to build logs PR comment ([#784](https://github.com/Autonoma-AI/agent/issues/784)) ([3bab7c0](https://github.com/Autonoma-AI/agent/commit/3bab7c0eec9af2a5f7485e592a1e36144b62e67e))
* reviewer evals (generation + replay) with multimedia rehydration ([#778](https://github.com/Autonoma-AI/agent/issues/778)) ([c26faa6](https://github.com/Autonoma-AI/agent/commit/c26faa6c688227435825d800e8c870fd3bfd0760))
* **ui:** redesign PR detail verdict layout ([#725](https://github.com/Autonoma-AI/agent/issues/725)) ([2b058fd](https://github.com/Autonoma-AI/agent/commit/2b058fd0f6abcd5b863ea40e85a447393fa796ed))


### Bug Fixes

* admin scenario recipe editing ([#760](https://github.com/Autonoma-AI/agent/issues/760)) ([5ade172](https://github.com/Autonoma-AI/agent/commit/5ade172616f6ec8731c8ba21339f457ddd1b0441))
* build better auth bump ([#786](https://github.com/Autonoma-AI/agent/issues/786)) ([d7374cf](https://github.com/Autonoma-AI/agent/commit/d7374cf111a22c85ace9dbdd9a06beb35171d77e))
* default to beta.autonoma.app for app url auth ([#800](https://github.com/Autonoma-AI/agent/issues/800)) ([c70f921](https://github.com/Autonoma-AI/agent/commit/c70f9215900c7c40197f0e6dc638943880558bf1))
* modify better-auth kysely dependency install ([e130df7](https://github.com/Autonoma-AI/agent/commit/e130df76d33123f71eb547fcfa7aa456f03ccc8e))
* PR comment assets and deployment links ([#775](https://github.com/Autonoma-AI/agent/issues/775)) ([bfc4b0b](https://github.com/Autonoma-AI/agent/commit/bfc4b0b9b9c1694327bc5ee65a869f8f7260af7a))
* prevent resolution agent from acting twice on the same failed slug ([#761](https://github.com/Autonoma-AI/agent/issues/761)) ([94c2ffd](https://github.com/Autonoma-AI/agent/commit/94c2ffdade1784e787c1aeefb113b28dd0cba024))
* previewkit auth check membership for org switch ([#781](https://github.com/Autonoma-AI/agent/issues/781)) ([503465d](https://github.com/Autonoma-AI/agent/commit/503465d44e5c90ddf1e8815801d809db5c3ded36))
* **previewkit:** inject bypass header into webhook headers on deployment ([#801](https://github.com/Autonoma-AI/agent/issues/801)) ([746934e](https://github.com/Autonoma-AI/agent/commit/746934e60e8f795709ce4e326842643ab68a4fc9))
* **previewkit:** log deployment payload sent to GitHub ([#799](https://github.com/Autonoma-AI/agent/issues/799)) ([1c42e18](https://github.com/Autonoma-AI/agent/commit/1c42e18f428701928500093c4ecc66a31c1cd895))
* **previewkit:** replace HTTPRoute with nginx ingress for each namespace ([#797](https://github.com/Autonoma-AI/agent/issues/797)) ([25c1901](https://github.com/Autonoma-AI/agent/commit/25c1901a3ce4bbc0308cde9cce888288298cdf26))
* redirect url ([#785](https://github.com/Autonoma-AI/agent/issues/785)) ([1802cf2](https://github.com/Autonoma-AI/agent/commit/1802cf247d97723e3ebdf910c0993220f7c6493f))
* remove stale 'qa-tests' mention from system prompt ([#773](https://github.com/Autonoma-AI/agent/issues/773)) ([2d518a1](https://github.com/Autonoma-AI/agent/commit/2d518a11395b643c92660a5bb7b016928b72e947))

## [1.1.0](https://github.com/Autonoma-AI/agent/compare/v1.0.0...v1.1.0) (2026-06-02)


### Features

* add custom testing guidelines for plan-authoring agents ([#638](https://github.com/Autonoma-AI/agent/issues/638)) ([9b03467](https://github.com/Autonoma-AI/agent/commit/9b034671353deef00b9319335cfa5cf3c71960e6))
* add debugging panels to generations and runs ([#648](https://github.com/Autonoma-AI/agent/issues/648)) ([915d5fc](https://github.com/Autonoma-AI/agent/commit/915d5fc30b21634a4dc03de562b6116ebe324edc))
* add sns and s3 notificaciones recipe ([#662](https://github.com/Autonoma-AI/agent/issues/662)) ([e0de53d](https://github.com/Autonoma-AI/agent/commit/e0de53d0fd59495a517529d40f2e5bc5f678a1f3))
* adopt Agent abstraction across diffs pipeline ([#720](https://github.com/Autonoma-AI/agent/issues/720)) ([6445690](https://github.com/Autonoma-AI/agent/commit/6445690cf9b00dd9fee09684540433e319ee2f71))
* agent abstraction in @autonoma/ai + universal Codebase ([#689](https://github.com/Autonoma-AI/agent/issues/689)) ([bb0b076](https://github.com/Autonoma-AI/agent/commit/bb0b07678bf73bcecd64766e97f0d62a78f480a9))
* **bugs:** include bug URL in classification event ([#735](https://github.com/Autonoma-AI/agent/issues/735)) ([9256480](https://github.com/Autonoma-AI/agent/commit/92564804f91291e38ad37236553d13f961737310))
* **bugs:** track true/false positive classification via PostHog ([#734](https://github.com/Autonoma-AI/agent/issues/734)) ([4244b9d](https://github.com/Autonoma-AI/agent/commit/4244b9d5e3aeb8ffcc27326a6b6f8ddff6782746))
* buildkit retry loop + aws recipe ([#619](https://github.com/Autonoma-AI/agent/issues/619)) ([426170d](https://github.com/Autonoma-AI/agent/commit/426170d34002cd5066d132636d1a3977dc31489d))
* canonical observability for diffs job + refinement loop ([#671](https://github.com/Autonoma-AI/agent/issues/671)) ([88b6bb9](https://github.com/Autonoma-AI/agent/commit/88b6bb9b2105a2d037e2e5981ec7ede8f89a5262))
* compact snapshot detail and add /admin/issues ([#686](https://github.com/Autonoma-AI/agent/issues/686)) ([f62555c](https://github.com/Autonoma-AI/agent/commit/f62555c16ab3969c3df1b7e86365558ab934a4ff))
* delete dead app-scoped overview routes ([#660](https://github.com/Autonoma-AI/agent/issues/660)) ([a561a54](https://github.com/Autonoma-AI/agent/commit/a561a545ce3f4c41a192833c1e98581607e0717e))
* drop step caps and bulk read tools in diff/healing agents ([#663](https://github.com/Autonoma-AI/agent/issues/663)) ([3282e3a](https://github.com/Autonoma-AI/agent/commit/3282e3aa1a2bd2ffe87d8c921c3d3bd8226d2ec4))
* enforce 1:1 between BranchSnapshot and RefinementLoop ([#669](https://github.com/Autonoma-AI/agent/issues/669)) ([832eb58](https://github.com/Autonoma-AI/agent/commit/832eb589ac22fafe57c913259df3f009e283ebe2))
* link to Temporal diffs workflow from snapshot detail ([#667](https://github.com/Autonoma-AI/agent/issues/667)) ([26916cc](https://github.com/Autonoma-AI/agent/commit/26916cc0567783daa7755bcd7353b7c14bff306c))
* migrate to Kubernetes ingress gateway ([#700](https://github.com/Autonoma-AI/agent/issues/700)) ([7347d1b](https://github.com/Autonoma-AI/agent/commit/7347d1b4c63b2d99de2ff5c437df607524bfa464))
* openModelSession + singleton diffs model registry ([#747](https://github.com/Autonoma-AI/agent/issues/747)) ([8ddf544](https://github.com/Autonoma-AI/agent/commit/8ddf54403cab7ad3cff9a063808f190de8b6cec4))
* per-call cost collector on ModelRegistry.getModel ([#746](https://github.com/Autonoma-AI/agent/issues/746)) ([fe1d142](https://github.com/Autonoma-AI/agent/commit/fe1d1424a49e18cd7687aaf656823a761f222f30))
* previewkit auth proxy ([#698](https://github.com/Autonoma-AI/agent/issues/698)) ([1ffd643](https://github.com/Autonoma-AI/agent/commit/1ffd64320d6fab94e718f04e27bdf32c22624ad7))
* **previewkit:** add {{hostname}} template to env-injector ([#755](https://github.com/Autonoma-AI/agent/issues/755)) ([da98bb6](https://github.com/Autonoma-AI/agent/commit/da98bb614fd3c8638708db487aeb90a521ba3954))
* **previewkit:** add addon system to integrate with third-party tools ([#655](https://github.com/Autonoma-AI/agent/issues/655)) ([180dbc4](https://github.com/Autonoma-AI/agent/commit/180dbc412faf4c2895f844792f1ad59ea19d8707))
* **previewkit:** add ECR Pull through cache to buildkit ([#687](https://github.com/Autonoma-AI/agent/issues/687)) ([b2691a9](https://github.com/Autonoma-AI/agent/commit/b2691a9c484443173213d4a4c23b9e6303e55cac))
* **previewkit:** add generic docker-image recipe ([#693](https://github.com/Autonoma-AI/agent/issues/693)) ([6f7ed0a](https://github.com/Autonoma-AI/agent/commit/6f7ed0a3ddf9a6939b4a71466e602b9adb140208))
* **previewkit:** add image option to postgres recipe ([#756](https://github.com/Autonoma-AI/agent/issues/756)) ([6dcc058](https://github.com/Autonoma-AI/agent/commit/6dcc0582fb68fa5ddccb0bbf17d2f1d8355fca5f))
* **previewkit:** add Karpenter nodepool for buildkit ([#685](https://github.com/Autonoma-AI/agent/issues/685)) ([d30ade6](https://github.com/Autonoma-AI/agent/commit/d30ade63036c34be4df9fca6d4310270b6b27fb7))
* **previewkit:** add main branch preview environment deploy endpoint ([#758](https://github.com/Autonoma-AI/agent/issues/758)) ([a675d2b](https://github.com/Autonoma-AI/agent/commit/a675d2b9d2a0b17fb8b81f0e56eb7513979ce8c4))
* **previewkit:** add MongoDB recipe ([#712](https://github.com/Autonoma-AI/agent/issues/712)) ([d96c5b3](https://github.com/Autonoma-AI/agent/commit/d96c5b38af2e4855f2f07cb574c17d506744a814))
* **previewkit:** add redeploy endpoint ([#653](https://github.com/Autonoma-AI/agent/issues/653)) ([c90b59f](https://github.com/Autonoma-AI/agent/commit/c90b59f9e92218c263226fa3bd10aeb2aaed9a4b))
* **previewkit:** add upstash recipe ([#715](https://github.com/Autonoma-AI/agent/issues/715)) ([6058937](https://github.com/Autonoma-AI/agent/commit/60589374caee207088693db87199f4c4b6807517))
* **previewkit:** bun/pnpm/yarn turbo monorepo build path ([#701](https://github.com/Autonoma-AI/agent/issues/701)) ([f506024](https://github.com/Autonoma-AI/agent/commit/f506024d16c40971d088dcfc99cb7bc2bf81e12b))
* **previewkit:** create one buildkitd job per app building ([#675](https://github.com/Autonoma-AI/agent/issues/675)) ([fe67d36](https://github.com/Autonoma-AI/agent/commit/fe67d3651669c414d7ce7015813bca606e748359))
* **previewkit:** increase buildkit node EBS volume to 100Gi ([#691](https://github.com/Autonoma-AI/agent/issues/691)) ([23236d1](https://github.com/Autonoma-AI/agent/commit/23236d1d0cabdebfc8eb4d3f1f8148da555986ce))
* **previewkit:** make apps build and deploy independently of each other ([#635](https://github.com/Autonoma-AI/agent/issues/635)) ([c45d08a](https://github.com/Autonoma-AI/agent/commit/c45d08abac830d3297e99a6c2441a0e9cd43838e))
* **previewkit:** mask preview URLs with HMAC-SHA256 instead of readable labels ([#704](https://github.com/Autonoma-AI/agent/issues/704)) ([f5f09be](https://github.com/Autonoma-AI/agent/commit/f5f09be4b937a24eafdd99d20b3de4e905db48c0))
* **previewkit:** mount app secrets bundle in hook jobs ([#754](https://github.com/Autonoma-AI/agent/issues/754)) ([ca4f6f0](https://github.com/Autonoma-AI/agent/commit/ca4f6f043a250b8bc9c91611895478fde8984990))
* **previewkit:** notify on the PR when a fallback branch is used in multirepo dependencies ([#637](https://github.com/Autonoma-AI/agent/issues/637)) ([e33a4cf](https://github.com/Autonoma-AI/agent/commit/e33a4cfbb05bff8f13e2a3ffe0fdacf6818a32f6))
* **previewkit:** support .preview.yml as alternative config filename ([#727](https://github.com/Autonoma-AI/agent/issues/727)) ([81532c8](https://github.com/Autonoma-AI/agent/commit/81532c8c0ed554ea5d45e2b9560a805f988568aa))
* **previewkit:** trigger diffs analysis automatically after preview deploy ([#628](https://github.com/Autonoma-AI/agent/issues/628)) ([b467784](https://github.com/Autonoma-AI/agent/commit/b467784304d4f78d77d8c6fb89d1fc047ed5e3d6))
* **previewkit:** trigger diffs via GitHub Deployments ([#668](https://github.com/Autonoma-AI/agent/issues/668)) ([9010082](https://github.com/Autonoma-AI/agent/commit/9010082ba49c8113dcf5d748ad4b4aa93b7ed954))
* **previewkit:** upgrade buildkit deployment CPU and memory requests ([fdf64a8](https://github.com/Autonoma-AI/agent/commit/fdf64a8f1c06f6e98e19f290988f05eb7d196b87))
* redesign PR detail page around test-suite changes ([#661](https://github.com/Autonoma-AI/agent/issues/661)) ([28083cd](https://github.com/Autonoma-AI/agent/commit/28083cdc782245931bfe5b388d3457bec94ab78d))
* relocate diffs analysis to worker-diffs + adopt openModelSession ([#751](https://github.com/Autonoma-AI/agent/issues/751)) ([bcc5f9b](https://github.com/Autonoma-AI/agent/commit/bcc5f9bebf5273930b881e49ff41a9b593333573))
* remove skills UI and API surface ([#696](https://github.com/Autonoma-AI/agent/issues/696)) ([a0d8ccd](https://github.com/Autonoma-AI/agent/commit/a0d8ccdf0daee72b338e8336bec7d618cf96cc4f))
* replace multi-step onboarding with CLI-driven setup ([#652](https://github.com/Autonoma-AI/agent/issues/652)) ([86fc13e](https://github.com/Autonoma-AI/agent/commit/86fc13e8a95bf402ce0c9475c0ac2e0f7b740596))
* shell cleanup - app selector in sidebar, hide light mode ([#659](https://github.com/Autonoma-AI/agent/issues/659)) ([89d8678](https://github.com/Autonoma-AI/agent/commit/89d8678804b34bfbc0f1e9ca0371248f0989d433))
* **ui:** add Github App repositories list to admin page ([#736](https://github.com/Autonoma-AI/agent/issues/736)) ([12677da](https://github.com/Autonoma-AI/agent/commit/12677da47aba058a60d4ae6bb7eb38d1c0d025af))
* **ui:** track onboarding_started event for signup measurement ([#728](https://github.com/Autonoma-AI/agent/issues/728)) ([092a749](https://github.com/Autonoma-AI/agent/commit/092a749476caf2d0e65f9ef85de4b4d436fe240b))


### Bug Fixes

* add publishNotReadyAddresses to MongoDB for proper startup script ([#723](https://github.com/Autonoma-AI/agent/issues/723)) ([6263b81](https://github.com/Autonoma-AI/agent/commit/6263b8163f39ef6c7efd592b400ed21d8764c9f6))
* auth, use autonoma service secret ([#676](https://github.com/Autonoma-AI/agent/issues/676)) ([6e33c3c](https://github.com/Autonoma-AI/agent/commit/6e33c3c2a5545a0c2a915d2f3e265b8366db2226))
* dedupe view link in snapshot changes detail ([#726](https://github.com/Autonoma-AI/agent/issues/726)) ([77c8d17](https://github.com/Autonoma-AI/agent/commit/77c8d172c2a99766a487c2031586750019bacd1c))
* drop skill processing from application setup ([#649](https://github.com/Autonoma-AI/agent/issues/649)) ([12d497e](https://github.com/Autonoma-AI/agent/commit/12d497e4369650aa330abfb8298d0efa461ce449))
* ENOTEMPTY race in diffs job repo cleanup ([#714](https://github.com/Autonoma-AI/agent/issues/714)) ([51fbad7](https://github.com/Autonoma-AI/agent/commit/51fbad7f8873af9cf91222f40dc0afb24243abcf))
* flush sentry on worker exit and capture activity failures ([#711](https://github.com/Autonoma-AI/agent/issues/711)) ([d45cdb0](https://github.com/Autonoma-AI/agent/commit/d45cdb01e073c5b009134976bffdb64439c7ea6d))
* **healing:** reject duplicate actions for the same testCase ([#679](https://github.com/Autonoma-AI/agent/issues/679)) ([9bd2897](https://github.com/Autonoma-AI/agent/commit/9bd289717fd43371e9a68149b4d4ecc7fecf140b))
* **infra:** unblock node-exporter pulls and right-size buildkit nodes ([#692](https://github.com/Autonoma-AI/agent/issues/692)) ([573cbe2](https://github.com/Autonoma-AI/agent/commit/573cbe2a29ab0b715eae84339478cda61ff6f985))
* nginx api gw ([#716](https://github.com/Autonoma-AI/agent/issues/716)) ([244b0d8](https://github.com/Autonoma-AI/agent/commit/244b0d81b7f738017879ec449b477a97f198d82a))
* **onboarding:** CLI upload, shared-secret surfacing, funnel stitching, scoped GitHub disconnect ([#733](https://github.com/Autonoma-AI/agent/issues/733)) ([72bad52](https://github.com/Autonoma-AI/agent/commit/72bad52fd025260051b3b39fed2a971d4dc13c2f))
* oom previewkit ([#688](https://github.com/Autonoma-AI/agent/issues/688)) ([6548d44](https://github.com/Autonoma-AI/agent/commit/6548d449f3ded1333b74025a3c5f42ba58550348))
* **previewkit:** add a connection tryout before firing buildctl job ([#678](https://github.com/Autonoma-AI/agent/issues/678)) ([3738149](https://github.com/Autonoma-AI/agent/commit/37381494ee169205e618344802b0a1c8a4127a8b))
* **previewkit:** avoid deleting service deployments on redeploy ([#721](https://github.com/Autonoma-AI/agent/issues/721)) ([86da0e2](https://github.com/Autonoma-AI/agent/commit/86da0e26fe29badcfe09e7d6eb8e13725232a6a5))
* **previewkit:** avoid Upstash recipe from crashing on boot ([#732](https://github.com/Autonoma-AI/agent/issues/732)) ([b153b50](https://github.com/Autonoma-AI/agent/commit/b153b5030a8f6935e3da5f4a13fe215c3228756d))
* **previewkit:** bump bun to 1.2.20 for musl support ([#705](https://github.com/Autonoma-AI/agent/issues/705)) ([b933d36](https://github.com/Autonoma-AI/agent/commit/b933d36f6e5a43634f48dff3b4fe7e1356474bad))
* **previewkit:** delete crashed service pods + readiness diagnostics ([#722](https://github.com/Autonoma-AI/agent/issues/722)) ([acd0dd2](https://github.com/Autonoma-AI/agent/commit/acd0dd21b52b759b5185dc026b817e850feb5cb7))
* **previewkit:** fix immutable RoleBinding roleRef and Role name mismatch ([#695](https://github.com/Autonoma-AI/agent/issues/695)) ([0ef3198](https://github.com/Autonoma-AI/agent/commit/0ef31984b271a1785a94549457ee2021c33e6daa))
* **previewkit:** inject PORT env var into app containers ([#707](https://github.com/Autonoma-AI/agent/issues/707)) ([7c4ce1c](https://github.com/Autonoma-AI/agent/commit/7c4ce1cc67c417a3478d3e2aa8dacdfb12c72c22))
* **previewkit:** prevent stale CrashLoopBackOff pods from failing re-deploys ([#719](https://github.com/Autonoma-AI/agent/issues/719)) ([fe75a99](https://github.com/Autonoma-AI/agent/commit/fe75a99edbf31b52e329daa5258e83226ba64176))
* **previewkit:** redo secrets endpoint ([#673](https://github.com/Autonoma-AI/agent/issues/673)) ([738b269](https://github.com/Autonoma-AI/agent/commit/738b269371fc702d42082c7ada8516d5f8ece6b9))
* **previewkit:** refactor tests to use new nginx gateway ([12c55f6](https://github.com/Autonoma-AI/agent/commit/12c55f652fd6b70f53abecd808af845a3bfbcbb9))
* **previewkit:** remove cluster DNS check in postStart script for MongoDB ([#730](https://github.com/Autonoma-AI/agent/issues/730)) ([ae216b0](https://github.com/Autonoma-AI/agent/commit/ae216b08d4b7612b0b59b3e70b00538d96e8a620))
* **previewkit:** remove deprecated secret store from tests ([f193481](https://github.com/Autonoma-AI/agent/commit/f19348181406c5097ec69a98acc4df06ee73e6f6))
* **previewkit:** remove resources property from schema ([5a40fcd](https://github.com/Autonoma-AI/agent/commit/5a40fcdb0b884054d585aa0c3213ae29dd97c238))
* **previewkit:** sanitize AWS secret name before creation ([#703](https://github.com/Autonoma-AI/agent/issues/703)) ([7fc2f9e](https://github.com/Autonoma-AI/agent/commit/7fc2f9e76d2d7ec84a014a36d6968b194d51729b))
* **previewkit:** scope RoleBinding name per namespace to prevent overwrites ([#702](https://github.com/Autonoma-AI/agent/issues/702)) ([a7da4d9](https://github.com/Autonoma-AI/agent/commit/a7da4d905aabfe88ed5e909bd761aa33d4d61925))
* **previewkit:** use correct service account name for buildkitd ([3be515f](https://github.com/Autonoma-AI/agent/commit/3be515fccb6399fa74c1ce4a0c5c6522e83433ee))
* propagate cancellation gracefully through generation and replay workflows ([#630](https://github.com/Autonoma-AI/agent/issues/630)) ([007b4a3](https://github.com/Autonoma-AI/agent/commit/007b4a3f63df9719ba77f76888755ffac6982e99))
* reliably register environment search attribute on alpha temporal namespace ([#672](https://github.com/Autonoma-AI/agent/issues/672)) ([48394fe](https://github.com/Autonoma-AI/agent/commit/48394fecb813c6ff2b392de13ad0d001c63f73b4))
* remove default max steps from all diffs agents ([#729](https://github.com/Autonoma-AI/agent/issues/729)) ([d2184f8](https://github.com/Autonoma-AI/agent/commit/d2184f88bb752355f440249c673601c38f8566e0))
* remove skills from snapshot-draft, fetch-info, create-branch-snapshot ([#697](https://github.com/Autonoma-AI/agent/issues/697)) ([a74fc14](https://github.com/Autonoma-AI/agent/commit/a74fc148f691447d93008d564660c69c6c7dab33))
* shield healing agent from unreportable testCaseIds ([#717](https://github.com/Autonoma-AI/agent/issues/717)) ([c669b64](https://github.com/Autonoma-AI/agent/commit/c669b643a99596fe93f327bde0714b854a68ead1))
* strip skills from healing/plan-authoring agent ([#650](https://github.com/Autonoma-AI/agent/issues/650)) ([674929f](https://github.com/Autonoma-AI/agent/commit/674929f5d92128d105fb3908364cf9bdb2ae738d))
* strip skills from the execution agent runtime ([#651](https://github.com/Autonoma-AI/agent/issues/651)) ([4e23e5a](https://github.com/Autonoma-AI/agent/commit/4e23e5ab5d7398529734e3faceb056a67cb0868c))
* **ui:** chunk onboarding artifact uploads to avoid CloudFront/WAF 403 ([#706](https://github.com/Autonoma-AI/agent/issues/706)) ([312ecab](https://github.com/Autonoma-AI/agent/commit/312ecab726e39f4f2579ed7b05a5ec1c21af8240))
* **ui:** shrink artifact upload chunks below WAF 8KB body limit ([#710](https://github.com/Autonoma-AI/agent/issues/710)) ([5586e84](https://github.com/Autonoma-AI/agent/commit/5586e841da2f42798ab95f5a37002cab4a085e08))
* **webhook:** increase discover/up timeout from 30s to 90s ([#681](https://github.com/Autonoma-AI/agent/issues/681)) ([97802f5](https://github.com/Autonoma-AI/agent/commit/97802f598cc399d939146246686e3874caf79d86))
* **worker-diffs:** reduce max concurrent activity executions to 1 ([#664](https://github.com/Autonoma-AI/agent/issues/664)) ([1e3d492](https://github.com/Autonoma-AI/agent/commit/1e3d49223c2eb637c508a463e780fb2235dd4673))


### Reverts

* **deployment:** restore original web worker memory limits ([#658](https://github.com/Autonoma-AI/agent/issues/658)) ([8d4f621](https://github.com/Autonoma-AI/agent/commit/8d4f6215da164ae751782f43d4b40d729f5250ec))
* **ui:** remove chunk artifacts upload strategy ([a76bf06](https://github.com/Autonoma-AI/agent/commit/a76bf0600b1e1853854901ee54cc00cc03338a8c))

## 1.0.0 (2026-05-19)


### Features

* @autonoma/diffs planner ([#216](https://github.com/Autonoma-AI/agent/issues/216)) ([d23f6cd](https://github.com/Autonoma-AI/agent/commit/d23f6cd83a83ab1e51a4c85809259464f0f873b3))
* add admin promo codes UI ([#346](https://github.com/Autonoma-AI/agent/issues/346)) ([716c00b](https://github.com/Autonoma-AI/agent/commit/716c00b0fa7dd0a3bad16c592c53a92f6dca0b20))
* add AI cost tracking system ([#161](https://github.com/Autonoma-AI/agent/issues/161)) ([1e02c71](https://github.com/Autonoma-AI/agent/commit/1e02c714b96db151e786d48244f512d150e3801b))
* add alb for access prometheus from grafana ([#410](https://github.com/Autonoma-AI/agent/issues/410)) ([23c439d](https://github.com/Autonoma-AI/agent/commit/23c439dba580686dee0e723d0ede0dea8419ddb2))
* add animated plan viewer to generation detail page ([#84](https://github.com/Autonoma-AI/agent/issues/84)) ([1f2cdf3](https://github.com/Autonoma-AI/agent/commit/1f2cdf387de1bffcb422a18ab5609335ba622c4f))
* add app prompt settings ([#174](https://github.com/Autonoma-AI/agent/issues/174)) ([cbaf92b](https://github.com/Autonoma-AI/agent/commit/cbaf92b98ca90147a871ddcddcf1ac7f74715ec9))
* add arrow key navigation to step image previews ([#187](https://github.com/Autonoma-AI/agent/issues/187)) ([4df1883](https://github.com/Autonoma-AI/agent/commit/4df18839c16c89ea5d4bbed9d0dde264168ee0cd))
* add beta banner and feedback survey ([#331](https://github.com/Autonoma-AI/agent/issues/331)) ([6fba579](https://github.com/Autonoma-AI/agent/commit/6fba57995cbdbf760346f743b42f90ba502beef0))
* add bug tracking entity with semantic matching ([#302](https://github.com/Autonoma-AI/agent/issues/302)) ([db2af75](https://github.com/Autonoma-AI/agent/commit/db2af75834e02d939ebd84a3bcdf187940975376))
* add clickable heading anchor links in docs ([#214](https://github.com/Autonoma-AI/agent/issues/214)) ([e9c351d](https://github.com/Autonoma-AI/agent/commit/e9c351d89b6667b3e16c71370f4a67af7429338b))
* Add cost tracking and breakdown to mobile test execution ([#228](https://github.com/Autonoma-AI/agent/issues/228)) ([c0c4618](https://github.com/Autonoma-AI/agent/commit/c0c4618e709042e3fc4d740e7dd2d8361ffaba51))
* add create application dialog to frontend ([#115](https://github.com/Autonoma-AI/agent/issues/115)) ([115fa7b](https://github.com/Autonoma-AI/agent/commit/115fa7bd53e283fa23d237096184a6cf3cab7534))
* add cronjob dump db, use dump on alpha build ([#198](https://github.com/Autonoma-AI/agent/issues/198)) ([6dacb5a](https://github.com/Autonoma-AI/agent/commit/6dacb5a20083b769a81bf4504899f12fafc416d8))
* add dedicated diffs worker and task queue ([#518](https://github.com/Autonoma-AI/agent/issues/518)) ([aa589b9](https://github.com/Autonoma-AI/agent/commit/aa589b9a7718bc810ec9d0c564f42796275da89e))
* add drag command for element drag-and-drop interactions ([#109](https://github.com/Autonoma-AI/agent/issues/109)) ([993696a](https://github.com/Autonoma-AI/agent/commit/993696a7d0e54d08ef09159ada4badfd1eb06a58))
* add dry run button to scenarios table ([#403](https://github.com/Autonoma-AI/agent/issues/403)) ([0a274c7](https://github.com/Autonoma-AI/agent/commit/0a274c771c75d1e3563114ced4e86571829d40e9))
* Add E2E Test Planner documentation and Claude Code skill ([#140](https://github.com/Autonoma-AI/agent/issues/140)) ([467b29f](https://github.com/Autonoma-AI/agent/commit/467b29ffe2170c00773df26acde4ba5abeb54028))
* add emulator package ([#193](https://github.com/Autonoma-AI/agent/issues/193)) ([0fffaa9](https://github.com/Autonoma-AI/agent/commit/0fffaa9eb5c60d3958c24a4e56dea3dca273f2ac))
* add execution agent memory system ([#139](https://github.com/Autonoma-AI/agent/issues/139)) ([4648e74](https://github.com/Autonoma-AI/agent/commit/4648e74b1289c367c1bf4bbb7ddb31d751288d91))
* add execution-agent-web build and deploy ([#162](https://github.com/Autonoma-AI/agent/issues/162)) ([e95f935](https://github.com/Autonoma-AI/agent/commit/e95f935a52f15a965c005725bf89ca7855b0cc46))
* add fatal logging for critical workflow/job failures ([#309](https://github.com/Autonoma-AI/agent/issues/309)) ([a7a4df3](https://github.com/Autonoma-AI/agent/commit/a7a4df32fd1f8448bc0a09de3a41ea69722902b2))
* add generation in-progress banner and progress page ([#333](https://github.com/Autonoma-AI/agent/issues/333)) ([706b1d5](https://github.com/Autonoma-AI/agent/commit/706b1d5db0210c54aaaebbe2ce682fe4fa157e1b))
* add generation-reviewer ([#252](https://github.com/Autonoma-AI/agent/issues/252)) ([7f7f4e8](https://github.com/Autonoma-AI/agent/commit/7f7f4e8d5b579afbc3bd2a69ade5e04f33bf4f50))
* add GET /setups/:id/existing-tests endpoint for ad hoc test planner ([#476](https://github.com/Autonoma-AI/agent/issues/476)) ([12ec6f8](https://github.com/Autonoma-AI/agent/commit/12ec6f82d8645ce7ed4c098fa24722d7f84f5f56))
* add GH API deployment status for alpha/beta envs ([#152](https://github.com/Autonoma-AI/agent/issues/152)) ([cba0062](https://github.com/Autonoma-AI/agent/commit/cba0062c1be1f80a78e6934501798eb4d286890d))
* add Github release + blue-green deployment strategy ([#398](https://github.com/Autonoma-AI/agent/issues/398)) ([2d8f521](https://github.com/Autonoma-AI/agent/commit/2d8f521f5be57dbd09df5aa43f514504005e7357))
* add hover command to execution agent ([#195](https://github.com/Autonoma-AI/agent/issues/195)) ([3612d3a](https://github.com/Autonoma-AI/agent/commit/3612d3a006e0482aa9e694bdfe5f45733db3c82b))
* add loading spinner and error toast to login button ([#336](https://github.com/Autonoma-AI/agent/issues/336)) ([b0d7eaf](https://github.com/Autonoma-AI/agent/commit/b0d7eaf2e1bef85dd8186993e7c5ced693cc9723))
* add migration job ([#160](https://github.com/Autonoma-AI/agent/issues/160)) ([17e6727](https://github.com/Autonoma-AI/agent/commit/17e6727b5c64aa848154fe54f7d6170b2856f432))
* add new UI components and documentation ([#241](https://github.com/Autonoma-AI/agent/issues/241)) ([37e24f2](https://github.com/Autonoma-AI/agent/commit/37e24f2f5adb143158f9046ef5682b8da1e3b753))
* add node class and node pool for agent web pod ([#93](https://github.com/Autonoma-AI/agent/issues/93)) ([12d5570](https://github.com/Autonoma-AI/agent/commit/12d557083837fe16b54091e17ae3e7dcc0670e98))
* add open-source files and guides ([#278](https://github.com/Autonoma-AI/agent/issues/278)) ([4221563](https://github.com/Autonoma-AI/agent/commit/4221563dc473db4d1183de0771d5717d46e1a40b))
* add packageName column to MobileDeployment model ([#259](https://github.com/Autonoma-AI/agent/issues/259)) ([3431991](https://github.com/Autonoma-AI/agent/commit/34319913d287a7571f117364c1a63a290214d832))
* add packages and apps README.md files ([#304](https://github.com/Autonoma-AI/agent/issues/304)) ([ec56d64](https://github.com/Autonoma-AI/agent/commit/ec56d640f3b7bdfd7a70c46ca83565b5851255e8))
* add postgres workflow docker build ([#355](https://github.com/Autonoma-AI/agent/issues/355)) ([a506728](https://github.com/Autonoma-AI/agent/commit/a5067286c65708a6036e7e54792e549b0be49dcd))
* add posthog autocapture labels ([#301](https://github.com/Autonoma-AI/agent/issues/301)) ([0a30df5](https://github.com/Autonoma-AI/agent/commit/0a30df5109f9308246a2913e1b757d289ae1314e))
* add PostHog purchase events for billing ([#380](https://github.com/Autonoma-AI/agent/issues/380)) ([19aba5b](https://github.com/Autonoma-AI/agent/commit/19aba5bcb3d60f004388a036fb3a14fbe3656346))
* add preview environment onboarding notice ([#499](https://github.com/Autonoma-AI/agent/issues/499)) ([9183e05](https://github.com/Autonoma-AI/agent/commit/9183e059572e06a55c83b51022f9582ca9ed7f93))
* add previewkit app ([#467](https://github.com/Autonoma-AI/agent/issues/467)) ([d7a31bf](https://github.com/Autonoma-AI/agent/commit/d7a31bf1c1061beacc153ccdde4b34c32204782d))
* add Prisma auto-instrumentation to Sentry ([#337](https://github.com/Autonoma-AI/agent/issues/337)) ([4aa7b87](https://github.com/Autonoma-AI/agent/commit/4aa7b873380b3f02e49df7d8bf2a1f585e186d1e))
* add rbac for k8s permissions, change node selector for pod crea… ([#89](https://github.com/Autonoma-AI/agent/issues/89)) ([597fc28](https://github.com/Autonoma-AI/agent/commit/597fc289c54446b1afdf2f771bc38f7d6d87afbf))
* add recipe viewer/editor for admin users on scenarios tab ([#587](https://github.com/Autonoma-AI/agent/issues/587)) ([9bfd016](https://github.com/Autonoma-AI/agent/commit/9bfd0163813e61718ffb2dbc51737481ea11c91e))
* add reload plugins step and don't-close-tab warnings ([#344](https://github.com/Autonoma-AI/agent/issues/344)) ([ee90155](https://github.com/Autonoma-AI/agent/commit/ee90155ddbba9e32d8c490bffc8c023d75037375))
* add replay reviewer for failed run analysis ([#287](https://github.com/Autonoma-AI/agent/issues/287)) ([0db6c5f](https://github.com/Autonoma-AI/agent/commit/0db6c5f1216dd387c6bb82bec63fc80299b867c3))
* add runs api, changes over engine ([#212](https://github.com/Autonoma-AI/agent/issues/212)) ([0c38990](https://github.com/Autonoma-AI/agent/commit/0c389902c956f2a5c64a9d68d88d22a35d6661f5))
* add scenario endpoint test runners ([#176](https://github.com/Autonoma-AI/agent/issues/176)) ([af44efd](https://github.com/Autonoma-AI/agent/commit/af44efdd4473c6e1639f65382f815a77dac9c650))
* add scenario observability and per-service Sentry DSN routing ([#475](https://github.com/Autonoma-AI/agent/issues/475)) ([04d0c36](https://github.com/Autonoma-AI/agent/commit/04d0c3683f2b4e817c6dd8bf82ef83362eb69b45))
* add scenario setup/teardown backend for E2E test isolation ([#118](https://github.com/Autonoma-AI/agent/issues/118)) ([272878b](https://github.com/Autonoma-AI/agent/commit/272878b8d482243363ddf2e658dd9a392b4d0a3c))
* add secret service for previewkit deployments ([#589](https://github.com/Autonoma-AI/agent/issues/589)) ([1113d6b](https://github.com/Autonoma-AI/agent/commit/1113d6b08e7b3b3661b09ccba2465a1b3d56dc73))
* add sentry tags to API requests ([#149](https://github.com/Autonoma-AI/agent/issues/149)) ([b7f22f0](https://github.com/Autonoma-AI/agent/commit/b7f22f08aca120a914794242b41f9a38f436a7df))
* add service worker caching, suspense skeletons, and UI polish ([#234](https://github.com/Autonoma-AI/agent/issues/234)) ([ce36942](https://github.com/Autonoma-AI/agent/commit/ce369425e31c59dab82754406c773c88e3d80ac4))
* add skill resolver tool for test sub-flows ([#116](https://github.com/Autonoma-AI/agent/issues/116)) ([bd9483a](https://github.com/Autonoma-AI/agent/commit/bd9483a48900dc2f962c96a0d450e8a8d4c9a269))
* add skills support for test generation ([#163](https://github.com/Autonoma-AI/agent/issues/163)) ([d11cc10](https://github.com/Autonoma-AI/agent/commit/d11cc1074b5b114f46afe0212f86129a640bc2ea))
* add soft-delete for applications ([#395](https://github.com/Autonoma-AI/agent/issues/395)) ([017d64f](https://github.com/Autonoma-AI/agent/commit/017d64fa2cd8b526f8f33d643bcb71b05c011f8c))
* add stripe credits system (webhooks, metering, auto top-up) ([#232](https://github.com/Autonoma-AI/agent/issues/232)) ([3a93b43](https://github.com/Autonoma-AI/agent/commit/3a93b430f4d553833d8b5c60dcbde134068e3ac0))
* add talk to support button in onboarding and app selector ([#335](https://github.com/Autonoma-AI/agent/issues/335)) ([0e229e3](https://github.com/Autonoma-AI/agent/commit/0e229e34c44dd4d4458dfe5c0698b3b4655b9b10))
* add temporal alert rules ([#551](https://github.com/Autonoma-AI/agent/issues/551)) ([78651e1](https://github.com/Autonoma-AI/agent/commit/78651e1d390b9e444a3ab10d54825f3393b20d4a))
* add test-scenario.sh script and improve Environment Factory docs ([#190](https://github.com/Autonoma-AI/agent/issues/190)) ([6f58a44](https://github.com/Autonoma-AI/agent/commit/6f58a44d2b5b50d6e05b087297c7a8737b0442b5))
* add UI support for navigate step type ([#584](https://github.com/Autonoma-AI/agent/issues/584)) ([1d117a8](https://github.com/Autonoma-AI/agent/commit/1d117a8ef4235a0baf0fa0c9a9125d373703aaf9))
* add upgrade button to sidebar for unsubscribed users ([#341](https://github.com/Autonoma-AI/agent/issues/341)) ([20593c2](https://github.com/Autonoma-AI/agent/commit/20593c29d113b589ab5fd800b01397d646f23504))
* add upload application endpoint and ui ([#311](https://github.com/Autonoma-AI/agent/issues/311)) ([6d72719](https://github.com/Autonoma-AI/agent/commit/6d72719afe61a4201776d92a05c712e9db073078))
* add user role column ([#284](https://github.com/Autonoma-AI/agent/issues/284)) ([9368add](https://github.com/Autonoma-AI/agent/commit/9368add83433b7e93edd2cc4b134306d36691bbb))
* added refresh feature ([#95](https://github.com/Autonoma-AI/agent/issues/95)) ([520ca78](https://github.com/Autonoma-AI/agent/commit/520ca784d3ae31b499ba63124af7d65d0b1bca0a))
* added some workspace config ([#90](https://github.com/Autonoma-AI/agent/issues/90)) ([fe9e1c4](https://github.com/Autonoma-AI/agent/commit/fe9e1c41a5eade913554a25a62b9d5a44a71df4d))
* added wait condition for first step ([#560](https://github.com/Autonoma-AI/agent/issues/560)) ([35ba915](https://github.com/Autonoma-AI/agent/commit/35ba915a4eb95c2b1ce57815796e4b1642b409c2))
* **ai:** add request timeout to all AI provider calls ([#614](https://github.com/Autonoma-AI/agent/issues/614)) ([72e963f](https://github.com/Autonoma-AI/agent/commit/72e963f2bce34d2106a4d483c28047d94479ab00))
* allow alpha origin ([#125](https://github.com/Autonoma-AI/agent/issues/125)) ([d582353](https://github.com/Autonoma-AI/agent/commit/d58235329b46f30f055ea8225e0c88f1eab559ae))
* allow alpha origin cors ([#126](https://github.com/Autonoma-AI/agent/issues/126)) ([fb06a71](https://github.com/Autonoma-AI/agent/commit/fb06a71f5427e050cc5b49d9e1a4734d9c8e50df))
* allow generating from existing test cases ([#178](https://github.com/Autonoma-AI/agent/issues/178)) ([4ef4897](https://github.com/Autonoma-AI/agent/commit/4ef4897b485523ab0f7b96aa147e146b469bb288))
* allow persona emails, create orgs with approved status ([#343](https://github.com/Autonoma-AI/agent/issues/343)) ([114765e](https://github.com/Autonoma-AI/agent/commit/114765e5135e86b6822903019b627927982de6ac))
* **api:** add github webhook event handling ([#559](https://github.com/Autonoma-AI/agent/issues/559)) ([00440a3](https://github.com/Autonoma-AI/agent/commit/00440a3ccfc60fb2bd128e06b5cd5dc6fb977e48))
* apply image version and default to latest beta ([#136](https://github.com/Autonoma-AI/agent/issues/136)) ([afc054e](https://github.com/Autonoma-AI/agent/commit/afc054e4db41d0494f14adcbafe433866e1a2d64))
* argo server ([#123](https://github.com/Autonoma-AI/agent/issues/123)) ([cddebdc](https://github.com/Autonoma-AI/agent/commit/cddebdc3feb751865c0059baa7f96e16c147e54e))
* auto-onboarding signup hooks ([#349](https://github.com/Autonoma-AI/agent/issues/349)) ([ae6ce6d](https://github.com/Autonoma-AI/agent/commit/ae6ce6d4aca41b3727383943bcf940749965bba0))
* auto-trigger reviews on failed generation/replay runs ([#317](https://github.com/Autonoma-AI/agent/issues/317)) ([20c539e](https://github.com/Autonoma-AI/agent/commit/20c539ede7c7c11c379ec00ad346ebdf2a248617))
* blacklight ([#201](https://github.com/Autonoma-AI/agent/issues/201)) ([5b5d101](https://github.com/Autonoma-AI/agent/commit/5b5d10146e6f3774fa61ea4f20a8e9b84473387b))
* block mobile users with desktop-only message ([#377](https://github.com/Autonoma-AI/agent/issues/377)) ([e6e730d](https://github.com/Autonoma-AI/agent/commit/e6e730d34839f31d3f507bee48b265e5fd30bbc7))
* build and deploy backend repos together with frontend ([#618](https://github.com/Autonoma-AI/agent/issues/618)) ([7a35e99](https://github.com/Autonoma-AI/agent/commit/7a35e9924599e9df958fbc71f7bb801b2e6305c6))
* build scenario beta image, trigger build ([#194](https://github.com/Autonoma-AI/agent/issues/194)) ([8d1243f](https://github.com/Autonoma-AI/agent/commit/8d1243f23cf3ffa34bbd64757285fee50d196978))
* build worker web on arm ([#508](https://github.com/Autonoma-AI/agent/issues/508)) ([e396659](https://github.com/Autonoma-AI/agent/commit/e3966591a30396a54d4289de3641d1dd56ba2128))
* collapsible code block for onboarding install command ([#424](https://github.com/Autonoma-AI/agent/issues/424)) ([b172a7b](https://github.com/Autonoma-AI/agent/commit/b172a7bed299d3520ad3810a245d66c4b84fa182))
* compose postgres and redis ([#156](https://github.com/Autonoma-AI/agent/issues/156)) ([438fa0b](https://github.com/Autonoma-AI/agent/commit/438fa0b93c35c019c0ba09533fa66e6a098d324d))
* create alpha temporal namespace for each alpha deployment ([#500](https://github.com/Autonoma-AI/agent/issues/500)) ([1f7d51f](https://github.com/Autonoma-AI/agent/commit/1f7d51f546f74f7afe50a17886941ecd4cc7ed0e))
* **db:** add previewkit database models ([#556](https://github.com/Autonoma-AI/agent/issues/556)) ([c17c893](https://github.com/Autonoma-AI/agent/commit/c17c8937f81d507c01f252e27888631b76fe33c6))
* **deployments:** preview envs and details pages ([#539](https://github.com/Autonoma-AI/agent/issues/539)) ([6c358db](https://github.com/Autonoma-AI/agent/commit/6c358dbc97e8df3c7510486f1a8e7ab104f1c406))
* diff job information in snapshot UI page ([#577](https://github.com/Autonoma-AI/agent/issues/577)) ([dbb3980](https://github.com/Autonoma-AI/agent/commit/dbb39804b65619e03e414c6e13a6feaa7e42f888))
* diffs to test end-to-end ([#272](https://github.com/Autonoma-AI/agent/issues/272)) ([1dc66ef](https://github.com/Autonoma-AI/agent/commit/1dc66ef77226e15f21402d33e8fe0d6af16b8685))
* **diffs:** implement Phase 1 merge-matrix shortcut ([#512](https://github.com/Autonoma-AI/agent/issues/512)) ([e11ff88](https://github.com/Autonoma-AI/agent/commit/e11ff8864c45c2918768a6f93950c699b00ec41f))
* disable upgrade button when user is already subscribed ([#350](https://github.com/Autonoma-AI/agent/issues/350)) ([34d1279](https://github.com/Autonoma-AI/agent/commit/34d1279b812c15f9031d591487d56ea27dffe685))
* discovery as first-class node in onboarding state machine ([#521](https://github.com/Autonoma-AI/agent/issues/521)) ([00315ed](https://github.com/Autonoma-AI/agent/commit/00315ed0d088b64b1aaafa303d7247eb45573ced))
* documentation ([#117](https://github.com/Autonoma-AI/agent/issues/117)) ([ecd03cb](https://github.com/Autonoma-AI/agent/commit/ecd03cb7252a337f0d0d0a7d0999e18036d5c115))
* enforce one promo redemption per org ([#323](https://github.com/Autonoma-AI/agent/issues/323)) ([f89ce2f](https://github.com/Autonoma-AI/agent/commit/f89ce2fb4520264c5c685ccce8f7c07fab00e765))
* enforce TestCaseQuarantine on generation, runs, and diffs ([#603](https://github.com/Autonoma-AI/agent/issues/603)) ([c8fe75b](https://github.com/Autonoma-AI/agent/commit/c8fe75b8bbd468bec57b6597cdd44ec09439d830))
* enhance drag annotation ([#202](https://github.com/Autonoma-AI/agent/issues/202)) ([aaa74cb](https://github.com/Autonoma-AI/agent/commit/aaa74cbbb25370a52597a7603c76b75e646b8201))
* enhance llms txt ([#138](https://github.com/Autonoma-AI/agent/issues/138)) ([526d9ea](https://github.com/Autonoma-AI/agent/commit/526d9eaf2292a1e1214df4b788aaeecb44e734d8))
* env validation ([#114](https://github.com/Autonoma-AI/agent/issues/114)) ([d36dabc](https://github.com/Autonoma-AI/agent/commit/d36dabc3854d08bd5eecbcd23340acf0747887c2))
* file upload implementation ([#159](https://github.com/Autonoma-AI/agent/issues/159)) ([9466c88](https://github.com/Autonoma-AI/agent/commit/9466c883d6a54f986ca262d8b1f41282623e275e))
* finished UI changes & nits for launch ([#286](https://github.com/Autonoma-AI/agent/issues/286)) ([5928ef2](https://github.com/Autonoma-AI/agent/commit/5928ef2b1c10d5b7925d6b841aea2d696bfafef0))
* freemium provisioning ([#312](https://github.com/Autonoma-AI/agent/issues/312)) ([c2e0ed4](https://github.com/Autonoma-AI/agent/commit/c2e0ed45bfad6115caaaa09b318b45294ef160ff))
* full iOS test support ([#206](https://github.com/Autonoma-AI/agent/issues/206)) ([17af57c](https://github.com/Autonoma-AI/agent/commit/17af57c4203b3263b75accb9e4da44464d7c2549))
* gh integration ([#143](https://github.com/Autonoma-AI/agent/issues/143)) ([9f51396](https://github.com/Autonoma-AI/agent/commit/9f51396ae54be9e3482a28b93fe991810882fd48))
* GitHub app per alpha ([#432](https://github.com/Autonoma-AI/agent/issues/432)) ([d063206](https://github.com/Autonoma-AI/agent/commit/d063206b48169b3308c19c1c327b2c22577f9999))
* GitHub integration for diffs pipeline ([#378](https://github.com/Autonoma-AI/agent/issues/378)) ([af2204b](https://github.com/Autonoma-AI/agent/commit/af2204be8c64f1bfe6e87e210b37651b96e2837a))
* **github:** PullRequest merge metadata + associated PRs helper ([#507](https://github.com/Autonoma-AI/agent/issues/507)) ([2e42290](https://github.com/Autonoma-AI/agent/commit/2e422906c78416198eb32f9155180b6fea503ec1))
* HealingAgent + refinement loop ([#580](https://github.com/Autonoma-AI/agent/issues/580)) ([adb15b0](https://github.com/Autonoma-AI/agent/commit/adb15b078622a4e8cea261164bac9dd882f5ac64))
* home and UI nits ([#99](https://github.com/Autonoma-AI/agent/issues/99)) ([1656c31](https://github.com/Autonoma-AI/agent/commit/1656c319ee9fed6b28408a84a0720dc0c7fe200c))
* hybrid repository ([#501](https://github.com/Autonoma-AI/agent/issues/501)) ([9b8a749](https://github.com/Autonoma-AI/agent/commit/9b8a749e3dc20c362b683fb6bbceb5fd1932e2c5))
* implement upload skills dialog ([#230](https://github.com/Autonoma-AI/agent/issues/230)) ([0d94e57](https://github.com/Autonoma-AI/agent/commit/0d94e575a05d0410b1e2288908f668a897a523ba))
* improve generation review ([#119](https://github.com/Autonoma-AI/agent/issues/119)) ([170d8d5](https://github.com/Autonoma-AI/agent/commit/170d8d57ed71b12626936f5bf335498cb495904b))
* improve instant dns for new alphas ([#130](https://github.com/Autonoma-AI/agent/issues/130)) ([ba08426](https://github.com/Autonoma-AI/agent/commit/ba084261332523985af976ba9fd4fb0ee1ae9687))
* improve logging, network idle to wait, use smart visual for wait ([#274](https://github.com/Autonoma-AI/agent/issues/274)) ([32954a1](https://github.com/Autonoma-AI/agent/commit/32954a1b1f5965f8ec1c2f14d74c897db8835958))
* increase worker job TTL to 24h for debugging ([#583](https://github.com/Autonoma-AI/agent/issues/583)) ([cfb1e2a](https://github.com/Autonoma-AI/agent/commit/cfb1e2a005931dc1a9784e33c2046b725bc0ff60))
* install git on general worker image for diff activity ([#470](https://github.com/Autonoma-AI/agent/issues/470)) ([e65bfab](https://github.com/Autonoma-AI/agent/commit/e65bfab33d2b077731491be51ef8bab3ec2f3291))
* integrate bug tracking into UI with updated charts and metrics ([#313](https://github.com/Autonoma-AI/agent/issues/313)) ([96cc41b](https://github.com/Autonoma-AI/agent/commit/96cc41b7e2db393ff32dabd2358152e520dff23e))
* **keda:** remove maxReplicaCount limit for web and mobile jobs ([#612](https://github.com/Autonoma-AI/agent/issues/612)) ([6ce6b27](https://github.com/Autonoma-AI/agent/commit/6ce6b27227cc6e8ff7a45e2eb5aacc938f7592e0))
* link diffs candidates to created tests by id ([#617](https://github.com/Autonoma-AI/agent/issues/617)) ([6329e85](https://github.com/Autonoma-AI/agent/commit/6329e856be4a0cfb804c5d17e8f863de41ed38ad))
* migrate from Argo Workflows to Temporal ([#381](https://github.com/Autonoma-AI/agent/issues/381)) ([de35047](https://github.com/Autonoma-AI/agent/commit/de35047d2e1d2cc759c168ce6820367635261f73))
* migrate from biome to oxfmt + oxlint ([#303](https://github.com/Autonoma-AI/agent/issues/303)) ([5d701eb](https://github.com/Autonoma-AI/agent/commit/5d701eb0ab7ae7b70b07fdac79fbc9be6c3b6aa4))
* migrate toasts to blacklight and add mutation toasts ([#308](https://github.com/Autonoma-AI/agent/issues/308)) ([8be4040](https://github.com/Autonoma-AI/agent/commit/8be404028ea93a30ec521d3907976cad64176d62))
* migrate web and mobile workers to KEDA ScaledJob ([#578](https://github.com/Autonoma-AI/agent/issues/578)) ([ca8b5a1](https://github.com/Autonoma-AI/agent/commit/ca8b5a1fd657e531ab193e3d01728752e236a100))
* migration to blacklight + onboarding + some new ui components ([#208](https://github.com/Autonoma-AI/agent/issues/208)) ([89c04cb](https://github.com/Autonoma-AI/agent/commit/89c04cb3bbce88cbd4343a0b09935f53c09ac39b))
* milestones ([#418](https://github.com/Autonoma-AI/agent/issues/418)) ([e4fb168](https://github.com/Autonoma-AI/agent/commit/e4fb1686a53d5f72663871e4bab9c4ba2d31282b))
* missing migrations from schema ([#148](https://github.com/Autonoma-AI/agent/issues/148)) ([f78a375](https://github.com/Autonoma-AI/agent/commit/f78a3753a1bf60df8dd4851e45fd4a5b07f4026f))
* mobile agent + replay engine ([#40](https://github.com/Autonoma-AI/agent/issues/40)) ([10723cb](https://github.com/Autonoma-AI/agent/commit/10723cb03e8c59941c06f2d8c521a8f5c4c134e4))
* modify nginx for ui, add build for alpha ([#124](https://github.com/Autonoma-AI/agent/issues/124)) ([50640ef](https://github.com/Autonoma-AI/agent/commit/50640efff519730b5f99c5ae25dc70b1876a03cd))
* navigate. need to test it ([#581](https://github.com/Autonoma-AI/agent/issues/581)) ([0956e5a](https://github.com/Autonoma-AI/agent/commit/0956e5ad1f0dc22404b497a5d7013d168630f08e))
* new braille loadings indicator ([#450](https://github.com/Autonoma-AI/agent/issues/450)) ([c2568d6](https://github.com/Autonoma-AI/agent/commit/c2568d65aa44960f9197a77ea6f61d921ad8c322))
* new integration-test package ([#177](https://github.com/Autonoma-AI/agent/issues/177)) ([840760a](https://github.com/Autonoma-AI/agent/commit/840760aba13c20b31ff8ebf94286dfbeb7dcac45))
* onboarding application ([#270](https://github.com/Autonoma-AI/agent/issues/270)) ([24ba6bc](https://github.com/Autonoma-AI/agent/commit/24ba6bc6bae1d1935bd0a4cc92c87a05a1b9bbbf))
* onboarding deploy UX and migrate appId to URL params ([#425](https://github.com/Autonoma-AI/agent/issues/425)) ([a9cb693](https://github.com/Autonoma-AI/agent/commit/a9cb693513b4f36b561a77216c30bd50ea7d93ea))
* onboarding v2 ([#391](https://github.com/Autonoma-AI/agent/issues/391)) ([5d56360](https://github.com/Autonoma-AI/agent/commit/5d5636036e84cdb5d56e0049b4d94f6e75521178))
* pass scenario-up auth output to run-generation ([#189](https://github.com/Autonoma-AI/agent/issues/189)) ([857899b](https://github.com/Autonoma-AI/agent/commit/857899b68764909fb63e1ff1105c31a74a9f7cbb))
* pass search labels to workflow ([#465](https://github.com/Autonoma-AI/agent/issues/465)) ([823a9f8](https://github.com/Autonoma-AI/agent/commit/823a9f88ea5e66859af3438570b40b85a82cefed))
* persist diffs job state to the database ([#562](https://github.com/Autonoma-AI/agent/issues/562)) ([88cbec9](https://github.com/Autonoma-AI/agent/commit/88cbec97243e74b68934736cc68d2bb8bc9598b4))
* photo upload implementation ([#175](https://github.com/Autonoma-AI/agent/issues/175)) ([28bfa89](https://github.com/Autonoma-AI/agent/commit/28bfa8989bd9abdbf516d2788c8a81652606f830))
* plugin integrates sdk ([#444](https://github.com/Autonoma-AI/agent/issues/444)) ([9d71d9f](https://github.com/Autonoma-AI/agent/commit/9d71d9fc6081c6e48516757f770c3e1cf809e32a))
* plumb affectedReason through diff workflow ([#506](https://github.com/Autonoma-AI/agent/issues/506)) ([de4eb34](https://github.com/Autonoma-AI/agent/commit/de4eb344bcb0d0c9de545d147e71d161d55c15dc))
* **pond-ui:** import config pond-ui Storybook from v0 ([#63](https://github.com/Autonoma-AI/agent/issues/63)) ([ab92726](https://github.com/Autonoma-AI/agent/commit/ab92726ee8fbc73e6815829d4b23388e565a97b4))
* PostHog cross-domain tracking from getautonoma.com ([#352](https://github.com/Autonoma-AI/agent/issues/352)) ([005c91e](https://github.com/Autonoma-AI/agent/commit/005c91e58a3b86f402dea83d7abfaf75114ad63e))
* **pr-page:** enhanced visuals & dropdown nit ([#520](https://github.com/Autonoma-AI/agent/issues/520)) ([04e1b70](https://github.com/Autonoma-AI/agent/commit/04e1b70302c65fdc9658387d833743e6bd05445a))
* **previewkit:** add api gateway recipe ([#532](https://github.com/Autonoma-AI/agent/issues/532)) ([2c8b00a](https://github.com/Autonoma-AI/agent/commit/2c8b00a3c2bf7967d0ae2bd96e21214754635a8b))
* **previewkit:** add branch_convention to multirepo config (same_branch_name, regex, manual) ([#624](https://github.com/Autonoma-AI/agent/issues/624)) ([f38693c](https://github.com/Autonoma-AI/agent/commit/f38693ca4b3f1758430d0b621d3dd4ebd4c1019b))
* **previewkit:** add build_secrets option to pass app secrets on build time ([62550ec](https://github.com/Autonoma-AI/agent/commit/62550ecca8669851a588650d3caa9fc5eab5e41a))
* **previewkit:** add cross cluster communication ([7d209ee](https://github.com/Autonoma-AI/agent/commit/7d209eeb68b3f0c94985d6a855e46dace5cb1ea1))
* **previewkit:** add env injector parsing to build args ([e4697ed](https://github.com/Autonoma-AI/agent/commit/e4697ed28be675af3c784724505049bac8350b4c))
* **previewkit:** add GITHUB_FEEDBACK_ENABLED column per organization ([d2e1a77](https://github.com/Autonoma-AI/agent/commit/d2e1a779664b65b359635c266de7f17572bc8f79))
* **previewkit:** add HTTProute to deployer ([#564](https://github.com/Autonoma-AI/agent/issues/564)) ([4f67e5e](https://github.com/Autonoma-AI/agent/commit/4f67e5e6374694b7b29e4bf69b0e0aa59823305c))
* **previewkit:** add preview schema configuration ([#515](https://github.com/Autonoma-AI/agent/issues/515)) ([727867c](https://github.com/Autonoma-AI/agent/commit/727867cfdbda9e208886a739b3c420e6222b1b28))
* **previewkit:** add previewkit logs to Sentry ([2d7d204](https://github.com/Autonoma-AI/agent/commit/2d7d204559ec5f345e97cd496b9ceb578e7b6782))
* **previewkit:** add s3 cache layer for buildctl ([#613](https://github.com/Autonoma-AI/agent/issues/613)) ([3dcc2b5](https://github.com/Autonoma-AI/agent/commit/3dcc2b56bfa91557eb0c2bf55ce1be6f211c2e87))
* **previewkit:** add valkey recipe ([#517](https://github.com/Autonoma-AI/agent/issues/517)) ([45a025e](https://github.com/Autonoma-AI/agent/commit/45a025e488545281fc67a237253831840b919bda))
* **previewkit:** deploy ordering via depends_on ([#600](https://github.com/Autonoma-AI/agent/issues/600)) ([56d5e5a](https://github.com/Autonoma-AI/agent/commit/56d5e5a26f4280b5e31cdcc66b45e917a1e0e17e))
* **previewkit:** handle github pull_request webhook events ([#590](https://github.com/Autonoma-AI/agent/issues/590)) ([48e1df1](https://github.com/Autonoma-AI/agent/commit/48e1df1a33a7f9a36532b7ad69336a6e290a3cd2))
* **previewkit:** isolate preview namespaces with network policies ([#558](https://github.com/Autonoma-AI/agent/issues/558)) ([ed0e709](https://github.com/Autonoma-AI/agent/commit/ed0e7096f020553897e830c75a9eee3789c01fe0))
* **previewkit:** replace manual git clone for octokit tarball ([#592](https://github.com/Autonoma-AI/agent/issues/592)) ([15b0ddd](https://github.com/Autonoma-AI/agent/commit/15b0ddd135319e58a6862db5851a76d860585997))
* **previewkit:** save namespace status change to database ([#568](https://github.com/Autonoma-AI/agent/issues/568)) ([861fb70](https://github.com/Autonoma-AI/agent/commit/861fb7050c9672fa43b973049338efe5a1e7028e))
* **previewkit:** upload build logs to S3 ([#602](https://github.com/Autonoma-AI/agent/issues/602)) ([651d755](https://github.com/Autonoma-AI/agent/commit/651d755542d31cac40b9e3c1bb80cf99bf5dd3b4))
* prometheus + alert manager ([#382](https://github.com/Autonoma-AI/agent/issues/382)) ([6eac2cf](https://github.com/Autonoma-AI/agent/commit/6eac2cf04a625d0a5eb9845c27538a85db219920))
* re-run and delete generation, and more nits and fixes  ([#239](https://github.com/Autonoma-AI/agent/issues/239)) ([c0b2fd6](https://github.com/Autonoma-AI/agent/commit/c0b2fd6c4183cc7c5d6ca01fbdb0ff910fdc34dc))
* re-run creates a new generation/run instead of mutating the old ([#565](https://github.com/Autonoma-AI/agent/issues/565)) ([ebc32b5](https://github.com/Autonoma-AI/agent/commit/ebc32b51d721b067a037d3b3c1926bc73f8a5a67))
* rebuild docs site with custom Blacklight UI theme ([#238](https://github.com/Autonoma-AI/agent/issues/238)) ([edefa31](https://github.com/Autonoma-AI/agent/commit/edefa3173461e49b4f786a0f67f8da4413edfffd))
* refactor diffs analysis into multi-step Temporal workflow ([#435](https://github.com/Autonoma-AI/agent/issues/435)) ([140e17f](https://github.com/Autonoma-AI/agent/commit/140e17fe0b4f87d9012a5f86981fb799f21567ba))
* register refresh command in web replay engine ([#561](https://github.com/Autonoma-AI/agent/issues/561)) ([737b242](https://github.com/Autonoma-AI/agent/commit/737b242cbdf383f12ddd00e5251a69381d0883e0))
* remove auth logging, add all api logging ([#96](https://github.com/Autonoma-AI/agent/issues/96)) ([e9d3012](https://github.com/Autonoma-AI/agent/commit/e9d3012d6e0f92fe2e67851c0b3eb460f2d39bc0))
* replay mobile ([#329](https://github.com/Autonoma-AI/agent/issues/329)) ([a325625](https://github.com/Autonoma-AI/agent/commit/a3256255dd5a83ca12f8a8ca68f322cb43ea4981))
* report bugs from diff resolution agent ([#498](https://github.com/Autonoma-AI/agent/issues/498)) ([c0fa5a6](https://github.com/Autonoma-AI/agent/commit/c0fa5a68c0d425c86c6e6389463761a60e2038b5))
* require folderId when creating test cases ([#436](https://github.com/Autonoma-AI/agent/issues/436)) ([1d9375e](https://github.com/Autonoma-AI/agent/commit/1d9375e51823d2e9f7b41f3191a0a8f673633f8e))
* restore conversation function and test ([#433](https://github.com/Autonoma-AI/agent/issues/433)) ([50b71b8](https://github.com/Autonoma-AI/agent/commit/50b71b81f5a48e12a568ebb49c6731f32b8ee976))
* restore db from s3 dump ([#211](https://github.com/Autonoma-AI/agent/issues/211)) ([4458480](https://github.com/Autonoma-AI/agent/commit/4458480d1a9464e5cda771d5c23a282b598bb5b5))
* rollback job web worker ([#572](https://github.com/Autonoma-AI/agent/issues/572)) ([6334fa5](https://github.com/Autonoma-AI/agent/commit/6334fa5c6ffce2e6d10f2530d76bae867654210f))
* rollback shutdown workers change ([#575](https://github.com/Autonoma-AI/agent/issues/575)) ([a45bd16](https://github.com/Autonoma-AI/agent/commit/a45bd166b189556dce836571f32d97010af667df))
* route PostHog events through API proxy to bypass ad blockers ([#389](https://github.com/Autonoma-AI/agent/issues/389)) ([741fb48](https://github.com/Autonoma-AI/agent/commit/741fb48f7e10af28db3c5fb6ffdb9ecadafa57e3))
* run detail - restart, delete, sentry logs, test link, failure r… ([#292](https://github.com/Autonoma-AI/agent/issues/292)) ([05cc0ac](https://github.com/Autonoma-AI/agent/commit/05cc0ac757813c4e9522343ff5f1c1524aafbb6a))
* runs page ([#285](https://github.com/Autonoma-AI/agent/issues/285)) ([f5caecd](https://github.com/Autonoma-AI/agent/commit/f5caecd78738f8e1f81964abeadf188d7f85bd6a))
* save replay videos in local diff pipeline ([#513](https://github.com/Autonoma-AI/agent/issues/513)) ([9857079](https://github.com/Autonoma-AI/agent/commit/9857079a8279949d7bf8e8f9d93067d9d341f68f))
* scale up faster keda workers ([#547](https://github.com/Autonoma-AI/agent/issues/547)) ([8fa5599](https://github.com/Autonoma-AI/agent/commit/8fa55993d7f3dd8fb677303e07b2035ac2aa1377))
* scenario dry run ([#362](https://github.com/Autonoma-AI/agent/issues/362)) ([170bdd4](https://github.com/Autonoma-AI/agent/commit/170bdd423eabfc0aeb9643411c6c5888dea3b4f7))
* scenario v2 + SDK flow ([#404](https://github.com/Autonoma-AI/agent/issues/404)) ([5812adb](https://github.com/Autonoma-AI/agent/commit/5812adb7ef905c679380694e1ea6e0b30188ec10))
* scenario-aware diff resolution agent ([#468](https://github.com/Autonoma-AI/agent/issues/468)) ([3708467](https://github.com/Autonoma-AI/agent/commit/370846764c8ddfec0b1725a146004b0928a70939))
* scenarios for replay runs, multiple DB model fixes ([#205](https://github.com/Autonoma-AI/agent/issues/205)) ([0a63ba2](https://github.com/Autonoma-AI/agent/commit/0a63ba2f10955b02f64ccf0dedca518defba74e0))
* script to generate multiple test generations ([#112](https://github.com/Autonoma-AI/agent/issues/112)) ([47cf994](https://github.com/Autonoma-AI/agent/commit/47cf9944aaf6746ba71f186ab5232d5fb44a3ae4))
* secret manager ([#484](https://github.com/Autonoma-AI/agent/issues/484)) ([3e45ab4](https://github.com/Autonoma-AI/agent/commit/3e45ab4b1d11796a4c0e0e0ebb8d5de2868a5f14))
* sentry flush + context ([#105](https://github.com/Autonoma-AI/agent/issues/105)) ([34a1cde](https://github.com/Autonoma-AI/agent/commit/34a1cde3a8a23ca081578132448d92977a6f2175))
* server-side platform_signup/platform_login classification ([#441](https://github.com/Autonoma-AI/agent/issues/441)) ([d6fccef](https://github.com/Autonoma-AI/agent/commit/d6fccef2d7cbf6ab9a7dac9888be0962ba724a25))
* set sentry env to filter on sentry, add more logging for workflows ([#171](https://github.com/Autonoma-AI/agent/issues/171)) ([a8d5e3a](https://github.com/Autonoma-AI/agent/commit/a8d5e3a5082888bd2b91e90eddf568f6d93142d3))
* share plan-authoring context with diffs and healing agents ([#627](https://github.com/Autonoma-AI/agent/issues/627)) ([3f18612](https://github.com/Autonoma-AI/agent/commit/3f18612dab1fae533f17892cd73b85eb3a971a00))
* show edit tests button in empty tests view ([#623](https://github.com/Autonoma-AI/agent/issues/623)) ([7d1e1b0](https://github.com/Autonoma-AI/agent/commit/7d1e1b0856beef04a6c94127573aaf096e4684c3))
* show incomplete onboarding apps in dropdown with continue setup ([#379](https://github.com/Autonoma-AI/agent/issues/379)) ([d986bd5](https://github.com/Autonoma-AI/agent/commit/d986bd579ff54d4ff56b436f9654f0a2acbecc33))
* show response body truncated in webhooks calls ([#293](https://github.com/Autonoma-AI/agent/issues/293)) ([5ead333](https://github.com/Autonoma-AI/agent/commit/5ead3333f04e94cbada2868dc73664b4ccd10f5d))
* simplify mobile installer creation ([#295](https://github.com/Autonoma-AI/agent/issues/295)) ([b3663c0](https://github.com/Autonoma-AI/agent/commit/b3663c050372674285e39ce0771d9941c1ed3299))
* snapshot pages for PR view ([#519](https://github.com/Autonoma-AI/agent/issues/519)) ([4ea9264](https://github.com/Autonoma-AI/agent/commit/4ea9264f99c830a70ac94360bdbfe1789448b749))
* snapshot update UI ([#251](https://github.com/Autonoma-AI/agent/issues/251)) ([bbc7b09](https://github.com/Autonoma-AI/agent/commit/bbc7b099d4866ec4b64e009dca5b9fadf26d801f))
* some improvements to test list page ([#294](https://github.com/Autonoma-AI/agent/issues/294)) ([608291b](https://github.com/Autonoma-AI/agent/commit/608291bbcc38aeef921759652da3a4c99c466db9))
* store diff conversations in S3 ([#574](https://github.com/Autonoma-AI/agent/issues/574)) ([d092bfc](https://github.com/Autonoma-AI/agent/commit/d092bfc4e08b051ab6c6d6a8c4bc32551980c72c))
* store generation conversations in S3 instead of database ([#273](https://github.com/Autonoma-AI/agent/issues/273)) ([04f0453](https://github.com/Autonoma-AI/agent/commit/04f04538942f04d2f6a7713cc64a33fc5959d04d))
* store session on db to allow switch org on alpha envs ([#137](https://github.com/Autonoma-AI/agent/issues/137)) ([4ea608e](https://github.com/Autonoma-AI/agent/commit/4ea608e4c58de7144219b1b7211d2e3fe61b8ff7))
* support multi tabs ([#268](https://github.com/Autonoma-AI/agent/issues/268)) ([86b6f3c](https://github.com/Autonoma-AI/agent/commit/86b6f3c86dc85d2aef79de9b8fb3fbfc97976112))
* support uploading skills with test cases in folder structure ([#172](https://github.com/Autonoma-AI/agent/issues/172)) ([d11c318](https://github.com/Autonoma-AI/agent/commit/d11c3185fe0afa96ce6b0aaa370702e8ca6745d5))
* support x/y coordinates in mobile scroll command ([#191](https://github.com/Autonoma-AI/agent/issues/191)) ([1b83024](https://github.com/Autonoma-AI/agent/commit/1b83024a21ce4e4d1af29e0b41331a7725b98f66))
* switch to FormData for file uploads ([#203](https://github.com/Autonoma-AI/agent/issues/203)) ([1e2675a](https://github.com/Autonoma-AI/agent/commit/1e2675acd3ce95936a26274b0de9af2c71ac1b15))
* tag tRPC requests with organizationId and per-RPC log line ([#631](https://github.com/Autonoma-AI/agent/issues/631)) ([c08e641](https://github.com/Autonoma-AI/agent/commit/c08e64102cdc5ceedd04bc9ff3b6dcc691eb1079))
* test and folder management ([#70](https://github.com/Autonoma-AI/agent/issues/70)) ([929c539](https://github.com/Autonoma-AI/agent/commit/929c539bc99117724fa9c5074bb215081e734eb8))
* test update package ([#229](https://github.com/Autonoma-AI/agent/issues/229)) ([c29417e](https://github.com/Autonoma-AI/agent/commit/c29417e78a01b09f320026f18f020f0c87cf0699))
* test versioning ([#153](https://github.com/Autonoma-AI/agent/issues/153)) ([1b74b09](https://github.com/Autonoma-AI/agent/commit/1b74b09c673501c9d5c8059949202615c7dcff9f))
* trigger actions on package.json change ([#88](https://github.com/Autonoma-AI/agent/issues/88)) ([3b52185](https://github.com/Autonoma-AI/agent/commit/3b521853f33926ad8f445951a142057fad68cfa8))
* trigger api build ([#166](https://github.com/Autonoma-AI/agent/issues/166)) ([2e77ba8](https://github.com/Autonoma-AI/agent/commit/2e77ba83dee29c50cc6cf7c0b34d82d4c6a44619))
* trigger worker web build ([#571](https://github.com/Autonoma-AI/agent/issues/571)) ([bfb3a7e](https://github.com/Autonoma-AI/agent/commit/bfb3a7e8ee93b6fae943cfc098ef2878b1f50d61))
* trpc sentry integration ([#101](https://github.com/Autonoma-AI/agent/issues/101)) ([a0abfd7](https://github.com/Autonoma-AI/agent/commit/a0abfd798f92b2cde2395bacfea69d60c37931f1))
* **ui:** add pull request detail and list pages ([#502](https://github.com/Autonoma-AI/agent/issues/502)) ([6a36d41](https://github.com/Autonoma-AI/agent/commit/6a36d419a38251f22e78174d07ed9156337c17ac))
* update scenarios documentation ([#154](https://github.com/Autonoma-AI/agent/issues/154)) ([94ea32a](https://github.com/Autonoma-AI/agent/commit/94ea32af58a9ae61e8e6514bb36e43c66962a583))
* upload multiple generations ([#111](https://github.com/Autonoma-AI/agent/issues/111)) ([4882692](https://github.com/Autonoma-AI/agent/commit/4882692897a13997f37378b918633fd258c9e25d))
* use credentials when received in scenario up ([#283](https://github.com/Autonoma-AI/agent/issues/283)) ([de5dacb](https://github.com/Autonoma-AI/agent/commit/de5dacb68259717b36cff1195e70a89a571ddbdb))
* use interceptors for sentry logging ([#490](https://github.com/Autonoma-AI/agent/issues/490)) ([56d0f1d](https://github.com/Autonoma-AI/agent/commit/56d0f1d7d23e9664d1e49d3dab28904c4eb5dc6d))
* use job for worker web ([#570](https://github.com/Autonoma-AI/agent/issues/570)) ([75c83d8](https://github.com/Autonoma-AI/agent/commit/75c83d82c3230420a65ad9f0dfb2d0ee3a7df3d4))
* use pat token for push to production ([#279](https://github.com/Autonoma-AI/agent/issues/279)) ([0d068c2](https://github.com/Autonoma-AI/agent/commit/0d068c22c50d049ab312584f03672cf5de0bfbe2))
* use same secret as beta ([#282](https://github.com/Autonoma-AI/agent/issues/282)) ([aa5f3e5](https://github.com/Autonoma-AI/agent/commit/aa5f3e5ecd97a11e4f85b092884345e98c515a69))
* use shared redis instance for better auth sessions ([#134](https://github.com/Autonoma-AI/agent/issues/134)) ([dbe5276](https://github.com/Autonoma-AI/agent/commit/dbe5276257a81e9ef4c670ed7cb72a55e13a8c73))
* use sqs instead of workflows ([#359](https://github.com/Autonoma-AI/agent/issues/359)) ([036b03e](https://github.com/Autonoma-AI/agent/commit/036b03ee7ed93ab318e3df44608ac688fbd74183))
* use structured SkillEntry with frontmatter for skill resolver ([#127](https://github.com/Autonoma-AI/agent/issues/127)) ([9f3e16d](https://github.com/Autonoma-AI/agent/commit/9f3e16dff881eb7707dd3e13bfafb6ba63f82a57))
* write flag on exit to shutdown chrom sidecar ([#107](https://github.com/Autonoma-AI/agent/issues/107)) ([e009171](https://github.com/Autonoma-AI/agent/commit/e009171a682e3b08df79d396dc7794e115418f72))


### Bug Fixes

* @autonoma/errors exports ([#305](https://github.com/Autonoma-AI/agent/issues/305)) ([ccfa290](https://github.com/Autonoma-AI/agent/commit/ccfa29063cc5eb3515a8b0cce49b6ee7cc029814))
* action build beta ([#370](https://github.com/Autonoma-AI/agent/issues/370)) ([d68ae57](https://github.com/Autonoma-AI/agent/commit/d68ae57e71a81ea63a9c0fa2670a0bb37d800379))
* adapt build scripts to new file structure ([#141](https://github.com/Autonoma-AI/agent/issues/141)) ([0ea9018](https://github.com/Autonoma-AI/agent/commit/0ea90189d86b5847a19c4af09a4267996f3ed1de))
* add /dev/shm shared memory volume to web worker pods ([#598](https://github.com/Autonoma-AI/agent/issues/598)) ([53e1940](https://github.com/Autonoma-AI/agent/commit/53e194051b42b75af9b123be79e12d114e627c81))
* add API logs ([#184](https://github.com/Autonoma-AI/agent/issues/184)) ([341b0cb](https://github.com/Autonoma-AI/agent/commit/341b0cba8b15967852b4e0f0029548f67425bd3e))
* add back link to admin page and redirect on org switch ([#180](https://github.com/Autonoma-AI/agent/issues/180)) ([8d95e2a](https://github.com/Autonoma-AI/agent/commit/8d95e2a3933e1b89b9c2ae4512e258957c3200ad))
* add ca certificate for git clone ([#472](https://github.com/Autonoma-AI/agent/issues/472)) ([755b02b](https://github.com/Autonoma-AI/agent/commit/755b02bb11b4ddd01864602eafb35e31523f4b95))
* add conductor local setup ([#135](https://github.com/Autonoma-AI/agent/issues/135)) ([b6a27aa](https://github.com/Autonoma-AI/agent/commit/b6a27aaa322f2f628363548db3a9bb842c687104))
* add error handling to generation exit billing notification ([#385](https://github.com/Autonoma-AI/agent/issues/385)) ([3bb8af2](https://github.com/Autonoma-AI/agent/commit/3bb8af259108b1a710facf71cebbe2e7b63cec6a))
* add gap between app name and architecture label ([#321](https://github.com/Autonoma-AI/agent/issues/321)) ([3b8c565](https://github.com/Autonoma-AI/agent/commit/3b8c56583361635b1af9bb84a8aac8e22baad569))
* add Github App authethication to release-please workflow ([#447](https://github.com/Autonoma-AI/agent/issues/447)) ([ff48de2](https://github.com/Autonoma-AI/agent/commit/ff48de23043f959a5fed462419f2db5233eb5ff5))
* add LFS to sync to public repo ([d276c43](https://github.com/Autonoma-AI/agent/commit/d276c432abf68d5c9a7e9a29e20ea8483da08b32))
* add logs for wait condition checker ([#290](https://github.com/Autonoma-AI/agent/issues/290)) ([633a40c](https://github.com/Autonoma-AI/agent/commit/633a40c1002a2504aea68acfbb36feed6f296d77))
* add missing @sentry/node dep to web and mobile workers ([#538](https://github.com/Autonoma-AI/agent/issues/538)) ([99e1d68](https://github.com/Autonoma-AI/agent/commit/99e1d683715e1ce81ff48442bf2eddfb6023182c))
* add missing exports ([#322](https://github.com/Autonoma-AI/agent/issues/322)) ([00fee10](https://github.com/Autonoma-AI/agent/commit/00fee10d4459693b20e48f55a7ba8fb0316216c5))
* add missing navlink ([#165](https://github.com/Autonoma-AI/agent/issues/165)) ([32734bb](https://github.com/Autonoma-AI/agent/commit/32734bb39a6386611107634bb74a31f47b56347b))
* add PR number to branch table ([#417](https://github.com/Autonoma-AI/agent/issues/417)) ([0b8bf5e](https://github.com/Autonoma-AI/agent/commit/0b8bf5e2eb4b07ab2a46346466a667cf2980556c))
* add ripgrep to worker-general ([#477](https://github.com/Autonoma-AI/agent/issues/477)) ([f94ed6d](https://github.com/Autonoma-AI/agent/commit/f94ed6dcb275b0de9f86aa0c08225275a8b6fabd))
* add sharp linuxmusl-arm64 runtime to mobile ([1b5d07c](https://github.com/Autonoma-AI/agent/commit/1b5d07c9387544053f7424ac6eb817c94dbc98c3))
* add superjson transformer and send dates directly in trpc ([#113](https://github.com/Autonoma-AI/agent/issues/113)) ([dbd3bf2](https://github.com/Autonoma-AI/agent/commit/dbd3bf205994cabc3a993ec759c9c4fa6c14c8e9))
* add system-prompt.md to final build of engine-mobile ([2966e4d](https://github.com/Autonoma-AI/agent/commit/2966e4d19f39422e75165e93c6d8f2179f4d1445))
* add workflow-level failure handling for generations and runs ([#566](https://github.com/Autonoma-AI/agent/issues/566)) ([d28f477](https://github.com/Autonoma-AI/agent/commit/d28f4775214565510035bdca4a1b44683ae8539b))
* agent status & toasts & bugs query  ([#345](https://github.com/Autonoma-AI/agent/issues/345)) ([0deaed7](https://github.com/Autonoma-AI/agent/commit/0deaed7c3ca4217b17b007371eecf8b710b03e03))
* align workflow/core/world-postgres versions ([#358](https://github.com/Autonoma-AI/agent/issues/358)) ([6abb298](https://github.com/Autonoma-AI/agent/commit/6abb298ec31cb753539477a77f6e636980b0b5df))
* apium recording time back to 30 min ([#220](https://github.com/Autonoma-AI/agent/issues/220)) ([fffe64f](https://github.com/Autonoma-AI/agent/commit/fffe64f1ec0af6a48e0969fb37cf2d861a612332))
* auth ([#168](https://github.com/Autonoma-AI/agent/issues/168)) ([5a4fe6c](https://github.com/Autonoma-AI/agent/commit/5a4fe6c8fc39c1395a374bcb8e191a6fd7ba8249))
* auto generate slug (avoid duplicates) ([#289](https://github.com/Autonoma-AI/agent/issues/289)) ([77ed8b8](https://github.com/Autonoma-AI/agent/commit/77ed8b8386dab7569675fc331a318b4df8a644e6))
* avoid .api-port writes in production and keep fixed port ([#383](https://github.com/Autonoma-AI/agent/issues/383)) ([4fd42aa](https://github.com/Autonoma-AI/agent/commit/4fd42aaf2ba8c15707dc8bdd16f11a109c8156f1))
* avoid download and restore dump when is not first time creating … ([#531](https://github.com/Autonoma-AI/agent/issues/531)) ([fe1ee5d](https://github.com/Autonoma-AI/agent/commit/fe1ee5d6fbf4ff666abbba40c455ba82a1ce65d3))
* beta build ([#188](https://github.com/Autonoma-AI/agent/issues/188)) ([96ee3f2](https://github.com/Autonoma-AI/agent/commit/96ee3f2655db420a8a9b731ab020784116aaa8cc))
* billing callback link ([#416](https://github.com/Autonoma-AI/agent/issues/416)) ([7d65220](https://github.com/Autonoma-AI/agent/commit/7d65220a534b66f0d5d9bf5dc8927d8b9dd2ef85))
* blacklight docs type issue ([#227](https://github.com/Autonoma-AI/agent/issues/227)) ([7667190](https://github.com/Autonoma-AI/agent/commit/766719038ae79d522a8655216422a3bbc340fd23))
* branch resolution logic ([#544](https://github.com/Autonoma-AI/agent/issues/544)) ([ed8054c](https://github.com/Autonoma-AI/agent/commit/ed8054c1257f5383c65857f7f743f7c31ef6830c))
* build error ([#121](https://github.com/Autonoma-AI/agent/issues/121)) ([def2d3d](https://github.com/Autonoma-AI/agent/commit/def2d3d836676460d62d777a17e06c317a6d9f9d))
* build execution agent web ([#100](https://github.com/Autonoma-AI/agent/issues/100)) ([b81b2ad](https://github.com/Autonoma-AI/agent/commit/b81b2ad739075509ba244ca459e22f786e0f18ed))
* build, add notification for scenario build ([#196](https://github.com/Autonoma-AI/agent/issues/196)) ([83f0caa](https://github.com/Autonoma-AI/agent/commit/83f0caa390de241f6adef4d011e2190f8d11bf48))
* bump web worker CPU and memory to match previous architecture ([#599](https://github.com/Autonoma-AI/agent/issues/599)) ([d0615e1](https://github.com/Autonoma-AI/agent/commit/d0615e1636e54ef582f75286f303e0ae6ee4920f))
* bundle workflow on nitro build ([#353](https://github.com/Autonoma-AI/agent/issues/353)) ([eae1d18](https://github.com/Autonoma-AI/agent/commit/eae1d18ebf96335635abfdaee57938a398d8678f))
* change engine-mobile entrypoint ([#307](https://github.com/Autonoma-AI/agent/issues/307)) ([f5aba6f](https://github.com/Autonoma-AI/agent/commit/f5aba6f0b0cde2d7edcd676f0c3fd059f0cb0b48))
* change temporal-web service from headless to ClusterIP ([#533](https://github.com/Autonoma-AI/agent/issues/533)) ([204c3ce](https://github.com/Autonoma-AI/agent/commit/204c3ce49190e24028fe4848b36a224c0a1f3e24))
* clear gh apps only when is fresh database from dump ([#530](https://github.com/Autonoma-AI/agent/issues/530)) ([f60ab4e](https://github.com/Autonoma-AI/agent/commit/f60ab4e9d716c26c3167fc02872f043620f9ceb6))
* clear github installations on alpha build ([#505](https://github.com/Autonoma-AI/agent/issues/505)) ([b350979](https://github.com/Autonoma-AI/agent/commit/b350979821d21d7c0b6dca7a78990fb3adeb926a))
* command test fixtures ([#481](https://github.com/Autonoma-AI/agent/issues/481)) ([f3b9eea](https://github.com/Autonoma-AI/agent/commit/f3b9eea9647f65d1fab3e792068f7e6b7de4bf6c))
* configure Appium screen recording to support long runs ([#213](https://github.com/Autonoma-AI/agent/issues/213)) ([baf5f55](https://github.com/Autonoma-AI/agent/commit/baf5f551927f4ab7f5bf281360fb0f5f216fb110))
* configure Vercel deployment for pre-built static output ([#146](https://github.com/Autonoma-AI/agent/issues/146)) ([6ddb5b4](https://github.com/Autonoma-AI/agent/commit/6ddb5b417442187ef077bce3d3033237f1a7bcd3))
* copy all test/skill assignments on branch creation ([#488](https://github.com/Autonoma-AI/agent/issues/488)) ([42c4a5d](https://github.com/Autonoma-AI/agent/commit/42c4a5d268ef6512e2012e8673191636ccd4f505))
* correct Ministral 8B pricing in AI cost calculation ([#182](https://github.com/Autonoma-AI/agent/issues/182)) ([42a6fae](https://github.com/Autonoma-AI/agent/commit/42a6faecc3aded083e463d4dd1a4d1d7cef2c6e0))
* create /tmp/flag directory before writing done flag in generation jobs ([#487](https://github.com/Autonoma-AI/agent/issues/487)) ([aeca2a7](https://github.com/Autonoma-AI/agent/commit/aeca2a728051a14fdd6cbc785ef4e1b036c1a735))
* **db:** preserve key order in scenario recipe JSON ([#529](https://github.com/Autonoma-AI/agent/issues/529)) ([2a7e790](https://github.com/Autonoma-AI/agent/commit/2a7e7905b99e761bae5eea3e1e942f26ff18dcd9))
* dedupe bug reports at apply time instead of via agent tool ([#621](https://github.com/Autonoma-AI/agent/issues/621)) ([597f7dd](https://github.com/Autonoma-AI/agent/commit/597f7dd4a861dcd3dcfaa11bff098807b7a87240))
* deploy workers ([#427](https://github.com/Autonoma-AI/agent/issues/427)) ([ee1373a](https://github.com/Autonoma-AI/agent/commit/ee1373a80f4b8f6feade48f4a1805dd29abcb903))
* disable AI evals in CI ([#324](https://github.com/Autonoma-AI/agent/issues/324)) ([896e744](https://github.com/Autonoma-AI/agent/commit/896e7446ca9d79085fe9302688506d255dbd1b76))
* disable previewkit build ([#479](https://github.com/Autonoma-AI/agent/issues/479)) ([b1aa147](https://github.com/Autonoma-AI/agent/commit/b1aa1478d553d785e072d0d90e90a54c39c7e31b))
* display argo button for batch generation ([#257](https://github.com/Autonoma-AI/agent/issues/257)) ([d5e42df](https://github.com/Autonoma-AI/agent/commit/d5e42df0e95979db38255f688f096e78ea61d342))
* don't show apps with no main branch ([#407](https://github.com/Autonoma-AI/agent/issues/407)) ([0f4ee41](https://github.com/Autonoma-AI/agent/commit/0f4ee415da75e721e10947e03aeda34dd6c0b65d))
* dotenv missing issue ([#103](https://github.com/Autonoma-AI/agent/issues/103)) ([76fdb92](https://github.com/Autonoma-AI/agent/commit/76fdb92d6eb149d4d41a0ab43e91879b6aa625c4))
* download file from s3 in replay job ([#310](https://github.com/Autonoma-AI/agent/issues/310)) ([e21085d](https://github.com/Autonoma-AI/agent/commit/e21085d66f0ec4682cfafdc8c4a2aca2c3659a98))
* drag nits ([#110](https://github.com/Autonoma-AI/agent/issues/110)) ([bc252bb](https://github.com/Autonoma-AI/agent/commit/bc252bb29f9d7a026e5fb8ac8dc8b4d92181933c))
* drop unused tables from schema ([#567](https://github.com/Autonoma-AI/agent/issues/567)) ([3653ebc](https://github.com/Autonoma-AI/agent/commit/3653ebc057e9bf0746acb39ee7476e27fff36d39))
* encode GITHUB_APP_PRIVATE_KEY in base64, decode at boot ([#606](https://github.com/Autonoma-AI/agent/issues/606)) ([349800e](https://github.com/Autonoma-AI/agent/commit/349800ed8cf988875c06328cd86cfe14c4a9cf53))
* explicitly register stripe webhook step in workflow runtime ([#360](https://github.com/Autonoma-AI/agent/issues/360)) ([6bcef85](https://github.com/Autonoma-AI/agent/commit/6bcef85b691d0ff9385b58f4cb845e1574fb687d))
* fail success runs with zero steps or missing assert ([#225](https://github.com/Autonoma-AI/agent/issues/225)) ([4e4a81f](https://github.com/Autonoma-AI/agent/commit/4e4a81fe29ab79d620a50615f3c6370300520e33))
* fix stripe webhook workflow dispatch ([#351](https://github.com/Autonoma-AI/agent/issues/351)) ([30c8e8b](https://github.com/Autonoma-AI/agent/commit/30c8e8b9a40878aaeca6ee93fd8a89acf592fbe6))
* force build ([#365](https://github.com/Autonoma-AI/agent/issues/365)) ([80a482a](https://github.com/Autonoma-AI/agent/commit/80a482aed9a1c3b0bc77d91037a1d86249899b21))
* generation assigner ([#254](https://github.com/Autonoma-AI/agent/issues/254)) ([7ecf124](https://github.com/Autonoma-AI/agent/commit/7ecf12444b781d5eb0c758cf3732c531618ec1ae))
* **github:** add local dev mock client for testing ([#509](https://github.com/Autonoma-AI/agent/issues/509)) ([46ea389](https://github.com/Autonoma-AI/agent/commit/46ea3893295c27cfc0edf644bbb20790042db218))
* handle application name uniqueness conflict in setup ([#372](https://github.com/Autonoma-AI/agent/issues/372)) ([da34b1e](https://github.com/Autonoma-AI/agent/commit/da34b1eae8fbdf3f469316ebdd6039b10e3ce808))
* import starlight-llms-txt plugin in astro config ([#155](https://github.com/Autonoma-AI/agent/issues/155)) ([dada958](https://github.com/Autonoma-AI/agent/commit/dada958ddc6c0a525cc12628540ec94320ffdaca))
* increase generation and replay activity startToCloseTimeout ([#591](https://github.com/Autonoma-AI/agent/issues/591)) ([df39404](https://github.com/Autonoma-AI/agent/commit/df39404e3ef64aad5ace5e22d75054ef77fa8177))
* issue with drag points that made UI crash ([c37df75](https://github.com/Autonoma-AI/agent/commit/c37df7556a98bef0624105e8c43fd80282525ffd))
* k8s package export ([#128](https://github.com/Autonoma-AI/agent/issues/128)) ([34284fa](https://github.com/Autonoma-AI/agent/commit/34284fae0db3d2525c99b0002a87365f805e1e27))
* keep checkout/portal return path consistent ([#363](https://github.com/Autonoma-AI/agent/issues/363)) ([67495b2](https://github.com/Autonoma-AI/agent/commit/67495b297020a26702fa8d1ed700503cc1c8e991))
* let sw go to server when is auth callback ([#245](https://github.com/Autonoma-AI/agent/issues/245)) ([b6f8a2e](https://github.com/Autonoma-AI/agent/commit/b6f8a2e29cf5bc20221181396c7a391e7919b0c8))
* load workflow postgres world on startup plugin ([#354](https://github.com/Autonoma-AI/agent/issues/354)) ([2e67b1d](https://github.com/Autonoma-AI/agent/commit/2e67b1dadffbda74ac6a61e466408a443cfb7105))
* lockfile ([#442](https://github.com/Autonoma-AI/agent/issues/442)) ([5afba0d](https://github.com/Autonoma-AI/agent/commit/5afba0df7b7fd9d58921b9a550350fe414078e13))
* login search params ([#338](https://github.com/Autonoma-AI/agent/issues/338)) ([c6166ab](https://github.com/Autonoma-AI/agent/commit/c6166ab0a91d8eb86f6e56c39206440a1489f02c))
* make SCENARIO_ENCRYPTION_KEY required ([#319](https://github.com/Autonoma-AI/agent/issues/319)) ([a3bf03c](https://github.com/Autonoma-AI/agent/commit/a3bf03c9efa6dda4c4f837a3f6eb19e9543a8423))
* maybe fix ([#281](https://github.com/Autonoma-AI/agent/issues/281)) ([6e7f2dd](https://github.com/Autonoma-AI/agent/commit/6e7f2ddb5d8523c14fb6accf91376fc8b739e1d7))
* migrate old test case generation ([#299](https://github.com/Autonoma-AI/agent/issues/299)) ([60a42f3](https://github.com/Autonoma-AI/agent/commit/60a42f334df8f95cb14d3457418e6d53dbd41625))
* milestones queries ([#457](https://github.com/Autonoma-AI/agent/issues/457)) ([6a6b661](https://github.com/Autonoma-AI/agent/commit/6a6b6613dc9a1cde02c9388990145ef2f0323f3e))
* missing migration generation review status ([#262](https://github.com/Autonoma-AI/agent/issues/262)) ([22a4f8d](https://github.com/Autonoma-AI/agent/commit/22a4f8d82346fc0e62dae810f3e560c0cc8af7eb))
* move the temporal deps to the pnpm catalog ([#438](https://github.com/Autonoma-AI/agent/issues/438)) ([c631bab](https://github.com/Autonoma-AI/agent/commit/c631babb36e61a972c317841f3a1c203756e3f88))
* name overflow ([#511](https://github.com/Autonoma-AI/agent/issues/511)) ([0197882](https://github.com/Autonoma-AI/agent/commit/01978826051c6d4c4061d11234d3aeb1253cb049))
* nits for uala android local ([#223](https://github.com/Autonoma-AI/agent/issues/223)) ([d98bb45](https://github.com/Autonoma-AI/agent/commit/d98bb4586657a10ee5eae7aec1356368c731a131))
* only advance onboarding highlight when active step is copied ([#462](https://github.com/Autonoma-AI/agent/issues/462)) ([671d3fa](https://github.com/Autonoma-AI/agent/commit/671d3fab8b0a2d101a1d10da82e8ea1abc6ac335))
* overview bugs & contrast UI color nits ([#326](https://github.com/Autonoma-AI/agent/issues/326)) ([a9e89d8](https://github.com/Autonoma-AI/agent/commit/a9e89d89516f04ef46f38b5b1e41caefcbd8c8ac))
* per-app GitHub repo linking in settings page ([#419](https://github.com/Autonoma-AI/agent/issues/419)) ([fe406dc](https://github.com/Autonoma-AI/agent/commit/fe406dcd9f28d8cfaae81fbb0eb36230bda85758))
* preserve appId in GitHub onboarding redirect and open install in new tab ([#582](https://github.com/Autonoma-AI/agent/issues/582)) ([d56c758](https://github.com/Autonoma-AI/agent/commit/d56c758d89dc6101975c946e21dad5c82a1223e3))
* **previewkit:** add mise dependency for railpack ([471e3da](https://github.com/Autonoma-AI/agent/commit/471e3dac654022db1f5aaa4150549634801cc43b))
* **previewkit:** add MISE_VERSION version for Railpack ([5da881f](https://github.com/Autonoma-AI/agent/commit/5da881fbb19d15c8aa3c85fae2e614ebe19647c8))
* **previewkit:** allow multiple secrets per Application ([#625](https://github.com/Autonoma-AI/agent/issues/625)) ([214872b](https://github.com/Autonoma-AI/agent/commit/214872b1676ef86187ab77e1eb08ae86e32027d7))
* **previewkit:** avoid buildkitd node disk pressure error using cache control ([72be75e](https://github.com/Autonoma-AI/agent/commit/72be75e8d19dd9a2f2907437f732e6d763d16e07))
* **previewkit:** avoid namespace creation when database upsert fails ([6be0828](https://github.com/Autonoma-AI/agent/commit/6be08282c3778c3560b6d6c5dc72fc8b027daf3a))
* **previewkit:** don't wait for connector-like services to be ready in deployment phase ([6f7aa06](https://github.com/Autonoma-AI/agent/commit/6f7aa06a22f556cba31f95d0ed8d61a5e3a26386))
* **previewkit:** initialize logger in constructor body ([#543](https://github.com/Autonoma-AI/agent/issues/543)) ([37286d8](https://github.com/Autonoma-AI/agent/commit/37286d8dec5ea1be6a6e5802ef5e9a1479bc5184))
* **previewkit:** read railpacks's CLI flags during plan generation instead from the subprocess ([e1725e2](https://github.com/Autonoma-AI/agent/commit/e1725e2b0f5671feafbdd9748e516029379484c7))
* **previewkit:** redo regex for proper namespace naming convention ([8c15137](https://github.com/Autonoma-AI/agent/commit/8c151371f1a986a217fef47081576f72b0f75240))
* **previewkit:** remove error thrown when preview.yaml is missing from repostory ([d35ea7f](https://github.com/Autonoma-AI/agent/commit/d35ea7fdaf7f6c199d2fd8a512f5ace31d02e0e0))
* **previewkit:** replace GithubRepository model with Application githubRepositoryId column ([8a07eeb](https://github.com/Autonoma-AI/agent/commit/8a07eeb3826d34e2e338e6c28682b5eb250e92b2))
* queue pending generations when setup completes and onboarding already done ([#536](https://github.com/Autonoma-AI/agent/issues/536)) ([f82ffa4](https://github.com/Autonoma-AI/agent/commit/f82ffa46daa14aad87200984d85371b041637dd1))
* read PR number from FeatureBranchInfo in deployments.listByPr ([#596](https://github.com/Autonoma-AI/agent/issues/596)) ([2301961](https://github.com/Autonoma-AI/agent/commit/2301961742a6f56c00675ebec741e46490c075b0))
* redo previewkit Dockerfile ([8797534](https://github.com/Autonoma-AI/agent/commit/87975340bf385cb399ed03f6406f1faba6de4659))
* reduce toast timeout, cap at 3, silence delete app toasts ([#485](https://github.com/Autonoma-AI/agent/issues/485)) ([6f4ee02](https://github.com/Autonoma-AI/agent/commit/6f4ee02c6b17eab765434ebdd6b6d60fbada651b))
* reduce web and mobile worker concurrency to 1 ([#546](https://github.com/Autonoma-AI/agent/issues/546)) ([e0f828a](https://github.com/Autonoma-AI/agent/commit/e0f828a107a5b9d86217931584b9419d8199adb3))
* remove branch_snapshot.deployment_id ([#471](https://github.com/Autonoma-AI/agent/issues/471)) ([10c1e42](https://github.com/Autonoma-AI/agent/commit/10c1e4211262f23af0d1d43af2e956275b3de6b4))
* remove DB creds ([#460](https://github.com/Autonoma-AI/agent/issues/460)) ([0d3a3c4](https://github.com/Autonoma-AI/agent/commit/0d3a3c4276de87cdd49fa2a844e504a570b1db23))
* remove deprecated models ([#157](https://github.com/Autonoma-AI/agent/issues/157)) ([6150dbe](https://github.com/Autonoma-AI/agent/commit/6150dbe3abf2fccb72412785e89cd3536222ceee))
* remove deprecated workflow ([#320](https://github.com/Autonoma-AI/agent/issues/320)) ([a78858d](https://github.com/Autonoma-AI/agent/commit/a78858d73a9d4ac1e512c036551838859c20699d))
* remove github repository information from database and old commit diff handler ([#422](https://github.com/Autonoma-AI/agent/issues/422)) ([0545971](https://github.com/Autonoma-AI/agent/commit/0545971ed20935879005df6eaa663e04af764b86))
* remove http from remote browser url ([#104](https://github.com/Autonoma-AI/agent/issues/104)) ([2283db2](https://github.com/Autonoma-AI/agent/commit/2283db2eed77ef5d6726ce225a20304aaee34fda))
* remove inject-workspace-packages ([#443](https://github.com/Autonoma-AI/agent/issues/443)) ([21b4911](https://github.com/Autonoma-AI/agent/commit/21b491111ad08ea7d449fc493442df01ca3f338f))
* remove issue creation from resolution agent ([#497](https://github.com/Autonoma-AI/agent/issues/497)) ([e113390](https://github.com/Autonoma-AI/agent/commit/e113390723df06220f799990e2dc12f6e14b65c2))
* remove pond ui styles.css import ([#334](https://github.com/Autonoma-AI/agent/issues/334)) ([fc49adc](https://github.com/Autonoma-AI/agent/commit/fc49adc21421895c5a4bbafd9ce018595a848ae6))
* remove postgres system pod alert ([#535](https://github.com/Autonoma-AI/agent/issues/535)) ([bfc0ed7](https://github.com/Autonoma-AI/agent/commit/bfc0ed72621f3c559bf3eaaa64059cb656845810))
* remove remaining autonoma.app references ([#342](https://github.com/Autonoma-AI/agent/issues/342)) ([6d0e61f](https://github.com/Autonoma-AI/agent/commit/6d0e61f90dbcd7ed4e4d9ef338dba1fe94fad701))
* remove retries in jobs other than scenario up/down ([#548](https://github.com/Autonoma-AI/agent/issues/548)) ([be88c54](https://github.com/Autonoma-AI/agent/commit/be88c548fe6cc19a36741ae42bf43362e5b65f35))
* remove retries in replay/generation workflows ([#541](https://github.com/Autonoma-AI/agent/issues/541)) ([f2ccf54](https://github.com/Autonoma-AI/agent/commit/f2ccf54aef6096009f89d87930156ca5fd3ad268))
* remove SQS env var from API deployment manifest ([#371](https://github.com/Autonoma-AI/agent/issues/371)) ([5f063dd](https://github.com/Autonoma-AI/agent/commit/5f063dd1d0995f2c347bad2bb8dd3abaa08f6986))
* remove test case generator job ([#423](https://github.com/Autonoma-AI/agent/issues/423)) ([fdd5b47](https://github.com/Autonoma-AI/agent/commit/fdd5b47544e7259109380bf2140a9e0b84df2389))
* remove the branch from the route in the whole UI ([#405](https://github.com/Autonoma-AI/agent/issues/405)) ([3e56493](https://github.com/Autonoma-AI/agent/commit/3e564934d016d9be54d604bc6501d67c93a8b49e))
* remove tmp repo before and after diff run ([#474](https://github.com/Autonoma-AI/agent/issues/474)) ([627e128](https://github.com/Autonoma-AI/agent/commit/627e1283859a3c7df9513e9a6f276b28a09d83cf))
* remove trigger diff action (moved to agent-actions repo) ([#464](https://github.com/Autonoma-AI/agent/issues/464)) ([8e72d39](https://github.com/Autonoma-AI/agent/commit/8e72d39556ab4ea7e3895a4be270f589877583a6))
* remove unused application_setup_artifact table ([#482](https://github.com/Autonoma-AI/agent/issues/482)) ([0fd22a8](https://github.com/Autonoma-AI/agent/commit/0fd22a81deb46eccc63adf924424dea06fad4f7e))
* remove unused CI test steps ([#185](https://github.com/Autonoma-AI/agent/issues/185)) ([51bc8c6](https://github.com/Autonoma-AI/agent/commit/51bc8c6ceec86f6d0c018829d580b9d2e38fa278))
* remove unused jobs, improved scenario env handling ([#183](https://github.com/Autonoma-AI/agent/issues/183)) ([bc105f9](https://github.com/Autonoma-AI/agent/commit/bc105f9b7c064e25a812cf43d558cb3124a9b7b1))
* rename AUTONOMA_SIGNING_SECRET to AUTONOMA_SHARED_SECRET in onboarding ([#453](https://github.com/Autonoma-AI/agent/issues/453)) ([dfe644b](https://github.com/Autonoma-AI/agent/commit/dfe644bc23d8eb13968436694f9e57bb74cb9ca0))
* replace BrailleSpinner with CircleNotch in onboarding step indic… ([#463](https://github.com/Autonoma-AI/agent/issues/463)) ([de47533](https://github.com/Autonoma-AI/agent/commit/de475338c2da6dc786749dfaecc449713f43b731))
* replace useQuery with useSuspenseQuery ([#179](https://github.com/Autonoma-AI/agent/issues/179)) ([afa0562](https://github.com/Autonoma-AI/agent/commit/afa0562ccde535a7836547e947457da7ec889850))
* replay runs read deployment from run's snapshot branch ([#540](https://github.com/Autonoma-AI/agent/issues/540)) ([06482e3](https://github.com/Autonoma-AI/agent/commit/06482e3ed83708d6ed107d6542b9ffc82b0a31d7))
* replay/generation task queue ([#489](https://github.com/Autonoma-AI/agent/issues/489)) ([72e6c5c](https://github.com/Autonoma-AI/agent/commit/72e6c5ca8946a74afa7b845649cae4240f6dc98c))
* resolve black screen flash on onboarding page transition ([#339](https://github.com/Autonoma-AI/agent/issues/339)) ([dcef6c4](https://github.com/Autonoma-AI/agent/commit/dcef6c466a2e55405455bc45dad1446e2c84b510))
* resolve race condition in signup hooks that drops welcome emails ([#390](https://github.com/Autonoma-AI/agent/issues/390)) ([378ba4b](https://github.com/Autonoma-AI/agent/commit/378ba4b31cb8715b944aa85214117a7ff751562d))
* resolve Vercel docs build path issues ([#144](https://github.com/Autonoma-AI/agent/issues/144)) ([9e24ff5](https://github.com/Autonoma-AI/agent/commit/9e24ff5b2792322c12c07b3de498443a82239445))
* restore generation_id tag on generation sentry logs ([#537](https://github.com/Autonoma-AI/agent/issues/537)) ([53956d2](https://github.com/Autonoma-AI/agent/commit/53956d29ee12ed1dad41b3f6adfb1e1355efe21f))
* route tree ([#325](https://github.com/Autonoma-AI/agent/issues/325)) ([0ea8fa7](https://github.com/Autonoma-AI/agent/commit/0ea8fa7ce4235c089077c15ede40c555fd135447))
* run diffs resolution on candidates and surface affected/run gap ([#486](https://github.com/Autonoma-AI/agent/issues/486)) ([514b4de](https://github.com/Autonoma-AI/agent/commit/514b4dea9e91fb642ae138ee061d9d91698791dd))
* run step assignments in diffs + inconsistent architecture ([#493](https://github.com/Autonoma-AI/agent/issues/493)) ([7283a9c](https://github.com/Autonoma-AI/agent/commit/7283a9c9a877b6ac22a44dc62107906827c01dcc))
* run stripe webhook processing inside workflow body ([#361](https://github.com/Autonoma-AI/agent/issues/361)) ([e43a2dd](https://github.com/Autonoma-AI/agent/commit/e43a2dd8d0d18e44c352978d4294948acccd5ac7))
* **scenario:** fix webhook parse error handling ([#510](https://github.com/Autonoma-AI/agent/issues/510)) ([a2cebe6](https://github.com/Autonoma-AI/agent/commit/a2cebe62862c0c9b8817aa3764a6644a8191de71))
* scope diffs workflow id to snapshot to allow retriggers ([#491](https://github.com/Autonoma-AI/agent/issues/491)) ([06710d9](https://github.com/Autonoma-AI/agent/commit/06710d99e394adb32077669fbeecba4a1f2058db))
* scope scenario headers to app origin only ([#601](https://github.com/Autonoma-AI/agent/issues/601)) ([6fb740f](https://github.com/Autonoma-AI/agent/commit/6fb740f9b896450f7505c17cb524639e313c5b2f))
* send error data in fatal logs ([#579](https://github.com/Autonoma-AI/agent/issues/579)) ([f00b8af](https://github.com/Autonoma-AI/agent/commit/f00b8af20eba1c22ada1eb494a1621859ecb90e4))
* set api upstream for beta build ([#164](https://github.com/Autonoma-AI/agent/issues/164)) ([dcc625c](https://github.com/Autonoma-AI/agent/commit/dcc625cfb981ec5af249f90f51f050856ac02b62))
* set NAMESPACE env in api deployment manifest ([#173](https://github.com/Autonoma-AI/agent/issues/173)) ([518a3e3](https://github.com/Autonoma-AI/agent/commit/518a3e3e2ea1899d32fcc76ebd86f19954797da4))
* set pnpm version for cicd actions (ci and beta-build are failing) ([#87](https://github.com/Autonoma-AI/agent/issues/87)) ([45bf4d3](https://github.com/Autonoma-AI/agent/commit/45bf4d3590e2fd93a15e2de6a3adbeb0dc4a3853))
* shutdown workers after first activity to prevent race conditions ([#573](https://github.com/Autonoma-AI/agent/issues/573)) ([49f9f27](https://github.com/Autonoma-AI/agent/commit/49f9f2713860c7aa5afc29597becb6fb77fc91e3))
* stale deployment secret config ([#215](https://github.com/Autonoma-AI/agent/issues/215)) ([13b0bc7](https://github.com/Autonoma-AI/agent/commit/13b0bc7b96377711cc992cdad2635e58333768fb))
* start workflow world on nitro ready to avoid step not found ([#356](https://github.com/Autonoma-AI/agent/issues/356)) ([b23f651](https://github.com/Autonoma-AI/agent/commit/b23f65122c7125f213e30cd4058f8bc21388f2cf))
* step descriptions missing for drag, scroll, and hover commands ([#242](https://github.com/Autonoma-AI/agent/issues/242)) ([c90a7b4](https://github.com/Autonoma-AI/agent/commit/c90a7b41eb5c948ebe084bfb771fa72c49275bd9))
* step descriptions missing for drag, scroll, and hover commands ([#242](https://github.com/Autonoma-AI/agent/issues/242)) ([971ba32](https://github.com/Autonoma-AI/agent/commit/971ba320915efd5f299fa9b6ad51318c172375e8))
* stop querying k8s on local API method ([#258](https://github.com/Autonoma-AI/agent/issues/258)) ([3973bb0](https://github.com/Autonoma-AI/agent/commit/3973bb06228991a5f89e88bdc6bb7b800fb7440a))
* switch onboarding generation from zip archives to directories ([#219](https://github.com/Autonoma-AI/agent/issues/219)) ([98ae91d](https://github.com/Autonoma-AI/agent/commit/98ae91d5639c178a3b3e137e858792541532d7d5))
* switch org on alphas ([#261](https://github.com/Autonoma-AI/agent/issues/261)) ([171a849](https://github.com/Autonoma-AI/agent/commit/171a8492bc1b6bb64e863ef27801aa9709a2940d))
* switch org w/o refresh ([#106](https://github.com/Autonoma-AI/agent/issues/106)) ([8f1c9cb](https://github.com/Autonoma-AI/agent/commit/8f1c9cb0eaf83761e2eafdb55e08e224959d5e71))
* trigger build ([#429](https://github.com/Autonoma-AI/agent/issues/429)) ([d4fa7c3](https://github.com/Autonoma-AI/agent/commit/d4fa7c340fe8affaf39cd07dc7d0a0db6bc5663c))
* trigger build beta ([#430](https://github.com/Autonoma-AI/agent/issues/430)) ([404cf4e](https://github.com/Autonoma-AI/agent/commit/404cf4e99e5e45b518da1d68060b6238d03cc3f2))
* trigger diffs on main branch ([#534](https://github.com/Autonoma-AI/agent/issues/534)) ([e6bab01](https://github.com/Autonoma-AI/agent/commit/e6bab01965a1a30819b2a07d1ca6fd9469a8daae))
* ui beta build ([#131](https://github.com/Autonoma-AI/agent/issues/131)) ([37530ae](https://github.com/Autonoma-AI/agent/commit/37530aed034eeb825aa07811e2bbc2adfc650178))
* ui click annotations ([#129](https://github.com/Autonoma-AI/agent/issues/129)) ([41a55bb](https://github.com/Autonoma-AI/agent/commit/41a55bba0815288e1233c5debd462f427bee624d))
* **ui:** make table rows proper links for cmd+click support ([#545](https://github.com/Autonoma-AI/agent/issues/545)) ([b5ac689](https://github.com/Autonoma-AI/agent/commit/b5ac689cf7b337b5fa6cbc0c5d039ffcb493434b))
* **ui:** poll runs and generations lists while items are active ([#604](https://github.com/Autonoma-AI/agent/issues/604)) ([9d2fcfd](https://github.com/Autonoma-AI/agent/commit/9d2fcfd9c303b2c0e7fa20a40f18f427f6f4fd18))
* **ui:** replace history on generation re-run navigation ([#607](https://github.com/Autonoma-AI/agent/issues/607)) ([fce8421](https://github.com/Autonoma-AI/agent/commit/fce8421f3dade840c891c43e54b51efc78c0a9ee))
* update feedback survey ID for unified PostHog project ([#369](https://github.com/Autonoma-AI/agent/issues/369)) ([fea8d84](https://github.com/Autonoma-AI/agent/commit/fea8d8475e489182ba69f6b0ea32fb62744014ac))
* update scenario tests ([#167](https://github.com/Autonoma-AI/agent/issues/167)) ([d0fbcf2](https://github.com/Autonoma-AI/agent/commit/d0fbcf2d1f5d2a3d0325f4e3a6393aa180a60c43))
* use amd64 as platform for build agent, set complete images with … ([#94](https://github.com/Autonoma-AI/agent/issues/94)) ([f8fdf09](https://github.com/Autonoma-AI/agent/commit/f8fdf095c3ecb5ba3a09b24152ea4370e3b75cc1))
* use Appium API for iOS video recording instead of xcrun ([#386](https://github.com/Autonoma-AI/agent/issues/386)) ([130e971](https://github.com/Autonoma-AI/agent/commit/130e971b579858a52cf798a93148ad486ecf6276))
* use CID inline PNG for onboarding email logo ([#434](https://github.com/Autonoma-AI/agent/issues/434)) ([01ebde1](https://github.com/Autonoma-AI/agent/commit/01ebde157bcd7cd81ccb1b8f39e47f9305e0127d))
* use client-side navigation in generation detail page ([#330](https://github.com/Autonoma-AI/agent/issues/330)) ([956015f](https://github.com/Autonoma-AI/agent/commit/956015f3d887816ff9f2ca199b548d445dd9812f))
* use correct bucket for setup db ([#492](https://github.com/Autonoma-AI/agent/issues/492)) ([2df4bcc](https://github.com/Autonoma-AI/agent/commit/2df4bcc3b529bc3711add4c2482aa20878b10203))
* use database url env ([#91](https://github.com/Autonoma-AI/agent/issues/91)) ([8d75b3f](https://github.com/Autonoma-AI/agent/commit/8d75b3f718ae176a96c6483247b136eb9c210a21))
* use dynamic import for workflow ([#357](https://github.com/Autonoma-AI/agent/issues/357)) ([3be05dd](https://github.com/Autonoma-AI/agent/commit/3be05ddd56786895085b5e1348072ad42d26b3c0))
* use window.location.origin for AUTONOMA_API_URL in onboarding ([#516](https://github.com/Autonoma-AI/agent/issues/516)) ([0e3d113](https://github.com/Autonoma-AI/agent/commit/0e3d113b93460b9029737ffe64bee12b812d3442))
* use workflow fetch in stripe workflow ([#364](https://github.com/Autonoma-AI/agent/issues/364)) ([2108f95](https://github.com/Autonoma-AI/agent/commit/2108f95b7cace428fc6a1603a5eb79dd1c508952))
* validate diffs agent test slugs and suggest corrections ([#414](https://github.com/Autonoma-AI/agent/issues/414)) ([c6c066b](https://github.com/Autonoma-AI/agent/commit/c6c066b86ddfb3774b1488bce1fed8ebb88d7eca))
* wire scenario recipe variables to generation execution ([#496](https://github.com/Autonoma-AI/agent/issues/496)) ([16cac6b](https://github.com/Autonoma-AI/agent/commit/16cac6b634e642443f52c7c63619e22eb26d3197))
* workers now read DATABASE_URL from env instead of secrets ([#428](https://github.com/Autonoma-AI/agent/issues/428)) ([a74f950](https://github.com/Autonoma-AI/agent/commit/a74f950831caea2d6e63e2a2fdb0f7e1bc20c4a9))
* workflow task queue ([#495](https://github.com/Autonoma-AI/agent/issues/495)) ([58b1d1e](https://github.com/Autonoma-AI/agent/commit/58b1d1e02a7c9231e9a91b58a4191d21a5e4b5db))
* **workflow:** use Promise.allSettled for parallel executeChild calls ([#629](https://github.com/Autonoma-AI/agent/issues/629)) ([7ae8839](https://github.com/Autonoma-AI/agent/commit/7ae8839ddc7abf457aeb5e0c3583ea1aa73127d2))


### Performance Improvements

* add caching for session/org info, optimizing navigation ([#260](https://github.com/Autonoma-AI/agent/issues/260)) ([6872142](https://github.com/Autonoma-AI/agent/commit/6872142e25dab87076ec5e566d784808df12502a))
* optimize generation detail loading speed ([#235](https://github.com/Autonoma-AI/agent/issues/235)) ([f4bf7f2](https://github.com/Autonoma-AI/agent/commit/f4bf7f2029874c9a113e614e989a8c7bd72150e0))


### Reverts

* "fix: disable previewkit build ([#479](https://github.com/Autonoma-AI/agent/issues/479))" ([#480](https://github.com/Autonoma-AI/agent/issues/480)) ([5c2cbc2](https://github.com/Autonoma-AI/agent/commit/5c2cbc2a6009a91fa1594dd8afa8dde304696b1d))
