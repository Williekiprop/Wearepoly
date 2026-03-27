/**
 * Proxy-aware fetch for Polymarket API calls.
 *
 * Proxy URL is read from PROXY_URL env var on startup, or set at runtime
 * via setProxyUrl(). Supports HTTP/HTTPS and SOCKS5 proxies via undici.
 *
 * Non-Polymarket calls (Kraken BTC prices) always use direct fetch.
 */

import { ProxyAgent, fetch as undiciFetch } from "undici";

// undefined  = never set by user (fall back to PROXY_URL env var)
// null       = user explicitly cleared (ignore env var)
// string     = user-supplied override URL
let _runtimeUrl: string | null | undefined = undefined;
let _agent: ProxyAgent | null = null;
let _proxyFetch: typeof fetch | null = null;

// Geoblock cooldown: after a geoblock, suspend the proxy for this many ms before retrying
const GEOBLOCK_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
let _geoblockedUntil = 0;

/** Normalise proxy URL — strip trailing slash, convert tcp:// → http:// */
function cleanUrl(url: string): string {
  return url.trim()
    .replace(/^tcp:\/\//i, "http://")   // ngrok tcp:// tunnels are HTTP proxies
    .replace(/\/+$/, "");               // strip trailing slashes
}

function getActiveUrl(): string | null {
  // If proxy is in geoblock cooldown, return null (suspended, not cleared)
  if (_geoblockedUntil > 0 && Date.now() < _geoblockedUntil) return null;
  // Cooldown expired — reset so proxy can be retried
  if (_geoblockedUntil > 0 && Date.now() >= _geoblockedUntil) {
    _geoblockedUntil = 0;
    _agent = null;
    _proxyFetch = null;
    console.log("[PROXY] Geoblock cooldown expired — re-enabling proxy for next attempt");
  }
  // If user has explicitly set or cleared at runtime, respect that — never fall back to env var
  if (_runtimeUrl !== undefined) return _runtimeUrl ? cleanUrl(_runtimeUrl) : null;
  // Otherwise use the env var (startup default)
  const raw = process.env.PROXY_URL ?? null;
  return raw ? cleanUrl(raw) : null;
}

function buildProxyFetch(): typeof fetch {
  const proxyUrl = getActiveUrl();
  if (!proxyUrl) return fetch;

  if (!_agent) {
    try {
      _agent = new ProxyAgent(proxyUrl);
      console.log(`[PROXY] Agent created via: ${maskUrl(proxyUrl)}`);
    } catch (e) {
      console.error("[PROXY] Failed to create ProxyAgent:", e);
      return fetch;
    }
  }

  if (!_proxyFetch) {
    _proxyFetch = (input, init) =>
      undiciFetch(input as string | URL, {
        ...(init as object),
        dispatcher: _agent!,
      }) as unknown as Promise<Response>;
  }

  return _proxyFetch;
}

/** Set (or clear) the proxy URL at runtime — no server restart needed. */
export function setProxyUrl(url: string | null): void {
  _runtimeUrl = url ? cleanUrl(url) : null;
  _agent = null;
  _proxyFetch = null;
  _geoblockedUntil = 0; // always reset geoblock cooldown when user changes proxy
  if (_runtimeUrl) {
    console.log(`[PROXY] Set to: ${maskUrl(_runtimeUrl)}`);
  } else {
    console.log("[PROXY] Cleared.");
  }
}

/**
 * Mark the current proxy as temporarily geoblocked.
 * The proxy URL is NOT cleared — it will be retried after GEOBLOCK_COOLDOWN_MS.
 * This allows automatic re-try when the user's VPN switches to a non-blocked region.
 */
export function markProxyGeoblocked(): void {
  _geoblockedUntil = Date.now() + GEOBLOCK_COOLDOWN_MS;
  _agent = null;
  _proxyFetch = null;
  const retryAt = new Date(_geoblockedUntil).toISOString();
  console.warn(`[PROXY] Geoblocked — suspended until ${retryAt} (5 min cooldown)`);
}

/**
 * Reset geoblock cooldown immediately — call this when the user's VPN has switched
 * to a non-blocked region and they want to retry without waiting.
 * The proxy URL is preserved.
 */
export function resetGeoblockCooldown(): void {
  _geoblockedUntil = 0;
  _agent = null;
  _proxyFetch = null;
  console.log("[PROXY] Geoblock cooldown reset manually — proxy will be retried on next request");
}

/** Returns a password-masked copy of the URL for logging/display. */
export function maskUrl(url: string): string {
  return url.replace(/:([^@:]+)@/, ":***@");
}

/** Returns the active proxy URL (masked for display), or null if none. */
export function getProxyDisplay(): string | null {
  const url = getActiveUrl();
  if (url) return maskUrl(url);
  // Show cooldown status if proxy URL exists but is temporarily suspended
  const rawUrl = _runtimeUrl ?? process.env.PROXY_URL;
  if (rawUrl && _geoblockedUntil > Date.now()) {
    const secsLeft = Math.ceil((_geoblockedUntil - Date.now()) / 1000);
    const minsLeft = Math.ceil(secsLeft / 60);
    return `GEOBLOCKED — retrying in ${minsLeft}m (${maskUrl(cleanUrl(rawUrl))})`;
  }
  return null;
}

/** Returns time remaining in geoblock cooldown (ms), or 0 if not in cooldown. */
export function getGeoblockCooldownMs(): number {
  return Math.max(0, _geoblockedUntil - Date.now());
}

/** Returns the raw configured proxy URL regardless of geoblock cooldown. */
function getRawUrl(): string | null {
  if (_runtimeUrl !== undefined) return _runtimeUrl ? cleanUrl(_runtimeUrl) : null;
  const raw = process.env.PROXY_URL ?? null;
  return raw ? cleanUrl(raw) : null;
}

/** Returns true if a proxy URL is configured (even if currently in geoblock cooldown). */
export function hasProxy(): boolean {
  return Boolean(getRawUrl());
}

/** Returns proxied fetch if proxy is configured, otherwise native fetch. */
export function polyFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  return buildProxyFetch()(input as string, init);
}

/**
 * Test the proxy by asking ipify.org what IP it sees.
 * Returns the observed exit IP and its geolocation country.
 * Direct (no-proxy) IP is also returned for comparison.
 */
export async function testProxy(): Promise<{
  proxyIp: string | null;
  proxyCountry: string | null;
  directIp: string | null;
  proxyConfigured: boolean;
  error?: string;
}> {
  const proxyConfigured = hasProxy();

  // Always fetch direct IP
  let directIp: string | null = null;
  try {
    const r = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(8000) });
    const d = await r.json() as { ip: string };
    directIp = d.ip;
  } catch { /* ignore */ }

  if (!proxyConfigured) {
    return { proxyIp: null, proxyCountry: null, directIp, proxyConfigured: false };
  }

  try {
    // Fetch through proxy
    const proxyFetchFn = buildProxyFetch();
    const r = await proxyFetchFn("https://api.ipify.org?format=json", {
      signal: AbortSignal.timeout(10000),
    } as RequestInit);
    const d = await r.json() as { ip: string };
    const proxyIp = d.ip;

    // Geo + ISP lookup (free, no key needed)
    let proxyCountry: string | null = null;
    let proxyOrg: string | null = null;
    let isDatacenter = false;
    try {
      const geo = await fetch(`https://ipapi.co/${proxyIp}/json/`, { signal: AbortSignal.timeout(6000) });
      const geoData = await geo.json() as {
        country_name?: string; city?: string; org?: string;
      };
      proxyCountry = geoData.city
        ? `${geoData.city}, ${geoData.country_name}`
        : (geoData.country_name ?? null);
      proxyOrg = geoData.org ?? null;
      // Heuristic: datacenter ISPs contain these keywords
      const dcKeywords = ["hosting", "datacenter", "data center", "cloud", "vps", "server",
        "webshare", "hetzner", "digitalocean", "linode", "vultr", "aws", "amazon",
        "google", "microsoft", "azure", "ovh", "contabo", "leaseweb"];
      isDatacenter = dcKeywords.some(k => proxyOrg?.toLowerCase().includes(k));
    } catch { /* geo lookup optional */ }

    console.log(`[PROXY TEST] Exit IP: ${proxyIp} (${proxyCountry ?? "unknown"}, org: ${proxyOrg}) | Direct IP: ${directIp}`);
    return { proxyIp, proxyCountry, directIp, proxyConfigured: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[PROXY TEST] Failed:", msg);
    return { proxyIp: null, proxyCountry: null, directIp, proxyConfigured: true, error: msg };
  }
}
