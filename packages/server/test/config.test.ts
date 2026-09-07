import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Config } from "@opencode-ai/schema/config"
import { Effect, Schema } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"
import { AbsolutePath } from "@opencode-ai/schema/schema"

it.live("returns ordered config entries for the requested directory", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-endpoint-")))
    const global = path.join(tmp.path, "global")
    const project = path.join(tmp.path, "project")
    const config = path.join(project, "opencode.json")
    yield* Effect.promise(() =>
      Promise.all([fs.mkdir(global, { recursive: true }), fs.mkdir(project, { recursive: true })]),
    )
    yield* Effect.promise(() =>
      fs.writeFile(
        config,
        JSON.stringify({
          permissions: [
            { action: "shell", resource: "*", effect: "ask" },
            { action: "shell", resource: "git status", effect: "allow" },
          ],
          mcp: { servers: { docs: { type: "remote", url: "https://example.com/mcp" } } },
        }),
      ),
    )
    const server = yield* startServer(global)
    const url = new URL("/api/config", server.base)
    url.searchParams.set("location[directory]", project)
    const response = yield* Effect.promise(() => fetch(url, { headers: server.headers }))
    const body: unknown = yield* Effect.promise(() => response.json())
    const entries = Schema.decodeUnknownSync(Schema.Array(Config.Entry))(body)

    expect(response.status).toBe(200)
    expect(Array.isArray(entries)).toBe(true)
    const document = entries.find(
      (entry): entry is Config.Document => entry.type === "document" && entry.path === config,
    )
    expect(document?.info.permissions).toEqual([
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "git status", effect: "allow" },
    ])
    expect(document?.path).toBe(AbsolutePath.make(config))
    if (!Array.isArray(body)) throw new Error("Expected a config entry array")
    const raw = body.find((entry) => isRecord(entry) && entry["type"] === "document" && entry["path"] === config)
    if (!isRecord(raw) || !isRecord(raw["info"])) throw new Error("Expected a config document")
    expect(raw["info"]).not.toHaveProperty("default_agent")
    expect(raw["info"]).not.toHaveProperty("model")
    const mcp = raw["info"]["mcp"]
    if (!isRecord(mcp) || !isRecord(mcp["servers"]) || !isRecord(mcp["servers"]["docs"]))
      throw new Error("Expected an MCP server config")
    expect(mcp["servers"]["docs"]).not.toHaveProperty("headers")
    expect(mcp["servers"]["docs"]).not.toHaveProperty("oauth")
  }),
)

it.live("persists global configuration updates", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-update-")))
    const global = path.join(tmp.path, "global")
    yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
    const server = yield* startServer(global)
    const url = new URL("/api/config/global", server.base)
    const updated = yield* Effect.promise(() =>
      fetch(url, {
        method: "PATCH",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({ customInstructions: "Prefer Bun APIs." }),
      }),
    )
    const read = yield* Effect.promise(() => fetch(url, { headers: server.headers }))
    const body: unknown = yield* Effect.promise(() => read.json())
    const config = Schema.decodeUnknownSync(Config.Info)(body)
    const persisted = JSON.parse(yield* Effect.promise(() => fs.readFile(path.join(global, "opencode.json"), "utf8")))

    expect(updated.status).toBe(200)
    expect(read.status).toBe(200)
    expect(config.customInstructions).toBe("Prefer Bun APIs.")
    expect(persisted.customInstructions).toBe("Prefer Bun APIs.")
  }),
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
