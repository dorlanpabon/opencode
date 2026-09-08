export * as SessionGoal from "./goal.js"

import { Schema } from "effect"
import { SessionSchema } from "./schema.js"

export const ObjectiveStatus = Schema.Literals(["pending", "in_progress", "completed", "blocked", "cancelled"])
export type ObjectiveStatus = typeof ObjectiveStatus.Type

export const Objective = Schema.Struct({
  content: Schema.String,
  status: ObjectiveStatus,
})
export type Objective = typeof Objective.Type

export const Source = Schema.Literals(["command", "infinite"])
export type Source = typeof Source.Type

export const State = Schema.Struct({
  goal: Schema.String,
  active: Schema.Boolean,
  objectives: Schema.Array(Objective),
  source: Source,
  sourceID: Schema.optionalKey(Schema.String),
})
export type State = typeof State.Type

const states = new Map<SessionSchema.ID, State>()

export const get = (sessionID: SessionSchema.ID): State | undefined => states.get(sessionID)

export const set = (sessionID: SessionSchema.ID, state: State): void => {
  states.set(sessionID, state)
}

export const remove = (sessionID: SessionSchema.ID): void => {
  states.delete(sessionID)
}

export const clear = (): void => {
  states.clear()
}
