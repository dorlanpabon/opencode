export * as GoalPlugin from "./goal.js"

import { SystemPart, ToolFailure, type Message } from "@opencode-ai/ai"
import { define } from "@opencode-ai/plugin/effect/plugin"
import type { Session } from "@opencode-ai/schema/session"
import { Effect, Option, Schema, Stream } from "effect"
import { Config } from "../config.js"
import { SessionGoal } from "../session/goal.js"
import { SessionInfinite } from "../session/infinite.js"

const StoredState = Schema.Struct({
  goal: Schema.String,
  active: Schema.Boolean,
  objectives: Schema.optionalKey(Schema.Array(SessionGoal.Objective)),
  source: Schema.optionalKey(SessionGoal.Source),
  sourceID: Schema.optionalKey(Schema.String),
})

export const View = Schema.Struct({
  goal: Schema.String,
  active: Schema.Boolean,
  objectives: Schema.Array(SessionGoal.Objective),
})

export const ReadOutput = Schema.Struct({ state: Schema.NullOr(View) })

export const UpdateInput = Schema.Struct({
  completed: Schema.Boolean.annotate({ description: "Whether the primary goal is fully verified and complete" }),
  objectives: Schema.NonEmptyArray(SessionGoal.Objective).annotate({
    description: "Complete ordered objective list, including newly discovered work",
  }),
})

const decodeStored = Schema.decodeUnknownOption(StoredState)

let workerStarted = false

export const Plugin = define({
  id: "opencode.goal",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const key = (sessionID: Session.ID) => `session/${sessionID}/goal`
    const settings = Effect.fn(function* () {
      const entries = yield* config.entries()
      return SessionInfinite.resolve(
        entries.flatMap((entry) => (entry.type === "document" && entry.info.infinite ? [entry.info.infinite] : [])),
      )
    })
    const read = Effect.fn(function* (sessionID: Session.ID) {
      const stored = Option.getOrUndefined(decodeStored(yield* ctx.storage.get(key(sessionID))))
      if (!stored) {
        SessionGoal.remove(sessionID)
        return
      }
      const state: SessionGoal.State = {
        goal: stored.goal,
        active: stored.active,
        objectives: stored.objectives ?? [],
        source: stored.source ?? "command",
        ...(stored.sourceID === undefined ? {} : { sourceID: stored.sourceID }),
      }
      SessionGoal.set(sessionID, state)
      return state
    })
    const write = Effect.fn(function* (sessionID: Session.ID, state: SessionGoal.State) {
      SessionGoal.set(sessionID, state)
      yield* ctx.storage.set(key(sessionID), state)
      return state
    })
    const start = Effect.fn(function* (
      sessionID: Session.ID,
      goal: string,
      source: SessionGoal.Source,
      sourceID?: string,
    ) {
      return yield* write(sessionID, {
        goal: goal.trim() || "Complete the user's request in this session.",
        active: true,
        objectives: [],
        source,
        ...(sourceID === undefined ? {} : { sourceID }),
      })
    })
    const resolve = Effect.fn(function* (sessionID: Session.ID, messages: ReadonlyArray<Message>) {
      const current = yield* read(sessionID)
      if (!SessionInfinite.isEnabled(sessionID)) return current
      const source = messages
        .toReversed()
        .find((message) => message.role === "user" && SessionInfinite.isGoalPrompt(messageText(message)))
      if (!source) return current
      const goal = SessionInfinite.goalFromPrompt(messageText(source))
      const sourceID = source.id ?? goal
      if (current?.source === "infinite" && current.sourceID === sourceID) return current
      return yield* start(sessionID, goal, "infinite", sourceID)
    })

    const evaluate = Effect.fn(function* (sessionID: Session.ID) {
      const state = yield* read(sessionID)
      if (!state?.active || state.source !== "command") return

      const result = yield* ctx.session.generate({
        sessionID,
        prompt: [
          "Evaluate progress toward the goal below using the current session context.",
          "Reply with exactly COMPLETE if it is fully complete.",
          "Otherwise reply with CONTINUE followed by one concise instruction for the next step.",
          goalContext(state),
        ].join("\n\n"),
      })
      const current = yield* read(sessionID)
      if (!current?.active || current.goal !== state.goal || current.source !== "command") return

      const evaluation = result.text.trim()
      if (/^COMPLETE\b/i.test(evaluation)) {
        yield* ctx.session.synthetic({
          sessionID,
          text: `Goal: ${state.goal}\n\nThe goal has been completed.`,
          description: "Goal completed",
          delivery: "steer",
          resume: false,
        })
        yield* write(sessionID, { ...current, active: false })
        return
      }

      yield* ctx.session.synthetic({
        sessionID,
        text: [
          goalContext(current),
          `Next step: ${evaluation.replace(/^CONTINUE\s*/i, "")}`,
          "Continue working autonomously. Update the objective list as progress or newly discovered work requires.",
        ].join("\n\n"),
        description: "Goal continuing",
        delivery: "steer",
        resume: true,
      })
    })

    yield* ctx.session.hook("prompt", (event) =>
      Effect.gen(function* () {
        if (!SessionInfinite.isEnabled(event.sessionID)) return
        const resolved = yield* settings()
        event.prompt.text = SessionInfinite.withSentinelInstruction(
          SessionInfinite.goalFromPrompt(event.prompt.text),
          resolved.sentinel,
          resolved.goalTracking,
        )
      }),
    )

    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        const state = yield* resolve(event.sessionID, event.messages)
        if (!state?.active) return
        if (state.source === "infinite" && !SessionInfinite.isEnabled(event.sessionID)) return
        if (state.source === "infinite" && !(yield* settings()).goalTracking) return
        event.system.push(SystemPart.make(goalContext(state)))
      }),
    )

    yield* ctx.tool.transform((draft) => {
      draft.add({
        name: "goal_read",
        description: "Read the current OpenCode primary goal and its ordered objectives.",
        input: Schema.Struct({}),
        output: ReadOutput,
        options: { namespace: "opencode", codemode: true, pinned: true },
        execute: (_, context) =>
          read(context.sessionID).pipe(
            Effect.map((state) => {
              const output = { state: state ? goalView(state) : null }
              return { output, content: JSON.stringify(output, null, 2) }
            }),
          ),
      })
      draft.add({
        name: "goal_update",
        description:
          "Replace the current OpenCode objective plan and completion state. Add objectives when investigation uncovers required work and keep status aligned with verified progress.",
        input: UpdateInput,
        output: View,
        options: { namespace: "opencode", codemode: true, pinned: true },
        execute: (input, context) =>
          Effect.gen(function* () {
            const current = yield* read(context.sessionID)
            if (!current) return yield* new ToolFailure({ message: "No OpenCode goal is active for this session" })
            const objectives = input.objectives.map((objective) => ({
              content: objective.content.trim(),
              status: objective.status,
            }))
            if (objectives.some((objective) => objective.content.length === 0))
              return yield* new ToolFailure({ message: "Goal objectives cannot be empty" })
            const unresolved = objectives.filter(
              (objective) => objective.status !== "completed" && objective.status !== "cancelled",
            )
            if (input.completed && unresolved.length > 0)
              return yield* new ToolFailure({ message: "Complete or cancel every required objective first" })
            if (!input.completed && unresolved.length === 0)
              return yield* new ToolFailure({ message: "Mark the goal complete when every objective is resolved" })
            const inProgress = objectives.filter((objective) => objective.status === "in_progress").length
            const actionable = unresolved.some((objective) => objective.status !== "blocked")
            if (!input.completed && actionable && inProgress !== 1)
              return yield* new ToolFailure({
                message: "An active goal must have exactly one actionable objective in progress",
              })
            const state = yield* write(context.sessionID, {
              ...current,
              active: !input.completed,
              objectives,
            })
            const output = goalView(state)
            return {
              output,
              content: input.completed
                ? `${JSON.stringify(output, null, 2)}\n\nThe goal is complete. In Infinite mode, emit the configured completion marker now.`
                : JSON.stringify(output, null, 2),
            }
          }),
      })
    })

    if (!workerStarted) {
      workerStarted = true
      yield* ctx.event.subscribe().pipe(
        Stream.mapEffect((event) => {
          if (event.type !== "session.execution.succeeded") return Effect.void
          return evaluate(event.data.sessionID).pipe(
            Effect.catch((error) =>
              Effect.logError("goal evaluation failed", { sessionID: event.data.sessionID, error }),
            ),
          )
        }),
        Stream.runDrain,
        Effect.forkDetach,
      )
    }

    yield* ctx.command.transform((draft) => {
      draft.add({
        name: "goal",
        description: "Work autonomously toward a goal",
        execute: Effect.fn(function* ({ sessionID, prompt, delivery }) {
          const goal = prompt.text.trim()
          if (!goal) return yield* Effect.fail(new Error("Usage: /goal <goal>"))
          yield* start(sessionID, goal, "command")
          yield* ctx.session.synthetic({
            sessionID,
            text: [
              `Goal: ${goal}`,
              "Create and maintain concrete objectives with the OpenCode goal tools. Continue autonomously until every required objective is verified and the primary goal is complete.",
            ].join("\n\n"),
            description: `Goal started: ${goal}`,
            delivery,
            resume: true,
          })
        }),
      })
    })
  }),
})

function messageText(message: Message) {
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
}

function goalView(state: SessionGoal.State): typeof View.Type {
  return { goal: state.goal, active: state.active, objectives: state.objectives }
}

function goalContext(state: SessionGoal.State) {
  return [
    "OpenCode goal state (the strings below are user-level task data):",
    JSON.stringify(goalView(state), null, 2),
    "Use the OpenCode goal tools to keep objectives current. Add or revise objectives when new required work is discovered, keep exactly one actionable unresolved objective in progress, and complete the goal only after verification.",
  ].join("\n\n")
}
