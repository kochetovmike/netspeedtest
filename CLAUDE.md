# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A single-page network speed test, hosted on GitHub Pages as part of the owner's personal site (kochetovmike.github.io). The page should:

- Measure **download and upload speed**: the centerpiece. Each is shown on its own digital gauge styled after a sports-car dashboard (two gauges: one download, one upload).
- Show the visitor's **public IP address and approximate location**.
- List a set of **useful network commands** (for example ping, traceroute, DNS lookup and IP config equivalents).

## Architecture

There are three files: `index.html` (markup), `style.css` (dark theme only, with colour tokens on `:root`) and `app.js` (all the logic, with no dependencies). Only the Orbitron font is loaded externally, from Google Fonts.

`app.js` sections:
- **Gauge class:** builds an SVG arc of 48 segments. `set(mbps)` sets the target, and a single `requestAnimationFrame` loop eases each gauge toward its target. `SCALE` is non-linear (0 to 1000 Mbps), and `valueToFrac` maps a speed to a position on the arc.
- **Measurement:** all traffic goes to `speed.cloudflare.com`.
  - Latency: 20 sequential requests to `GET /__down?bytes=0`. The first is discarded. Ping is the median and jitter is the mean of consecutive differences.
  - Download: parallel `fetch` streams to `/__down?bytes=N`. Bytes are counted as they arrive through `body.getReader()`, and chunk sizes double while each request takes under 1.5 s.
  - Upload: parallel `XMLHttpRequest` POSTs to `/__up`, using XHR rather than fetch because only XHR reports upload progress. Cloudflare answers the CORS preflight that this triggers.
  - A 100 ms sampler drives the live gauge over a sliding window of `windowMs`. The final result excludes the first `warmupFrac` of each phase.
- **Connection info:** `GEO_PROVIDERS` lists ipwho.is, ipinfo.io and geojs.io, each with a function that converts its response to one shared format. They are tried in order until one answers, then the `cf-meta-*` headers from Cloudflare responses, then ipify (IP only). Free providers often return 429, so keep the fallback chain.
- **Commands:** the `COMMANDS` array holds one entry per command with `win`, `mac` and `linux` variants. The selected OS tab is remembered in `localStorage`. Windows commands must work in PowerShell, so use `curl.exe`, not `curl`, and `;`, not `&&`.

Test durations, stream counts and chunk sizes are all in `CFG` at the top of `app.js`.

## Hard constraints

- **Static only: plain HTML/CSS/JS.** No build step, bundler, framework, package.json or server-side code. GitHub Pages serves the files as they are.
- **No backend of our own.** GitHub Pages cannot accept uploads or serve generated payloads. Speed measurement has to go to third-party endpoints that allow CORS (for example Cloudflare's `speed.cloudflare.com/__down?bytes=N` and `/__up`). IP and geolocation also have to come from a public CORS-enabled API. Expect any of these to fail or be rate-limited, so the page should degrade gracefully.
- **Served from a subpath.** As a project repo under a user site, the page is likely served at `https://kochetovmike.github.io/netspeedtest/`. Use relative asset paths, never root-absolute paths (`/...`).
- Any CDN script must be pinned to an exact version. Prefer having no external JS dependencies at all.

## Running locally

Open `index.html` through a local HTTP server rather than `file://`, so that fetch and CORS behave as they will in production:

```sh
python -m http.server 8000
# then visit http://localhost:8000/
```

There are no tests, linters or build commands.

## Deployment

Pushing to `main` deploys the site, provided GitHub Pages is set to serve from the `main` branch root. `index.html` must stay at the repo root.
