import { setTimer, type SetTimer } from "@opcode/core/refresh"
import { createSchedule as createTimers } from "@opcode/core/schedule"
import { createSignal } from "solid-js"

/** `@opcode/core/schedule`, with its clock and next refresh as signals, so views age as time passes. */
export function createSchedule(refresh: () => void, minutes: () => number, timer: SetTimer = setTimer) {
  const [now, setNow] = createSignal(Date.now())
  const [next, setNext] = createSignal<number>()
  const schedule = createTimers(refresh, minutes, { timer, tick: setNow, next: setNext })
  return { ...schedule, now, next }
}

export type Schedule = ReturnType<typeof createSchedule>
