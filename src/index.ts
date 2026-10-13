interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * inside-airbnb -- short-term rental listings by city (fleet #2973).
 *
 * Data: Inside Airbnb (insideairbnb.com), per-city "visualisations/
 * listings.csv" summary snapshots, CC BY 4.0. The site publishes bulk files
 * only (no live API), so this pack builds a copy
 * (scripts/inside-airbnb/load-data.mjs) into a D1 database the gateway hands
 * it as `_d1` (pack-manifest "d1Binding": "INSIDE_AIRBNB_DB"). Each covered
 * city has its OWN scrape date -- there is no single "as of" for the whole
 * pack. Design note: this file + store.ts.
 *
 * PERSONAL DATA: host_id, host_name, host_profile_id and license are never
 * read by the loader and never stored -- see store.ts's header comment.
 * Every response here is listing-level or city/neighbourhood-level only:
 * price, room type, availability, neighbourhood, review counts, and
 * aggregates built from those.
 *
 * Every response carries `source`, `source_url`, `license`, `attribution`
 * and `data_as_of` (the covered city's own scrape date, or -- for
 * list_str_cities, which spans every city -- each row's own date).
 */
import {
  clampLimit,
  getCity,
  listCities,
  normalizeCityInput,
  normalizeRoomType,
  queryListings,
  requireDb,
  SOURCE,
  topNeighbourhoods,
  type D1Like,
} from './store.js';

const tools: McpToolExport['tools'] = [
  {
    name: 'list_str_cities',
    description:
      'Every city this pack has short-term rental (Airbnb) data for, from Inside Airbnb. Returns, per city: display name, country, currency the price fields are IN (prices are never converted -- each city\'s own local currency, e.g. CZK for Prague, not USD), how many listings are loaded, the overall median nightly price, and that city\'s OWN scrape date (data_as_of) -- coverage dates differ city to city because Inside Airbnb scrapes each one independently. Call this first if unsure whether a city is covered; str_city_summary and str_listings refuse an uncovered city by naming the covered set, but this is the smaller way to check.',
    summary: 'List every covered city, with listing count, median price, and that city\'s own scrape date.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'str_city_summary',
    description:
      'City-wide short-term rental summary for one city, from Inside Airbnb: total listings, overall median nightly price (in that city\'s own local currency -- see the `currency` field, e.g. CZK for Prague, never converted), a breakdown by room type (entire home/apt, private room, shared room, hotel room -- each with its own count and median price), and the top neighbourhoods by listing count (each with its own listing count and median price). Pass a city name (e.g. "Paris", "NYC", "San Francisco") or its slug (e.g. "new-york-city"). Returns data_as_of = that city\'s own Inside Airbnb scrape date. An uncovered city is refused by name, listing every covered city rather than returning an empty result -- call list_str_cities to browse the full set.',
    summary: 'Median price, room-type breakdown and top neighbourhoods for one city.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        city: { type: 'string', description: 'City name or slug, e.g. "Paris", "NYC", "san-francisco".' },
      },
      required: ['city'],
    },
  },
  {
    name: 'str_listings',
    description:
      'Listing-level short-term rental rows for one city, from Inside Airbnb: listing id, public listing URL, listing title, neighbourhood, room type, nightly price (in that city\'s own local currency -- see the response\'s `currency` field, never converted; min_price/max_price filter in that same currency), minimum nights, review counts, last review date, availability_365, and the host\'s total listing count (a bare number -- no host name, no host id, no host profile link; see the pack\'s "Personal data" note). Pass city plus any combination of neighbourhood, room_type ("Entire home/apt", "Private room", "Shared room", "Hotel room", or a loose match like "apartment"), min_price, max_price to narrow. Rows beyond `limit` are reported via truncated/total_matching rather than silently dropped -- narrow the filters or page with limit/offset to see the rest. An uncovered city is refused by name, listing every covered city.',
    summary: 'Filterable listing-level rows (price, room type, neighbourhood, reviews, availability) for one city.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        city: { type: 'string', description: 'City name or slug, e.g. "Paris", "NYC", "san-francisco".' },
        neighbourhood: { type: 'string', description: 'Optional: filter to one neighbourhood (case-insensitive exact match).' },
        room_type: { type: 'string', description: 'Optional: "Entire home/apt", "Private room", "Shared room", "Hotel room" (loose matches like "apartment" or "house" also work).' },
        min_price: { type: 'number', description: 'Optional: minimum nightly price.' },
        max_price: { type: 'number', description: 'Optional: maximum nightly price.' },
        limit: { type: 'number', description: 'Max rows to return, 1-200. Default 50. A truncated response carries truncated:true and total_matching.' },
        offset: { type: 'number', description: 'Pagination offset. Default 0.' },
      },
      required: ['city'],
    },
  },
];

function listingUrl(id: number): string {
  return `https://www.airbnb.com/rooms/${id}`;
}

async function notFoundCity(db: D1Like, input: unknown) {
  const cities = await listCities(db);
  return {
    found: false,
    reason: 'unknown_city',
    message: `${JSON.stringify(input)} is not a city this pack has loaded. Covered cities: ${cities.map((c) => c.display_name).join(', ')}.`,
    covered_cities: cities.map((c) => ({ slug: c.slug, display_name: c.display_name, country: c.country })),
    ...SOURCE,
  };
}

async function listStrCitiesTool(db: D1Like) {
  const cities = await listCities(db);
  if (!cities.length) {
    throw new Error('inside-airbnb: the cities table is bound but returned zero rows -- the store is empty, not merely unfiltered. This is a loader/deploy defect, not a valid empty answer.');
  }
  return {
    found: true,
    total_cities: cities.length,
    cities: cities.map((c) => ({
      slug: c.slug,
      display_name: c.display_name,
      country: c.country,
      currency: c.currency,
      total_listings: c.total_listings,
      median_price: c.median_price,
      data_as_of: c.data_as_of,
    })),
    ...SOURCE,
  };
}

async function strCitySummaryTool(db: D1Like, args: Record<string, unknown>) {
  const slug = normalizeCityInput(args.city);
  const city = slug ? await getCity(db, slug) : null;
  if (!city) return notFoundCity(db, args.city);

  let roomTypeSummary: Record<string, { count: number; median_price: number | null }>;
  try {
    roomTypeSummary = JSON.parse(city.room_type_summary);
  } catch {
    throw new Error(`inside-airbnb: city ${city.slug} has an unparseable room_type_summary -- loader defect, not a valid empty answer.`);
  }

  const neighbourhoods = await topNeighbourhoods(db, city.slug, 20);
  return {
    found: true,
    slug: city.slug,
    display_name: city.display_name,
    country: city.country,
    currency: city.currency,
    total_listings: city.total_listings,
    median_price: city.median_price,
    by_room_type: roomTypeSummary,
    top_neighbourhoods: neighbourhoods.map((n) => ({
      neighbourhood: n.neighbourhood,
      neighbourhood_group: n.neighbourhood_group,
      listing_count: n.listing_count,
      median_price: n.median_price,
    })),
    top_neighbourhoods_truncated: neighbourhoods.length >= 20,
    data_as_of: city.data_as_of,
    ...SOURCE,
  };
}

async function strListingsTool(db: D1Like, args: Record<string, unknown>) {
  const slug = normalizeCityInput(args.city);
  const city = slug ? await getCity(db, slug) : null;
  if (!city) return notFoundCity(db, args.city);

  const neighbourhood = args.neighbourhood != null && args.neighbourhood !== '' ? String(args.neighbourhood).trim() : null;

  let roomType: string | null = null;
  if (args.room_type != null && args.room_type !== '') {
    roomType = normalizeRoomType(args.room_type);
    if (!roomType) {
      return {
        found: false,
        reason: 'invalid_room_type',
        message: `${JSON.stringify(args.room_type)} is not a recognized room type. Use "Entire home/apt", "Private room", "Shared room", or "Hotel room".`,
        ...SOURCE,
      };
    }
  }

  const minPrice = args.min_price != null && args.min_price !== '' ? Number(args.min_price) : null;
  if (minPrice != null && !Number.isFinite(minPrice)) throw new Error('min_price must be a valid number');
  const maxPrice = args.max_price != null && args.max_price !== '' ? Number(args.max_price) : null;
  if (maxPrice != null && !Number.isFinite(maxPrice)) throw new Error('max_price must be a valid number');

  const limit = clampLimit(args.limit);
  const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
  const { rows, total_matching, truncated } = await queryListings(db, city.slug, neighbourhood, roomType, minPrice, maxPrice, limit, offset);

  if (!rows.length) {
    return {
      found: false,
      reason: 'no_listings',
      city: city.slug,
      message: `No listings matched city=${city.slug}${neighbourhood ? ` neighbourhood=${neighbourhood}` : ''}${roomType ? ` room_type=${roomType}` : ''}${minPrice != null ? ` min_price=${minPrice}` : ''}${maxPrice != null ? ` max_price=${maxPrice}` : ''}. The city is covered (${city.total_listings} total listings) but these filters matched none -- widen them.`,
      currency: city.currency,
      data_as_of: city.data_as_of,
      ...SOURCE,
    };
  }

  return {
    found: true,
    city: city.slug,
    display_name: city.display_name,
    currency: city.currency,
    returned: rows.length,
    total_matching,
    truncated,
    ...(truncated ? { hint: 'More rows exist than were returned. Narrow with neighbourhood/room_type/min_price/max_price, or page with limit/offset.' } : {}),
    listings: rows.map((r) => ({
      id: r.id,
      listing_url: listingUrl(r.id),
      name: r.name,
      neighbourhood_group: r.neighbourhood_group,
      neighbourhood: r.neighbourhood,
      room_type: r.room_type,
      price: r.price,
      minimum_nights: r.minimum_nights,
      number_of_reviews: r.number_of_reviews,
      number_of_reviews_ltm: r.number_of_reviews_ltm,
      reviews_per_month: r.reviews_per_month,
      last_review: r.last_review,
      availability_365: r.availability_365,
      host_listing_count: r.calculated_host_listings_count,
    })),
    data_as_of: city.data_as_of,
    ...SOURCE,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const bound = requireDb(args._d1);
  switch (name) {
    case 'list_str_cities':
      return listStrCitiesTool(bound);
    case 'str_city_summary':
      return strCitySummaryTool(bound, args);
    case 'str_listings':
      return strListingsTool(bound, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
