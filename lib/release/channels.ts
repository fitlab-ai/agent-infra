type FetchResponse = { ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> };
type Fetcher = (url: string) => Promise<FetchResponse>;

async function inspectNpmChannel(name: string, version: string, fetcher: Fetcher = fetch as unknown as Fetcher) {
  try {
    const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`);
    if (response.status === 404) return { status: 'no-op' as const, published: false, version, error: null };
    if (!response.ok) return { status: 'blocked' as const, published: null, version, error: { code: 'NPM_REGISTRY_UNAVAILABLE', message: `npm registry returned ${response.status}` } };
    const body = await response.json() as Record<string, unknown>;
    return { status: 'no-op' as const, published: body.version === version, version, error: null };
  } catch (error) {
    return { status: 'blocked' as const, published: null, version, error: { code: 'NPM_REGISTRY_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) } };
  }
}

async function inspectHomebrewChannel(url: string, version: string, fetcher: Fetcher = fetch as unknown as Fetcher) {
  try {
    const response = await fetcher(url);
    if (response.status === 404) return { status: 'no-op' as const, published: false, version, error: null };
    if (!response.ok) return { status: 'blocked' as const, published: null, version, error: { code: 'HOMEBREW_UNAVAILABLE', message: `formula endpoint returned ${response.status}` } };
    const formula = await response.text();
    const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { status: 'no-op' as const, published: new RegExp(`(?:version\\s+["']${escaped}["']|/v?${escaped}\\.)`).test(formula), version, error: null };
  } catch (error) {
    return { status: 'blocked' as const, published: null, version, error: { code: 'HOMEBREW_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) } };
  }
}

export { inspectHomebrewChannel, inspectNpmChannel };
export type { Fetcher, FetchResponse };
