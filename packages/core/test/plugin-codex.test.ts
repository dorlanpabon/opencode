import { expect, test } from "bun:test"
import { Config } from "@opencode-ai/core/config"
import * as CodexPlugin from "@opencode-ai/core/plugin/codex"
import { Config as ConfigSchema } from "@opencode-ai/schema/config"
import { Effect, Stream } from "effect"
import { mkdir } from "node:fs/promises"
import path from "path"
import { tmpdir } from "./fixture/tmpdir"

test("imports Codex skills and safe MCP definitions without copying literal environment values", async () => {
  await using tmp = await tmpdir()
  const previous = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = tmp.path
  try {
    const root = path.join(tmp.path, ".codex", "plugins", "cache", "fixture-source", "fixture", "1.2.3")
    await mkdir(path.join(root, ".codex-plugin"), { recursive: true })
    await mkdir(path.join(root, "skills", "review"), { recursive: true })
    await Bun.write(
      path.join(root, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "fixture",
        version: "1.2.3",
        description: "Fixture plugin",
        skills: "./skills/",
        mcpServers: "./.mcp.json",
        apps: "./.app.json",
        hooks: { hooks: {} },
        interface: { displayName: "Fixture Plugin" },
      }),
    )
    await Bun.write(path.join(root, "skills", "review", "SKILL.md"), "---\nname: review\n---\nReview files.")
    await Bun.write(
      path.join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          local: { command: "node", args: ["server.mjs"], cwd: ".", startup_timeout_sec: 10 },
          remote: { type: "http", url: "https://example.com/mcp", bearer_token_env_var: "FIXTURE_TOKEN" },
          unsafe: { command: "node", env: { TOKEN: "literal-secret" } },
        },
      }),
    )

    let current = new ConfigSchema.Info({})
    const config = Config.Service.of({
      entries: () => Effect.succeed([]),
      global: () => Effect.succeed(current),
      updateGlobal: (patch) =>
        Effect.sync(() => {
          current = new ConfigSchema.Info(Object.assign({}, current, patch))
          return current
        }),
      changes: () => Stream.empty,
    })
    const run = <A, E>(effect: Effect.Effect<A, E, Config.Service>) =>
      Effect.runPromise(effect.pipe(Effect.provideService(Config.Service, config)))

    const catalog = await run(CodexPlugin.list())
    expect(catalog).toHaveLength(1)
    expect(catalog[0]).toMatchObject({
      id: "fixture-source/fixture/1.2.3",
      displayName: "Fixture Plugin",
      features: { skills: 1, mcp: 3, apps: true, hooks: true },
      compatible: { skills: 1, mcp: 2 },
      installed: false,
    })

    const installed = await run(CodexPlugin.install(catalog[0].id))
    expect(installed.installed).toBe(true)
    expect(current.skills).toEqual([path.join(root, "skills")])
    expect(current.mcp?.servers?.local).toMatchObject({ type: "local", command: ["node", "server.mjs"], cwd: root })
    expect(current.mcp?.servers?.remote).toMatchObject({
      type: "remote",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer {env:FIXTURE_TOKEN}" },
    })
    expect(current.mcp?.servers?.unsafe).toBeUndefined()
    expect(JSON.stringify(current)).not.toContain("literal-secret")
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_TEST_HOME
    else process.env.OPENCODE_TEST_HOME = previous
  }
})
