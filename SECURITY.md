# Security Policy

Packet Flip is an educational network simulator that runs entirely in your browser.
This document describes what it is designed to protect, and how to report a problem.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.
Use GitHub's **"Report a vulnerability"** button (Security → Advisories) on this repository
to send a private report. Include steps to reproduce, the affected version or commit, and
what an attacker could achieve. We aim to acknowledge reports within 7 days.

## Supported versions

Only the latest release on the `main` branch receives security fixes.

## Threat model

| Asset / boundary | Risk | Mitigation |
|---|---|---|
| Shared topology links (`?topo=`) and imported save files | Untrusted data crafted to inject script, pollute prototypes, or freeze the tab | Parsed with `JSON.parse` only, then a strict schema validator with size caps (bytes, devices, links, string length); `__proto__` / `constructor` / `prototype` keys rejected; fuzz-tested |
| Player-entered text (device names, CLI input, notes) | Cross-site scripting | Rendered only as text nodes (Preact). ESLint bans `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `dangerouslySetInnerHTML` |
| The simulator itself | A hostile topology creating routing loops or broadcast storms to hang the browser | Every packet carries a TTL; caps on packets in flight, events per tick, and broadcast fan-out |
| The page | Script injection, data exfiltration | Strict Content-Security-Policy (`script-src 'self'`, `connect-src 'none'`, `object-src 'none'`, `base-uri 'none'`); no inline scripts; no `eval` / `new Function` |
| The user's real network | Being used as a scanning or attack tool | **No real networking exists in the code.** All packets, "attacks" and hosts are in-memory simulations. ESLint bans `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `WebTransport`, `RTCPeerConnection` and `sendBeacon` in `src/` |
| Privacy | Tracking | No analytics, telemetry, cookies, or third-party requests. Progress is kept in your browser's `localStorage` only |
| Supply chain | Malicious or compromised dependency | Minimal dependencies, exact-pinned versions, committed lockfile, `npm ci --ignore-scripts`, `npm audit` in CI, Dependabot, CodeQL |
| CI/CD | Token abuse | Workflows default to `contents: read`; only the Pages deploy job gets `pages: write` / `id-token: write`; checkout does not persist credentials |

### Out of scope

- Hosts that cannot send HTTP headers (e.g. GitHub Pages) cannot enforce `frame-ancestors`
  via `<meta>`; clickjacking protection therefore depends on the host.
- Self-hosted forks that relax the CSP or add network features.

## For contributors

- Never render untrusted strings as HTML. Use JSX text or `textContent`.
- Every new import path for external data must go through `src/persistence/validate.ts`.
- New dependencies need a clear justification in the pull request; prefer writing small utilities.
- Run `npm run check` before pushing; CI runs the same checks plus `npm audit`.
