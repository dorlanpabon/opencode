export * as SessionInfinite from "./infinite.js"

import { ConfigInfinite } from "@opencode-ai/schema/config/infinite"
import { SessionSchema } from "./schema.js"

export const GoalMarker = "<opencode-infinite-goal>"

export const withSentinelInstruction = (text: string, sentinel: string, goalTracking = true): string => {
  if (!goalTracking) {
    if (text.includes(sentinel)) return text
    return `${text}\n\nWhen the task is fully complete, emit ${sentinel} on its own line.`
  }
  if (text.includes(GoalMarker)) return text
  return `${text}\n\n${GoalMarker}
Infinite mode is active. Treat the request above as the primary OpenCode goal.
Use the OpenCode goal tools to create a concise, ordered set of objectives before substantial work. Keep exactly one actionable unresolved objective in progress, update objective status as work advances, and add or revise objectives whenever investigation reveals missing work.
Iterate through evidence, action, verification, and reassessment. Do not complete the goal while any required objective is pending, in progress, or blocked. When every required objective is verified, mark the goal complete and emit ${sentinel} on its own line.
</opencode-infinite-goal>`
}

export const isGoalPrompt = (text: string): boolean => text.includes(GoalMarker)

export const goalFromPrompt = (text: string): string => {
  const index = text.lastIndexOf(`\n\n${GoalMarker}`)
  return (index === -1 ? text : text.slice(0, index)).trim()
}

export const continuationPrompt = (sentinel: string, goalTracking: boolean = true): string => {
  if (!goalTracking)
    return `Continue working toward the objective. Do not stop until everything is done. When fully complete, emit ${sentinel} on its own line.`
  return [
    "Review the current OpenCode goal and objectives with the goal tools.",
    "Reassess completed work against the user's request and concrete evidence. Update objective status, create or revise objectives for any uncovered work, then execute the next unresolved objective.",
    `Verify the result. Only after every required objective is complete or cancelled, mark the goal complete and emit ${sentinel} on its own line.`,
  ].join("\n\n")
}

export const containsSentinel = (text: string, sentinel: string): boolean => text.includes(sentinel)

export const isTerminated = (goal: { readonly active: boolean } | undefined): boolean => goal?.active === false

export const shouldContinue = (input: {
  readonly text: string
  readonly sentinel: string
  readonly goalTracking: boolean
  readonly goal: { readonly active: boolean } | undefined
}): boolean => {
  if (input.goalTracking && isTerminated(input.goal)) return false
  if (containsSentinel(input.text, input.sentinel) && (!input.goalTracking || input.goal === undefined)) return false
  return true
}

export const Defaults = {
  maxIterations: 100,
  maxHours: 8,
  sentinel: "[TASK_COMPLETE]",
  goalTracking: true,
} as const

export type Resolved = {
  readonly maxIterations: number
  readonly maxHours: number
  readonly sentinel: string
  readonly goalTracking: boolean
}

export const resolve = (infos: ReadonlyArray<ConfigInfinite.Info>): Resolved =>
  infos.reduce<Resolved>(
    (result, current) => ({
      maxIterations: current.maxIterations ?? result.maxIterations,
      maxHours: current.maxHours ?? result.maxHours,
      sentinel: current.sentinel ?? result.sentinel,
      goalTracking: current.goalTracking ?? current.todoDetection ?? result.goalTracking,
    }),
    { ...Defaults },
  )

const enabled = new Set<string>()
const progress = new Map<string, { readonly iterations: number; readonly startedAt: number }>()

export const enable = (sessionID: SessionSchema.ID): void => {
  enabled.add(sessionID)
  if (!progress.has(sessionID)) progress.set(sessionID, { iterations: 0, startedAt: Date.now() })
}

export const disable = (sessionID: SessionSchema.ID): void => {
  enabled.delete(sessionID)
  progress.delete(sessionID)
}

export const isEnabled = (sessionID: SessionSchema.ID): boolean => enabled.has(sessionID)

export const getProgress = (
  sessionID: SessionSchema.ID,
): { readonly iterations: number; readonly startedAt: number } | undefined => progress.get(sessionID)

export const recordIteration = (sessionID: SessionSchema.ID): void => {
  const current = progress.get(sessionID) ?? { iterations: 0, startedAt: Date.now() }
  progress.set(sessionID, { iterations: current.iterations + 1, startedAt: current.startedAt })
}

export const clear = (): void => {
  enabled.clear()
  progress.clear()
}
