/**
 * Dev-time transport for the lookup handler.
 *
 * Exists so the browser app talks to a real endpoint during development instead
 * of a static file — the wire format and error paths get exercised the same way
 * they will in production, rather than only at deploy time.
 */
import type { Plugin } from "vite";
import { Store } from "../store/db.ts";
import { BadRequest, etagFor, lookupPayload, parseRequest } from "./lookup.ts";

export function filmprintApi(dbPath = process.env.FILMPRINT_DB ?? "data/filmprint.db"): Plugin {
  let store: Store | null = null;
  let stamp = "";

  return {
    name: "filmprint-api",
    configureServer(server) {
      server.middlewares.use("/api/films", async (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: "POST only" }));
          return;
        }

        try {
          store ??= new Store(dbPath);
          stamp ||= String(store.stats().films);

          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          const { filmKeys } = parseRequest(body);

          const etag = etagFor(filmKeys, stamp);
          if (req.headers["if-none-match"] === etag) {
            res.statusCode = 304;
            res.end();
            return;
          }

          const payload = lookupPayload(store, filmKeys);
          res.setHeader("content-type", "application/json");
          res.setHeader("etag", etag);
          // Film metadata is effectively immutable, so a repeat upload should not
          // re-download it. Private because the key set identifies a library.
          res.setHeader("cache-control", "private, max-age=86400");
          res.end(JSON.stringify(payload));
        } catch (err) {
          const bad = err instanceof BadRequest;
          res.statusCode = bad ? 400 : 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: bad ? (err as Error).message : "Lookup failed." }));
          if (!bad) server.config.logger.error(`[filmprint-api] ${(err as Error).stack ?? err}`);
        }
      });
    },
    closeBundle() {
      store?.close();
      store = null;
    },
  };
}
