/**
 * Proxy-aware fetch for Polymarket API calls.
 *
 * Proxy URL is read from PROXY_URL env var on startup, or set at runtime
 * via setProxyUrl() (e.g. from the dashboard UI). Runtime value takes
 * precedence over env var.
 *
 * Supports HTTP/HTTPS and SOCKS5 proxies via undici ProxyAgent.
 * Non-Polymarket calls (Kraken BTC prices) always use direct fetch.
 */

import { ProxyAgent, fetch as undiciFetch } from "undici";

let _runtimeUrl: string | null = null;
let _agent: ProxyAgent | null = null;
let _proxyFetch: typeof fetch | null = null;

function getActiveUrl(): string | null {
  return _runtimeUrl ?? process.env.PROXY_URL?.trim() ?? null;
}

function buildProxyFetch(): typeof fetch {
  const proxyUrl = getActiveUrl();
  if (!proxyUrl) return fetch;

  if (!_agent) {
    _agent = new ProxyAgent(proxyUrl);
    console.log(`[PROXY] Routing Polymarket requests via: ${maskUrl(proxyUrl)}`);
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
  _runtimeUrl = url?.trim() || null;
  _agent = null;
  _proxyFetch = null;
  if (_runtimeUrl) {
    console.log(`[PROXY] Updated proxy URL: ${maskUrl(_runtimeUrl)}`);
  } else {
    console.log("[PROXY] Proxy cleared.");
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
