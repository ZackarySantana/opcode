import { errorMessage } from "@opcode/core"
import type { FeedsClient } from "../client"
import { kinds } from "../model"
import { feedURL, type FeedKind, type Preset } from "../presets"
import { unsubscribedPresets, type SubscriptionRow } from "./view"

type Params = Record<string, string | number | boolean>
type Option<T> = { title: string; value: T; description?: string; group?: string }

/** What the actions need from the window: the app's dialogs and toasts, copy, and the followed feeds. */
export interface ActionHost {
  t(key: string, params?: Params): string
  plural(key: string, count: number, params?: Params): string
  select<T>(options: { title: string; placeholder?: string; options: Option<T>[] }): Promise<T | undefined>
  prompt(options: { title: string; placeholder?: string }): Promise<string | undefined>
  confirm(options: { title: string; description?: string; confirm?: string; danger?: boolean }): Promise<boolean>
  toast(options: { title: string; description?: string; variant?: "default" | "success" | "error" }): void
  feeds: Pick<FeedsClient, "subscriptions" | "error" | "subscribe" | "unsubscribe" | "refresh">
}

const CUSTOM = "custom"

/**
 * Subscribing, unsubscribing, and refreshing, as dialogs around the followed feeds. Changes show at once; one the
 * server refuses is undone, and the feeds' error says why.
 */
export function feedActions(host: ActionHost) {
  const { t } = host
  /** Asks for a URL, then its kind, since the kind decides how its items are read. */
  async function chooseCustom(): Promise<Pick<Preset, "url" | "kind"> | undefined> {
    const text = (await host.prompt({ title: t("subscribe.url.title"), placeholder: t("subscribe.url.placeholder") }))?.trim()
    if (!text) return undefined
    let url: string
    try { url = feedURL(text) } catch (error) {
      host.toast({ title: t("subscribe.failed"), description: errorMessage(error), variant: "error" })
      return undefined
    }
    if (host.feeds.subscriptions().some((subscription) => subscription.url === url)) {
      host.toast({ title: t("subscribe.already", { title: url }) })
      return undefined
    }
    const kind = await host.select<FeedKind>({
      title: t("subscribe.kind.title"),
      options: kinds.map((kind) => ({ title: t(`subscribe.kind.${kind}`), description: t(`subscribe.kind.${kind}.description`), value: kind })),
    })
    return kind && { url, kind }
  }
  return {
    /** Offers the presets not yet subscribed, then a custom URL. */
    async subscribe(): Promise<void> {
      const picked = await host.select<Preset | typeof CUSTOM>({
        title: t("subscribe.title"),
        placeholder: t("subscribe.placeholder"),
        options: [
          ...unsubscribedPresets(host.feeds.subscriptions()).map((preset) => ({ title: preset.title, description: preset.url, value: preset, group: t(`group.${preset.kind}`) })),
          { title: t("subscribe.custom"), description: t("subscribe.custom.description"), value: CUSTOM, group: t("subscribe.custom.group") },
        ],
      })
      const feed = picked === CUSTOM ? await chooseCustom() : picked
      if (feed) host.feeds.subscribe(feed.url, feed.kind)
    },
    async unsubscribe(row: Pick<SubscriptionRow, "url" | "title">): Promise<void> {
      const confirmed = await host.confirm({
        title: t("unsubscribe.title", { title: row.title }), description: t("unsubscribe.description"), confirm: t("unsubscribe.confirm"), danger: true,
      })
      if (confirmed) host.feeds.unsubscribe(row.url)
    },
    /** Fetches every feed now and says how many, as /feed-refresh does in the terminal. */
    refresh(): void {
      const count = host.feeds.subscriptions().length
      const error = host.feeds.error()
      host.toast(count ? { title: host.plural("refresh.started", count) }
        // With no feeds to show, a server that can't be reached, or can't read them, is the news.
        : error ? { title: t("refresh.failed"), description: error, variant: "error" }
        : { title: t("refresh.none") })
      host.feeds.refresh()
    },
  }
}

export type FeedActions = ReturnType<typeof feedActions>
