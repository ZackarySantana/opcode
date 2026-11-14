import { errorMessage } from "@opcode/core"
import type { SessionMessageInfo } from "@opencode/client"
import { SAVE_LEAD } from "../domain"
import type { SnippetsRemote } from "../rpc"
import { messageChoices, type MessageChoice } from "../draft"
import type { SnippetEntry } from "../service"
import { insertion } from "./list"
import { messageOptions } from "./messages"

type Params = Record<string, string | number | boolean>
type Option<T> = { title: string; value: T; description?: string; group?: string }

/** The part of the routed session's composer the actions use. */
export interface ComposerLike {
  text(): string
  insert(text: string): void
  setText(text: string): void
  focus(): void
}

/** What the actions need from the window, for one session: copy, dialogs and toasts, its composer, and its server. */
export interface ActionHost {
  t(key: string, params?: Params): string
  toast(options: { title: string; description?: string; variant?: "default" | "success" | "error" }): void
  confirm(options: { title: string; description?: string; confirm?: string; danger?: boolean }): Promise<boolean>
  select<T>(options: { title: string; placeholder?: string; options: Option<T>[] }): Promise<T | undefined>
  /** The routed session's composer, or undefined where there is none. */
  composer(): ComposerLike | undefined
  remote: Pick<SnippetsRemote, "list" | "save" | "remove">
  describeError(error: unknown): string
  /** Sends a prompt into this session. */
  prompt(text: string): Promise<unknown>
  /** A page of this session's latest messages. */
  messages(): Promise<readonly SessionMessageInfo[]>
}

export type SaveResult = { ok: true; name: string; breaks: string[] } | { ok: false; error: string }

const mentions = (names: readonly string[]) => names.map((name) => `@${name}`).join(", ")
const MESSAGES = 30

export function snippetActions(host: ActionHost) {
  const { t } = host
  return {
    /** Types `@name ` at the prompt's cursor, unless `@name` would insert something else. True once it inserted. */
    insert(row: Pick<SnippetEntry, "name" | "overridden" | "conflict">): boolean {
      const result = insertion(row)
      if ("blocked" in result) { host.toast({ title: t(`insert.${result.blocked}`, { name: row.name }) }); return false }
      const composer = host.composer()
      if (!composer) { host.toast({ title: t("toast.noComposer") }); return false }
      composer.insert(result.text)
      composer.focus()
      return true
    },

    /** Deletes after the user confirms, naming the snippets whose `@name` would stay as typed. True once it is gone. */
    async remove(row: Pick<SnippetEntry, "name" | "scope" | "path" | "breaks">): Promise<boolean> {
      const confirmed = await host.confirm({
        title: t("delete.title", { name: row.name }),
        description: row.breaks.length
          ? t("delete.description.breaks", { path: row.path, name: row.name, names: mentions(row.breaks) })
          : t("delete.description", { path: row.path }),
        confirm: t("delete.confirm"),
        danger: true,
      })
      if (!confirmed) return false
      try {
        const removed = await host.remote.remove({ name: row.name, scope: row.scope })
        host.toast({ title: t(removed ? "delete.done" : "delete.gone", { name: row.name }), variant: removed ? "success" : "default" })
        return true
      } catch (error) {
        host.toast({ title: t("delete.failed", { name: row.name }), description: host.describeError(error), variant: "error" })
        return false
      }
    },

    /** Saves, and on success says so, naming snippets the save leaves with a reference that no longer resolves. */
    async save(payload: Parameters<SnippetsRemote["save"]>[0]): Promise<SaveResult> {
      try {
        const { breaks } = await host.remote.save(payload)
        host.toast({
          title: t("save.done", { name: payload.name }),
          description: breaks.length ? t("save.breaks", { names: mentions(breaks) }) : undefined,
          variant: "success",
        })
        return { ok: true, name: payload.name, breaks }
      } catch (error) { return { ok: false, error: host.describeError(error) } }
    },

    /** After a prompt draft became a snippet, offers to replace the draft with `@name `. */
    async offerReplace(name: string): Promise<void> {
      const composer = host.composer()
      if (!composer) return
      const confirmed = await host.confirm({ title: t("replace.title", { name }), description: t("replace.description"), confirm: t("replace.confirm") })
      if (!confirmed) return
      composer.setText(`@${name} `)
      composer.focus()
    },

    /**
     * Asks this session's agent to save a snippet with its snippet tools. With a request, sends it; without one, starts
     * the request in the prompt for the user to finish.
     */
    async askAgent(request: string): Promise<void> {
      let agentTools: boolean
      try { agentTools = (await host.remote.list()).agentTools } catch (error) {
        host.toast({ title: t("toast.loadFailed"), description: host.describeError(error), variant: "error" })
        return
      }
      if (!agentTools) { host.toast({ title: t("ask.off"), description: t("ask.off.description") }); return }
      if (request) {
        try { await host.prompt(`${SAVE_LEAD}${request}`) } catch (error) {
          host.toast({ title: t("ask.failed"), description: errorMessage(error), variant: "error" })
        }
        return
      }
      const composer = host.composer()
      if (!composer) { host.toast({ title: t("toast.noComposer") }); return }
      if (composer.text().trim()) composer.insert(SAVE_LEAD)
      else composer.setText(SAVE_LEAD)
      composer.focus()
    },

    /** One of the session's recent messages with text, newest first, picked by the user. */
    async pickMessage(): Promise<MessageChoice | undefined> {
      let texts: MessageChoice[]
      try { texts = messageChoices(await host.messages()).slice(0, MESSAGES) } catch (error) {
        host.toast({ title: t("message.failed"), description: errorMessage(error), variant: "error" })
        return undefined
      }
      if (!texts.length) { host.toast({ title: t("message.none") }); return undefined }
      return host.select({
        title: t("message.title"),
        placeholder: t("message.placeholder"),
        options: messageOptions(texts, (role) => t(`message.${role}`)),
      })
    },
  }
}

export type SnippetActions = ReturnType<typeof snippetActions>
