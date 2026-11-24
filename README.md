# Packet Flip

A gamified 3D network simulator that runs in the browser. You play a network engineer: you cable switches, routers and firewalls on an isometric board, configure them from forms or a command line, and watch every packet travel the wires.

> Status: early alpha (v0.1). It has a sandbox and 5 scenarios. An endless mode, a campaign and dynamic routing are planned.

## What you can do

- **Build**: place PCs, laptops, servers, printers, IP phones, switches, routers, firewalls and an ISP uplink, then cable them port to port with copper or fiber.
- **Configure** devices through Inspector forms, or through the **NetOS** terminal. NetOS uses common command conventions (`enable`, `configure terminal`, `show ip route`, `?`, Tab completion and abbreviations such as `sh ip int br`). Both edit the same device state.
- **Simulated protocols**: Ethernet, ARP, IPv4, ICMP (ping and traceroute), MAC learning, 802.1Q VLANs and trunks, router-on-a-stick, static routes, DHCP (with relay and APIPA), DNS, HTTP over a simplified TCP, extended ACLs, NAT/PAT with port forwarding, and a stateful zone firewall.
- **Watch**: packets are colored by protocol. When a device drops a packet, it shows the reason (for example "VLAN does not exist", "No ARP reply" or "Blocked by access list"). **Step mode** follows traffic hop by hop and opens any packet layer by layer.
- **Scenarios**: ticket-style jobs with a budget, objectives and 1–3 stars. Objectives are checked by sending real simulated traffic, not just by reading the config.
  1. First Day: switching, IP addressing
  2. Two Floors: routing, default gateways
  3. Ticket #42: troubleshooting masks and gateways
  4. Guest Isolation: VLANs, trunks, router-on-a-stick, ACLs
  5. Going Online: DHCP, DNS, NAT/PAT, port forwarding
- **Sandbox**: no budget and no failure state. It includes traffic generators (web, ping, voice, Internet visitors, simulated port scans), save/load, file export and share links.

## Quick start

```bash
npm ci
npm run dev        # http://127.0.0.1:5173
npm run check      # typecheck + lint + tests
npm run build      # static site in dist/
```

Node 20.19 or newer is required.

### Controls

| Key | Action |
|---|---|
| `V` | Select / drag |
| `C` | Cable tool (click a device, pick a port, click the other device) |
| `P` | Ping tool (source, then destination) |
| `U` / `X` | Unplug a cable / delete |
| `Space` | Pause (or Step in step mode) |
| `R` / `T` | Reset camera / toggle top-down |
| Right-drag, wheel | Pan, zoom |
| `Esc` | Cancel tool / menu |

## Architecture

```
src/sim/          headless, deterministic simulator (no DOM, no Three.js), fully unit-tested
  net/            address math, PDUs
  devices/        Host, Switch, Router, Firewall, Cloud on a shared IPv4 stack (l3.ts)
  services/       DHCP, DNS, HTTP, ACL, NAT
  diag/           ping, traceroute
  traffic/        background traffic generators
src/cli/          NetOS parser, shell, show/running-config renderers
src/persistence/  strict save validator, serializer, share links
src/game/         store, scenarios, objectives, scoring, progress
src/render/       Three.js board: procedural meshes, cables, instanced packets
src/ui/           Preact HUD
tests/            Vitest: simulator, CLI round-trips, persistence fuzzing, scenario solutions
```

ESLint enforces that `src/sim` and `src/cli` stay headless. Every scenario ships a reference solution that is typed through the real CLI. The test suite checks that each solution passes every objective and stays within budget.

## Security and privacy

Packet Flip is designed to be safe to publish and safe for beginners. [SECURITY.md](SECURITY.md) has the full threat model. In short:

- **No real networking.** All traffic, hosts and "attacks" are in-memory simulations. Lint rules ban `fetch`, `WebSocket` and other network APIs.
- **Strict CSP.** The production page sets `script-src 'self'` and `connect-src 'none'`, has no inline scripts, and never uses `eval`.
- **Untrusted input is validated.** Save files, share links and localStorage go through a strict schema with size caps, and prototype-pollution keys are rejected. The validator is fuzz-tested.
- **Share links stay private.** A link stores the network in the URL fragment (`#topo=…`), which browsers never send to the server.
- **No analytics, cookies or third-party requests.**
- **Supply chain.** There are 3 runtime dependencies (three, preact, and the Atkinson Hyperlegible font files), all versions are exact-pinned, and installs run with `--ignore-scripts`. CI runs `npm audit`, CodeQL and Dependabot.
- **Self-hosted font.** The Atkinson Hyperlegible typeface is bundled into the site, so pages make no font requests to Google or anyone else.
- **Secret scanning.** `scripts/check-secrets.mjs` runs as a pre-commit hook (`npm run hooks:install`) and in CI.

To report a vulnerability, use GitHub's private advisory reporting (see SECURITY.md).

## License

Packet Flip is released under the [MIT License](LICENSE). Bundled third-party components keep their own licenses (MIT for three.js and Preact, SIL OFL 1.1 for the Atkinson Hyperlegible font); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The built site ships every license text in `LICENSE.txt` and `licenses/`, and the in-game Help dialog links to them.

## Credits

Bundled third-party components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
