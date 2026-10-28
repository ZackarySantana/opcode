import { usePlugin } from "@opencode/plugin/gui"
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import type { FeedsClient } from "../client"
import type { FeedCondition } from "../model"
import type { FeedActions } from "./actions"
import { clockTime, conditionTone, relativeTime, sectionView, sections, subscriptionRows, windowSpan, type Row, type Section } from "./view"

/** Status, Upcoming, Releases, and Subscriptions, one at a time; entries open their links in the browser. */
export function FeedDialog(props: { feeds: FeedsClient; actions: FeedActions }) {
  const ctx = usePlugin()
  const [section, setSection] = createSignal<Section>("status")
  return (
    <ctx.ui.Dialog title={ctx.t("title")} size="large" footer={
      <div class="opcode-feed-footer">
        <ctx.ui.Button variant="neutral" icon="refresh" busy={props.feeds.refreshing()} onClick={() => props.actions.refresh()}>{ctx.t("action.refresh")}</ctx.ui.Button>
        <ctx.ui.Button variant="contrast" icon="plus" onClick={() => void props.actions.subscribe()}>{ctx.t("action.subscribe")}</ctx.ui.Button>
      </div>
    }>
      <div class="opcode-feed">
        <div class="opcode-feed-tabs" role="tablist">
          <For each={sections}>{(id) => (
            <button type="button" role="tab" class="opcode-feed-tab" aria-selected={section() === id} onClick={() => setSection(id)}>
              {ctx.t(`section.${id}`)}
            </button>
          )}</For>
        </div>
        <div class="opcode-feed-body" role="tabpanel">
          <Show when={props.feeds.error()}>{(error) => <div class="opcode-feed-error">{error()}</div>}</Show>
          <Switch>
            <Match when={section() === "subscriptions"}>
              <Subscriptions feeds={props.feeds} actions={props.actions} />
            </Match>
            <Match when={section() !== "subscriptions" && section() as Exclude<Section, "subscriptions">}>
              {(id) => <Timeline feeds={props.feeds} section={id()} />}
            </Match>
          </Switch>
        </div>
      </div>
    </ctx.ui.Dialog>
  )
}

function Empty(props: { title: string; description?: string }) {
  return (
    <div class="opcode-feed-center">
      <div class="opcode-feed-empty-title">{props.title}</div>
      <Show when={props.description}><div class="opcode-feed-muted">{props.description}</div></Show>
    </div>
  )
}

function Timeline(props: { feeds: FeedsClient; section: Exclude<Section, "subscriptions"> }) {
  const ctx = usePlugin()
  const view = createMemo(() => sectionView(props.feeds.timeline("feed"), props.feeds.subscriptions(), props.section))
  const span = () => windowSpan(props.feeds.settings().windowHours)
  const groupTitle = (id: "current" | "recent" | "upcoming") => id === "current"
    ? ctx.t("group.current")
    : ctx.plural(`group.${id}.${span().unit}`, span().count)
  return (
    <>
      <Show when={view().operational.length}>
        <div class="opcode-feed-muted">{ctx.t("operational", { names: view().operational.join(" · ") })}</div>
      </Show>
      <For each={view().unreachable}>{(failure) => (
        <div class="opcode-feed-error">{ctx.t("unreachable", { source: failure.source, error: failure.error })}</div>
      )}</For>
      <Switch>
        <Match when={view().empty === "unsubscribed"}>
          <Empty title={ctx.t(props.section === "releases" ? "empty.releases" : "empty.status")} description={ctx.t("empty.unsubscribed")} />
        </Match>
        <Match when={view().empty}>{(empty) => <Empty title={ctx.t(`empty.${empty()}`)} />}</Match>
      </Switch>
      <For each={view().groups}>{(group) => (
        <section class="opcode-feed-group">
          <h3 class="opcode-feed-heading">{groupTitle(group.id)}</h3>
          <For each={group.rows}>{(row) => <Entry row={row} now={props.feeds.now()} />}</For>
        </section>
      )}</For>
    </>
  )
}

function Entry(props: { row: Row; now: number }) {
  const ctx = usePlugin()
  const locale = () => ctx.locale.locale()
  return (
    <button type="button" class="opcode-feed-row" disabled={!props.row.link} title={props.row.link}
      onClick={() => props.row.link && ctx.system.openExternal(props.row.link)}>
      <span class="opcode-feed-dot" data-tone={props.row.tone} />
      <span class="opcode-feed-main">
        <span class="opcode-feed-line">
          <strong>{props.row.head}</strong>
          <Show when={props.row.detail}><span class="opcode-feed-muted">{props.row.detail}</span></Show>
          <span class="opcode-feed-time">
            {ctx.t("time", { relative: relativeTime(props.row.time, props.now, locale()), clock: clockTime(props.row.time, locale()) })}
          </span>
        </span>
        <span class="opcode-feed-title" data-tone={props.row.tone}>{props.row.title}</span>
        <Show when={props.row.summary}><span class="opcode-feed-muted">{props.row.summary}</span></Show>
      </span>
    </button>
  )
}

function Subscriptions(props: { feeds: FeedsClient; actions: FeedActions }) {
  const ctx = usePlugin()
  const rows = createMemo(() => subscriptionRows(props.feeds.subscriptions(), props.feeds.results(), props.feeds.now()))
  const describe = (condition: FeedCondition) => {
    switch (condition.kind) {
      case "none": return ""
      case "fetching": return ctx.t("state.fetching")
      case "error": return ctx.t("state.error", { error: condition.error })
      case "live": return ctx.t("state.live", { status: condition.item.status ?? ctx.t("state.ongoing"), title: condition.item.title })
      case "operational": return ctx.t("state.operational")
      case "latest": return condition.item.published === undefined ? condition.item.title
        : ctx.t("state.latest", { relative: relativeTime(condition.item.published, props.feeds.now(), ctx.locale.locale()), title: condition.item.title })
      case "empty": return ctx.t("state.empty")
    }
  }
  return (
    <Show when={rows().length} fallback={<Empty title={ctx.t("empty.subscriptions")} />}>
      <For each={(["status", "release"] as const).filter((kind) => rows().some((row) => row.kind === kind))}>{(kind) => (
        <section class="opcode-feed-group">
          <h3 class="opcode-feed-heading">{ctx.t(`group.${kind}`)}</h3>
          <For each={rows().filter((row) => row.kind === kind)}>{(row) => (
            <div class="opcode-feed-subscription">
              <span class="opcode-feed-main">
                <span class="opcode-feed-line">
                  <strong>{row.title}</strong>
                  <Show when={!row.preset}><span class="opcode-feed-muted">{ctx.t("custom")}</span></Show>
                </span>
                <span class="opcode-feed-muted" data-tone={conditionTone(row.condition)}>{describe(row.condition)}</span>
              </span>
              <ctx.ui.Tooltip value={ctx.t("action.unsubscribe", { title: row.title })}>
                <ctx.ui.IconButton icon="trash" variant="ghost" label={ctx.t("action.unsubscribe", { title: row.title })} onClick={() => void props.actions.unsubscribe(row)} />
              </ctx.ui.Tooltip>
            </div>
          )}</For>
        </section>
      )}</For>
    </Show>
  )
}
