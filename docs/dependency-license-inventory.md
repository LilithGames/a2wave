# Dependency License Inventory

Generated: 2026-08-13 · `node scripts/gates/check-license-inventory.mjs --write` · 827 packages

Regenerate with `pnpm licenses:write`; `pnpm licenses:check` verifies this file still matches
the installed dependency tree and is enforced in CI.

Platform-specific native binaries (`@esbuild/linux-x64`, `lightningcss-darwin-arm64`,
`fsevents`, …) are omitted: pnpm installs only the ones matching the host, so listing them
would make this file differ between a macOS laptop and a Linux CI runner. They are still
checked for forbidden licenses, and each carries the same license as its parent package.

## Summary

| License | Packages |
|---|---|
| MIT | 705 |
| ISC | 41 |
| Apache-2.0 | 38 |
| BSD-3-Clause | 23 |
| BSD-2-Clause | 7 |
| BlueOak-1.0.0 | 3 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 |
| (MIT OR CC0-1.0) | 1 |
| (MIT OR WTFPL) | 1 |
| 0BSD | 1 |
| CC-BY-4.0 | 1 |
| MIT AND ISC | 1 |
| MIT OR Apache-2.0 | 1 |
| MIT-0 | 1 |
| MPL-2.0 | 1 |
| OFL-1.1 | 1 |

Result: **no GPL/AGPL/LGPL/SSPL dependencies and no unknown licenses.** The inventory includes notice, attribution, font, and file-level copyleft licenses such as MPL-2.0; release artifacts must retain all applicable notices.

## Full list

| Package | Version(s) | License |
|---|---|---|
| @a2a-js/sdk | 1.0.1 | Apache-2.0 |
| @adobe/css-tools | 4.4.4 | MIT |
| @ant-design/colors | 8.0.1 | MIT |
| @ant-design/cssinjs | 2.1.0 | MIT |
| @ant-design/cssinjs-utils | 2.1.1 | MIT |
| @ant-design/fast-color | 3.0.1 | MIT |
| @ant-design/icons | 6.1.0 | MIT |
| @ant-design/icons-svg | 4.4.2 | MIT |
| @ant-design/react-slick | 2.0.0 | MIT |
| @asamuzakjp/css-color | 3.2.0 | MIT |
| @babel/code-frame | 7.29.0, 7.29.7 | MIT |
| @babel/compat-data | 7.29.0 | MIT |
| @babel/core | 7.29.0 | MIT |
| @babel/generator | 7.29.1 | MIT |
| @babel/helper-annotate-as-pure | 7.27.3 | MIT |
| @babel/helper-compilation-targets | 7.28.6 | MIT |
| @babel/helper-create-class-features-plugin | 7.29.3 | MIT |
| @babel/helper-globals | 7.28.0 | MIT |
| @babel/helper-member-expression-to-functions | 7.28.5 | MIT |
| @babel/helper-module-imports | 7.28.6 | MIT |
| @babel/helper-module-transforms | 7.28.6 | MIT |
| @babel/helper-optimise-call-expression | 7.27.1 | MIT |
| @babel/helper-plugin-utils | 7.28.6 | MIT |
| @babel/helper-replace-supers | 7.28.6 | MIT |
| @babel/helper-skip-transparent-expression-wrappers | 7.27.1 | MIT |
| @babel/helper-string-parser | 7.27.1, 7.29.7 | MIT |
| @babel/helper-validator-identifier | 7.28.5, 7.29.7 | MIT |
| @babel/helper-validator-option | 7.27.1 | MIT |
| @babel/helpers | 7.28.6 | MIT |
| @babel/parser | 7.29.0, 7.29.8 | MIT |
| @babel/plugin-proposal-decorators | 7.29.0 | MIT |
| @babel/plugin-syntax-decorators | 7.28.6 | MIT |
| @babel/plugin-syntax-jsx | 7.28.6 | MIT |
| @babel/plugin-syntax-typescript | 7.28.6 | MIT |
| @babel/plugin-transform-destructuring | 7.28.5 | MIT |
| @babel/plugin-transform-explicit-resource-management | 7.28.6 | MIT |
| @babel/plugin-transform-modules-commonjs | 7.28.6 | MIT |
| @babel/plugin-transform-react-jsx-self | 7.27.1 | MIT |
| @babel/plugin-transform-react-jsx-source | 7.27.1 | MIT |
| @babel/plugin-transform-typescript | 7.28.6 | MIT |
| @babel/preset-typescript | 7.28.5 | MIT |
| @babel/runtime | 7.28.6, 7.29.7 | MIT |
| @babel/template | 7.28.6 | MIT |
| @babel/traverse | 7.29.0 | MIT |
| @babel/types | 7.29.0, 7.29.8 | MIT |
| @bcoe/v8-coverage | 1.0.2 | MIT |
| @biomejs/biome | 1.9.4 | MIT OR Apache-2.0 |
| @codemirror/autocomplete | 6.20.0 | MIT |
| @codemirror/commands | 6.10.2 | MIT |
| @codemirror/language | 6.12.2 | MIT |
| @codemirror/state | 6.5.4 | MIT |
| @codemirror/view | 6.39.15 | MIT |
| @csstools/color-helpers | 5.1.0 | MIT-0 |
| @csstools/css-calc | 2.1.4 | MIT |
| @csstools/css-color-parser | 3.1.0 | MIT |
| @csstools/css-parser-algorithms | 3.0.5 | MIT |
| @csstools/css-tokenizer | 3.0.4 | MIT |
| @discordjs/builders | 1.14.1 | Apache-2.0 |
| @discordjs/collection | 1.5.3, 2.1.1 | Apache-2.0 |
| @discordjs/formatters | 0.6.2 | Apache-2.0 |
| @discordjs/rest | 2.6.3 | Apache-2.0 |
| @discordjs/util | 1.2.0 | Apache-2.0 |
| @discordjs/ws | 1.2.3 | Apache-2.0 |
| @drizzle-team/brocli | 0.10.2 | Apache-2.0 |
| @emotion/hash | 0.8.0 | MIT |
| @emotion/unitless | 0.7.5 | MIT |
| @esbuild-kit/core-utils | 3.3.2 | MIT |
| @esbuild-kit/esm-loader | 2.6.5 | MIT |
| @fastify/deepmerge | 3.2.1 | MIT |
| @floating-ui/core | 1.7.5 | MIT |
| @floating-ui/dom | 1.7.6 | MIT |
| @floating-ui/react-dom | 2.1.8 | MIT |
| @floating-ui/utils | 0.2.11 | MIT |
| @fontsource-variable/inter | 5.2.8 | OFL-1.1 |
| @gilbarbara/deep-equal | 0.4.1 | MIT |
| @gilbarbara/hooks | 0.11.0 | MIT |
| @gilbarbara/types | 0.2.2 | MIT |
| @hono/node-server | 2.0.12 | MIT |
| @hono/swagger-ui | 0.5.3 | MIT |
| @hookform/resolvers | 5.2.2 | MIT |
| @inquirer/ansi | 2.0.5 | MIT |
| @inquirer/checkbox | 5.1.5 | MIT |
| @inquirer/confirm | 6.0.13 | MIT |
| @inquirer/core | 11.1.10 | MIT |
| @inquirer/editor | 5.1.2 | MIT |
| @inquirer/expand | 5.0.14 | MIT |
| @inquirer/external-editor | 3.0.0 | MIT |
| @inquirer/figures | 2.0.5 | MIT |
| @inquirer/input | 5.0.13 | MIT |
| @inquirer/number | 4.0.13 | MIT |
| @inquirer/password | 5.0.13 | MIT |
| @inquirer/prompts | 8.4.3 | MIT |
| @inquirer/rawlist | 5.2.9 | MIT |
| @inquirer/search | 4.1.9 | MIT |
| @inquirer/select | 5.1.5 | MIT |
| @inquirer/type | 4.0.5 | MIT |
| @jridgewell/gen-mapping | 0.3.13 | MIT |
| @jridgewell/remapping | 2.3.5 | MIT |
| @jridgewell/resolve-uri | 3.1.2 | MIT |
| @jridgewell/sourcemap-codec | 1.5.5 | MIT |
| @jridgewell/trace-mapping | 0.3.31 | MIT |
| @larksuiteoapi/node-sdk | 1.59.0 | MIT |
| @lezer/common | 1.5.1 | MIT |
| @lezer/highlight | 1.2.3 | MIT |
| @lezer/lr | 1.4.8 | MIT |
| @marijn/find-cluster-break | 1.0.2 | MIT |
| @modelcontextprotocol/sdk | 1.27.1 | MIT |
| @node-rs/argon2 | 2.0.2 | MIT |
| @node-saml/node-saml | 5.1.0 | MIT |
| @oxc-project/types | 0.142.0, 0.143.0 | MIT |
| @petamoriken/float16 | 3.9.3 | MIT |
| @pinojs/redact | 0.4.0 | MIT |
| @playwright/test | 1.62.1 | Apache-2.0 |
| @protobufjs/aspromise | 1.1.2 | BSD-3-Clause |
| @protobufjs/base64 | 1.1.2 | BSD-3-Clause |
| @protobufjs/codegen | 2.0.5 | BSD-3-Clause |
| @protobufjs/eventemitter | 1.1.1 | BSD-3-Clause |
| @protobufjs/fetch | 1.1.1 | BSD-3-Clause |
| @protobufjs/float | 1.0.2 | BSD-3-Clause |
| @protobufjs/path | 1.1.2 | BSD-3-Clause |
| @protobufjs/pool | 1.1.0 | BSD-3-Clause |
| @protobufjs/utf8 | 1.1.1 | BSD-3-Clause |
| @rc-component/async-validator | 5.1.0 | MIT |
| @rc-component/cascader | 1.14.0 | MIT |
| @rc-component/checkbox | 2.0.0 | MIT |
| @rc-component/collapse | 1.2.0 | MIT |
| @rc-component/color-picker | 3.1.0 | MIT |
| @rc-component/context | 2.0.1 | MIT |
| @rc-component/dialog | 1.8.4 | MIT |
| @rc-component/drawer | 1.4.2 | MIT |
| @rc-component/dropdown | 1.0.2 | MIT |
| @rc-component/form | 1.6.2 | MIT |
| @rc-component/image | 1.6.0 | MIT |
| @rc-component/input | 1.1.2 | MIT |
| @rc-component/input-number | 1.6.2 | MIT |
| @rc-component/mentions | 1.6.0 | MIT |
| @rc-component/menu | 1.2.0 | MIT |
| @rc-component/mini-decimal | 1.1.0 | MIT |
| @rc-component/motion | 1.1.6 | MIT |
| @rc-component/mutate-observer | 2.0.1 | MIT |
| @rc-component/notification | 1.2.0 | MIT |
| @rc-component/overflow | 1.0.0 | MIT |
| @rc-component/pagination | 1.2.0 | MIT |
| @rc-component/picker | 1.9.0 | MIT |
| @rc-component/portal | 2.2.0 | MIT |
| @rc-component/progress | 1.0.2 | MIT |
| @rc-component/qrcode | 1.1.1 | MIT |
| @rc-component/rate | 1.0.1 | MIT |
| @rc-component/resize-observer | 1.1.1 | MIT |
| @rc-component/segmented | 1.3.0 | MIT |
| @rc-component/select | 1.6.5 | MIT |
| @rc-component/slider | 1.0.1 | MIT |
| @rc-component/steps | 1.2.2 | MIT |
| @rc-component/switch | 1.0.3 | MIT |
| @rc-component/table | 1.9.1 | MIT |
| @rc-component/tabs | 1.7.0 | MIT |
| @rc-component/textarea | 1.1.2 | MIT |
| @rc-component/tooltip | 1.4.0 | MIT |
| @rc-component/tour | 2.3.0 | MIT |
| @rc-component/tree | 1.2.3 | MIT |
| @rc-component/tree-select | 1.8.0 | MIT |
| @rc-component/trigger | 3.9.0 | MIT |
| @rc-component/upload | 1.1.0 | MIT |
| @rc-component/util | 1.9.0 | MIT |
| @rc-component/virtual-list | 1.0.2 | MIT |
| @reduxjs/toolkit | 2.12.0 | MIT |
| @rolldown/pluginutils | 1.0.0-beta.27, 1.0.1 | MIT |
| @sapphire/async-queue | 1.5.5 | MIT |
| @sapphire/shapeshift | 4.0.0 | MIT |
| @sapphire/snowflake | 3.5.5 | MIT |
| @sec-ant/readable-stream | 0.4.1 | MIT |
| @sindresorhus/merge-streams | 4.0.0 | MIT |
| @slack/logger | 5.0.0 | MIT |
| @slack/socket-mode | 3.0.0 | MIT |
| @slack/types | 3.0.0 | MIT |
| @slack/web-api | 8.0.0 | MIT |
| @standard-schema/spec | 1.1.0 | MIT |
| @standard-schema/utils | 0.3.0 | MIT |
| @stryker-mutator/api | 9.6.1 | Apache-2.0 |
| @stryker-mutator/core | 9.6.1 | Apache-2.0 |
| @stryker-mutator/instrumenter | 9.6.1 | Apache-2.0 |
| @stryker-mutator/util | 9.6.1 | Apache-2.0 |
| @stryker-mutator/vitest-runner | 9.6.1 | Apache-2.0 |
| @tailwindcss/node | 4.3.3 | MIT |
| @tailwindcss/oxide | 4.3.3 | MIT |
| @tailwindcss/vite | 4.3.3 | MIT |
| @tanstack/query-core | 5.90.20 | MIT |
| @tanstack/react-query | 5.90.20 | MIT |
| @testing-library/dom | 10.4.1 | MIT |
| @testing-library/jest-dom | 6.9.1 | MIT |
| @testing-library/react | 16.3.2 | MIT |
| @testing-library/user-event | 14.6.3 | MIT |
| @types/adm-zip | 0.5.8 | MIT |
| @types/aria-query | 5.0.4 | MIT |
| @types/babel__core | 7.20.5 | MIT |
| @types/babel__generator | 7.27.0 | MIT |
| @types/babel__template | 7.4.4 | MIT |
| @types/babel__traverse | 7.28.0 | MIT |
| @types/better-sqlite3 | 7.6.13 | MIT |
| @types/chai | 5.2.3 | MIT |
| @types/cross-spawn | 6.0.6 | MIT |
| @types/d3-array | 3.2.2 | MIT |
| @types/d3-color | 3.1.3 | MIT |
| @types/d3-ease | 3.0.2 | MIT |
| @types/d3-interpolate | 3.0.4 | MIT |
| @types/d3-path | 3.1.1 | MIT |
| @types/d3-scale | 4.0.9 | MIT |
| @types/d3-shape | 3.1.8 | MIT |
| @types/d3-time | 3.0.4 | MIT |
| @types/d3-timer | 3.0.2 | MIT |
| @types/debug | 4.1.12 | MIT |
| @types/deep-eql | 4.0.2 | MIT |
| @types/estree | 1.0.9 | MIT |
| @types/estree-jsx | 1.0.5 | MIT |
| @types/hast | 3.0.4 | MIT |
| @types/mdast | 4.0.4 | MIT |
| @types/ms | 2.1.0 | MIT |
| @types/mustache | 4.2.6 | MIT |
| @types/node | 22.19.10 | MIT |
| @types/pg | 8.20.4 | MIT |
| @types/qs | 6.15.1 | MIT |
| @types/react | 19.2.13 | MIT |
| @types/react-dom | 19.2.3 | MIT |
| @types/retry | 0.12.0 | MIT |
| @types/sanitize-html | 2.16.1 | MIT |
| @types/unist | 2.0.11, 3.0.3 | MIT |
| @types/use-sync-external-store | 0.0.6 | MIT |
| @types/ws | 8.18.1 | MIT |
| @types/xml-encryption | 1.2.4 | MIT |
| @types/xml2js | 0.4.14 | MIT |
| @ungap/structured-clone | 1.3.0 | ISC |
| @vitejs/plugin-react | 4.7.0 | MIT |
| @vitest/coverage-v8 | 4.1.10 | MIT |
| @vitest/expect | 4.1.10 | MIT |
| @vitest/mocker | 4.1.10 | MIT |
| @vitest/pretty-format | 4.1.10 | MIT |
| @vitest/runner | 4.1.10 | MIT |
| @vitest/snapshot | 4.1.10 | MIT |
| @vitest/spy | 4.1.10 | MIT |
| @vitest/utils | 4.1.10 | MIT |
| @vladfrangu/async_event_emitter | 2.4.7 | MIT |
| @xmldom/is-dom-node | 1.0.1 | MIT |
| @xmldom/xmldom | 0.8.13 | MIT |
| accepts | 2.0.0 | MIT |
| acorn | 8.15.0 | MIT |
| adm-zip | 0.6.0 | MIT |
| agent-base | 6.0.2, 7.1.4 | MIT |
| ajv | 8.18.0 | MIT |
| ajv-formats | 3.0.1 | MIT |
| angular-html-parser | 10.4.0 | MIT |
| ansi-escapes | 7.3.0 | MIT |
| ansi-regex | 5.0.1, 6.2.2 | MIT |
| ansi-styles | 5.2.0, 6.2.3 | MIT |
| antd | 6.3.0 | MIT |
| any-promise | 1.3.0 | MIT |
| argparse | 1.0.10 | MIT |
| aria-query | 5.3.0, 5.3.2 | Apache-2.0 |
| assertion-error | 2.0.1 | MIT |
| ast-v8-to-istanbul | 1.0.5 | MIT |
| asynckit | 0.4.0 | MIT |
| atomic-sleep | 1.0.0 | MIT |
| axios | 1.18.1 | MIT |
| bail | 2.0.2 | MIT |
| balanced-match | 4.0.4 | MIT |
| base64-js | 1.5.1 | MIT |
| baseline-browser-mapping | 2.9.19 | Apache-2.0 |
| better-sqlite3 | 12.11.1 | MIT |
| bindings | 1.5.0 | MIT |
| bl | 4.1.0 | MIT |
| body-parser | 2.3.0 | MIT |
| brace-expansion | 5.0.8 | MIT |
| braces | 3.0.3 | MIT |
| browserslist | 4.28.1 | MIT |
| buffer | 5.7.1 | MIT |
| buffer-from | 1.1.2 | MIT |
| bundle-require | 5.1.0 | MIT |
| bytes | 3.1.2 | MIT |
| cac | 6.7.14 | MIT |
| call-bind-apply-helpers | 1.0.2 | MIT |
| call-bound | 1.0.4 | MIT |
| caniuse-lite | 1.0.30001769 | CC-BY-4.0 |
| ccount | 2.0.1 | MIT |
| chai | 6.2.2 | MIT |
| chalk | 5.6.2 | MIT |
| character-entities | 2.0.2 | MIT |
| character-entities-html4 | 2.1.0 | MIT |
| character-entities-legacy | 3.0.0 | MIT |
| character-reference-invalid | 2.0.1 | MIT |
| chardet | 2.1.1 | MIT |
| chokidar | 4.0.3 | MIT |
| chownr | 1.1.4 | ISC |
| citty | 0.1.6 | MIT |
| class-variance-authority | 0.7.1 | Apache-2.0 |
| cli-cursor | 5.0.0 | MIT |
| cli-truncate | 4.0.0 | MIT |
| cli-width | 4.1.0 | ISC |
| clsx | 2.1.1 | MIT |
| colorette | 2.0.20 | MIT |
| combined-stream | 1.0.8 | MIT |
| comma-separated-tokens | 2.0.3 | MIT |
| commander | 4.1.1, 13.1.0, 14.0.3 | MIT |
| compute-scroll-into-view | 3.1.1 | MIT |
| confbox | 0.1.8 | MIT |
| consola | 3.4.2 | MIT |
| content-disposition | 1.0.1 | MIT |
| content-type | 1.0.5, 2.0.0 | MIT |
| convert-source-map | 2.0.0 | MIT |
| cookie | 0.7.2, 1.1.1 | MIT |
| cookie-signature | 1.2.2 | MIT |
| cors | 2.8.6 | MIT |
| crelt | 1.0.6 | MIT |
| croner | 10.0.1 | MIT |
| cross-spawn | 7.0.6 | MIT |
| css.escape | 1.5.1 | MIT |
| cssstyle | 4.6.0 | MIT |
| csstype | 3.2.3 | MIT |
| d3-array | 3.2.4 | ISC |
| d3-color | 3.1.0 | ISC |
| d3-ease | 3.0.1 | BSD-3-Clause |
| d3-format | 3.1.2 | ISC |
| d3-interpolate | 3.0.1 | ISC |
| d3-path | 3.1.0 | ISC |
| d3-scale | 4.0.2 | ISC |
| d3-shape | 3.2.0 | ISC |
| d3-time | 3.1.0 | ISC |
| d3-time-format | 4.1.0 | ISC |
| d3-timer | 3.0.1 | ISC |
| data-urls | 5.0.0 | MIT |
| date-fns | 4.1.0 | MIT |
| dateformat | 4.6.3 | MIT |
| dayjs | 1.11.19 | MIT |
| debug | 4.4.3 | MIT |
| decimal.js | 10.6.0 | MIT |
| decimal.js-light | 2.5.1 | MIT |
| decode-named-character-reference | 1.3.0 | MIT |
| decompress-response | 6.0.0 | MIT |
| deep-extend | 0.6.0 | MIT |
| deepmerge | 4.3.1 | MIT |
| delayed-stream | 1.0.0 | MIT |
| depd | 2.0.0 | MIT |
| dequal | 2.0.3 | MIT |
| des.js | 1.1.0 | MIT |
| detect-libc | 2.1.2 | Apache-2.0 |
| devlop | 1.1.0 | MIT |
| diff-match-patch | 1.0.5 | Apache-2.0 |
| discord-api-types | 0.38.50 | MIT |
| discord.js | 14.27.0 | Apache-2.0 |
| dom-accessibility-api | 0.5.16, 0.6.3 | MIT |
| dom-serializer | 2.0.0 | MIT |
| domelementtype | 2.3.0 | BSD-2-Clause |
| domhandler | 5.0.3 | BSD-2-Clause |
| domutils | 3.2.2 | BSD-2-Clause |
| drizzle-kit | 0.31.10 | MIT |
| drizzle-orm | 0.45.2 | Apache-2.0 |
| dunder-proto | 1.0.1 | MIT |
| ee-first | 1.1.1 | MIT |
| electron-to-chromium | 1.5.286 | ISC |
| emoji-regex | 10.6.0 | MIT |
| encodeurl | 2.0.0 | MIT |
| end-of-stream | 1.4.5 | MIT |
| enhanced-resolve | 5.24.5 | MIT |
| entities | 4.5.0, 6.0.1, 7.0.1 | BSD-2-Clause |
| env-paths | 3.0.0 | MIT |
| environment | 1.1.0 | MIT |
| es-define-property | 1.0.1 | MIT |
| es-errors | 1.3.0 | MIT |
| es-module-lexer | 2.3.1 | MIT |
| es-object-atoms | 1.1.1 | MIT |
| es-set-tostringtag | 2.1.0 | MIT |
| es-toolkit | 1.50.0 | MIT |
| esbuild | 0.25.12, 0.27.3, 0.28.1 | MIT |
| escalade | 3.2.0 | MIT |
| escape-html | 1.0.3 | MIT |
| escape-string-regexp | 4.0.0, 5.0.0 | MIT |
| esprima | 4.0.1 | BSD-2-Clause |
| estree-util-is-identifier-name | 3.0.0 | MIT |
| estree-walker | 3.0.3 | MIT |
| etag | 1.8.1 | MIT |
| eventemitter3 | 4.0.7, 5.0.4 | MIT |
| eventsource | 3.0.7 | MIT |
| eventsource-parser | 3.0.6 | MIT |
| execa | 8.0.1, 9.6.1 | MIT |
| expand-template | 2.0.3 | (MIT OR WTFPL) |
| expect-type | 1.4.0 | Apache-2.0 |
| express | 5.2.1 | MIT |
| express-rate-limit | 8.5.2 | MIT |
| extend | 3.0.2 | MIT |
| extend-shallow | 2.0.1 | MIT |
| fast-copy | 4.0.2 | MIT |
| fast-deep-equal | 3.1.3 | MIT |
| fast-safe-stringify | 2.1.1 | MIT |
| fast-string-truncated-width | 3.0.3 | MIT |
| fast-string-width | 3.0.2 | MIT |
| fast-uri | 3.1.5 | BSD-3-Clause |
| fast-wrap-ansi | 0.2.0 | MIT |
| fd-package-json | 2.0.0 | MIT |
| fdir | 6.5.0 | MIT |
| figures | 6.1.0 | MIT |
| file-uri-to-path | 1.0.0 | MIT |
| fill-range | 7.1.1 | MIT |
| finalhandler | 2.1.1 | MIT |
| fix-dts-default-cjs-exports | 1.0.1 | MIT |
| follow-redirects | 1.16.0 | MIT |
| form-data | 4.0.6 | MIT |
| formatly | 0.3.0 | MIT |
| forwarded | 0.2.0 | MIT |
| fresh | 2.0.0 | MIT |
| fs-constants | 1.0.0 | MIT |
| function-bind | 1.1.2 | MIT |
| gel | 2.2.0 | Apache-2.0 |
| gensync | 1.0.0-beta.2 | MIT |
| get-east-asian-width | 1.6.0 | MIT |
| get-intrinsic | 1.3.0 | MIT |
| get-proto | 1.0.1 | MIT |
| get-stream | 8.0.1, 9.0.1 | MIT |
| get-tsconfig | 4.13.6, 4.14.1 | MIT |
| github-from-package | 0.0.0 | MIT |
| gopd | 1.2.0 | MIT |
| graceful-fs | 4.2.11 | ISC |
| gray-matter | 4.0.3 | MIT |
| has-flag | 4.0.0 | MIT |
| has-symbols | 1.1.0 | MIT |
| has-tostringtag | 1.0.2 | MIT |
| hasown | 2.0.4 | MIT |
| hast-util-to-jsx-runtime | 2.3.6 | MIT |
| hast-util-whitespace | 3.0.0 | MIT |
| help-me | 5.0.0 | MIT |
| hono | 4.12.34 | MIT |
| html-encoding-sniffer | 4.0.0 | MIT |
| html-escaper | 2.0.2 | MIT |
| html-parse-stringify | 3.0.1 | MIT |
| html-url-attributes | 3.0.1 | MIT |
| htmlparser2 | 10.1.0 | MIT |
| http-errors | 2.0.1 | MIT |
| http-proxy-agent | 7.0.2 | MIT |
| https-proxy-agent | 5.0.1, 7.0.6 | MIT |
| human-signals | 5.0.0, 8.0.1 | Apache-2.0 |
| husky | 9.1.7 | MIT |
| i18next | 25.8.13 | MIT |
| iconv-lite | 0.6.3, 0.7.2 | MIT |
| ieee754 | 1.2.1 | BSD-3-Clause |
| immer | 11.1.15 | MIT |
| indent-string | 4.0.0 | MIT |
| inherits | 2.0.4 | ISC |
| ini | 1.3.8 | ISC |
| inline-style-parser | 0.2.7 | MIT |
| internmap | 2.0.3 | ISC |
| ip-address | 10.3.1 | MIT |
| ipaddr.js | 1.9.1, 2.4.0 | MIT |
| is-alphabetical | 2.0.1 | MIT |
| is-alphanumerical | 2.0.1 | MIT |
| is-decimal | 2.0.1 | MIT |
| is-extendable | 0.1.1 | MIT |
| is-fullwidth-code-point | 4.0.0, 5.1.0 | MIT |
| is-hexadecimal | 2.0.1 | MIT |
| is-lite | 2.0.0 | MIT |
| is-mobile | 5.0.0 | MIT |
| is-number | 7.0.0 | MIT |
| is-plain-obj | 4.1.0 | MIT |
| is-plain-object | 5.0.0 | MIT |
| is-potential-custom-element-name | 1.0.1 | MIT |
| is-promise | 4.0.0 | MIT |
| is-stream | 3.0.0, 4.0.1 | MIT |
| is-unicode-supported | 2.1.0 | MIT |
| isexe | 3.1.5 | BlueOak-1.0.0 |
| isexe | 2.0.0 | ISC |
| istanbul-lib-coverage | 3.2.2 | BSD-3-Clause |
| istanbul-lib-report | 3.0.1 | BSD-3-Clause |
| istanbul-reports | 3.2.0 | BSD-3-Clause |
| jiti | 2.7.0 | MIT |
| jose | 5.10.0, 6.2.3 | MIT |
| joycon | 3.1.1 | MIT |
| js-md4 | 0.3.2 | MIT |
| js-tokens | 4.0.0, 10.0.0 | MIT |
| js-yaml | 3.15.1 | MIT |
| jsdom | 25.0.1 | MIT |
| jsesc | 3.1.0 | MIT |
| json-rpc-2.0 | 1.7.1 | MIT |
| json-schema-traverse | 1.0.0 | MIT |
| json-schema-typed | 8.0.2 | BSD-2-Clause |
| json2mq | 0.2.0 | MIT |
| json5 | 2.2.3 | MIT |
| kind-of | 6.0.3 | MIT |
| knip | 6.32.0 | ISC |
| launder | 1.7.1 | MIT |
| lightningcss | 1.32.0, 1.33.0 | MPL-2.0 |
| lilconfig | 3.1.3 | MIT |
| lines-and-columns | 1.2.4 | MIT |
| lint-staged | 15.5.2 | MIT |
| listr2 | 8.3.3 | MIT |
| load-tsconfig | 0.2.5 | MIT |
| lodash | 4.18.1 | MIT |
| lodash.groupby | 4.6.0 | MIT |
| lodash.identity | 3.0.0 | MIT |
| lodash.merge | 4.6.2 | MIT |
| lodash.pickby | 4.6.0 | MIT |
| lodash.snakecase | 4.1.1 | MIT |
| log-update | 6.1.0 | MIT |
| long | 5.3.2 | Apache-2.0 |
| longest-streak | 3.1.0 | MIT |
| lru-cache | 5.1.1, 10.4.3 | ISC |
| lucide-react | 0.469.0 | ISC |
| lz-string | 1.5.0 | MIT |
| magic-bytes.js | 1.13.0 | MIT |
| magic-string | 0.30.21 | MIT |
| magicast | 0.5.4 | MIT |
| make-dir | 4.0.0 | MIT |
| markdown-table | 3.0.4 | MIT |
| marked | 18.0.5 | MIT |
| math-intrinsics | 1.1.0 | MIT |
| mdast-util-find-and-replace | 3.0.2 | MIT |
| mdast-util-from-markdown | 2.0.3 | MIT |
| mdast-util-gfm | 3.1.0 | MIT |
| mdast-util-gfm-autolink-literal | 2.0.1 | MIT |
| mdast-util-gfm-footnote | 2.1.0 | MIT |
| mdast-util-gfm-strikethrough | 2.0.0 | MIT |
| mdast-util-gfm-table | 2.0.0 | MIT |
| mdast-util-gfm-task-list-item | 2.0.0 | MIT |
| mdast-util-mdx-expression | 2.0.1 | MIT |
| mdast-util-mdx-jsx | 3.2.0 | MIT |
| mdast-util-mdxjs-esm | 2.0.1 | MIT |
| mdast-util-phrasing | 4.1.0 | MIT |
| mdast-util-to-hast | 13.2.1 | MIT |
| mdast-util-to-markdown | 2.1.2 | MIT |
| mdast-util-to-string | 4.0.0 | MIT |
| media-typer | 1.1.0 | MIT |
| merge-descriptors | 2.0.0 | MIT |
| merge-stream | 2.0.0 | MIT |
| micromark | 4.0.2 | MIT |
| micromark-core-commonmark | 2.0.3 | MIT |
| micromark-extension-gfm | 3.0.0 | MIT |
| micromark-extension-gfm-autolink-literal | 2.1.0 | MIT |
| micromark-extension-gfm-footnote | 2.1.0 | MIT |
| micromark-extension-gfm-strikethrough | 2.1.0 | MIT |
| micromark-extension-gfm-table | 2.1.1 | MIT |
| micromark-extension-gfm-tagfilter | 2.0.0 | MIT |
| micromark-extension-gfm-task-list-item | 2.1.0 | MIT |
| micromark-factory-destination | 2.0.1 | MIT |
| micromark-factory-label | 2.0.1 | MIT |
| micromark-factory-space | 2.0.1 | MIT |
| micromark-factory-title | 2.0.1 | MIT |
| micromark-factory-whitespace | 2.0.1 | MIT |
| micromark-util-character | 2.1.1 | MIT |
| micromark-util-chunked | 2.0.1 | MIT |
| micromark-util-classify-character | 2.0.1 | MIT |
| micromark-util-combine-extensions | 2.0.1 | MIT |
| micromark-util-decode-numeric-character-reference | 2.0.2 | MIT |
| micromark-util-decode-string | 2.0.1 | MIT |
| micromark-util-encode | 2.0.1 | MIT |
| micromark-util-html-tag-name | 2.0.1 | MIT |
| micromark-util-normalize-identifier | 2.0.1 | MIT |
| micromark-util-resolve-all | 2.0.1 | MIT |
| micromark-util-sanitize-uri | 2.0.1 | MIT |
| micromark-util-subtokenize | 2.1.0 | MIT |
| micromark-util-symbol | 2.0.1 | MIT |
| micromark-util-types | 2.0.2 | MIT |
| micromatch | 4.0.8 | MIT |
| mime-db | 1.52.0, 1.54.0 | MIT |
| mime-types | 2.1.35, 3.0.2 | MIT |
| mimic-fn | 4.0.0 | MIT |
| mimic-function | 5.0.1 | MIT |
| mimic-response | 3.1.0 | MIT |
| min-indent | 1.0.1 | MIT |
| minimalistic-assert | 1.0.1 | ISC |
| minimatch | 10.2.5 | BlueOak-1.0.0 |
| minimist | 1.2.8 | MIT |
| mkdirp-classic | 0.5.3 | MIT |
| mlly | 1.8.0 | MIT |
| ms | 2.1.3 | MIT |
| mustache | 4.2.0 | MIT |
| mutation-server-protocol | 0.4.1 | Apache-2.0 |
| mutation-testing-elements | 3.7.3 | Apache-2.0 |
| mutation-testing-metrics | 3.7.3 | Apache-2.0 |
| mutation-testing-report-schema | 3.7.3 | Apache-2.0 |
| mute-stream | 3.0.0 | ISC |
| mz | 2.7.0 | MIT |
| nanoid | 3.3.16, 3.3.17 | MIT |
| napi-build-utils | 2.0.0 | MIT |
| negotiator | 1.0.0 | MIT |
| node-abi | 3.87.0 | MIT |
| node-releases | 2.0.27 | MIT |
| npm-run-path | 5.3.0, 6.0.0 | MIT |
| nwsapi | 2.2.23 | MIT |
| oauth4webapi | 3.8.6 | MIT |
| object-assign | 4.1.1 | MIT |
| object-inspect | 1.13.4 | MIT |
| obug | 2.1.4 | MIT |
| on-exit-leak-free | 2.1.2 | MIT |
| on-finished | 2.4.1 | MIT |
| once | 1.4.0 | ISC |
| onetime | 6.0.0, 7.0.0 | MIT |
| openid-client | 6.8.4 | MIT |
| oxc-parser | 0.142.0 | MIT |
| oxc-resolver | 11.24.2 | MIT |
| p-finally | 1.0.0 | MIT |
| p-queue | 6.6.2 | MIT |
| p-retry | 4.6.2 | MIT |
| p-timeout | 3.2.0 | MIT |
| parse-entities | 4.0.2 | MIT |
| parse-ms | 4.0.0 | MIT |
| parse-srcset | 1.0.2 | MIT |
| parse5 | 7.3.0 | MIT |
| parseurl | 1.3.3 | MIT |
| path-key | 3.1.1, 4.0.0 | MIT |
| path-to-regexp | 8.4.2 | MIT |
| pathe | 2.0.3 | MIT |
| pg | 8.22.0 | MIT |
| pg-cloudflare | 1.4.0 | MIT |
| pg-connection-string | 2.14.0 | MIT |
| pg-int8 | 1.0.1 | ISC |
| pg-pool | 3.14.0 | MIT |
| pg-protocol | 1.15.0 | MIT |
| pg-types | 2.2.0 | MIT |
| pgpass | 1.0.5 | MIT |
| picocolors | 1.1.1 | ISC |
| picomatch | 2.3.2, 4.0.5 | MIT |
| pidtree | 0.6.0 | MIT |
| pino | 10.3.1 | MIT |
| pino-abstract-transport | 3.0.0 | MIT |
| pino-pretty | 13.1.3 | MIT |
| pino-roll | 4.0.0 | MIT |
| pino-std-serializers | 7.1.0 | MIT |
| pirates | 4.0.7 | MIT |
| pkce-challenge | 5.0.1 | MIT |
| pkg-types | 1.3.1 | MIT |
| playwright | 1.62.1 | Apache-2.0 |
| playwright-core | 1.62.1 | Apache-2.0 |
| postcss | 8.5.25, 8.5.26 | MIT |
| postcss-load-config | 6.0.1 | MIT |
| postgres-array | 2.0.0 | MIT |
| postgres-bytea | 1.0.1 | MIT |
| postgres-date | 1.0.7 | MIT |
| postgres-interval | 1.2.0 | MIT |
| prebuild-install | 7.1.3 | MIT |
| pretty-format | 27.5.1 | MIT |
| pretty-ms | 9.3.0 | MIT |
| process-warning | 5.1.0 | MIT |
| progress | 2.0.3 | MIT |
| property-information | 7.1.0 | MIT |
| protobufjs | 7.6.5 | BSD-3-Clause |
| proxy-addr | 2.0.7 | MIT |
| proxy-from-env | 2.1.0 | MIT |
| pump | 3.0.3 | MIT |
| punycode | 2.3.1 | MIT |
| qs | 6.15.2 | BSD-3-Clause |
| quick-format-unescaped | 4.0.4 | MIT |
| range-parser | 1.2.1 | MIT |
| raw-body | 3.0.2 | MIT |
| rc | 1.2.8 | (BSD-2-Clause OR MIT OR Apache-2.0) |
| react | 19.2.4 | MIT |
| react-dom | 19.2.4 | MIT |
| react-hook-form | 7.71.1 | MIT |
| react-i18next | 16.5.4 | MIT |
| react-innertext | 1.1.5 | MIT |
| react-is | 17.0.2, 18.3.1 | MIT |
| react-joyride | 3.1.0 | MIT |
| react-markdown | 10.1.0 | MIT |
| react-redux | 9.3.0 | MIT |
| react-refresh | 0.17.0 | MIT |
| react-router | 7.18.2 | MIT |
| react-router-dom | 7.18.2 | MIT |
| readable-stream | 3.6.2 | MIT |
| readdirp | 4.1.2 | MIT |
| real-require | 0.2.0, 1.0.0 | MIT |
| recharts | 3.10.1 | MIT |
| redent | 3.0.0 | MIT |
| redux | 5.0.1 | MIT |
| redux-thunk | 3.1.0 | MIT |
| remark-gfm | 4.0.1 | MIT |
| remark-parse | 11.0.0 | MIT |
| remark-rehype | 11.1.2 | MIT |
| remark-stringify | 11.0.0 | MIT |
| require-from-string | 2.0.2 | MIT |
| reselect | 5.2.0 | MIT |
| resolve-from | 5.0.0 | MIT |
| resolve-pkg-maps | 1.0.0 | MIT |
| restore-cursor | 5.1.0 | MIT |
| retry | 0.13.1 | MIT |
| rfdc | 1.4.1 | MIT |
| rolldown | 1.2.3 | MIT |
| rollup | 4.61.0 | MIT |
| router | 2.2.0 | MIT |
| rrweb-cssom | 0.7.1, 0.8.0 | MIT |
| rxjs | 7.8.2 | Apache-2.0 |
| safe-buffer | 5.2.1 | MIT |
| safe-stable-stringify | 2.5.0 | MIT |
| safer-buffer | 2.1.2 | MIT |
| sanitize-html | 2.17.5 | MIT |
| sax | 1.6.0 | BlueOak-1.0.0 |
| saxes | 6.0.0 | ISC |
| scheduler | 0.27.0 | MIT |
| scroll | 3.0.1 | MIT |
| scroll-into-view-if-needed | 3.1.0 | MIT |
| scrollparent | 2.1.0 | ISC |
| section-matter | 1.0.0 | MIT |
| secure-json-parse | 4.1.0 | BSD-3-Clause |
| semver | 6.3.1, 7.7.4, 7.8.5 | ISC |
| send | 1.2.1 | MIT |
| serve-static | 2.2.1 | MIT |
| set-cookie-parser | 2.7.2 | MIT |
| setprototypeof | 1.2.0 | ISC |
| shebang-command | 2.0.0 | MIT |
| shebang-regex | 3.0.0 | MIT |
| shell-quote | 1.10.0 | MIT |
| side-channel | 1.1.0 | MIT |
| side-channel-list | 1.0.0 | MIT |
| side-channel-map | 1.0.1 | MIT |
| side-channel-weakmap | 1.0.2 | MIT |
| siginfo | 2.0.0 | ISC |
| signal-exit | 4.1.0 | ISC |
| simple-concat | 1.0.1 | MIT |
| simple-get | 4.0.1 | MIT |
| slice-ansi | 5.0.0, 7.1.2 | MIT |
| smol-toml | 1.7.1 | BSD-3-Clause |
| sonic-boom | 4.2.0, 4.2.1 | MIT |
| source-map | 0.6.1, 0.7.6 | BSD-3-Clause |
| source-map-js | 1.2.1 | BSD-3-Clause |
| source-map-support | 0.5.21 | MIT |
| space-separated-tokens | 2.0.2 | MIT |
| split2 | 4.2.0 | ISC |
| sprintf-js | 1.0.3 | BSD-3-Clause |
| stackback | 0.0.2 | MIT |
| statuses | 2.0.2 | MIT |
| std-env | 4.2.0 | MIT |
| string_decoder | 1.3.0 | MIT |
| string-argv | 0.3.2 | MIT |
| string-convert | 0.2.1 | MIT |
| string-width | 7.2.0 | MIT |
| stringify-entities | 4.0.4 | MIT |
| strip-ansi | 7.2.0 | MIT |
| strip-bom-string | 1.0.0 | MIT |
| strip-final-newline | 3.0.0, 4.0.0 | MIT |
| strip-indent | 3.0.0 | MIT |
| strip-json-comments | 2.0.1, 5.0.3 | MIT |
| style-mod | 4.1.3 | MIT |
| style-to-js | 1.1.21 | MIT |
| style-to-object | 1.0.14 | MIT |
| stylis | 4.3.6 | MIT |
| sucrase | 3.35.1 | MIT |
| supports-color | 7.2.0 | MIT |
| symbol-tree | 3.2.4 | MIT |
| tailwind-merge | 2.6.1 | MIT |
| tailwindcss | 4.3.3 | MIT |
| tapable | 2.3.3 | MIT |
| tar-fs | 2.1.4 | MIT |
| tar-stream | 2.2.0 | MIT |
| thenify | 3.3.1 | MIT |
| thenify-all | 1.6.0 | MIT |
| thread-stream | 4.2.0 | MIT |
| throttle-debounce | 5.0.2 | MIT |
| tiny-invariant | 1.3.3 | MIT |
| tinybench | 2.9.0 | MIT |
| tinyexec | 0.3.2, 1.3.0 | MIT |
| tinyglobby | 0.2.15, 0.2.17 | MIT |
| tinyrainbow | 3.1.1 | MIT |
| tldts | 6.1.86 | MIT |
| tldts-core | 6.1.86 | MIT |
| to-regex-range | 5.0.1 | MIT |
| toidentifier | 1.0.1 | MIT |
| tough-cookie | 5.1.2 | BSD-3-Clause |
| tr46 | 5.1.1 | MIT |
| tree-kill | 1.2.2 | MIT |
| trim-lines | 3.0.1 | MIT |
| trough | 2.2.0 | MIT |
| ts-interface-checker | 0.1.13 | Apache-2.0 |
| ts-mixer | 6.0.4 | MIT |
| tslib | 2.8.1 | 0BSD |
| tsup | 8.5.1 | MIT |
| tsx | 4.23.5 | MIT |
| tunnel | 0.0.6 | MIT |
| tunnel-agent | 0.6.0 | Apache-2.0 |
| type-fest | 4.41.0 | (MIT OR CC0-1.0) |
| type-is | 2.0.1, 2.1.0 | MIT |
| typed-inject | 5.0.0 | Apache-2.0 |
| typed-rest-client | 2.3.1 | MIT |
| typescript | 5.9.3 | Apache-2.0 |
| ufo | 1.6.3 | MIT |
| unbash | 4.0.6 | ISC |
| underscore | 1.13.8 | MIT |
| undici | 6.28.0, 7.29.0 | MIT |
| undici-types | 6.21.0 | MIT |
| unicorn-magic | 0.3.0 | MIT |
| unified | 11.0.5 | MIT |
| unist-util-is | 6.0.1 | MIT |
| unist-util-position | 5.0.0 | MIT |
| unist-util-stringify-position | 4.0.0 | MIT |
| unist-util-visit | 5.1.0 | MIT |
| unist-util-visit-parents | 6.0.2 | MIT |
| unpipe | 1.0.0 | MIT |
| update-browserslist-db | 1.2.3 | MIT |
| use-sync-external-store | 1.6.0 | MIT |
| util-deprecate | 1.0.2 | MIT |
| uuid | 14.0.0 | MIT |
| vary | 1.1.2 | MIT |
| vfile | 6.0.3 | MIT |
| vfile-message | 4.0.3 | MIT |
| victory-vendor | 37.3.6 | MIT AND ISC |
| vite | 8.2.0 | MIT |
| vitest | 4.1.10 | MIT |
| void-elements | 3.1.0 | MIT |
| w3c-keyname | 2.2.8 | MIT |
| w3c-xmlserializer | 5.0.0 | MIT |
| walk-up-path | 4.0.0 | ISC |
| weapon-regex | 1.3.6 | Apache-2.0 |
| webidl-conversions | 7.0.0 | BSD-2-Clause |
| whatwg-encoding | 3.1.1 | MIT |
| whatwg-mimetype | 4.0.0 | MIT |
| whatwg-url | 14.2.0 | MIT |
| which | 2.0.2, 4.0.0 | ISC |
| why-is-node-running | 2.3.0 | MIT |
| wrap-ansi | 9.0.2 | MIT |
| wrappy | 1.0.2 | ISC |
| ws | 8.21.0 | MIT |
| xml-crypto | 6.1.2 | MIT |
| xml-encryption | 3.1.0 | MIT |
| xml-name-validator | 5.0.0 | Apache-2.0 |
| xml2js | 0.6.2 | MIT |
| xmlbuilder | 11.0.1, 15.1.1 | MIT |
| xmlchars | 2.2.0 | MIT |
| xpath | 0.0.32, 0.0.33, 0.0.34 | MIT |
| xtend | 4.0.2 | MIT |
| yallist | 3.1.1 | ISC |
| yaml | 2.9.0 | ISC |
| yoctocolors | 2.1.2 | MIT |
| zod | 3.25.76, 4.4.3 | MIT |
| zod-to-json-schema | 3.25.1 | ISC |
| zwitch | 2.0.4 | MIT |
