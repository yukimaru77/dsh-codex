# Vendored DeepSeek Harness Pi adapter sources

`config.ts`, `catalog.ts`, `provider.ts`, `models.ts`, `context.ts`, `replay.ts`, and
`stream.ts` are copied from DeepSeek Harness tag `dsh-v0.2.1-rc.2`
(commit `687f282e8625c6b8d11ff58211a90524be2e4317`), `packages/llm/llm-pi-ai/src/`. They are unchanged except for a `// @ts-nocheck` header on
`catalog.ts`: its compile-time drift gate lists the compat fields of pi-ai 1.1.0, while the
released installation carries pi-ai 1.3.0 (one added field). The released adapter runs the same
code against 1.3.0, so only the type check differs.

The released `@deepseek-ai/dsh-llm-pi-ai` package exposes only its bundled entry, not
these internal helpers. Carrying the same-version sources here lets this bundle build
without a DeepSeek Harness source checkout; their package imports still resolve to
the running DSH installation. Re-copy them from the matching tag when the pinned DSH
version changes.

MIT licensed; the copyright notice is retained in `licenses/DeepSeek-Harness.txt`.
