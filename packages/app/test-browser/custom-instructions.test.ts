import { expect, test, vi } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createCustomInstructionsDraftController } from "../src/settings/general/behavior"

test("keeps saved custom instructions visible while remote config catches up", async () => {
  vi.useFakeTimers()
  try {
    const [saved, setSaved] = createSignal("Existing instructions")
    const writes: string[] = []
    const owned = createRoot((dispose) => ({
      dispose,
      controller: createCustomInstructionsDraftController({
        saved,
        persist: async (value) => {
          writes.push(value)
        },
      }),
    }))

    await Promise.resolve()
    expect(owned.controller.draft()).toBe("Existing instructions")

    owned.controller.update("Keep this text visible")
    vi.advanceTimersByTime(500)
    await Promise.resolve()
    await Promise.resolve()

    expect(writes).toEqual(["Keep this text visible"])
    expect(owned.controller.draft()).toBe("Keep this text visible")

    setSaved("Keep this text visible")
    await Promise.resolve()
    expect(owned.controller.draft()).toBe("Keep this text visible")
    owned.dispose()
  } finally {
    vi.useRealTimers()
  }
})
