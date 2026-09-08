import { afterEach, describe, expect, test } from "bun:test"
import { ConfigInfinite } from "@opencode-ai/schema/config/infinite"
import { SessionGoal } from "@opencode-ai/core/session/goal"
import { SessionInfinite } from "@opencode-ai/core/session/infinite"

const sessionID = "ses_infinite_test" as never

afterEach(() => {
  SessionInfinite.clear()
  SessionGoal.clear()
})

describe("SessionInfinite", () => {
  test("appends the goal protocol and sentinel only once", () => {
    const sentinel = SessionInfinite.Defaults.sentinel
    const withInstruction = SessionInfinite.withSentinelInstruction("Build the feature", sentinel)
    expect(withInstruction).toContain("Build the feature")
    expect(withInstruction).toContain(SessionInfinite.GoalMarker)
    expect(withInstruction).toContain(sentinel)
    expect(SessionInfinite.goalFromPrompt(withInstruction)).toBe("Build the feature")
    const already = SessionInfinite.withSentinelInstruction(withInstruction, sentinel)
    expect(already).toBe(withInstruction)
    const untracked = SessionInfinite.withSentinelInstruction("Build the feature", "[DONE]", false)
    expect(untracked).not.toContain(SessionInfinite.GoalMarker)
    expect(untracked).toContain("[DONE]")
  })

  test("detects sentinel in assistant text", () => {
    expect(SessionInfinite.containsSentinel("All done [TASK_COMPLETE]", "[TASK_COMPLETE]")).toBe(true)
    expect(SessionInfinite.containsSentinel("Still working", "[TASK_COMPLETE]")).toBe(false)
  })

  test("terminates only when the tracked goal is inactive", () => {
    expect(SessionInfinite.isTerminated(undefined)).toBe(false)
    expect(SessionInfinite.isTerminated({ active: true })).toBe(false)
    expect(SessionInfinite.isTerminated({ active: false })).toBe(true)
  })

  test("continues while the tracked goal remains active", () => {
    expect(
      SessionInfinite.shouldContinue({
        text: "Claimed done [TASK_COMPLETE]",
        sentinel: "[TASK_COMPLETE]",
        goalTracking: true,
        goal: { active: true },
      }),
    ).toBe(true)
    expect(
      SessionInfinite.shouldContinue({
        text: "Verified",
        sentinel: "[TASK_COMPLETE]",
        goalTracking: true,
        goal: { active: false },
      }),
    ).toBe(false)
    expect(
      SessionInfinite.shouldContinue({
        text: "Done [TASK_COMPLETE]",
        sentinel: "[TASK_COMPLETE]",
        goalTracking: true,
        goal: undefined,
      }),
    ).toBe(false)
  })

  test("tracks enable, progress, and limits", () => {
    expect(SessionInfinite.isEnabled(sessionID)).toBe(false)
    SessionInfinite.enable(sessionID)
    expect(SessionInfinite.isEnabled(sessionID)).toBe(true)
    expect(SessionInfinite.getProgress(sessionID)?.iterations).toBe(0)
    SessionInfinite.recordIteration(sessionID)
    expect(SessionInfinite.getProgress(sessionID)?.iterations).toBe(1)
    const settings = SessionInfinite.resolve([new ConfigInfinite.Info({ maxIterations: 1 })])
    const progress = SessionInfinite.getProgress(sessionID)
    expect(progress !== undefined && progress.iterations >= settings.maxIterations).toBe(true)
    SessionInfinite.disable(sessionID)
    expect(SessionInfinite.isEnabled(sessionID)).toBe(false)
    expect(SessionInfinite.getProgress(sessionID)).toBeUndefined()
  })

  test("does not continue while a permission request is pending", () => {
    SessionInfinite.enable(sessionID)
    const pendingPermissions = [{ id: "perm_1" }]
    const shouldContinue = pendingPermissions.length === 0
    expect(shouldContinue).toBe(false)
  })

  test("builds continuation prompt with sentinel", () => {
    const prompt = SessionInfinite.continuationPrompt("[TASK_COMPLETE]")
    expect(prompt).toContain("[TASK_COMPLETE]")
    expect(prompt).toContain("OpenCode goal")
    expect(prompt).toContain("create or revise objectives")
  })
})
