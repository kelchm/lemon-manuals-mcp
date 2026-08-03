# lemon-manuals-mcp

Prototype MCP server (streamable HTTP, stateless) for the self-hosted
LEMON/CHARM car-repair-manual archive (`lemon.home.kelch.io`, home-lab repo
`kubernetes/apps/lemon-manuals/`).

Tools:

- `list_makes` — all makes with vehicle counts and year ranges
- `search_vehicles` — free-text over make/model/engine/year → grouped drivetrains, variants, and all source manuals
- `get_page` — opaque encoded site path → normalized markdown, with tree depth and byte controls
- `search_manual` — persistent FTS5 search over titles and/or body text, deduplicated by document content
- `get_image` — opaque encoded image path → validated MCP image block (2 MB maximum; never truncated)

All returned paths are opaque encoded tokens. Pass them to `get_page`,
`search_manual`, or `get_image` exactly as returned; never decode or rebuild them.
`search_manual` defaults to `mode: "both"`; `title` and `body` are also
available. Results contain a body-text `snippet`, an `also_under` list for
duplicate tree placements, and parsed `from`/`through` applicability when the
publisher labels it. Image-only pages are identified explicitly.

Browse/search is answered locally from the databases' `index.json` files
(~305k vehicles, ~200ms load); page content is fetched from the lemon-website
server and converted with turndown. Relative and `/hyperlink/...` references are
normalized to absolute encoded site paths that can be passed directly back to
the tools.

Manual full-text data lives in `data/manual-search.sqlite` by default. A first
search tree-walks and persists an unindexed manual. `mode: "title"` only fetches
matching leaves; `body`/`both` completes the manual's body index and can
therefore be slow on first use. Production should prebuild the index:

```sh
# One or more opaque vehicle roots (recommended for incremental rollout)
bun run index-manuals -- '/Volkswagen/2005/Touareg%20%287LA%29%20V8-4.2L%20%28BHX%29/'

# No arguments indexes every isComplete vehicle. This is a full-corpus job.
bun run index-manuals
```

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
(default `./data`), and `LEMON_SEARCH_DB` (default
`$LEMON_DATA_DIR/manual-search.sqlite`). The search database directory must be
writable and persistent if lazy indexing is enabled.

## Run / register

```sh
mise exec -- bun src/index.ts                 # HTTP server on :8787 (/mcp, /healthz)
mise exec -- bun test/client.ts               # end-to-end smoke (needs port-forward)
mise exec -- bun run live-corpus              # one complete manual/corpus/decade
mise exec -- bun test                         # hermetic regression suite
mise exec -- bun run typecheck
claude mcp add --transport http lemon-manuals http://127.0.0.1:8787/mcp
```

The `pages.mtbl` direct-read option (vendored `oxidized-mtbl` crate in
kelchm/lemon-website) can eventually replace the HTML ingestion round-trip.
