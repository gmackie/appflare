import type { FetchLike } from "@appflare/cf-api";

/** Private Cloudflare service binding to Llavero's AppflareCatalog entrypoint. */
export interface CatalogGithubApp {
  LLAVERO_CATALOG?: { fetch: FetchLike };
}
const PUBLIC_CATALOGS = new Set(["appflare/catalog", "gmackie/appflare-catalog"]);
const API = "https://api.github.com";

function assetRoute(input: string) {
  const url = URL.parse(input);
  if (
    url?.origin !== "https://github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return null;
  const [, repository, rawTag, rawName] =
    /^\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(url.pathname) ?? [];
  const repo = repository?.toLowerCase();
  if (!repo || !rawTag || !rawName || !PUBLIC_CATALOGS.has(repo)) return null;
  try {
    return { repo, tag: decodeURIComponent(rawTag), name: decodeURIComponent(rawName) };
  } catch {
    return null;
  }
}

/** Resolve signed release assets through Llavero while preserving public reads before setup. */
export function catalogGithubFetch(
  env: CatalogGithubApp,
  inner: FetchLike,
  count: (fetch: FetchLike) => FetchLike = (f) => f,
): FetchLike {
  const binding = env.LLAVERO_CATALOG;
  if (!binding) return inner;
  const read = count((input, init) => binding.fetch(input, init));
  const pending = (r: Response) =>
    r.status === 503 && r.headers.get("X-Llavero-Catalog") === "pending-installation";
  const releases = new Map<string, Promise<Map<string, number> | null>>();
  async function lookup(url: string) {
    const res = await read(url, { redirect: "manual" });
    if (pending(res)) return null;
    if (!res.ok) throw new Error(`Llavero catalog release lookup returned HTTP ${res.status}`);
    const release = (await res.json()) as { assets: { name: string; id: number }[] };
    return new Map(release.assets.map((a) => [a.name, a.id]));
  }
  return async (input, init) => {
    const route = assetRoute(input);
    if (!route || (init?.method ?? "GET").toUpperCase() !== "GET") return inner(input, init);
    const base = `${API}/repos/${route.repo}/releases`;
    const tagUrl = `${base}/tags/${encodeURIComponent(route.tag)}`;
    let release = releases.get(tagUrl);
    if (!release) {
      release = lookup(tagUrl).catch((error) => {
        releases.delete(tagUrl);
        throw error;
      });
      releases.set(tagUrl, release);
    }
    const assets = await release;
    if (assets === null) {
      releases.delete(tagUrl);
      return inner(input, init);
    }
    const id = assets.get(route.name);
    if (!id || !Number.isSafeInteger(id))
      throw new Error(`The catalog release has no ${route.name} asset.`);
    const range = new Headers(init?.headers).get("range");
    const response = await read(`${base}/assets/${id}`, {
      redirect: "manual",
      headers: range ? { Range: range } : {},
    });
    if (pending(response)) return inner(input, init);
    const location = response.headers.get("location");
    if (response.status !== 302 || !location) return response;
    const target = URL.parse(location);
    if (target?.protocol !== "https:" || target.username || target.password)
      throw new Error("GitHub returned an invalid release download URL.");
    if (init?.redirect === "manual") return response;
    await response.body?.cancel();
    if (init?.redirect === "error") throw new Error("GitHub redirected the asset download.");
    return inner(target.href, { headers: range ? { Range: range } : {}, redirect: "follow" });
  };
}
