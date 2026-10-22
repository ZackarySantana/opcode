/** Every whitespace-separated word of the query must appear in the text, case-insensitively. */
export function matchesText(text: string, query: string): boolean {
  const haystack = text.toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word))
}

export function age(time: number | undefined, now = Date.now()): string {
  if (time === undefined) return ""
  const minutes = Math.max(0, Math.floor((now - time) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  // Past a day: days plus leftover hours, e.g. "1d 5h"; whole days drop the "0h".
  return hours % 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours / 24}d`
}

export function relative(time: number, now = Date.now()): string {
  return time > now ? `in ${age(now, time)}` : `${age(time, now)} ago`
}

/** The sidebar's refresh line, counting down to the second. */
export function refreshStatus(refreshing: boolean, next: number | undefined, now = Date.now()): string | undefined {
  if (refreshing) return "Refreshing…"
  if (next === undefined) return undefined
  const seconds = Math.max(0, Math.ceil((next - now) / 1000))
  // Seconds keep two digits past a minute so the line doesn't shift as it counts.
  return `Next refresh in ${seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`}`
}
