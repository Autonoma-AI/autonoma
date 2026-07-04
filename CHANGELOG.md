# Changelog

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
