# bazatap

See why AI agents fail to buy from a store.

An AI agent finds the store, tries to buy, and fails. Today you find out from a
support ticket. `bazatap` tells you why — before the agent gives up.

```sh
npx bazatap scan allbirds.com
```

> Not on npm yet. Until 0.2.0 is published:
>
> ```sh
> git clone https://github.com/bazatap/bazatap && cd bazatap
> node bin/bazatap.js scan allbirds.com
> ```

Two commands: `scan` checks what an agent can discover, `tap` records what
actually happened when it tried.

## `scan` — what the agent sees

Fetches `https://<domain>/.well-known/ucp` and reports on the things that stop
an agent:

- **Reachability** — HTTPS, no redirects, JSON, 200.
- **Shape** — required `ucp.version`, `services`, `payment_handlers`, capability
  entries, transports and endpoints.
- **Namespace binding** — every declared schema URL must be owned by the domain
  in its reverse-domain name (`dev.shopify.*` must come from `shopify.dev`).
- **Schemas** — every declared schema resolves, without redirects, as JSON.
- **Version constraints** — `requires.protocol` and `requires.capabilities` must
  be satisfiable by the profile's version.
- **Signing keys** — `keys[]` present and usable, since unsigned profiles cannot
  verify requests or webhooks.
- **Extensions** — parents that the profile does not declare will be pruned
  during negotiation.

```text
bazatap https://shop.example.com/.well-known/ucp
HTTP 200 · version 2026-08-25 · 15 capabilities · 3 services · 0 keys

Findings (2)
  error SCHEMA_STATUS  Schema for `dev.ucp.common.ask` returned HTTP 404.
  warn  NO_KEYS        No signing keys. Discovery works, but signed requests and webhooks cannot be verified.

Score 80/100   Grade B
```

Exit codes: `0` no errors (warnings are fine), `1` at least one error or fatal
finding, `2` bad usage. Usable as a CI gate as-is.

## `tap` — what actually happened

A local proxy in front of the store. It records every request, detects agent
traffic, classifies the checkout lifecycle, and shows the failure reasons and
completion rate in a local dashboard.

```sh
bazatap tap --upstream=http://localhost:3000
```

```text
bazatap tap  http://127.0.0.1:6060
  upstream   http://localhost:3000
  dashboard  http://127.0.0.1:6060/__bazatap
  log        .bazatap/events.jsonl

Waiting for traffic. Ctrl+C to stop.
```

Point an agent, or a test client, at `http://127.0.0.1:6060` instead of the
store. Each request is appended to the JSONL log and rolled up:

- requests, agent traffic, checkout attempts and completion rate;
- the failure reasons agents hit (`out_of_stock`, `idempotency_conflict`,
  `payment_declined`, `invalid_request`, …);
- which agents are calling (`UCP-Agent` profile host);
- recent requests with status, operation, failure and latency.

Useful flags:

```text
--port=N        local port (default 6060)
--host=ADDR     local bind address (default 127.0.0.1)
--log=PATH      JSONL event log (default .bazatap/events.jsonl)
--no-bodies     record metadata only, never request or response bodies
```

Bodies are capped at 64 KB each and never leave the machine.

## Install

```sh
npx bazatap scan <domain>
# or
npm install -g bazatap
```

Requires Node 20+. No dependencies, no build step.

## What it does not do

- It does not install anything on the store and needs no credentials.
- It does not write to the store, complete a purchase, or hold payment data.
- It does not validate product catalogs or order payloads yet.

## Status

`0.2.0` — `scan` and `tap`. Next: `tap` middleware packages, then `scan --ci`
for release regression.

## Development

```sh
npm test                          # node --test, no dependencies
node bin/bazatap.js scan allbirds.com
node bin/bazatap.js tap --upstream=http://localhost:3000
```

## License

Apache-2.0. See [LICENSE](LICENSE).
