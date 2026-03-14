/**
 * Proxy-aware fetch for Polymarket API calls.
 *
 * When PROXY_URL env var is set (e.g. http://user:pass@eu-proxy:8080),
 * all Polymarket requests are routed through it — bypassing geoblock.
 *
 * Supports HTTP/HTTPS SOCKS4/SOCKS5 proxies via undici ProxyAgent.
 * Non-Polymarket calls (Kraken, etc.) always use direct fetch.
 */

import { ProxyAgent, fetch as undiciFetch } from "undici";

let _agent: ProxyAgent | null = null;
let _proxyFetch: typeof fetch | null = null;

function buildProxyFetch(): typeof fetch {
  const proxyUrl = process.env.PROXY_URL?.trim();
  if (!proxyUrl) return fetch;

  if (!_agent) {
    _agent = new ProxyAgent(proxyUrl);
    console.log(`[PROXY] Routing Polymarket requests via: ${proxyUrl.replace(/:([^@]+)@/, ":***@")}`);
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

/** Returns proxied fetch if PROXY_URL is set, otherwise native fetch. */
export function polyFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  return buildProxyFetch()(input as string, init);
}

export function hasProxy(): boolean {
  return Boolean(process.env.PROXY_URL?.trim());
}
