/**
 * FlowTracker API Configuration
 * 
 * Client-side: uses relative /scraper-api path (proxied by nginx on port 3200)
 * Server-side (SSR): calls localhost:3100 directly (same machine, no nginx needed)
 */

// Client-side: use nginx proxy (reliable, handles connection management)
// Server-side: call scraper directly on localhost (fast, internal)
export const API_BASE = typeof window !== "undefined"
  ? (process.env.NEXT_PUBLIC_API_BASE || "/scraper-api")
  : (process.env.API_BASE || "http://127.0.0.1:3100");

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

