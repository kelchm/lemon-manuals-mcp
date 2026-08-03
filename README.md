# lemon-manuals-mcp

Prototype MCP server (streamable HTTP, stateless) for the self-hosted
LEMON/CHARM car-repair-manual archive (`lemon.home.kelch.io`, home-lab repo
`kubernetes/apps/lemon-manuals/`).

Tools:

- `list_makes` — all makes with vehicle counts and year ranges
- `search_vehicles` — free-text over make/model/engine/year → manual root paths
- `get_page` — any site path → markdown (nav chrome stripped, links preserved)

Browse/search is answered locally from the databases' `index.json` files
(~305k vehicles, ~200ms load); page content is fetched from the lemon-website
server and converted with turndown.

## Setup

The index files are gitignored (147MB, re-fetchable from the cluster):

```sh
kubectl -n lemon-manuals exec deploy/lemon-website -- cat /data/charm/index.json > data/charm-index.json
kubectl -n lemon-manuals exec deploy/lemon-website -- cat /data/lemon/index.json > data/lemon-index.json
```

The server needs HTTP reach to lemon-website. For local dev:

```sh
kubectl -n lemon-manuals port-forward deploy/lemon-website 18080:8080
```

Env: `LEMON_BASE_URL` (default `http://127.0.0.1:18080`), `LEMON_DATA_DIR`
(default `./data`).

## Run / register

```sh
mise exec -- bun src/index.ts                 # HTTP server on :8787 (/mcp, /healthz)
mise exec -- bun test/client.ts               # end-to-end smoke (needs port-forward)
claude mcp add --transport http lemon-manuals http://127.0.0.1:8787/mcp
```

## Productionizing (phase 2, per home-lab plan doc)

Containerize, deploy to the `ai` namespace, register with metamcp (same
streamable-HTTP shape as the rest of the fleet); read `index.json` from a PV
mount instead of local copies. The `pages.mtbl` direct-read option (vendored
`oxidized-mtbl` crate in kelchm/lemon-website) removes the HTML round-trip if
ever needed.
