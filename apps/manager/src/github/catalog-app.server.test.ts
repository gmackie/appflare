import type { FetchLike } from "@appflare/cf-api";
import { expect, it } from "vitest";
import { catalogGithubFetch } from "./catalog-app.server";

const repo = "https://api.github.com/repos/appflare/catalog";
const release = "https://github.com/appflare/catalog/releases/download/example@1.0/";
const cdn = "https://release-assets.githubusercontent.com/asset";

it("uses the Llavero binding for GitHub API reads and preserves range and redirect behavior", async () => {
  let lookups = 0;
  const broker: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers);
    expect(headers.has("authorization")).toBe(false);
    if (url === repo + "/releases/tags/example%401.0") {
      lookups++;
      return Response.json({
        assets: [
          { name: "manifest.json", id: 1 },
          { name: "manifest.sig", id: 2 },
        ],
      });
    }
    expect([repo + "/releases/assets/1", repo + "/releases/assets/2"]).toContain(url);
    return new Response(null, { status: 302, headers: { location: cdn } });
  };
  const publicFetch: FetchLike = async (url, init) => {
    expect(url).toBe(cdn);
    const headers = new Headers(init?.headers);
    expect(headers.has("authorization")).toBe(false);
    return new Response(headers.get("range") ?? "ok");
  };
  const fetch = catalogGithubFetch({ LLAVERO_CATALOG: { fetch: broker } }, publicFetch);
  await Promise.all(
    ["manifest.json", "manifest.sig"].map(async (name) =>
      expect(await (await fetch(release + name)).text()).toBe("ok"),
    ),
  );
  expect(lookups).toBe(1);
  expect(
    (await fetch(release + "manifest.json", { redirect: "manual" })).headers.get("location"),
  ).toBe(cdn);
  expect(
    await (await fetch(release + "manifest.json", { headers: { range: "bytes=0-3" } })).text(),
  ).toBe("bytes=0-3");
});

it("keeps public downloads available pending installation and surfaces provider errors", async () => {
  let pending = true;
  let publicReads = 0;
  const fetch = catalogGithubFetch(
    {
      LLAVERO_CATALOG: {
        fetch: async () =>
          pending
            ? new Response(null, {
                status: 503,
                headers: { "X-Llavero-Catalog": "pending-installation" },
              })
            : new Response(null, { status: 429 }),
      },
    },
    async (url) => {
      expect(url).toBe(release + "manifest.json");
      publicReads++;
      return new Response("public");
    },
  );
  expect(await (await fetch(release + "manifest.json")).text()).toBe("public");
  pending = false;
  await expect(fetch(release + "manifest.json")).rejects.toThrow(/429/);
  expect(publicReads).toBe(1);
});

it("passes through unrelated hosts and repositories, and runs anonymously when unconfigured", async () => {
  const seen: string[] = [];
  const inner: FetchLike = async (url, init) => {
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    seen.push(url);
    return new Response("public");
  };
  const configured = catalogGithubFetch(
    {
      LLAVERO_CATALOG: {
        fetch: () => {
          throw new Error("unexpected broker call");
        },
      },
    },
    inner,
  );
  const manifest = `${release}manifest.json`;
  const urls = [
    "https://example.net/manifest.json",
    manifest.replace("appflare/catalog", "other/private"),
    manifest.replace("github.com", "github.com.example.net"),
    manifest.replace("github.com", "a@github.com"),
    manifest.replace("example@1.0/", "%2e%2e/"),
  ];
  for (const url of urls) await configured(url);
  await catalogGithubFetch({}, inner)(`${release}manifest.json`);
  expect(seen).toEqual([...urls, `${release}manifest.json`]);
});
