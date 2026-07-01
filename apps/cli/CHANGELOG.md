# Changelog

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
