import { sign } from "node:crypto";
import type { FetchLike } from "@appflare/cf-api";

/** Server-only bindings on the manager. GitHub supplies the RSA PEM when the owner generates a key. */
export interface CatalogGithubApp {
  CATALOG_GITHUB_APP_ID?: string;
  CATALOG_GITHUB_INSTALLATION_ID?: string;
  CATALOG_GITHUB_PRIVATE_KEY?: string;
}

const PUBLIC_CATALOGS = new Set(["appflare/catalog", "gmackie/appflare-catalog"]);
const API = "https://api.github.com";
const USER_AGENT = "Appflare-Catalog";
type Token = { value: string; expires: number };

// Only settled values can cross Worker requests. In-flight fetches below belong to one caller.
const tokens = new WeakMap<CatalogGithubApp, Token>();

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

async function mint(env: CatalogGithubApp, fetch: FetchLike, now: number): Promise<Token> {
  const app = env.CATALOG_GITHUB_APP_ID;
  const installation = env.CATALOG_GITHUB_INSTALLATION_ID;
  const pem = env.CATALOG_GITHUB_PRIVATE_KEY;
  if (!app || !/^\d+$/.test(app) || !installation || !/^\d+$/.test(installation) || !pem) {
    throw new Error(
      "Configure the catalog GitHub App ID, installation ID and private key together.",
    );
  }
  const seconds = Math.floor(now / 1000);
  const encode = (x: object) => Buffer.from(JSON.stringify(x)).toString("base64url");
  const unsigned =
    encode({ alg: "RS256", typ: "JWT" }) +
    "." +
    encode({ iss: app, iat: seconds - 60, exp: seconds + 540 });
  const jwt = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), pem).toString("base64url")}`;
  const response = await fetch(`${API}/app/installations/${installation}/access_tokens`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "User-Agent": USER_AGENT,
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ permissions: { contents: "read" } }),
  });
  if (!response.ok)
    throw new Error(`GitHub App installation token request returned HTTP ${response.status}`);
  const data = (await response.json()) as { token?: string; expires_at?: string };
  const expires = Date.parse(data.expires_at ?? "");
  if (!data.token || !Number.isFinite(expires) || expires <= now)
    throw new Error("GitHub returned an invalid installation token.");
  const result = { value: data.token, expires };
  tokens.set(env, result);
  return result;
}

/** Read public catalog release assets through GitHub's authenticated REST API. */
export function catalogGithubFetch(
  env: CatalogGithubApp,
  inner: FetchLike,
  now = Date.now,
): FetchLike {
  if (
    !env.CATALOG_GITHUB_APP_ID &&
    !env.CATALOG_GITHUB_INSTALLATION_ID &&
    !env.CATALOG_GITHUB_PRIVATE_KEY
  )
    return inner;
  let minting: Promise<Token> | undefined;
  const releases = new Map<string, Promise<Map<string, number>>>();
  async function api(url: string, accept: string, range?: string | null) {
    let token = tokens.get(env);
    if (!token || token.expires <= now() + 60_000) {
      minting ??= mint(env, inner, now()).finally(() => {
        minting = undefined;
      });
      token = await minting;
    }
    const headers = new Headers({
      "User-Agent": USER_AGENT,
      Accept: accept,
      Authorization: `Bearer ${token.value}`,
    });
    if (range) headers.set("Range", range);
    const res = await inner(url, { headers, redirect: "manual" });
    if (res.status === 401 && tokens.get(env) === token) tokens.delete(env);
    return res;
  }
  async function lookup(url: string) {
    const res = await api(url, "application/vnd.github+json");
    if (!res.ok) throw new Error(`GitHub catalog release lookup returned HTTP ${res.status}`);
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
    const id = (await release).get(route.name);
    if (!id || !Number.isSafeInteger(id))
      throw new Error(`The catalog release has no ${route.name} asset.`);
    const range = new Headers(init?.headers).get("range");
    const response = await api(`${base}/assets/${id}`, "application/octet-stream", range);
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
