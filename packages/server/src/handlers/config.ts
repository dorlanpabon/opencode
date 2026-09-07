import { Config } from "@opencode-ai/core/config"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { UnknownError } from "@opencode-ai/protocol/errors"
import { Api } from "../api"

export const ConfigHandler = HttpApiBuilder.group(Api, "server.config", (handlers) =>
  handlers
    .handle("config.global", () => Config.Service.use((config) => config.global()))
    .handle("config.update", (ctx) =>
      Config.Service.use((config) =>
        config.updateGlobal(ctx.payload).pipe(Effect.mapError((error) => new UnknownError({ message: error.message }))),
      ),
    )
    .handle("config.get", () => Config.Service.use((config) => config.entries())),
)
