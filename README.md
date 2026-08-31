# Unisol

Unisol is a modular Cloudflare Worker tunnel gateway built after studying useful design patterns in [`cmliu/edgetunnel`](https://github.com/cmliu/edgetunnel) and [`byJoey/cfnew`](https://github.com/byJoey/cfnew). It is an independent implementation rather than a fork or a copied single-file source.

Version 0.2 adds an **adaptive egress** path designed for the common Worker problem where ordinary destinations respond normally but Cloudflare-fronted destinations can stall. It does not copy cfnew's fixed built-in fallback list: Unisol waits for evidence of a real stall, inspects the application hostname, classifies it with DNS-over-HTTPS, dynamically discovers current Cloudflare edge addresses, and races only the routes that make sense.

## What it supports

- VLESS TCP over WebSocket
- VLESS TCP over XHTTP (`stream-one` style request/response streaming)
- Trojan TCP over WebSocket
- Trojan TCP over XHTTP
- VLESS UDP DNS on port 53, translated to DNS-over-HTTPS
- Adaptive direct/edge egress with first-byte health checks
- TLS ClientHello SNI and HTTP Host inspection for routing only
- Dynamic Cloudflare classification using DoH and Cloudflare's published IPv4 ranges
- Dynamic edge candidates rather than a copied fixed ProxyIP pool
- Per-isolate edge success scoring and failure cooldowns
- Direct outbound TCP with configurable connection racing
- Optional manual ProxyIP/fallback destinations
- SOCKS5 outbound, with or without username/password
- HTTP CONNECT outbound, with optional Basic authentication
- HTTPS CONNECT outbound, with TLS on the Worker-to-proxy hop
- Per-domain routing rules
- `adaptive`, `proxy-first`, `direct-first`, `proxy-only`, and `direct` outbound modes
- Optional IPv6-disable policy
- Literal private/local destination filtering by default
- Optional per-connection outbound overrides
- KV-backed live configuration and an `/admin` interface
- Raw/Base64, Clash, and Sing-box subscription output
- A normal-looking cafe page at `/`

## Architecture

```text
src/index.js          HTTP routing / control plane
src/core.js           config parsing, endpoints, policy, route matching
src/adaptive.js       SNI/Host sniffing, DoH classification, edge scoring
src/protocol.js       VLESS + Trojan wire protocol parsing
src/outbound.js       adaptive/direct/SOCKS5/HTTP(S) CONNECT egress
src/transport.js      bounded upload queue + stream aggregation
src/session.js        WebSocket / XHTTP sessions + DNS framing
src/subscription.js   node links + Clash / Sing-box generation
src/store.js          KV configuration cache and persistence
src/ui.js             camouflage and admin pages
```

The transport code does not need to know how a SOCKS5 handshake works, and the adaptive classifier does not need to know whether ingress was WebSocket or XHTTP.

## Adaptive egress

`adaptive` is the default mode in v0.2.

For a normal TCP request with initial application data, the sequence is:

```text
1. Open original destination directly
2. Send the untouched client bytes
3. If a response arrives before the hedge delay -> keep direct
4. If it stalls -> inspect SNI / HTTP Host
5. Resolve that application hostname with Cloudflare DoH
6. Continue edge logic only if its A records are inside Cloudflare's published ranges
7. Discover current edge candidates from live DNS and derive a target-range sibling candidate
8. Race the still-pending direct socket against a small number of edge candidates
9. First route that returns actual response bytes wins
10. Close every losing and late-opening socket
11. If all adaptive routes fail -> manual ProxyIP -> configured SOCKS/HTTP(S) proxy
```

A TCP socket being "opened" is not treated as proof that the route works. The adaptive path uses **first response byte** as the health signal and preserves that byte when handing the winning socket back to the tunnel session.

### Why it differs from a fixed fallback list

Unisol intentionally does not ship a copied set of ten or twenty Cloudflare addresses. Instead:

- fast direct traffic incurs no DoH classification request;
- only stalled traffic is classified;
- non-Cloudflare destinations are not sprayed at Cloudflare addresses;
- current edge candidates are obtained from live DNS;
- Cloudflare ownership is checked against an embedded copy of the published IPv4 CIDR set;
- a deterministic sibling candidate can be derived inside the target Cloudflare range;
- failed edge candidates receive an isolate-local exponential cooldown;
- successful candidates receive a small preference score;
- candidate racing is bounded to avoid unnecessary sockets.

This is still an opportunistic workaround, not a Cloudflare platform guarantee. See **Cloudflare platform constraints** below.

## Required configuration

The tunnel needs a valid UUIDv4. It can be supplied directly as a Worker variable:

```text
UUID=90cd4a77-141a-43c9-991b-08263cfe9c10
```

Or set `ADMIN`, bind KV, open `/admin`, and save the UUID there. `/health`, `/admin`, and `/api/config` remain routable before a UUID exists.

Recommended:

```text
ADMIN=use-a-long-random-password
```

Bind a Cloudflare KV namespace as `KV` if settings changed through `/admin` should persist.

### Environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `UUID` | required for tunnel traffic | VLESS user and deployment identity; UUIDv4 only |
| `ADMIN` | empty | Bearer-token password protecting `/api/config` |
| `PATH` | first 8 UUID chars | Ingress/subscription path prefix |
| `TROJAN_PASSWORD` | empty | Enables Trojan when set |
| `OUTBOUND` | empty | Optional `socks5://`, `http://`, or `https://` final egress proxy |
| `MODE` | `adaptive` | Global outbound policy |
| `PROXYIP` | empty | Optional manual fallback endpoints |
| `PREFERRED` | empty | Subscription edge endpoints, optionally with `#name` |
| `ROUTES` | empty | Destination policy rules such as `*.example.com=proxy-only` |
| `DIAL_RACE` | `2` | Parallel original-destination connect attempts, 1-4 |
| `ADAPTIVE_EDGE` | `true` | Enable stalled Cloudflare edge discovery/hedging |
| `HEDGE_DELAY` | `900` | Soft delay before classifying/launching adaptive contenders, ms |
| `FIRST_BYTE_TIMEOUT` | `5000` | Direct/proxy response-byte deadline, ms |
| `EDGE_FIRST_BYTE_TIMEOUT` | `3000` | Edge/ProxyIP response-byte deadline, ms |
| `EDGE_RACE` | `2` | Maximum adaptive edge contenders, 1-4 |
| `ENABLE_WS` | `true` | Enable WebSocket ingress |
| `ENABLE_XHTTP` | `true` | Enable XHTTP ingress |
| `BLOCK_PRIVATE` | `true` | Reject literal localhost/private/link-local targets and local names |
| `DISABLE_IPV6` | `false` | Reject IPv6 destinations and omit IPv6 preferred nodes |
| `ALLOW_PATH_OVERRIDE` | `false` | Allow connection query parameters to override outbound settings |
| `MAX_EARLY_DATA` | `8192` | Maximum WebSocket early-data bytes |
| `UPLOAD_COALESCE` | `16384` | Target outbound upload batch size |
| `UPLOAD_QUEUE` | `4194304` | Maximum buffered upload bytes |
| `DOWNLOAD_GRAIN` | `32768` | Maximum downstream aggregation target |
| `SUB_NAME` | `Unisol` | Subscription node-name prefix |
| `ROOT_MODE` | `cafe` | Use `404` to hide the root page |

`BLOCK_PRIVATE` validates literal IPv4/IPv6 targets, IPv4-mapped IPv6 targets, localhost/local names, multicast, link-local, RFC1918, CGNAT, and IPv6 local ranges before dialing. It does not pre-resolve arbitrary DNS names, so it is not a DNS-rebinding firewall.

## Outbound policies

### `adaptive` - recommended default

```text
fast original direct
  -> on stall: classified/dynamic Cloudflare edge race
  -> manual ProxyIP fallbacks
  -> configured SOCKS/HTTP(S) proxy
```

The external proxy is therefore a final escape path rather than a mandatory bottleneck.

### `proxy-first`

```text
configured proxy -> original destination -> ProxyIP fallbacks
```

### `direct-first`

```text
original destination -> ProxyIP fallbacks -> configured proxy
```

### `proxy-only`

Only the configured SOCKS/HTTP(S) proxy is allowed. There is no direct leak fallback.

### `direct`

Uses the original destination and optional manual ProxyIP fallbacks, but not the configured external proxy.

### Domain routing

`ROUTES` overrides the global mode for matching destinations:

```text
ROUTES=*.example.com=adaptive; api.example.net=direct; *.blocked.invalid=block
```

Supported route policies:

```text
adaptive
proxy-first
direct-first
proxy-only
direct
block
```

A pattern beginning with `*.` matches subdomains but not the bare apex. `*` matches everything.

## Optional manual fallback/proxy

Adaptive mode does not require either one, but both are retained as later escape paths.

```text
PROXYIP=proxy-a.example:443#SG, [2001:db8::10]:8443#v6
```

Proxy examples:

```text
OUTBOUND=proxy.example:1080
OUTBOUND=socks5://user:pass@proxy.example:1080
OUTBOUND=http://user:pass@proxy.example:8080
OUTBOUND=https://user:pass@proxy.example:443
```

## Per-connection overrides

Disabled by default. If you explicitly set:

```text
ALLOW_PATH_OVERRIDE=true
```

WebSocket and XHTTP requests can use:

```text
proxy=socks5://user:pass@host:1080
mode=adaptive
proxyip=fallback.example:443
no6=1
```

Example:

```text
/<PATH>/ws?mode=adaptive
```

Do not enable path overrides where untrusted users know the ingress path unless you want them to select outbound policies.

## Paths and subscriptions

If `PATH=myedge`:

| Path | Method | Purpose |
|---|---|---|
| `/` | GET | Cafe camouflage page |
| `/health` | GET | Minimal JSON status |
| `/myedge` | WebSocket upgrade | WebSocket ingress alias |
| `/myedge/ws` | WebSocket upgrade | WebSocket ingress |
| `/myedge/xhttp` | POST | XHTTP ingress |
| `/myedge/sub` | GET | Subscription |
| `/sub/myedge` | GET | Subscription alias |
| `/admin` | GET | Admin UI; shows setup instructions if `ADMIN` is missing |
| `/api/config` | GET/POST | Bearer-authenticated config API |

Subscription formats:

```text
/myedge/sub?format=base64
/myedge/sub?format=plain
/myedge/sub?format=clash
/myedge/sub?format=singbox
```

Clash and Sing-box output currently includes the WebSocket nodes. Raw/Base64 also contains XHTTP links.

## Admin / KV

The admin page now exposes adaptive controls directly:

- Mode
- Adaptive edge enable/disable
- Hedge delay
- Direct first-byte timeout
- Edge first-byte timeout
- Edge race count
- manual ProxyIP
- optional SOCKS/HTTP(S) proxy
- routes, identity, transports, IPv6, and security switches

`/admin` itself is always reachable. If `ADMIN` is not configured it presents setup instructions and keeps save/reload disabled. The actual `/api/config` remains locked until the Bearer credential is configured.

The browser stores the password only in `sessionStorage`. `ADMIN` is never persisted to KV. KV configuration is cached in the Worker isolate for 30 seconds, and successful saves update the current isolate cache immediately.

**Upgrade note:** if an existing deployment previously saved `MODE=proxy-only` or another mode in KV, updating the source does not overwrite that choice. Open `/admin`, choose `adaptive`, and save if you want the new behavior.

## DNS behavior

VLESS UDP is accepted only for destination port 53. Two-byte length-prefixed DNS packets are forwarded as DNS wire messages to:

```text
https://1.1.1.1/dns-query
```

Adaptive route classification separately uses Cloudflare's JSON DoH endpoint and caches A-record answers for a bounded period. Trojan UDP and non-DNS UDP are intentionally rejected.

## Deploy with Wrangler

```bash
npm install
npx wrangler deploy
```

For secrets:

```bash
npx wrangler secret put ADMIN
```

The included `wrangler.toml` points to `src/index.js`. The standalone bundle is generated at:

```text
dist/_worker.js
```

## Build and verification

```bash
npm install
npm run check
```

`npm run check` runs unit tests, builds the standalone Worker, and performs a Wrangler deployment dry-run.

GitHub Actions also boots the Worker under local `wrangler dev`/workerd and smoke-tests control-plane behavior. The unit suite includes adaptive-specific tests for:

- Cloudflare published-range classification;
- TLS SNI extraction;
- plaintext HTTP Host extraction;
- dynamic DoH edge discovery;
- skipping edge logic for non-Cloudflare destinations;
- fast direct traffic making no classification request;
- stalled Cloudflare traffic winning through a dynamically discovered edge route;
- manual ProxyIP fallback for non-Cloudflare failures;
- first-byte preservation;
- closure of losing and late-opening hedge sockets.

## Security defaults

- literal localhost, RFC1918, link-local, carrier-grade NAT, mapped-private IPv6, multicast, local names, and IPv6 local ranges are blocked;
- connection-level overrides are disabled;
- `proxy-only` never falls back to direct;
- adaptive edge routing is gated by destination classification and supported web ports;
- candidate races are bounded;
- failed candidates receive cooldowns instead of being hammered repeatedly;
- admin writes require a Bearer token and KV binding;
- admin credentials are never persisted;
- malformed protocol frames are rejected before outbound dialing;
- WebSocket early data and upload buffers are bounded;
- invalid UDP types are rejected rather than guessed.

## Cloudflare platform constraints

Cloudflare documents that Workers outbound TCP sockets to Cloudflare IP ranges are blocked. Therefore the adaptive edge technique must be treated as **opportunistic behavior**, not a guaranteed or supported bypass of the platform rule. Runtime behavior can differ by deployment and can change without notice.

Unisol keeps manual ProxyIP and SOCKS/HTTP(S) egress precisely so there is still a conventional fallback when the adaptive edge route is unavailable. `proxy-only` remains the strict option when avoiding direct egress matters more than performance.

Use the project only where you are authorized to operate the tunnel and comply with Cloudflare's terms and applicable law.

## Design relationship to the studied projects

The upstream projects demonstrated useful patterns such as protocol multiplexing, fallback routing, optimized streaming, proxy egress, and subscription generation. Unisol v0.2 deliberately diverges in several ways:

- modular, independently testable source instead of one large Worker file;
- a shared outbound interface for WS and XHTTP;
- adaptive first-byte hedging instead of treating `socket.opened` as success;
- live DoH classification before Cloudflare-specific fallback;
- live edge discovery instead of copying a fixed upstream address pool;
- SNI/Host inspection to avoid relying only on the VLESS/Trojan requested hostname;
- per-isolate candidate scoring and exponential cooldown;
- explicit cleanup of losing and late-opening race sockets;
- conventional ProxyIP/SOCKS/HTTP(S) fallback retained after adaptive attempts;
- strict target filtering and dedicated DNS framing;
- CI that validates unit behavior, bundle compatibility, and local Workers runtime behavior.

The goal is not to reproduce either upstream project feature-for-feature. It is to build a smaller foundation that can evolve independently and be reasoned about under failure.
