# WebCapture

WebCapture saves websites you are allowed to archive to your own computer and replays them later in an isolated, offline viewer. It captures what a real browser renders — pages, images, fonts, video, scripts and the responses those scripts load — so saved pages keep working after the original site changes or goes away.

WebCapture runs entirely on your machine. It listens only on `127.0.0.1`, and nothing is uploaded anywhere.

## Features

- **Full rendering capture.** Pages are opened in an isolated headless Chrome or Edge profile. WebCapture stores the rendered DOM and every resource the page loads: HTML, CSS, all `srcset` image candidates, fonts, GIF, SVG, video, audio, JavaScript modules, Shadow DOM and Canvas snapshots.
- **Site crawling.** WebCapture follows links within the same site. External links can be followed to a depth you choose. Related domains can be grouped with same-site keywords.
- **Safe interactions.** During capture, WebCapture opens tabs, accordions, menus and hover states. Content that appears only after interaction is saved too. It never submits forms, buys, deletes, posts or logs in on your behalf.
- **Video and streaming.** Complete media files are saved, including every segment of HLS and DASH streams. Large media can be downloaded in the background or later.
- **Isolated replay.** Saved sites are replayed in a sandboxed iframe on a separate local origin, with back, forward and reload. Requests are answered from the archive. Script-driven POST requests such as GraphQL or search APIs are matched to the saved responses, and outgoing traffic is blocked.
- **Quality report.** After saving, WebCapture checks every page in a real browser. It reports missing images, fonts and requests, and scores the archive.
- **Resume and repair.** You can pause, resume, continue a stopped capture, retry only the failed pages, or re-save a site and compare it with the previous version.
- **Standard formats.** Archives are stored as content-addressed blobs with a JSON manifest and a WARC 1.1 file. You can export them as a `.webcapture` file, which another WebCapture can import, or as WACZ for tools such as ReplayWeb.page.
- **Login-aware capture (optional).** You can register a login session in a dedicated browser window to save pages that need an account. Cookie values are never shown in the UI or written to logs.
- **Resource-aware.** Capture concurrency adapts to CPU, memory, disk and network load. A low-impact mode is available.
- **English and Japanese UI**, with light and dark themes.

## Requirements

- [Node.js](https://nodejs.org/) 24 or later
- Google Chrome, Microsoft Edge or Chromium
  - Windows and macOS: the standard install location is detected automatically.
  - Linux: `google-chrome`, `chromium` or `microsoft-edge` must be on `PATH`.
  - Any platform: set `WEBCAPTURE_BROWSER` to the browser executable to choose one explicitly.

Windows 11 is the primary development platform. Some extras are Windows-only: desktop notifications, the system load counters and the scripts in `AppDetail/`.

## Getting started

```bash
git clone https://github.com/<your-account>/WebCapture.git
cd WebCapture
npm ci
npm start
```

Then open <http://127.0.0.1:43193/> in your browser. Enter a URL, choose the scope, and press **Start saving**. Saved sites appear on the **Archives** tab.

Archives, login sessions and logs are stored inside the project folder, under `data/` and `runtime/`. They are excluded from Git.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `WEBCAPTURE_PORT` | `43193` | Port of the management UI |
| `WEBCAPTURE_REPLAY_PORT` | `43194` | Port of the isolated replay server |
| `WEBCAPTURE_DATA_ROOT` | `./data` | Where archives and login sessions are stored |
| `WEBCAPTURE_LOG_ROOT` | `./runtime/logs` | Where diagnostic logs are written |
| `WEBCAPTURE_METRICS_ROOT` | `./runtime/metrics` | Where system load samples are written |
| `WEBCAPTURE_BROWSER` | auto-detected | Path to the Chrome, Edge or Chromium executable |

Earlier versions used the name SiteVault. Variables with the old `SITEVAULT_` prefix are still accepted, and `.sitevault` export files can still be imported.

## Security model

- Both servers bind to `127.0.0.1` only. The management API requires a same-origin CSRF token.
- WebCapture refuses URLs that point at localhost, private or link-local networks, reserved ranges, cloud metadata endpoints, or URLs that contain credentials. DNS results are pinned, and every redirect and resource is checked again.
- During capture, only `GET`, `HEAD` and the page's own background `POST` requests are allowed. Form submissions and `PUT`, `PATCH` and `DELETE` requests are blocked.
- Replayed pages cannot reach the network. They run in a sandboxed iframe on a per-archive origin, and passkey and WebAuthn prompts are refused.

## What cannot be reproduced

Server-side behaviour is not reproduced after the original site is gone. This includes searching, posting, logging in, payments, comments, WebSocket, WebRTC, push notifications, DRM-protected media, and responses that depend on the user or the current time. Replay covers the saved responses plus whatever the page's own JavaScript can do on the client.

## Responsible use

Only archive content that you own or have permission to store. `robots.txt` support is optional and is a crawling courtesy, not a grant of rights. Archives made with a login session may contain personal information, so take care before sharing exported files.

## Development

```bash
npm test          # full automated test suite (Node test runner)
npm run check     # syntax and project-structure checks
```

Tests that need a real browser are skipped automatically when no Chrome, Edge or Chromium is found. `Test/README.md` explains what each test covers. Developer notes are kept in Japanese in `PLAN.md`, `API_CHANGE_HANDOFF.md` and `docs/DEVELOPMENT.ja.md`. Contributors, including AI coding agents, should follow `AGENTS.md`.

## License

WebCapture is licensed under the [Apache License 2.0](LICENSE). Third-party notices are listed in [NOTICE](NOTICE).
