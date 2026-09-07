import { Config } from "@opencode-ai/schema/config"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location.js"
import { UnknownError } from "../errors.js"

export const ConfigGroup = HttpApiGroup.make("server.config")
  .add(
    HttpApiEndpoint.get("config.global", "/api/config/global", {
      success: Config.Info,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.config.global",
        summary: "Get global configuration",
        description: "Return the merged global configuration.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("config.update", "/api/config/global", {
      payload: Config.Info,
      success: Config.Info,
      error: UnknownError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.config.update",
        summary: "Update global configuration",
        description: "Merge fields into the writable global configuration document.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("config.get", "/api/config", {
      query: LocationQuery,
      success: Schema.Array(Config.Entry),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.config.get",
          summary: "Get configuration",
          description:
            "Return configuration documents and discovery sources for the requested location, from lowest to highest priority.",
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "config", description: "Location-scoped configuration routes." }))
