# Vendored Pi cores

Copied from installed packages (not fetched):

- `web/request.ts`: `@howaboua/pi-codex-web-run` **0.0.7**, `src/request.ts`, unchanged. `web/contract.ts` supplies only the upstream constant/type and avoids loading Pi/TypeBox. MIT license retained in `web/LICENSE`.
- `image/{client/codex-images.ts,auth/codex-auth.ts,runtime/retry.ts,errors.ts,types.ts}`: `@crazygit/pi-codex-image-gen` **0.2.2**, unchanged. MIT license retained in `image/LICENSE`.
- `../image.ts::decodePngBase64` adapts the same image package's `src/output/image-store.ts` validation, under that license.

Adapter schemas in `../index.ts` reproduce the installed web/image interfaces in DSH's schema DSL. The upstream web executor was inspected; its command encoder and normalizer are reused, but its environment/config/cookie/proxy discovery is not. Its HTTP/auth orchestration is replaced with injected host auth, a fixed official endpoint, redirect rejection, and bounded response decoding.

The upstream image generator/store/reference planner were inspected. Their local filesystem operations and Pi-global output paths are NOT used: DSH attachment/fs/approval capabilities replace those boundaries, while the actual image HTTP client, retry rules, endpoint whitelist and response parser are reused. No Pi runtime provider or agent backend is loaded by this adapter.
