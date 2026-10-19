# Third-party code and related projects

This project is an independent DeepSeek Harness extension. It is not an official
DeepSeek, OpenAI, or Pi product. Existing copyright notices and licenses apply to
the components listed below.

| Component | Source and version | License in this repository |
| --- | --- | --- |
| Web request encoder and response normalization | [`@howaboua/pi-codex-web-run`](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-codex-web-run), 0.0.7 | [`src/tools/vendor/web/LICENSE`](src/tools/vendor/web/LICENSE) |
| Image HTTP client, auth helpers, retry logic, types, and adapted PNG validation | [`@crazygit/pi-codex-image-gen`](https://github.com/crazygit/pi-codex-image-gen), 0.2.2 | [`src/tools/vendor/image/LICENSE`](src/tools/vendor/image/LICENSE) |
| Native Codex compaction protocol and history helpers | Pi `pi-codex-compact`, 1.3.3, Copyright 2026 Narumi | [`src/compact/LICENSE.pi-codex-compact`](src/compact/LICENSE.pi-codex-compact) |
| Service-tier domain logic | Pi `pi-service-tier`, 0.4.0, Copyright 2026 Matthias Vallentin | [`src/tier/LICENSE.pi-service-tier`](src/tier/LICENSE.pi-service-tier) |
| Portable compaction extraction policy | [`kb-repomap`](https://github.com/yukimaru77/kb-repomap), TypeScript implementation from the author's local `codex-portable-compact` project | [`LICENSE`](LICENSE) |

All of the above licenses are MIT. Additional implementation notes for the web
and image components are in [`src/tools/vendor/NOTICE.md`](src/tools/vendor/NOTICE.md).

The build derives the agent preset from the installed DeepSeek Harness source
checkout and bundles parts of its Pi adapter. DeepSeek Harness is MIT licensed;
its copyright notice is retained in [`licenses/DeepSeek-Harness.txt`](licenses/DeepSeek-Harness.txt).
Generated configuration and compiled output are excluded from Git.

`dsh-ssh-remote` and `@deepseek-harness-tui/dsh-tui` are separate upstream projects,
not code authored by this repository. They are installed separately. The author's
forks preserve the upstream history:

- [SSH fork](https://github.com/yukimaru77/dsh-kylin-ssh-tunnel) — [upstream](https://github.com/kkutysllb/dsh-kylin-ssh-tunnel)
- [TUI fork](https://github.com/yukimaru77/dsh-TUI) — [upstream](https://github.com/ccch1mneyyy/dsh-TUI)
