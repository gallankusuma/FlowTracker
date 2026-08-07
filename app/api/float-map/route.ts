import { NextResponse } from "next/server";
import { readFile } from "fs/promises";

/**
 * Serves the nightly Float Cost Map snapshot.
 *
 * Reads a file the nightly job writes, rather than querying anything. Two
 * constraints shaped that: the frontend has no database client, and the scraper
 * that does is frozen for its operational burn-in — so neither gets touched.
 *
 * The file deliberately does NOT live in public/. Next 16 snapshots that
 * directory at build time, so a file written afterwards 404s until the next
 * rebuild; verified on the deployed box, not assumed. Reading it here at
 * request time decouples the daily data from the frontend build entirely.
 */

// The snapshot changes once a day and must never be baked into the build.
export const dynamic = "force-dynamic";

const SNAPSHOT = process.env.FLOAT_MAP_JSON || "/var/www/flowtracker/data/float-map.json";

export async function GET() {
  try {
    const raw = await readFile(SNAPSHOT, "utf8");
    return new NextResponse(raw, {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch {
    // 503, not an empty 200. A page that receives {} renders an empty map and
    // looks like a market with no cost structure, which is a lie a reader has
    // no way to detect.
    return NextResponse.json(
      { error: "FLOAT_MAP_NOT_GENERATED", detail: "The nightly job has not written a snapshot yet." },
      { status: 503 },
    );
  }
}
