/**
 * Build-time TMDB client. Never bundled into the browser — the API key lives in
 * .env and is read only by the generator.
 */
import { APPEND_TO_RESPONSE, extractFilm, type FilmMetadata } from "./schema.ts";

const BASE = "https://api.themoviedb.org/3";

/** Simple token bucket. TMDB tolerates roughly 50 req/s; we default lower. */
class RateLimiter {
  #tokens: number;
  #lastRefill = Date.now();
  readonly #rps: number;
  constructor(rps: number) {
    this.#rps = rps;
    this.#tokens = rps;
  }
  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.#tokens = Math.min(this.#rps, this.#tokens + ((now - this.#lastRefill) / 1000) * this.#rps);
      this.#lastRefill = now;
      if (this.#tokens >= 1) {
        this.#tokens -= 1;
        return;
      }
      await sleep(Math.ceil((1 - this.#tokens) * (1000 / this.#rps)));
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type SearchResult = {
  id: number;
  title: string;
  original_title: string;
  release_date: string;
  vote_count: number;
  popularity: number;
};

export class TmdbClient {
  #limiter: RateLimiter;
  #calls = 0;
  readonly #apiKey: string;

  constructor(apiKey: string, rps = 20) {
    this.#apiKey = apiKey;
    if (!apiKey) {
      throw new Error(
        "TMDB_API_KEY is empty. Copy .env.example to .env and paste your key.\n" +
          "Get one at https://www.themoviedb.org/settings/api",
      );
    }
    this.#limiter = new RateLimiter(rps);
  }

  get callCount(): number {
    return this.#calls;
  }

  async #get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(BASE + path);
    url.searchParams.set("api_key", this.#apiKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.#limiter.take();
      this.#calls++;
      let res: Response;
      try {
        res = await fetch(url, { headers: { accept: "application/json" } });
      } catch (err) {
        if (attempt === maxAttempts) throw err;
        await sleep(2 ** attempt * 250);
        continue;
      }

      if (res.status === 429) {
        // Honour Retry-After when TMDB sends it; otherwise back off.
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 500);
        continue;
      }
      if (res.status === 404) throw new NotFound(path);
      if (res.status >= 500) {
        if (attempt === maxAttempts) throw new Error(`TMDB ${res.status} on ${path}`);
        await sleep(2 ** attempt * 250);
        continue;
      }
      if (!res.ok) throw new Error(`TMDB ${res.status} on ${path}: ${await res.text()}`);
      return (await res.json()) as T;
    }
    throw new Error(`TMDB: exhausted retries on ${path}`);
  }

  /** One request per film: details + credits + keywords together. */
  async film(tmdbId: number): Promise<FilmMetadata> {
    const raw = await this.#get<Parameters<typeof extractFilm>[0]>(`/movie/${tmdbId}`, {
      append_to_response: APPEND_TO_RESPONSE,
    });
    return extractFilm(raw);
  }

  async searchMovie(title: string, year?: number): Promise<SearchResult[]> {
    const params: Record<string, string> = { query: title, include_adult: "true" };
    if (year) params.year = String(year);
    const body = await this.#get<{ results?: SearchResult[] }>("/search/movie", params);
    return body.results ?? [];
  }

  /** Part list for a collection, used by the completionist stat. */
  async collection(id: number): Promise<{
    id: number;
    name?: string;
    parts?: { id: number; title?: string; release_date?: string | null }[];
  }> {
    return this.#get(`/collection/${id}`);
  }
}

export class NotFound extends Error {
  constructor(path: string) {
    super(`TMDB 404: ${path}`);
    this.name = "NotFound";
  }
}

/** Bounded-concurrency map that preserves input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
