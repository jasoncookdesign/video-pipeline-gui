# Documentation index

A routing map from each document to the part of the project it is the source of
truth for. Before completing a change, find the row(s) whose subject your change
touched and update those documents **in the same change** — stale docs are defects.
When you add or remove a document, update this index too.

| Document | Source of truth for |
|---|---|
| [README.md](README.md) | What the control-tower GUI is; prerequisites; build/run/test; how it relates to the `video-pipeline` CLI it is a view over. The entry point. |
| [docs/architecture.md](docs/architecture.md) | The control-tower design: the five tenets, the three layers (frontend / Rust core / Python CLI) and three contracts (schema / IPC / process), the dependency scheduler (skip vs fail), channel binding + descriptors, the single-`<video>` previewer, and the Tauri/Mac-first shell decision. |
| [docs/mac-build-runbook.md](docs/mac-build-runbook.md) | The Mac-only build & verification seams (cargo / Tauri / npm / heavy pipeline deps): what runs on the Mac vs in the sandbox, step order, and pass criteria. |
| [docs/alpha-spike.md](docs/alpha-spike.md) | Historical record of the transparent-layer-in-webview de-risk spike — **superseded** by the h264-proxy previewer design (see the banner in the doc and the Previewer section of `architecture.md`). Kept for history. |

The schema/meta-schema contract this GUI consumes is owned on the pipeline side:
see `video-pipeline/docs/gui-schema.md`.
