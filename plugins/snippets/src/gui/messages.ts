import type { MessageChoice } from "../draft"
import { shorten } from "./list"

export interface MessageOption {
  title: string
  description: string
  value: MessageChoice
}

/** One option per message: the start of its text, with who wrote it and more of the text below. */
export function messageOptions(choices: readonly MessageChoice[], role: (role: MessageChoice["role"]) => string): MessageOption[] {
  return choices.map((message) => {
    const title = shorten(message.text.split("\n").find((line) => line.trim()) ?? "", 80)
    return { title, description: [role(message.role), shorten(message.text, 160)].join(" · "), value: message }
  })
}
