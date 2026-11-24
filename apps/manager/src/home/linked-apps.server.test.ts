import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { readLinkedApps } from "./linked-apps.server";

beforeEach(async () => {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
  ).run();
  await env.DB.prepare("DELETE FROM settings WHERE key = 'linked_apps'").run();
});

async function store(value: string) {
  await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('linked_apps', ?, 0)")
    .bind(value)
    .run();
}

it("reads operator links from settings when no installation exists", async () => {
  expect(await readLinkedApps(env.DB)).toEqual([]);
  const links = [{ name: "Observability", url: "https://observe.example/app" }];
  await store(JSON.stringify(links));
  expect(await readLinkedApps(env.DB)).toEqual(links);
});

it.each([
  "not json",
  '{"links":[]}',
  '[{"name":"X","url":"javascript:alert(1)"}]',
  '[{"name":"X","url":"https://user:secret@example.org"}]',
])("ignores a malformed link configuration", async (value) => {
  await store(value);
  expect(await readLinkedApps(env.DB)).toEqual([]);
});
