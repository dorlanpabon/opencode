import { createEffect, on, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"

export type ShellOption = {
  path: string
  name: string
  acceptable: boolean
}

export type ShellSelectOption = {
  id: string
  value: string
  name: string
  terminalOnly: boolean
}

export function createShellOptions(input: { shells: ShellOption[]; current: string | undefined }) {
  const counts = input.shells.reduce((result, shell) => {
    result.set(shell.name, (result.get(shell.name) ?? 0) + 1)
    return result
  }, new Map<string, number>())
  const options: ShellSelectOption[] = [
    { id: "auto", value: "", name: "", terminalOnly: false },
    ...input.shells.map((shell) => {
      const ambiguous = (counts.get(shell.name) ?? 0) > 1
      const name = ambiguous ? shell.path : shell.name
      return {
        id: shell.path,
        value: ambiguous ? shell.path : shell.name,
        name,
        terminalOnly: !shell.acceptable,
      }
    }),
  ]
  if (input.current && !options.some((option) => option.value === input.current)) {
    options.push({ id: input.current, value: input.current, name: input.current, terminalOnly: false })
  }
  return options
}

export function createCustomInstructionsDraftController(input: {
  saved: Accessor<string>
  persist: (value: string) => Promise<unknown> | undefined
  delay?: number
}) {
  const [store, setStore] = createStore({ draft: "", dirty: false })
  createEffect(
    on(input.saved, (value) => {
      if (store.dirty) return
      setStore("draft", value)
    }),
  )

  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: string | undefined
  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    const next = pending
    pending = undefined
    if (next === undefined) return
    const request = input.persist(next)
    if (!request) {
      pending = next
      return
    }
    void request
      .then(() => {
        if (store.draft === next && pending === undefined) setStore("dirty", false)
      })
      .catch(() => {
        if (store.draft === next && pending === undefined) pending = next
      })
  }

  onCleanup(flush)
  return {
    draft: () => store.draft,
    flush,
    update(next: string) {
      setStore({ draft: next, dirty: true })
      clearTimeout(timer)
      pending = next
      timer = setTimeout(flush, input.delay ?? 500)
    },
  }
}

export function createSoundPreviewController(player: (id: string | undefined) => Promise<(() => void) | undefined>) {
  let cleanup: (() => void) | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let run = 0

  const stop = () => {
    run += 1
    cleanup?.()
    clearTimeout(timeout)
    cleanup = undefined
    timeout = undefined
  }
  const play = (id: string | undefined) => {
    stop()
    if (!id) return
    const current = ++run
    timeout = setTimeout(() => {
      timeout = undefined
      void player(id).then((next) => {
        if (run === current) {
          cleanup = next
          return
        }
        next?.()
      })
    }, 100)
  }

  onCleanup(stop)
  return { play, stop }
}
