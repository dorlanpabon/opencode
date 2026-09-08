import { expect, test } from "bun:test"
import { Plugin } from "../src/plugin.js"
import { Schema } from "effect"

test("Codex plugin info keeps stable identifiers and omits absent descriptions", () => {
  expect(Plugin.CodexFeatures.ast.annotations?.identifier).toBe("Plugin.CodexFeatures")
  expect(Plugin.CodexCompatible.ast.annotations?.identifier).toBe("Plugin.CodexCompatible")
  expect(Plugin.CodexInfo.ast.annotations?.identifier).toBe("Plugin.CodexInfo")

  const decoded = Schema.decodeUnknownSync(Plugin.CodexInfo)({
    id: "source/plugin/1.0.0",
    name: "plugin",
    displayName: "Plugin",
    version: "1.0.0",
    source: "source",
    features: { skills: 1, mcp: 0, apps: true, hooks: false },
    compatible: { skills: 1, mcp: 0 },
    installed: false,
  })

  expect(Schema.encodeSync(Plugin.CodexInfo)(decoded)).not.toHaveProperty("description")
  expect(() =>
    Schema.decodeUnknownSync(Plugin.CodexInfo)({
      ...decoded,
      compatible: { skills: -1, mcp: 0 },
    }),
  ).toThrow()
})
