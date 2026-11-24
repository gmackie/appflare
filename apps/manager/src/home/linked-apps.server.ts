import { z } from "zod";
import type { LinkedApp } from "./layout-data";

const links = z
  .array(
    z.object({
      name: z.string().trim().min(1).max(80),
      url: z.url({ protocol: /^https$/ }).refine((s) => {
        const url = new URL(s);
        return !url.username && !url.password;
      }),
    }),
  )
  .max(100);

export async function readLinkedApps(db: D1Database): Promise<LinkedApp[]> {
  const value = await db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .bind("linked_apps")
    .first<string>("value");
  if (!value) return [];
  try {
    const parsed = links.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}
