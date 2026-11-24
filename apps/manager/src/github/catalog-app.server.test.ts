import { generateKeyPairSync, verify } from "node:crypto";
import type { FetchLike } from "@appflare/cf-api";
import { expect, it } from "vitest";
import { catalogGithubFetch } from "./catalog-app.server";

const repo = "https://api.github.com/repos/appflare/catalog";
const release = "https://github.com/appflare/catalog/releases/download/example@1.0/";
const cdn = "https://release-assets.githubusercontent.com/asset";

it("uses expiring read-only credentials for catalog assets and keeps the token off the CDN", async () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const env = {
    CATALOG_GITHUB_APP_ID: "42",
    CATALOG_GITHUB_INSTALLATION_ID: "77",
    CATALOG_GITHUB_PRIVATE_KEY: keys.privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
  };
  let now = Date.now();
  let minted = 0;
  let lookups = 0;
  const inner: FetchLike = async (url, init) => {
    const h = new Headers(init?.headers);
    if (url === "https://api.github.com/app/installations/77/access_tokens") {
      const jwt = h.get("authorization")?.slice(7).split(".");
      if (!jwt?.[1] || !jwt[2] || jwt.length !== 3) throw new Error("Expected an App JWT");
      expect(
        verify(
          "RSA-SHA256",
          Buffer.from(jwt.slice(0, 2).join(".")),
          keys.publicKey,
          Buffer.from(jwt[2], "base64url"),
        ),
      ).toBe(true);
      const claims = JSON.parse(Buffer.from(jwt[1], "base64url").toString());
      expect(claims.iss).toBe("42");
      expect(claims.exp - Math.floor(now / 1000)).toBeLessThanOrEqual(600);
      expect(JSON.parse(String(init?.body))).toEqual({ permissions: { contents: "read" } });
      expect(init?.redirect).toBe("manual");
      minted++;
      return Response.json({
        token: `token-${minted}`,
        expires_at: new Date(now + 3600000).toISOString(),
      });
    }
    if (url === `${repo}/releases/tags/example%401.0`) {
      expect(h.get("authorization")).toBe(`Bearer token-${minted}`);
      lookups++;
      return Response.json({
        assets: [
          { name: "manifest.json", id: 1 },
          { name: "manifest.sig", id: 2 },
          { name: "example.zip", id: 3 },
        ],
      });
    }
    if (url.startsWith(`${repo}/releases/assets/`)) {
      expect(h.get("authorization")).toBe(`Bearer token-${minted}`);
      expect(h.get("accept")).toBe("application/octet-stream");
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { location: cdn } });
    }
    expect(url).toBe(cdn);
    expect(h.has("authorization")).toBe(false);
    return new Response(h.get("range") ?? "manifest");
  };
  const fetch = catalogGithubFetch(env, inner, () => now);
  await Promise.all(
    ["manifest.json", "manifest.sig"].map(async (name) => {
      expect(await (await fetch(release + name)).text()).toBe("manifest");
    }),
  );
  expect(minted).toBe(1);
  expect(lookups).toBe(1);
  const manually = await fetch(`${release}example.zip`, {
    redirect: "manual",
    headers: { Range: "bytes=0-5" },
  });
  expect(manually.headers.get("location")).toBe(cdn);
  expect(
    await (await fetch(`${release}example.zip`, { headers: { Range: "bytes=0-5" } })).text(),
  ).toBe("bytes=0-5");
  now += 60 * 60_000;
  await fetch(`${release}manifest.json`);
  expect(minted).toBe(2);
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
      CATALOG_GITHUB_APP_ID: "1",
      CATALOG_GITHUB_INSTALLATION_ID: "2",
      CATALOG_GITHUB_PRIVATE_KEY: "never used",
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
