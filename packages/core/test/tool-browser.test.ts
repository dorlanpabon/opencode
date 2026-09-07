import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Image } from "@opencode-ai/core/image"
import { Session } from "@opencode-ai/core/session"
import { Tool } from "@opencode-ai/core/tool"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import BrowserPlugin from "@opencode-ai/plugin-browser"
import { Browser } from "@opencode-ai/plugin-browser/rpc"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { codeModeListings, registerToolPlugin, toolDefinitions, toolIdentity } from "./lib/tool"

const browserToolNode = makeLocationNode({
  name: "test/browser-tool-plugin",
  layer: Layer.effectDiscard(
    registerToolPlugin(BrowserPlugin, {
      rpc: Object.assign(
        () => {
          throw new Error("unused rpc.client")
        },
        {
          register: () =>
            Effect.succeed({
              dispose: Effect.void,
              events: { emit: () => Effect.void },
            }),
        },
      ),
    }),
  ),
  deps: [Tool.node],
})

const sessionID = Session.ID.make("ses_browser_test")
const toolLayer = AppNodeBuilder.build(LayerNode.group([Tool.node, browserToolNode]), [
  Image.node.replace(imagePassthrough),
])
const it = testEffect(toolLayer)

const call = (code: string, id = "call-browser") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "execute", input: { code } },
})

describe("BrowserTool registration", () => {
  it.effect("exposes every browser operation through Code Mode behind execute", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["execute"])
      const snapshot = yield* registry.snapshot()
      const catalog = snapshot.codeModeCatalog
      expect(catalog).toBeDefined()
      if (!catalog) return
      const paths = codeModeListings(catalog)
        .map((entry) => entry.path)
        .sort()
      expect(paths).toEqual(Browser.Operations.map((operation) => `browser.${operation.name}`).sort())
    }),
  )

  it.effect("fails browser actions without a connected desktop as a typed tool error", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      const toolSet = yield* registry.snapshot()
      const result = yield* toolSet.execute(call("return await tools.browser.tabs.list({})"))
      expect(JSON.stringify(result)).toContain("[browser.disconnected]")
    }),
  )
})
