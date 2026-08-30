# Unisol

Unisol is a modular Cloudflare Worker tunnel gateway built after studying the design patterns in [`cmliu/edgetunnel`](https://github.com/cmliu/edgetunnel) and [`byJoey/cfnew`](https://github.com/byJoey/cfnew). It is an independent implementation rather than a fork or a copied single-file source.

The project keeps the parts that are useful in production—bounded streaming, protocol-aware parsing, multiple outbound strategies, live KV configuration, and self-contained subscriptions—while separating them into small modules that can be tested independently.

## What it supports

- VLESS TCP over WebSocket
- VLESS TCP over XHTTP (`stream-one` style request/response streaming)
- Trojan TCP over WebSocket
- Trojan TCP over XHTTP
- VLESS UDP DNS on port 53, translated to DNS-over-HTTPS
- Direct outbound TCP with configurable connection racing
- ProxyIP/fallback destinations
- SOCKS5 outbound, with or without username/password
- HTTP CONNECT outbound, with optional Basic authentication
- HTTPS CONNECT outbound, with TLS on the Worker-to-proxy hop
- Per-domain routing rules
- `proxy-first`, `direct-first`, `proxy-only`, and `direct` outbound modes
- Optional IPv6-disable policy
- Private/local destination blocking by default
- Optional per-connection outbound overrides
- KV-backed live configuration and an `/admin` interface
- Raw/Base64, Clash, and Sing-box subscription output
- A normal-looking cafe page at `/`

## Architecture

```text
src/index.js          HTTP routing / control plane
src/core.js           config parsing, endpoints, policy, route matching
src/protocol.js       VLESS + Trojan wire protocol parsing
src/outbound.js       direct, SOCKS5, HTTP CONNECT, HTTPS CONNECT
src/transport.js      bounded upload queue + stream aggregation
src/session.js        WebSocket / XHTTP sessions + DNS framing
src/subscription.js   node links + Clash / Sing-box generation
src/store.js          KV configuration cache and persistence
src/ui.js             camouflage and admin pages
```

This structure is intentional. The transport code does not need to know how a SOCKS5 handshake works, and the outbound code does not need to know whether the ingress was WebSocket or XHTTP.

## Required configuration

At minimum, set a valid UUIDv4:

```text
UUID=90cd4a77-141a-43c9-991b-08263cfe9c10
```

Recommended for the live admin interface:

```text
ADMIN=use-a-long-random-password
```

Bind a Cloudflare KV namespace as `KV` if you want settings changed in `/admin` to persist.

### Environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `UUID` | required | VLESS user and the base identity for the deployment; UUIDv4 only |
| `ADMIN` | empty | Password used as a Bearer token by `/api/config`; enables `/admin` |
| `PATH` | first 8 UUID chars | Ingress/subscription path prefix |
| `TROJAN_PASSWORD` | empty | Enables Trojan when set |
| `OUTBOUND` | empty | `socks5://`, `http://`, or `https://` proxy URL; no scheme means SOCKS5 |
| `MODE` | `proxy-first` | `proxy-first`, `direct-first`, `proxy-only`, or `direct` |
| `PROXYIP` | empty | Comma/newline-separated fallback endpoints |
| `PREFERRED` | empty | Subscription edge endpoints, optionally with `#name` |
| `ROUTES` | empty | Destination policy rules such as `*.example.com=proxy-only` |
| `DIAL_RACE` | `2` | Number of parallel direct connection attempts, 1–4 |
| `ENABLE_WS` | `true` | Enable WebSocket ingress |
| `ENABLE_XHTTP` | `true` | Enable XHTTP ingress |
| `BLOCK_PRIVATE` | `true` | Reject localhost/private/link-local target addresses |
| `DISABLE_IPV6` | `false` | Reject IPv6 destinations and omit IPv6 preferred nodes |
| `ALLOW_PATH_OVERRIDE` | `false` | Allow connection query parameters to override outbound settings |
| `MAX_EARLY_DATA` | `8192` | Maximum WebSocket early-data bytes |
| `UPLOAD_COALESCE` | `16384` | Target outbound upload batch size |
| `UPLOAD_QUEUE` | `4194304` | Maximum buffered upload bytes |
| `DOWNLOAD_GRAIN` | `32768` | Maximum downstream aggregation target |
| `SUB_NAME` | `Unisol` | Subscription node-name prefix |
| `ROOT_MODE` | `cafe` | Use `404` to hide the root page |

Endpoint examples:

```text
PROXYIP=proxy-a.example:443#SG, [2001:db8::10]:8443#v6
PREFERRED=1.2.3.4:443#Fast, edge.example:8443#Domain
```

Proxy examples:

```text
OUTBOUND=proxy.example:1080
OUTBOUND=socks5://user:pass@proxy.example:1080
OUTBOUND=http://user:pass@proxy.example:8080
OUTBOUND=https://user:pass@proxy.example:443
```

## Outbound policy

The default is `proxy-first`:

```text
proxy -> original destination -> ProxyIP fallbacks
```

`direct-first` reverses the preference:

```text
original destination -> ProxyIP fallbacks -> proxy
```

`proxy-only` is the leak-resistant mode. If the configured outbound proxy fails, the connection fails instead of silently becoming direct.

`direct` never uses the configured SOCKS/HTTP proxy, but can still try configured ProxyIP fallbacks.

### Domain routing

`ROUTES` overrides the global mode for matching destinations:

```text
ROUTES=*.example.com=proxy-only; api.example.net=direct; *.invalid=block
```

Supported policies are:

```text
proxy-first
direct-first
proxy-only
direct
block
```

A pattern beginning with `*.` matches subdomains but not the bare apex. `*` matches everything.

## Per-connection overrides

They are disabled by default. If you explicitly set:

```text
ALLOW_PATH_OVERRIDE=true
```

WebSocket and XHTTP requests can use these query parameters:

```text
proxy=socks5://user:pass@host:1080
mode=proxy-only
proxyip=fallback.example:443
no6=1
```

Example path:

```text
/<PATH>/ws?mode=proxy-only&proxy=socks5%3A%2F%2Fproxy.example%3A1080
```

Do not enable path overrides on a deployment where untrusted users know the ingress path unless you actually want them to select those policies.

## Paths

If `PATH=myedge`:

| Path | Method | Purpose |
|---|---|---|
| `/` | GET | Cafe camouflage page |
| `/health` | GET | Minimal JSON health/status response |
| `/myedge` | WebSocket upgrade | WebSocket ingress alias |
| `/myedge/ws` | WebSocket upgrade | WebSocket ingress |
| `/myedge/xhttp` | POST | XHTTP ingress |
| `/myedge/sub` | GET | Subscription |
| `/sub/myedge` | GET | Subscription alias |
| `/admin` | GET | Admin UI when `ADMIN` is configured |
| `/api/config` | GET/POST | Bearer-authenticated config API |

Subscription format can be selected explicitly:

```text
/myedge/sub?format=base64
/myedge/sub?format=plain
/myedge/sub?format=clash
/myedge/sub?format=singbox
```

Clash and Sing-box output currently includes the WebSocket nodes, because those formats have stable WebSocket support across common clients. Raw/Base64 output also contains XHTTP links.

## DNS behavior

VLESS UDP is accepted only for destination port 53. Its two-byte length-prefixed DNS packets are decoded and forwarded as DNS wire messages to:

```text
https://1.1.1.1/dns-query
```

Responses are converted back to VLESS UDP framing. Trojan UDP and non-DNS UDP are intentionally rejected instead of being incorrectly forwarded as TCP.

## Admin / KV

1. Create a Cloudflare KV namespace.
2. Bind it to the Worker as `KV`.
3. Set `ADMIN` to a strong value.
4. Open `/admin`.
5. Enter the admin password when prompted.

The browser stores the password only in `sessionStorage` and sends it to `/api/config` in the `Authorization: Bearer ...` header. `ADMIN` itself is not writable through the KV API.

KV configuration is cached in the Worker isolate for 30 seconds. A successful save updates the current isolate cache immediately.

## Deploy with Wrangler

```bash
npm install
npx wrangler deploy
```

For secrets, either configure variables in the Cloudflare dashboard or use Wrangler. For example:

```bash
npx wrangler secret put ADMIN
```

`UUID` can be a normal Worker variable; it does not have to be a secret.

The included `wrangler.toml` points directly to `src/index.js`, so Wrangler can deploy the modular source tree without requiring the bundled artifact.

## Build a single `_worker.js`

```bash
npm install
npm run check
```

The bundle is written to:

```text
dist/_worker.js
```

That file keeps `cloudflare:sockets` as a Worker runtime import and can be used for one-file deployment workflows.

## GitHub Actions verification

`.github/workflows/ci.yml` runs on every push and pull request. It:

1. parses every source and test file with `node --check`;
2. runs the Node unit tests;
3. bundles the Worker with esbuild;
4. verifies that the output exists and retains the Cloudflare socket runtime import;
5. uploads the built `_worker.js` as a workflow artifact.

The unit suite covers configuration, route matching, UUID/auth parsing, VLESS, Trojan/SHA-224, SOCKS5, HTTP CONNECT, HTTPS CONNECT, proxy response segmentation, bounded queueing, DNS framing/DoH, and subscription generation.

## Security defaults

Unisol intentionally defaults to a narrower security posture:

- localhost, RFC1918, link-local, carrier-grade NAT, local names, and IPv6 local ranges are blocked as destinations;
- connection-level outbound overrides are disabled;
- `proxy-only` never falls back to direct;
- admin writes require a Bearer token and KV binding;
- malformed protocol frames are rejected before outbound dialing;
- WebSocket early data and upload buffers are bounded;
- invalid UDP types are rejected rather than guessed.

If you disable these protections, do it deliberately.

## Cloudflare platform constraints

This is still a Cloudflare Worker, so Cloudflare runtime/network restrictions apply. In particular, Cloudflare documents that outbound TCP sockets to Cloudflare IP ranges are blocked. A `PROXYIP` therefore needs to be a destination that the Worker runtime is actually permitted to reach.

Use the project only where you are authorized to operate the tunnel and comply with the Cloudflare terms and the laws applicable to your deployment.

## Design relationship to the studied projects

The two upstream projects demonstrated several useful engineering patterns: protocol multiplexing at the Worker edge, runtime-configurable outbound selection, fallback routing, optimized streaming, and subscription generation. Unisol applies those ideas with a different internal design:

- multiple testable modules instead of one very large source file;
- explicit routing policy objects rather than transport-specific global state;
- one outbound interface shared by WS and XHTTP;
- generic SOCKS/HTTP(S) proxy handshakes with preserved buffered bytes;
- strict target filtering before dial;
- dedicated DNS framing rather than treating UDP payloads as TCP;
- CI as a required build/test path.

The goal is not to reproduce either upstream project feature-for-feature. It is to provide a smaller foundation that is easier to reason about and extend safely.
