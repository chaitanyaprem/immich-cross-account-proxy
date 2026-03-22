# immich-cross-account-proxy

> **Status: proof-of-concept / community RFC**
> Works on paper and passes local logic tests, but has not yet been validated against a live Immich instance. Feedback, testing reports, and PRs very welcome.

A lightweight Node.js proxy that enables **cross-account edit and delete permissions** in [Immich](https://immich.app/) — without modifying Immich itself or maintaining a fork.

---

## The problem

Immich's [partner sharing](https://immich.app/docs/features/partner-sharing/) is read-only. If you and your partner share a self-hosted Immich instance, you can view each other's libraries but you **cannot delete or edit each other's photos**. This is a [frequently requested feature](https://github.com/immich-app/immich/discussions/9441) that has not yet been implemented upstream.

Common workarounds (staying logged in on a spare browser, borrowing each other's phones) are clunky. Forks that address this don't exist in any maintained form. This proxy is an attempt at a clean, non-invasive solution.

---

## How it works

You point your Immich clients (mobile app, browser) at this proxy instead of directly at Immich. For the vast majority of requests — reads, uploads, auth, WebSocket sync — the proxy is completely transparent and adds zero logic.

For **mutating operations** (DELETE, metadata PUT), the proxy:

1. Identifies the caller from their API key
2. Looks up which account owns the asset(s) being acted on
3. Checks the permission config — e.g. "Alice can act as Bob"
4. If permitted, re-issues the request using the owner's API key
5. Returns the response to the caller unchanged

```
Immich App (Alice)
      │  DELETE /api/assets  { ids: ["abc123"] }
      │  x-api-key: alice_key
      ▼
┌──────────────────────────────────┐
│   immich-cross-account-proxy     │
│                                  │
│  1. alice_key  →  Alice          │
│  2. abc123 owner  →  Bob         │
│  3. Alice canActAs Bob?  →  yes  │
│  4. Re-issue with bob_key        │
└──────────────────────────────────┘
      │  DELETE /api/assets  { ids: ["abc123"] }
      │  x-api-key: bob_key
      ▼
   Immich Server  →  204 No Content
      │
      ▼  (proxied back to Alice's client)
```

### What's intercepted

| Endpoint | Method | Behaviour |
|---|---|---|
| `/api/assets` | `DELETE` | Fan-out by owner, issue one DELETE per owner group |
| `/api/assets/:id` | `PUT` | Metadata update (description, date, GPS, etc.) |
| `/api/assets` | `PUT` | Bulk metadata update |
| Everything else | `*` | **Pure transparent pass-through** |

"Everything else" includes: all reads, thumbnail/video streaming, photo uploads, login/auth, WebSocket (`/api/socket.io/`), and Immich's delta sync protocol (`/api/sync/`).

---

## Prerequisites

- Node.js 18+ (or Docker)
- A self-hosted Immich instance
- API keys for each account (generated in Immich → User Settings → API Keys)
- The User ID for each account (visible in Immich → User Settings → Account, or from the profile URL)

---

## Setup

### 1. Clone

```bash
git clone https://github.com/YOUR_USERNAME/immich-cross-account-proxy.git
cd immich-cross-account-proxy
npm install
```

### 2. Configure

```bash
cp config.example.yml config.yml
```

Edit `config.yml`:

```yaml
immich_url: "http://immich_server:3001"  # internal Docker URL, or http://localhost:2283
proxy_port: 2284
cache_ttl: 300  # seconds to cache asset ownership lookups

accounts:
  - name: "Alice"
    api_key: "your_alice_api_key_here"
    user_id: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

  - name: "Bob"
    api_key: "your_bob_api_key_here"
    user_id: "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy"

permissions:
  - account: "Alice"
    can_act_as: ["Bob"]
  - account: "Bob"
    can_act_as: ["Alice"]
```

> **Security note:** `config.yml` is gitignored. It contains API keys — treat it like a password file (`chmod 600 config.yml`).

### 3. Run

**Standalone:**

```bash
node src/index.js
```

**With Docker Compose (recommended — add to your existing Immich stack):**

```yaml
services:
  # ... your existing immich services ...

  immich-proxy:
    image: node:20-alpine
    working_dir: /app
    volumes:
      - ./immich-cross-account-proxy:/app
    command: sh -c "npm install --omit=dev && node src/index.js"
    ports:
      - "2284:2284"
    restart: unless-stopped
    networks:
      - immich_default  # same network as your immich_server container
```

### 4. Point your clients at the proxy

Change the Immich server URL in:
- **Mobile app**: Settings → Server → change port `2283` → `2284`
- **Browser**: update your bookmark / the URL you navigate to

Login, browsing, uploads, and background sync all work exactly as before.

---

## Architecture

```
immich-cross-account-proxy/
├── src/
│   ├── index.js      # Express app, route registration, pass-through proxy
│   ├── handlers.js   # Route handlers for intercepted endpoints
│   ├── ownership.js  # Asset ownership resolver + in-memory cache + permission checks
│   ├── config.js     # YAML config loader and validator
│   └── logger.js     # Winston logger
├── config.example.yml
├── package.json
└── README.md
```

**Dependencies:**
- [`express`](https://expressjs.com/) — HTTP server
- [`http-proxy-middleware`](https://github.com/chimurai/http-proxy-middleware) — transparent pass-through for everything not intercepted
- [`winston`](https://github.com/winstonjs/winston) — structured logging

No database, no persistent state. Ownership lookups are cached in-memory with a configurable TTL.

---

## Limitations and known gaps

These are areas that need further validation or are explicitly out of scope for this approach:

### Not yet validated on a live instance
The logic has been unit-tested but not yet run against a real Immich deployment. The first people to try this should pay attention to:
- Whether the intercepted DELETE/PUT endpoint paths and request body shapes still match current Immich (verified against the Immich OpenAPI spec as of early 2026, but Immich is pre-2.0 and breaking changes can still occur)
- Edge cases with `?key=` query-param auth vs `x-api-key` header auth
- Whether the bulk metadata PUT endpoint is reached via the same path in all client versions

### Face tagging across accounts
Not addressable via this proxy. Immich enforces face/person ownership at the ML pipeline level — it is not an API permission issue.

### Album-level permissions
The proxy does not change album ownership. Adding assets to a shared album you are an editor on already works natively in Immich. Removing assets from an album you don't own is a separate gap not currently handled here.

### In-process ownership cache
The cache lives in Node.js process memory. Running multiple proxy instances behind a load balancer would give each instance an independent cache. Fine for a typical homelab setup.

### Immich API stability
Immich is [pre-2.0](https://immich.app/docs/overview/support-the-project) and breaking changes can still occur. Review the intercepted endpoint paths and request shapes when upgrading Immich.

---

## Contributing

This is an early-stage project and community input is explicitly wanted on:

- **Does this actually work?** Test reports from people running it against real Immich instances are the most valuable contribution right now. Please open an issue with your Immich version and what you observed.
- **Edge cases in the ownership fan-out** — are there DELETE/PUT patterns this misses?
- **Immich version compatibility** — which versions has this been confirmed to work with?
- **Additional intercepted endpoints** — are there other mutating operations (e.g. `DELETE /api/albums/:id/assets`) that would benefit from cross-account routing?
- **A proper Dockerfile** — a standalone image would make deployment cleaner.
- **Tests against a real instance** — integration tests that spin up Immich in Docker and exercise the proxy end-to-end.

Please open an issue or PR. If you have tested this and it works (or doesn't), a comment in the [upstream Immich discussion](https://github.com/immich-app/immich/discussions/9441) pointing back here would also help others find it.

---

## Background and prior research

This was built in response to the long-standing Immich feature request for cross-account edit/delete access (GitHub discussions [#9441](https://github.com/immich-app/immich/discussions/9441), [#7038](https://github.com/immich-app/immich/discussions/7038), [#5649](https://github.com/immich-app/immich/discussions/5649)). The upstream team is aware of the demand; this proxy is a stopgap until it is implemented natively.

A prior research pass confirmed:
- Partner sharing is read-only by design at the Immich authorization layer
- No maintained forks address this (one personal patch exists: [zaggino/immich](https://github.com/zaggino/immich) — scoped to face sharing, not edit/delete)
- A proxy approach is viable because Immich's auth is entirely header/key based — there is no session binding that would break on token substitution
- Immich's Sync v2 delta sync protocol is session-scoped on the mobile client side and is unaffected by the proxy (deletions propagate to the mobile client on the next sync cycle via `AssetDeleteV1` events, same as if the owner had deleted them directly)

---

## License

MIT
