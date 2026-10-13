/**
 * Reads for inside-airbnb (fleet #2973).
 *
 * Data: Inside Airbnb (insideairbnb.com) -- per-city "visualisations/
 * listings.csv" summary snapshots, CC BY 4.0. Each covered city has its own
 * scrape date (`data_as_of`). Loaded into a D1 database the gateway hands
 * this pack as `_d1` (pack-manifest "d1Binding": "INSIDE_AIRBNB_DB") by
 * scripts/inside-airbnb/load-data.mjs -- never by a deploy.
 *
 * PERSONAL DATA: Inside Airbnb's raw file carries host_id, host_name and
 * host_profile_id (the host's first name and a link to their public Airbnb
 * profile) alongside every listing row, plus a `license` field that can hold
 * a local registration number. NONE of those four columns are read by the
 * loader and NONE exist in any table here -- there is no column to
 * accidentally select. `calculated_host_listings_count` (how many listings
 * that host runs, as a bare count) is kept because it is a number, not an
 * identifier. See README.md "Personal data" for the full accounting.
 *
 * Three tables:
 *   - cities: one row per covered city -- totals, overall median price, a
 *     JSON room-type breakdown, and that city's own data_as_of.
 *   - neighbourhoods: one row per (city, neighbourhood) -- listing count and
 *     median price, precomputed at load time.
 *   - listings: one row per listing -- the fields listed above, nothing else.
 *
 * Medians are precomputed by the LOADER (in Node, over the full in-memory
 * price array for each group) rather than computed per-request in D1 --
 * SQLite/D1 has no MEDIAN() aggregate, and the integer-offset subquery idiom
 * run per neighbourhood per request would multiply badly under the 50ms CPU
 * budget. Precomputing also means str_city_summary is one SELECT, not N.
 */

export interface D1Like {
  prepare(sql: string): D1StmtLike;
}
export interface D1StmtLike {
  bind(...values: unknown[]): D1StmtLike;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export class StoreUnavailableError extends Error {
  constructor() {
    super(
      'inside-airbnb: the short-term rental store is not bound in this runtime (no _d1). These tools only answer through the Pipeworx gateway; a standalone install has no data to read.',
    );
    this.name = 'StoreUnavailableError';
  }
}
export function requireDb(d1: unknown): D1Like {
  if (!d1 || typeof (d1 as D1Like).prepare !== 'function') throw new StoreUnavailableError();
  return d1 as D1Like;
}

export const SOURCE = {
  source: 'Inside Airbnb, per-city listings summary',
  source_url: 'https://insideairbnb.com/',
  license: 'CC BY 4.0 (Inside Airbnb) -- https://creativecommons.org/licenses/by/4.0/',
  attribution: 'Data sourced from Inside Airbnb (insideairbnb.com), licensed under CC BY 4.0.',
};

/** Row-count limit for str_listings: default 50, max 200, keeping a default
 *  response well under ~40KB. */
export function clampLimit(requested: unknown, dflt = 50, max = 200): number {
  const n = Math.floor(Number(requested));
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(n, max);
}

export interface CityRow {
  slug: string;
  display_name: string;
  country: string;
  currency: string | null;
  data_as_of: string;
  total_listings: number;
  median_price: number | null;
  room_type_summary: string; // JSON: { [roomType]: { count, median_price } }
  loaded_at: string;
}

export async function getCity(db: D1Like, slug: string): Promise<CityRow | null> {
  return db.prepare('SELECT * FROM cities WHERE slug = ?').bind(slug).first<CityRow>();
}

export async function listCities(db: D1Like): Promise<CityRow[]> {
  const r = await db.prepare('SELECT * FROM cities ORDER BY display_name').all<CityRow>();
  return r.results;
}

export interface NeighbourhoodRow {
  city_slug: string;
  neighbourhood: string;
  neighbourhood_group: string | null;
  listing_count: number;
  median_price: number | null;
}

export async function topNeighbourhoods(db: D1Like, citySlug: string, limit = 20): Promise<NeighbourhoodRow[]> {
  const r = await db
    .prepare('SELECT * FROM neighbourhoods WHERE city_slug = ? ORDER BY listing_count DESC LIMIT ?')
    .bind(citySlug, limit)
    .all<NeighbourhoodRow>();
  return r.results;
}

export interface ListingRow {
  id: number;
  city_slug: string;
  name: string | null;
  neighbourhood_group: string | null;
  neighbourhood: string | null;
  room_type: string;
  price: number | null;
  minimum_nights: number | null;
  number_of_reviews: number;
  number_of_reviews_ltm: number;
  reviews_per_month: number | null;
  last_review: string | null;
  availability_365: number | null;
  calculated_host_listings_count: number | null;
}

export interface PagedResult<T> {
  rows: T[];
  total_matching: number;
  truncated: boolean;
}

export async function queryListings(
  db: D1Like,
  citySlug: string,
  neighbourhood: string | null,
  roomType: string | null,
  minPrice: number | null,
  maxPrice: number | null,
  limit: number,
  offset: number,
): Promise<PagedResult<ListingRow>> {
  const where = ['city_slug = ?'];
  const params: unknown[] = [citySlug];
  if (neighbourhood) {
    where.push('neighbourhood = ? COLLATE NOCASE');
    params.push(neighbourhood);
  }
  if (roomType) {
    where.push('room_type = ? COLLATE NOCASE');
    params.push(roomType);
  }
  if (minPrice != null) {
    where.push('price >= ?');
    params.push(minPrice);
  }
  if (maxPrice != null) {
    where.push('price <= ?');
    params.push(maxPrice);
  }
  const whereSql = where.join(' AND ');
  const sql = `SELECT id, city_slug, name, neighbourhood_group, neighbourhood, room_type, price, minimum_nights,
      number_of_reviews, number_of_reviews_ltm, reviews_per_month, last_review, availability_365, calculated_host_listings_count
    FROM listings WHERE ${whereSql}
    ORDER BY number_of_reviews DESC, id
    LIMIT ? OFFSET ?`;
  const countSql = `SELECT COUNT(*) AS n FROM listings WHERE ${whereSql}`;
  const [r, c] = await Promise.all([
    db.prepare(sql).bind(...params, limit, offset).all<ListingRow>(),
    db.prepare(countSql).bind(...params).first<{ n: number }>(),
  ]);
  const total = c?.n ?? r.results.length;
  return { rows: r.results, total_matching: total, truncated: offset + r.results.length < total };
}

/** Resolve a caller's free-text city name to a canonical slug by exact alias
 *  match, then by loose normalization (lowercase, strip punctuation, spaces
 *  -> hyphens) against the slug itself. Does NOT guarantee the slug is
 *  actually loaded -- callers check against the `cities` table for that. */
const CITY_ALIASES: Record<string, string> = {
  'new york': 'new-york-city', nyc: 'new-york-city', ny: 'new-york-city', 'new york city': 'new-york-city',
  la: 'los-angeles', 'los angeles': 'los-angeles',
  sf: 'san-francisco', 'san francisco': 'san-francisco',
  washington: 'washington-dc', dc: 'washington-dc', 'washington dc': 'washington-dc', 'washington d.c.': 'washington-dc',
  cdmx: 'mexico-city', 'mexico city': 'mexico-city',
  munchen: 'munich', munich: 'munich',
  roma: 'rome', rome: 'rome',
  milano: 'milan', milan: 'milan',
  venezia: 'venice', venice: 'venice',
  firenze: 'florence', florence: 'florence',
  lisboa: 'lisbon', lisbon: 'lisbon',
  wien: 'vienna', vienna: 'vienna',
  praha: 'prague', prague: 'prague',
  kobenhavn: 'copenhagen', copenhagen: 'copenhagen',
  'hong kong': 'hong-kong',
  rio: 'rio-de-janeiro', 'rio de janeiro': 'rio-de-janeiro',
  'new orleans': 'new-orleans',
  'san diego': 'san-diego',
  'cape town': 'cape-town',
};

export function normalizeCityInput(input: unknown): string {
  const s = String(input ?? '').trim().toLowerCase();
  const aliased = CITY_ALIASES[s];
  if (aliased) return aliased;
  return s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The four room_type values Inside Airbnb actually uses, plus loose aliases
 *  a caller might type. Returns null (no filter) rather than guessing when
 *  the input doesn't resolve -- callers decide whether that is an error. */
const ROOM_TYPE_ALIASES: Record<string, string> = {
  'entire home/apt': 'Entire home/apt', 'entire home': 'Entire home/apt', 'entire apartment': 'Entire home/apt',
  apartment: 'Entire home/apt', apt: 'Entire home/apt', house: 'Entire home/apt', 'entire place': 'Entire home/apt',
  'private room': 'Private room', private: 'Private room',
  'shared room': 'Shared room', shared: 'Shared room',
  'hotel room': 'Hotel room', hotel: 'Hotel room',
};
export function normalizeRoomType(input: unknown): string | null {
  if (input == null || input === '') return null;
  const s = String(input).trim().toLowerCase();
  return ROOM_TYPE_ALIASES[s] ?? null;
}
