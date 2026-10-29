# @pipeworx/inside-airbnb

Short-term rental (Airbnb) listings by city: median nightly price, room-type
and neighbourhood breakdowns, and filterable listing-level rows — price,
room type, availability, review counts — for every city this pack has
loaded. Fleet #2973.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `list_str_cities()` — every covered city, with listing count, overall
  median nightly price, and that city's own scrape date (`data_as_of` —
  coverage dates differ city to city).
- `str_city_summary(city)` — total listings, overall median price, a
  room-type breakdown (entire home/apt, private room, shared room, hotel
  room — each with its own count and median price), and the top
  neighbourhoods by listing count (each with its own count and median
  price). An uncovered city is refused by name, listing every covered city.
- `str_listings(city, neighbourhood?, room_type?, min_price?, max_price?, limit?, offset?)`
  — listing-level rows: id, public listing URL, listing title, neighbourhood,
  room type, price, minimum nights, review counts, last review date,
  `availability_365`, and the host's total listing count (a bare number).
  `limit` defaults to 50 (max 200); a response with more matching rows than
  returned carries `truncated: true` and `total_matching` rather than
  silently dropping them.

City names resolve loosely (`"NYC"`, `"New York"`, `"new-york-city"` all
work; see `CITY_ALIASES` in `src/store.ts`). `room_type` accepts the four
canonical values or a loose match (`"apartment"` → `"Entire home/apt"`).

## Personal data

Inside Airbnb's raw per-listing file carries `host_id`, `host_profile_id`,
`host_name` (the host's first name) and `license` (which can hold a local
registration number) on every row. **None of those four columns are read by
the loader, and none exist in any D1 table this pack serves from** — there
is no column to accidentally select, not merely a field left out of the
response shape. `calculated_host_listings_count` is kept because it is a
bare count, not an identifier — how many listings that host runs, not who
they are. Every response is listing-level or city/neighbourhood-level only:
price, room type, availability, neighbourhood, review counts, and
aggregates built from those, plus a listing id and the public
`https://www.airbnb.com/rooms/<id>` URL (both already public on Airbnb's own
site).

## Auth

Keyless. The tools answer only through the Pipeworx gateway, which holds the
data; a standalone `npm install` has no data to read, and every tool throws
a clear "not bound in this runtime" error there instead of returning an
empty list.

## Licence

Inside Airbnb publishes under **CC BY 4.0**
(<https://creativecommons.org/licenses/by/4.0/>). Every tool response here
carries `source`, `source_url`, `license` and `attribution` fields quoting
that licence, per Inside Airbnb's own attribution request.

## Data sources

- Inside Airbnb, per-city listings summary — community-maintained snapshots
  of public Airbnb listing data, scraped and published independently per
  city under CC BY 4.0. The project publishes bulk per-city files only (no
  live query API), so this pack builds a copy
  (`scripts/inside-airbnb/load-data.mjs`) rather than proxying. Name the
  PUBLISHER and DATASET only — never a download path, directory, file name,
  endpoint, feed URL or query shape (CLAUDE.md step 9b). Routes live only in
  `scripts/inside-airbnb/load-data.mjs`.

### Coverage

A curated set of major cities across North America, Europe, Asia-Pacific,
and a handful of cities in South America, Africa and the Middle East — see
`list_str_cities` for the exact live set and `scripts/inside-airbnb/load-data.mjs`
for the full table (slug, country, scrape date). This is **not** every city
Inside Airbnb publishes (it covers over a hundred); it is a representative
subset chosen for breadth across regions. Extending coverage means adding a
row to the `CITIES` table in the loader and re-running it with
`--cities <new-slug>` — nothing about the schema or the tools changes.

### Known gaps — read before extending this pack

**Each city's scrape date is independent and will drift.** Inside Airbnb
re-scrapes each city on its own cadence (roughly quarterly, not
synchronized across cities), so `data_as_of` legitimately differs between
cities loaded in the same pass — that is not a bug, it is the one piece of
true provenance this pack has per city. A refresh should re-probe
<https://insideairbnb.com/get-the-data/> for each city's current date
rather than reuse the dates baked into the loader.

**Medians are precomputed at load time, not query time.** D1/SQLite has no
`MEDIAN()` aggregate, and the usual integer-offset-subquery idiom run once
per neighbourhood per request would multiply badly under D1's per-query CPU
budget. The loader computes every median (city-wide, per room type, per
neighbourhood) once, in Node, over that city's full in-memory price array,
and stores the result — so `str_city_summary` is one `SELECT`, not N.
Extending the aggregates (e.g. a price percentile) means changing the
loader's aggregation step, not adding a runtime query.

**`listings.name` is the listing's own title, not a host field.** It is
free text the host wrote for the *property* (e.g. "Cozy studio near the
park") and is excluded from nothing — it is not one of the four personal
fields this pack drops. A host who put their own name in a listing title
did so on Airbnb's own public page already; this pack does not add any
exposure beyond what Inside Airbnb itself publishes in that column, and it
never reads the separate, explicitly-personal `host_name` column at all.

### Refreshing or extending the data

```bash
node scripts/inside-airbnb/load-data.mjs                              # full reload, all covered cities
node scripts/inside-airbnb/load-data.mjs --cities paris,london        # reload a subset
node scripts/inside-airbnb/load-data.mjs --concurrency 4              # be gentler on the upstream
```

Needs `wrangler` logged in to the Pipeworx Cloudflare account. Each run
**replaces** `cities`, `neighbourhoods` and `listings` (DROP + reload)
rather than appending, scoped to the cities passed — a `--cities` subset
reload still drops and rebuilds the full schema, so running it with a
subset after a full load will leave the OTHER cities' tables intact only
because `DROP TABLE` + `CREATE TABLE` runs once per full invocation, not
per city; re-running with a subset is for testing a city's parse, not for
a partial production refresh. For a production refresh, pass every city
you want kept, or omit `--cities` entirely.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "inside-airbnb": {
      "url": "https://gateway.pipeworx.io/inside-airbnb/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/inside-airbnb/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/list_str_cities \
  -H 'Content-Type: application/json' \
  -d '{}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/list_str_cities`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-inside-airbnb` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/inside-airbnb/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "inside-airbnb": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-inside-airbnb"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Inside Airbnb data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
