import { Message } from "@opencode-ai/ai"
import { Config } from "@opencode-ai/core/config"
import { SessionGoal } from "@opencode-ai/core/session/goal"
import { SessionInfinite } from "@opencode-ai/core/session/infinite"
import type { CommandDefinition } from "@opencode-ai/plugin/effect/command"
import type { SessionHooks } from "@opencode-ai/plugin/effect/session"
import { Event } from "@opencode-ai/schema/event"
import { Session } from "@opencode-ai/schema/session"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionInbox } from "@opencode-ai/schema/session-inbox"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Tool } from "@opencode-ai/schema/tool"
import { DateTime, Deferred, Effect, PubSub, Stream } from "effect"
import { GoalPlugin } from "@opencode-ai/core/plugin/goal"
import { describe, expect } from "bun:test"
import { it } from "../lib/effect"
import { host } from "./host"

const sessionID = Session.ID.make("ses_goal_test")
type UpdateGoal = Tool.Info<typeof GoalPlugin.UpdateInput, typeof GoalPlugin.View>["execute"]

describe("GoalPlugin.Plugin", () => {
  it.effect("continues a goal until evaluation reports completion", () =>
    Effect.gen(function* () {
      const event: SessionEvent.Execution.Succeeded = {
        id: Event.ID.create(),
        created: 0,
        durable: { aggregateID: sessionID, seq: Event.Seq.make(0), version: Event.Version.make(1) },
        type: "session.execution.succeeded",
        data: { sessionID },
      }
      const events = yield* PubSub.unbounded<typeof event>()
      const completed = yield* Deferred.make<void>()
      const storage = new Map<string, unknown>()
      const descriptions = new Array<string>()
      let command: CommandDefinition | undefined
      let contextHook: ((input: SessionHooks["context"]) => Effect.Effect<void>) | undefined
      let updateGoal: UpdateGoal | undefined

      yield* GoalPlugin.Plugin.effect(
        host({
          command: {
            list: () => Effect.die("unused command.list"),
            reload: () => Effect.die("unused command.reload"),
            transform: (callback) => {
              callback({ add: (definition) => (command = definition) })
              return Effect.succeed({ dispose: Effect.void })
            },
          },
          event: { subscribe: () => Stream.fromPubSub(events) },
          tool: {
            transform: (callback) => {
              callback({
                list: () => [],
                get: () => undefined,
                namespace: () => {},
                add: (definition) => {
                  if (definition.name === "goal_update") updateGoal = definition.execute as unknown as UpdateGoal
                },
                update: () => {},
                remove: () => {},
              })
              return Effect.succeed({ dispose: Effect.void })
            },
            reload: () => Effect.die("unused tool.reload"),
            hook: () => Effect.die("unused tool.hook"),
          },
          storage: {
            get: (key) => Effect.succeed(storage.get(key) as never),
            set: (key, value) => Effect.sync(() => storage.set(key, value)),
            remove: (key) => Effect.sync(() => storage.delete(key)),
            scan: () => Effect.die("unused storage.scan"),
          },
          session: {
            hook: (name, callback) => {
              if (name === "context")
                contextHook = callback as unknown as (input: SessionHooks["context"]) => Effect.Effect<void>
              return Effect.succeed({ dispose: Effect.void })
            },
            generate: () => Effect.succeed({ text: "COMPLETE" }),
            synthetic: (input) =>
              Effect.gen(function* () {
                descriptions.push(input.description ?? "")
                if (input.description === "Goal completed") yield* Deferred.succeed(completed, undefined)
                return SessionInbox.Synthetic.make({
                  id: SessionMessage.ID.create(),
                  sessionID: input.sessionID,
                  timeCreated: DateTime.makeUnsafe(0),
                  type: "synthetic",
                  payload: { text: input.text, description: input.description },
                  delivery: input.delivery ?? "steer",
                })
              }),
          },
        }),
      ).pipe(
        Effect.provideService(
          Config.Service,
          Config.Service.of({
            entries: () => Effect.succeed([]),
            global: () => Effect.die("unused config.global"),
            updateGlobal: () => Effect.die("unused config.updateGlobal"),
            changes: () => Stream.empty,
          }),
        ),
      )
      yield* Effect.yieldNow
      if (!command) return yield* Effect.die("Goal command was not registered")
      if (!contextHook) return yield* Effect.die("Goal context hook was not registered")
      if (!updateGoal) return yield* Effect.die("Goal update tool was not registered")

      SessionInfinite.enable(sessionID)
      const request: SessionHooks["context"] = {
        sessionID,
        agent: "build" as never,
        model: { providerID: "test", id: "test" } as never,
        system: [],
        messages: [
          Message.make({
            id: SessionMessage.ID.create(),
            role: "user",
            content: SessionInfinite.withSentinelInstruction("Ship the local beta", "[TASK_COMPLETE]"),
          }),
        ],
        tools: {},
        generation: {},
        providerOptions: {},
      }
      yield* contextHook(request)
      expect(SessionGoal.get(sessionID)).toMatchObject({
        goal: "Ship the local beta",
        active: true,
        objectives: [],
        source: "infinite",
      })
      expect(request.system.at(-1)?.text).toContain("OpenCode goal state")
      const toolContext: Tool.Context = {
        sessionID,
        agent: "build" as never,
        messageID: SessionMessage.ID.create(),
        id: "goal_update_test" as never,
        progress: () => Effect.void,
      }
      yield* updateGoal(
        {
          completed: false,
          objectives: [
            { content: "Build the beta", status: "completed" },
            { content: "Verify the beta locally", status: "in_progress" },
          ],
        },
        toolContext,
      )
      expect(SessionGoal.get(sessionID)?.objectives).toHaveLength(2)
      yield* updateGoal(
        {
          completed: true,
          objectives: [
            { content: "Build the beta", status: "completed" },
            { content: "Verify the beta locally", status: "completed" },
          ],
        },
        toolContext,
      )
      expect(SessionGoal.get(sessionID)?.active).toBe(false)
      SessionInfinite.disable(sessionID)

      yield* command.execute({ sessionID, prompt: { text: "Finish the task" }, delivery: "steer" })
      yield* PubSub.publish(events, event)
      yield* Deferred.await(completed)

      expect(descriptions).toEqual(["Goal started: Finish the task", "Goal completed"])
      expect(storage.get(`session/${sessionID}/goal`)).toEqual({
        goal: "Finish the task",
        active: false,
        objectives: [],
        source: "command",
      })
    }),
  )
})
