# Changelog

## [0.1.27](https://github.com/Autonoma-AI/agent/compare/cli-v0.1.26...cli-v0.1.27) (2026-08-07)


### Features

* **cli:** record the environment a run happened in, and dump it to a file ([#2278](https://github.com/Autonoma-AI/agent/issues/2278)) ([32ed8f0](https://github.com/Autonoma-AI/agent/commit/32ed8f0b21371f126af3eac47154ef79efda515d))

## [0.1.26](https://github.com/Autonoma-AI/agent/compare/cli-v0.1.25...cli-v0.1.26) (2026-08-06)


### Features

* **cli:** make the test review pass visible in the TUI ([#2225](https://github.com/Autonoma-AI/agent/issues/2225)) ([41e43fb](https://github.com/Autonoma-AI/agent/commit/41e43fbd5b74b456fc031a0439a5518d1275abda))
* **cli:** stop asking questions that have only one answer ([#2223](https://github.com/Autonoma-AI/agent/issues/2223)) ([e41006b](https://github.com/Autonoma-AI/agent/commit/e41006b0be21171b3586a0ca06cf1a53bb8735bf))


### Bug Fixes

* **cli:** stop the TUI from leaking ~2.6 MB/s of short-lived Grid allocations ([#2226](https://github.com/Autonoma-AI/agent/issues/2226)) ([a29bead](https://github.com/Autonoma-AI/agent/commit/a29beadd9de462f616de091867d5c48e9c7b73cb))

## [0.1.25](https://github.com/Autonoma-AI/agent/compare/cli-v0.1.24...cli-v0.1.25) (2026-08-06)


### Features

* **cli:** formbricks SDK-integration eval case ([#2033](https://github.com/Autonoma-AI/agent/issues/2033)) ([88465d2](https://github.com/Autonoma-AI/agent/commit/88465d28aae25f1935fcd3d59f5c0a2373050986))
* **cli:** hand the SDK and dry run back to an agent when they do not pass ([#2222](https://github.com/Autonoma-AI/agent/issues/2222)) ([6f3e41f](https://github.com/Autonoma-AI/agent/commit/6f3e41fab6cf11c661e491e68779c1e724ca51d3))
* **cli:** let the agent check its recipe and prove it survives concurrent runs ([#2191](https://github.com/Autonoma-AI/agent/issues/2191)) ([446aead](https://github.com/Autonoma-AI/agent/commit/446aead437fd2ebe87b12838aa560e3013369971))
* **cli:** make the unattended path expressible and legible ([#2176](https://github.com/Autonoma-AI/agent/issues/2176)) ([d2d1443](https://github.com/Autonoma-AI/agent/commit/d2d144307fade3e106f1d841a7ec60ef4ecd627c))
* **cli:** read onboarding state and mint pairing codes ([#2160](https://github.com/Autonoma-AI/agent/issues/2160)) ([52786d8](https://github.com/Autonoma-AI/agent/commit/52786d8dc9c335f1b15ea776086d44cd147eb059))
* **cli:** register the onboarding MCP with the agent it spawns ([#2161](https://github.com/Autonoma-AI/agent/issues/2161)) ([8951d46](https://github.com/Autonoma-AI/agent/commit/8951d464ff423c85fa6dcb28f1b74e0a6ddd71c0))
* **cli:** set up the preview environment before the pipeline ([#2169](https://github.com/Autonoma-AI/agent/issues/2169)) ([7b26a25](https://github.com/Autonoma-AI/agent/commit/7b26a25ecdfec60652a6ce225d2330d7bf69bb07))
* **cli:** the run proves the scenarios before it calls itself done ([#2175](https://github.com/Autonoma-AI/agent/issues/2175)) ([8a31784](https://github.com/Autonoma-AI/agent/commit/8a317844f4b8926a56ca9fe508d238e626972412))
* **ui:** hand finish setup to the agent that is doing it ([#2177](https://github.com/Autonoma-AI/agent/issues/2177)) ([c8f6ed2](https://github.com/Autonoma-AI/agent/commit/c8f6ed2827e425aee4be99dfe1064478e99cd39d))


### Bug Fixes

* **cli:** choose an agent headlessly instead of skipping the preview ([#2209](https://github.com/Autonoma-AI/agent/issues/2209)) ([3d7cf21](https://github.com/Autonoma-AI/agent/commit/3d7cf214f712ab8bc29bf7319927495306dec960))
* **cli:** make the completion-watch cleanup test deterministic ([#2190](https://github.com/Autonoma-AI/agent/issues/2190)) ([fb40807](https://github.com/Autonoma-AI/agent/commit/fb408072bea3884a337114941aa25264d8a4028b))
* **cli:** make the preview handoff survive a real run ([#2171](https://github.com/Autonoma-AI/agent/issues/2171)) ([daf554a](https://github.com/Autonoma-AI/agent/commit/daf554ab56dc3eabd2638f861252875a2b1e7508))
* **cli:** pick the dry-run preview by the branch the repo is on ([#2208](https://github.com/Autonoma-AI/agent/issues/2208)) ([97f6484](https://github.com/Autonoma-AI/agent/commit/97f6484cc98269b9c17d6c70cd55013d25704e31))
* **cli:** take the app live itself instead of leaving it to the agent ([#2218](https://github.com/Autonoma-AI/agent/issues/2218)) ([f860f42](https://github.com/Autonoma-AI/agent/commit/f860f4202e5fed13fdad394508f9ae83a274bf8b))

## [0.1.24](https://github.com/Autonoma-AI/agent/compare/cli-v0.1.23...cli-v0.1.24) (2026-07-31)


### Features

* **cli:** make the coding agent branch and open a PR for its integration ([#1994](https://github.com/Autonoma-AI/agent/issues/1994)) ([3406c9d](https://github.com/Autonoma-AI/agent/commit/3406c9debe0f8a64ee0f337c29686dda85c48acd))
* **ui:** offer the coding agent on every SDK failure, not just finish-setup ([#1977](https://github.com/Autonoma-AI/agent/issues/1977)) ([b95cb46](https://github.com/Autonoma-AI/agent/commit/b95cb4685824b079d075bf973cf561d3e317e9b6))


### Bug Fixes

* **cli:** let the integration agent finish when it genuinely cannot push ([#1996](https://github.com/Autonoma-AI/agent/issues/1996)) ([f731541](https://github.com/Autonoma-AI/agent/commit/f7315417cc9335d74d0c9491346201a29715e77c))
* **cli:** make the test-generator step converge, ground its data, and enforce its own rules ([#1998](https://github.com/Autonoma-AI/agent/issues/1998)) ([c8daf82](https://github.com/Autonoma-AI/agent/commit/c8daf8208f1ea678a14feb993f7f0e0048dad849))
* **cli:** reserve budget to act on what the review finds ([#1969](https://github.com/Autonoma-AI/agent/issues/1969)) ([b2ff84d](https://github.com/Autonoma-AI/agent/commit/b2ff84db7f403d8eee3925bbbbef7781c2c75ae8))
* **cli:** stop capping how much a run may log ([#1978](https://github.com/Autonoma-AI/agent/issues/1978)) ([4ae85aa](https://github.com/Autonoma-AI/agent/commit/4ae85aaab2fee0290bb45ab0d4b7179aede65247))
* **cli:** tell the journey agent which node its tests belong to ([#1975](https://github.com/Autonoma-AI/agent/issues/1975)) ([0448a27](https://github.com/Autonoma-AI/agent/commit/0448a27df2d46ac670cc3f18a874f174fa57f32b))


### Documentation

* **cli:** drop the onboarding feedback backlog from the repo ([#1984](https://github.com/Autonoma-AI/agent/issues/1984)) ([3d1ba71](https://github.com/Autonoma-AI/agent/commit/3d1ba719511a3015a3b1bb30318b6a37b744d9bc))


### Code Refactoring

* **cli:** remove the project-context feature ([#1990](https://github.com/Autonoma-AI/agent/issues/1990)) ([9eb1369](https://github.com/Autonoma-AI/agent/commit/9eb13694b51c88dc37649a68754c7dca9bbbcd3e))

## [0.1.23](https://github.com/Autonoma-AI/agent/compare/cli-v0.1.22...cli-v0.1.23) (2026-07-30)


### Features

* **cli:** end the run with a summary you can act on ([#1866](https://github.com/Autonoma-AI/agent/issues/1866)) ([9fa9e17](https://github.com/Autonoma-AI/agent/commit/9fa9e1736e4dcd0e7ea321307b9b8382ac890547))
* **cli:** record the planner dashboard as a session replay ([#1871](https://github.com/Autonoma-AI/agent/issues/1871)) ([6c581fc](https://github.com/Autonoma-AI/agent/commit/6c581fc6e7722f0c62a89a28c708870f24441ecc))
* **cli:** say what the tests step is doing after the nodes are done ([#1926](https://github.com/Autonoma-AI/agent/issues/1926)) ([fd032e9](https://github.com/Autonoma-AI/agent/commit/fd032e971385608dfd7448782f59387928ea49b5))
* **cli:** ship the run narrative to PostHog logs, indexed by generation id ([#1884](https://github.com/Autonoma-AI/agent/issues/1884)) ([8270863](https://github.com/Autonoma-AI/agent/commit/827086335bd86ca1c32f23c521c077e70c2dacbb))


### Bug Fixes

* **analytics:** close the activation-funnel instrumentation gaps ([#1746](https://github.com/Autonoma-AI/agent/issues/1746)) ([865350c](https://github.com/Autonoma-AI/agent/commit/865350c980f0a235ec046b0172a9958320ddcb92))
* **cli:** a step that is still running never reads finished ([#1925](https://github.com/Autonoma-AI/agent/issues/1925)) ([0186478](https://github.com/Autonoma-AI/agent/commit/018647849e3764718513e87b916f0257a9a5e1a3))
* **cli:** bound the review pass so it cannot stall a run for hours ([#1876](https://github.com/Autonoma-AI/agent/issues/1876)) ([f613363](https://github.com/Autonoma-AI/agent/commit/f613363f466f2b06a4fba76de45bb305035130b2))
* **cli:** build INDEX.md from disk, last ([#1875](https://github.com/Autonoma-AI/agent/issues/1875)) ([6854cd7](https://github.com/Autonoma-AI/agent/commit/6854cd7fd7d2856a3ab77ae0623c41399f7eb822))
* **cli:** let journey generation write its tests again ([#1913](https://github.com/Autonoma-AI/agent/issues/1913)) ([2c51d53](https://github.com/Autonoma-AI/agent/commit/2c51d5383e1879b24ba7c127617c2fe1ec839972))
* **cli:** make a refused write_test countable ([#1923](https://github.com/Autonoma-AI/agent/issues/1923)) ([1ef5837](https://github.com/Autonoma-AI/agent/commit/1ef58375f8c2331f86fb5b468fadc0df1321aa3b))
* **cli:** make starting over actually start over ([#1922](https://github.com/Autonoma-AI/agent/issues/1922)) ([5759b06](https://github.com/Autonoma-AI/agent/commit/5759b0634f858fb45c787f0e23c2aa890402e5b9))
* **cli:** make the generated-test file contract explicit ([#1868](https://github.com/Autonoma-AI/agent/issues/1868)) ([676bc91](https://github.com/Autonoma-AI/agent/commit/676bc91555465653522239efb476382320e2e778))
* **cli:** report the real suite index and re-budget the recipe handoff ([#1883](https://github.com/Autonoma-AI/agent/issues/1883)) ([c2b4c33](https://github.com/Autonoma-AI/agent/commit/c2b4c337943dbb41a8b6a31b267dd3c8d173f675))
* **cli:** resolve recipe tokens in the planner's own sdk up ([#1842](https://github.com/Autonoma-AI/agent/issues/1842)) ([7c48e75](https://github.com/Autonoma-AI/agent/commit/7c48e7590d953cd252f3e0b5d5bb398fb0a736f5))
* **cli:** stop invented nodeIds inflating the planner's test count ([#1872](https://github.com/Autonoma-AI/agent/issues/1872)) ([84d2abf](https://github.com/Autonoma-AI/agent/commit/84d2abf90dd17c48208b0a561843695644333ec3))
* **cli:** stop the ETA extrapolating a linear per-page cost ([#1858](https://github.com/Autonoma-AI/agent/issues/1858)) ([361cddc](https://github.com/Autonoma-AI/agent/commit/361cddcfac272422df390670f54a6fab7fb602a6))
* **cli:** stop the journey pass resetting the tests step's progress ([#1924](https://github.com/Autonoma-AI/agent/issues/1924)) ([d5705c0](https://github.com/Autonoma-AI/agent/commit/d5705c04fcee89cfdc45faab4bd3a135809be446))
* **cli:** stop the review pass losing tests it deleted ([#1873](https://github.com/Autonoma-AI/agent/issues/1873)) ([0c6871b](https://github.com/Autonoma-AI/agent/commit/0c6871b08694f47153b77dabad75ab74e38bd3fc))
* **cli:** stop uploading quarantined tests ([#1877](https://github.com/Autonoma-AI/agent/issues/1877)) ([d1d44fc](https://github.com/Autonoma-AI/agent/commit/d1d44fce4f75a0d9bb76f362d69e66b0fa4b7667))


### Documentation

* screenshot every surface the docs tell you to go operate ([#1851](https://github.com/Autonoma-AI/agent/issues/1851)) ([dc08077](https://github.com/Autonoma-AI/agent/commit/dc08077fb33b0604b8d06c65e3f95f3f8aeb603f))

## [0.1.22](https://github.com/Autonoma-AI/agent/compare/cli-v0.1.21...cli-v0.1.22) (2026-07-28)


### Features

* add Codex CLI support to the SDK-implementation handoff ([#1738](https://github.com/Autonoma-AI/agent/issues/1738)) ([30146c4](https://github.com/Autonoma-AI/agent/commit/30146c40e5544e229dcefe597cbaecbdd8e7d7ea))
* **cli:** live Ink TUI for the planner - dashboard, in-TUI prompts, handoff reclaim ([#1683](https://github.com/Autonoma-AI/agent/issues/1683)) ([9dc9bc7](https://github.com/Autonoma-AI/agent/commit/9dc9bc7667b1f416f0fe255daa480e903504709e))
* **cli:** TUI phase C - human file names, follow fixes, adaptive ETA ([#1704](https://github.com/Autonoma-AI/agent/issues/1704)) ([e2ddbe8](https://github.com/Autonoma-AI/agent/commit/e2ddbe81a8c4f6176744fa03f3b76b663092567e))
* hand the SDK-integration step to the user's local coding agent ([#1665](https://github.com/Autonoma-AI/agent/issues/1665)) ([0e8f461](https://github.com/Autonoma-AI/agent/commit/0e8f46167c5b46f17d816ba4ad4765f5c0c428a5))
* homa SDK-eval case + per-case agent notes/secrets support ([#1726](https://github.com/Autonoma-AI/agent/issues/1726)) ([6ff7358](https://github.com/Autonoma-AI/agent/commit/6ff73588537a377fc9f0bbd55b654d58b8ff7898))
* iac vercel secret ([#1653](https://github.com/Autonoma-AI/agent/issues/1653)) ([9b540a0](https://github.com/Autonoma-AI/agent/commit/9b540a0d43fb08f03555fa584b8b54891048550e))
* **merge-gate:** per-org blocking PR check on client bugs with Skip button ([#1697](https://github.com/Autonoma-AI/agent/issues/1697)) ([f03af54](https://github.com/Autonoma-AI/agent/commit/f03af541a73bd37b19d6fbdffc33fcc3c2696fc5))
* **scenario:** built-in run-identity tokens + reject recipes that cannot provision ([#1799](https://github.com/Autonoma-AI/agent/issues/1799)) ([377c87e](https://github.com/Autonoma-AI/agent/commit/377c87e99f5ca0f83f2c4b9b1bee8242b630f2d9))
* **scenario:** dry-run a candidate recipe without storing it ([#1802](https://github.com/Autonoma-AI/agent/issues/1802)) ([7fc116e](https://github.com/Autonoma-AI/agent/commit/7fc116efe5503dcdedb7da5c6bcc9e4105a404d3))
* SDK-integration eval harness for the planner CLI ([#1500](https://github.com/Autonoma-AI/agent/issues/1500)) ([4d3a834](https://github.com/Autonoma-AI/agent/commit/4d3a8349d595bb501be43dbb59bb636aef1d259e))
* support multi-repo apps in SDK-integration eval ([#1582](https://github.com/Autonoma-AI/agent/issues/1582)) ([c1d3152](https://github.com/Autonoma-AI/agent/commit/c1d31522ba97bd9dd0d97f33128d4d5f5f3e6454))


### Bug Fixes

* **cli:** accurate failure message when no recipe.json exists to submit ([#1784](https://github.com/Autonoma-AI/agent/issues/1784)) ([00ebb01](https://github.com/Autonoma-AI/agent/commit/00ebb019ddc06aba64d54a4496d68ac2e49545ac))
* **cli:** always upload the recipe, even without AUTONOMA_API_URL ([#1755](https://github.com/Autonoma-AI/agent/issues/1755)) ([cac7134](https://github.com/Autonoma-AI/agent/commit/cac7134e6041c868bae96a22d16114062ae44fec))
* **cli:** drop the manual SDK-handoff questions; brighter file highlight ([#1708](https://github.com/Autonoma-AI/agent/issues/1708)) ([aae35da](https://github.com/Autonoma-AI/agent/commit/aae35dae393db03392ec232ec8630f24719ac58b))
* **cli:** stop the planner from stripping fields the recipe upload requires ([#1814](https://github.com/Autonoma-AI/agent/issues/1814)) ([b386291](https://github.com/Autonoma-AI/agent/commit/b386291e59272fe5303fa761d2235f008c555faa))

## [0.1.21](https://github.com/Autonoma-AI/agent/compare/cli-v0.1.20...cli-v0.1.21) (2026-07-16)


### Bug Fixes

* **onboarding:** stop CLI-step reset on refresh, gate on recipe, harden CLI upload ([#1553](https://github.com/Autonoma-AI/agent/issues/1553)) ([c6d7923](https://github.com/Autonoma-AI/agent/commit/c6d79230fa1ae0c9507be7b6ed7f28fb3ea5627b))

## [0.1.20](https://github.com/Autonoma-AI/agent/compare/cli-v0.1.19...cli-v0.1.20) (2026-07-13)


### Features

* **cli:** monorepo-aware planner (project mapper + FE/BE scoping) ([#1472](https://github.com/Autonoma-AI/agent/issues/1472)) ([d58fd8e](https://github.com/Autonoma-AI/agent/commit/d58fd8ee48ec5e6dc44fa56e65ae144f0d67ceb0))

## [0.1.19](https://github.com/Autonoma-AI/agent/compare/cli-v0.1.18...cli-v0.1.19) (2026-07-10)


### Features

* **cli:** use blacklight primary color as the CLI brand accent ([#1431](https://github.com/Autonoma-AI/agent/issues/1431)) ([c1c20e1](https://github.com/Autonoma-AI/agent/commit/c1c20e1dcd091709acc0eeb532c591fa7fdb7d66))

## [0.1.18](https://github.com/Autonoma-AI/agent/compare/cli-v0.1.17...cli-v0.1.18) (2026-07-09)


### Features

* **llm-proxy:** cap free-account CLI spend and per-request size to prevent abuse ([#1351](https://github.com/Autonoma-AI/agent/issues/1351)) ([1f0807f](https://github.com/Autonoma-AI/agent/commit/1f0807f1fc10123f78f71b6c941c31c18f8c23de))


### Bug Fixes

* **cli:** raise model retries to 10 (SDK-native) ([#1396](https://github.com/Autonoma-AI/agent/issues/1396)) ([1307968](https://github.com/Autonoma-AI/agent/commit/1307968b48f8e4e0e2ae864ef80ec094873638e7))

## [0.1.17](https://github.com/Autonoma-AI/agent/compare/cli-v0.1.16...cli-v0.1.17) (2026-07-02)


### Bug Fixes

* **cli:** friendly message when the planner proxy is unreachable ([#1256](https://github.com/Autonoma-AI/agent/issues/1256)) ([87c6c3d](https://github.com/Autonoma-AI/agent/commit/87c6c3d8a22d337c4a432bb9168ab7211896a862))

## [0.1.16](https://github.com/Autonoma-AI/agent/compare/cli-v0.1.15...cli-v0.1.16) (2026-07-01)


### Bug Fixes

* **cli:** fail fast on unsupported Node instead of a cryptic styleText crash ([#1211](https://github.com/Autonoma-AI/agent/issues/1211)) ([53dd52e](https://github.com/Autonoma-AI/agent/commit/53dd52e5b666dc63ebd6211b6ca72bccfa32303b))

## [0.1.15](https://github.com/Autonoma-AI/agent/compare/cli-v0.1.14...cli-v0.1.15) (2026-06-30)


### Features

* managed LLM proxy so the planner CLI runs on Autonoma credits ([#1194](https://github.com/Autonoma-AI/agent/issues/1194)) ([9e07e7a](https://github.com/Autonoma-AI/agent/commit/9e07e7ac8bccd157317ab5ea729edd7083be3717))

## [0.1.14](https://github.com/Autonoma-AI/agent/compare/cli-v0.1.13...cli-v0.1.14) (2026-06-30)


### Features

* **cli:** integrate @autonoma-ai/planner into the monorepo ([#1176](https://github.com/Autonoma-AI/agent/issues/1176)) ([38bb20f](https://github.com/Autonoma-AI/agent/commit/38bb20f54f1487780893e20c3cd921932c4d214b))


### Bug Fixes

* **cli:** decouple CLI release-please from the root flow ([#1184](https://github.com/Autonoma-AI/agent/issues/1184)) ([c626482](https://github.com/Autonoma-AI/agent/commit/c62648233a5fccac7cbc9f184b3c2668daa8dc9e))
* **cli:** use CLI_NPM_TOKEN secret for npm publish ([#1189](https://github.com/Autonoma-AI/agent/issues/1189)) ([fc4f706](https://github.com/Autonoma-AI/agent/commit/fc4f706117e141fee3ddc0c61495dd91df679f82))

## [0.1.13](https://github.com/Autonoma-AI/cli/compare/v0.1.12...v0.1.13) (2026-06-16)


### Bug Fixes

* don't crash when the review editor can't be spawned (Windows ENOENT) ([#31](https://github.com/Autonoma-AI/cli/issues/31)) ([59eab64](https://github.com/Autonoma-AI/cli/commit/59eab64342c3ff3f8c70318311b7965908d68263))

## [0.1.12](https://github.com/Autonoma-AI/cli/compare/v0.1.11...v0.1.12) (2026-06-16)


### Bug Fixes

* retry Gemini "Corrupted thought signature" instead of failing fatally ([#29](https://github.com/Autonoma-AI/cli/issues/29)) ([26d3594](https://github.com/Autonoma-AI/cli/commit/26d3594f3b09c00b65055ea0b0db39b90b7f1c2b))

## [0.1.11](https://github.com/Autonoma-AI/cli/compare/v0.1.10...v0.1.11) (2026-06-16)


### Bug Fixes

* ground recipe builder in the live SDK /discover schema ([#27](https://github.com/Autonoma-AI/cli/issues/27)) ([bd6b916](https://github.com/Autonoma-AI/cli/commit/bd6b916c616d7df9b2bd810f38eeeb85d4dc90de))

## [0.1.10](https://github.com/Autonoma-AI/cli/compare/v0.1.9...v0.1.10) (2026-06-16)


### Bug Fixes

* include _ref'd parents in the single-entity test payload ([#25](https://github.com/Autonoma-AI/cli/issues/25)) ([22534fa](https://github.com/Autonoma-AI/cli/commit/22534fa7235358ab93623ab39d0ab0d1dfa6425c))

## [0.1.9](https://github.com/Autonoma-AI/cli/compare/v0.1.8...v0.1.9) (2026-06-16)


### Bug Fixes

* stop gating recipe-builder recovery on the failure verdict ([#23](https://github.com/Autonoma-AI/cli/issues/23)) ([ea03ffb](https://github.com/Autonoma-AI/cli/commit/ea03ffb81408417fed6b254383d228d83eb93181))

## [0.1.8](https://github.com/Autonoma-AI/cli/compare/v0.1.7...v0.1.8) (2026-06-15)


### Features

* AI-triage recipe-builder failures and auto-fix recipe-side ones ([#22](https://github.com/Autonoma-AI/cli/issues/22)) ([d12b6cc](https://github.com/Autonoma-AI/cli/commit/d12b6ccf3f7231927551ba52b263bb158a988e03))


### Bug Fixes

* make CLI failures rarer and correctly attributed ([#19](https://github.com/Autonoma-AI/cli/issues/19)) ([d45b636](https://github.com/Autonoma-AI/cli/commit/d45b636faf1eed3dfbf3780cb33a2022f7b66869))

## [0.1.7](https://github.com/Autonoma-AI/cli/compare/v0.1.6...v0.1.7) (2026-06-10)


### Bug Fixes

* let Ctrl+C always close the CLI even if graceful exit stalls ([#17](https://github.com/Autonoma-AI/cli/issues/17)) ([fcecc2c](https://github.com/Autonoma-AI/cli/commit/fcecc2c7f6d6b1002e49becd0cdb7f9322f35267))

## [0.1.6](https://github.com/Autonoma-AI/cli/compare/v0.1.5...v0.1.6) (2026-06-10)


### Bug Fixes

* make CLI failures diagnosable instead of dumping raw library stacks ([#15](https://github.com/Autonoma-AI/cli/issues/15)) ([2ea5533](https://github.com/Autonoma-AI/cli/commit/2ea5533131c1226eb1b93f76eaf5b4e9368fb393))

## [0.1.5](https://github.com/Autonoma-AI/cli/compare/v0.1.4...v0.1.5) (2026-06-10)


### Bug Fixes

* recover from agent failures instead of hard-stopping the pipeline ([#13](https://github.com/Autonoma-AI/cli/issues/13)) ([bfcc281](https://github.com/Autonoma-AI/cli/commit/bfcc281c84568f95eb9827e761d9e02da1e89a81))

## [0.1.4](https://github.com/Autonoma-AI/cli/compare/v0.1.3...v0.1.4) (2026-06-08)


### Features

* auto-upload artifacts at end of run ([#9](https://github.com/Autonoma-AI/cli/issues/9)) ([559103f](https://github.com/Autonoma-AI/cli/commit/559103f062f1d45cd5c75404e86dc2e0c7f427a8))
* order recipe entities by AI-perceived importance ([#12](https://github.com/Autonoma-AI/cli/issues/12)) ([e5874fc](https://github.com/Autonoma-AI/cli/commit/e5874fc54720271009458b49274e58d03b18ffb8))


### Bug Fixes

* stop printing model id in CLI run output ([23c9cdd](https://github.com/Autonoma-AI/cli/commit/23c9cdd73562fb6d39d38102aee7742ea955164d))
* stop printing model id in CLI run output ([29e93c7](https://github.com/Autonoma-AI/cli/commit/29e93c7d3e375c90a7dfed1f6b13ffcaac529451))

## [0.1.3](https://github.com/Autonoma-AI/cli/compare/v0.1.2...v0.1.3) (2026-05-30)


### Features

* address early CLI onboarding feedback ([#7](https://github.com/Autonoma-AI/cli/issues/7)) ([9da88f2](https://github.com/Autonoma-AI/cli/commit/9da88f254175dcc92e3ff2d7edfeac9b093c5496))

## [0.1.2](https://github.com/Autonoma-AI/cli/compare/v0.1.1...v0.1.2) (2026-05-22)


### Bug Fixes

* default --project to current working directory ([#5](https://github.com/Autonoma-AI/cli/issues/5)) ([4fb71ee](https://github.com/Autonoma-AI/cli/commit/4fb71ee4d3b26e4b8fc5c1326076745a82042bec))

## [0.1.1](https://github.com/Autonoma-AI/cli/compare/v0.1.0...v0.1.1) (2026-05-22)


### Features

* publish as @autonoma-ai/planner via pnpm + release-please ([#2](https://github.com/Autonoma-AI/cli/issues/2)) ([d88a586](https://github.com/Autonoma-AI/cli/commit/d88a586cc2920b0886564e300a521bbda903e93d))
