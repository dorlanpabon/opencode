export * as Plugin from "./plugin.js"

import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"
import { NonNegativeInt, optional } from "./schema.js"

export const ID = Schema.String.pipe(Schema.brand("Plugin.ID"))
export type ID = typeof ID.Type

export const Source = Schema.Union([
  Schema.Struct({ type: Schema.Literal("builtin") }),
  Schema.Struct({
    type: Schema.Literal("package"),
    target: Schema.String,
    version: Schema.String.pipe(optional),
    outdated: Schema.Literal(true).pipe(optional),
    updating: Schema.Literal(true).pipe(optional),
  }),
  Schema.Struct({ type: Schema.Literal("local"), path: Schema.String }),
  Schema.Struct({ type: Schema.Literal("sdk") }),
]).annotate({ identifier: "Plugin.Source" })
export type Source = typeof Source.Type

export const Features = Schema.Struct({
  server: Schema.Literal(true).pipe(optional),
  tui: Schema.Literal(true).pipe(optional),
  rpc: Schema.Literal(true).pipe(optional),
}).annotate({ identifier: "Plugin.Features" })
export type Features = typeof Features.Type

export const State = Schema.Union([
  Schema.Struct({ status: Schema.Literal("active") }),
  Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String, ref: Schema.String.pipe(optional) }),
]).annotate({ identifier: "Plugin.State" })
export type State = typeof State.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID.pipe(optional),
  source: Source,
  features: Features,
  state: State,
}).annotate({ identifier: "Plugin.Info" })

export interface CodexFeatures extends Schema.Schema.Type<typeof CodexFeatures> {}
export const CodexFeatures = Schema.Struct({
  skills: NonNegativeInt,
  mcp: NonNegativeInt,
  apps: Schema.Boolean,
  hooks: Schema.Boolean,
}).annotate({ identifier: "Plugin.CodexFeatures" })

export interface CodexCompatible extends Schema.Schema.Type<typeof CodexCompatible> {}
export const CodexCompatible = Schema.Struct({
  skills: NonNegativeInt,
  mcp: NonNegativeInt,
}).annotate({ identifier: "Plugin.CodexCompatible" })

export interface CodexInfo extends Schema.Schema.Type<typeof CodexInfo> {}
export const CodexInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  displayName: Schema.String,
  description: Schema.String.pipe(optional),
  version: Schema.String,
  source: Schema.String,
  features: CodexFeatures,
  compatible: CodexCompatible,
  installed: Schema.Boolean,
}).annotate({ identifier: "Plugin.CodexInfo" })

const Updated = ephemeral({
  type: "plugin.updated",
  schema: {},
})
export const Event = { Updated, Definitions: inventory(Updated) }
