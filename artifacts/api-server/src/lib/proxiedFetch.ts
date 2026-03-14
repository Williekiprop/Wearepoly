/**
 * Proxy-aware fetch for Polymarket API calls.
 *
 * Proxy URL is read from PROXY_URL env var on startup, or set at runtime
 * via setProxyUrl(). Supports HTTP/HTTPS and SOCKS5 proxies via undici.
 *
 * Non-Polymarket calls (Kraken BTC prices) always use direct fetch.
 */

import { ProxyAgent, fetch as undiciFetch } from "undici";

let _runtimeUrl: string | null = null;
let _agent: ProxyAgent | null = null;
let _proxyFetch: typeof fetch | null = null;

/** Strip trailing slash — undici ProxyAgent misparses URLs like http://host:port/ */
function cleanUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function getActiveUrl(): string | null {
  const raw = _runtimeUrl ?? process.env.PROXY_URL ?? null;
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
  if (_runtimeUrl) {
    console.log(`[PROXY] Set to: ${maskUrl(_runtimeUrl)}`);
  } else {
    console.log("[PROXY] Cleared.");
  }
}

/** Returns a password-masked copy of the URL for logging/display. */
export function maskUrl(url: string): string {
  return url.replace(/:([^@:]+)@/, ":***@");
}

/** Returns the active proxy URL (masked for display), or null if none. */
export function getProxyDisplay(): string | null {
  const url = getActiveUrl();
  return url ? maskUrl(url) : null;
}

/** Returns true if a proxy is configured. */
export function hasProxy(): boolean {
  return Boolean(getActiveUrl());
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
    return { proxyIp, proxyCountry, proxyOrg, isDatacenter, directIp, proxyConfigured: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[PROXY TEST] Failed:", msg);
    return { proxyIp: null, proxyCountry: null, directIp, proxyConfigured: true, error: msg };
  }
}
