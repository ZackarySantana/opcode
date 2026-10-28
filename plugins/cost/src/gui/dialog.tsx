import { createRefresh, type RefreshState } from "@opcode/core/refresh"
import type { Context } from "@opencode/plugin/gui"
import { createEffect, createSignal, For, Match, on, onCleanup, Show, Switch, untrack, type Accessor, type JSX } from "solid-js"
import { createCostService, described } from "../client.js"
import { DATE_RANGES, type DateRange } from "../domain.js"
import type { Dimension, Ledger } from "../format.js"
import { breakdownTable, isEmpty, overview, turnRows, type Text } from "./view.js"

const SECTIONS = ["overview", "models", "projects", "daily", "turns"] as const
type Section = (typeof SECTIONS)[number]
/** The app's own server, which runs this plugin and owns the ledger's sessions. */
const SERVER = "sidecar"

interface Props {
  ctx: Context
  /** Changes when the server reports new usage, so the open view rereads. */
  revision: Accessor<number>
  close(): void
}

/** One read serves every section; reopening starts again from the last 30 days, like the terminal's. */
export function CostDialog(props: Props) {
  const ctx = props.ctx
  const ui = ctx.ui
  const [range, setRange] = createSignal<DateRange>("30d")
  const [section, setSection] = createSignal<Section>("overview")
  const [read, setRead] = createSignal<RefreshState<Ledger>>({ loading: true })
  const refresh = createRefresh(async (signal) => {
    const service = createCostService(ctx.client)
    const current = untrack(range)
    const [usage, time] = await described(Promise.all([service.dashboard(current, signal), service.time(current, signal)]))
    return { usage, time }
  }, setRead, { delay: 100 })
  // Drop stale values only for a different range, not a background refresh.
  createEffect(on(range, () => {
    refresh.reset()
    void refresh.refresh()
  }))
  createEffect(on(props.revision, () => refresh.schedule(), { defer: true }))
  onCleanup(() => refresh.dispose())
  // A failure with loaded data is a stale-data warning; without it, there is nothing honest to show.
  const warning = () => read().value === undefined ? undefined : read().error
  return (
    <ui.Dialog size="x-large" title={ctx.t("dialog.title")} description={ctx.t("dialog.description", { range: ctx.t(`range.${range()}`) })}
      footer={<ui.Button icon="refresh" busy={read().loading} onClick={() => void refresh.refresh()}>{ctx.t("dialog.refresh")}</ui.Button>}>
      <div class="opcode-cost">
        <div class="opcode-cost-bar">
          <div class="opcode-cost-group" role="group" aria-label={ctx.t("section.label")}>
            <For each={SECTIONS}>{(item) => (
              <ui.Button size="small" variant={section() === item ? "neutral" : "ghost"} onClick={() => setSection(item)}>{ctx.t(`section.${item}`)}</ui.Button>
            )}</For>
          </div>
          <div class="opcode-cost-group" role="group" aria-label={ctx.t("range.label")}>
            <For each={DATE_RANGES}>{(item) => (
              <ui.Button size="small" variant={range() === item ? "neutral" : "ghost"} onClick={() => setRange(item)}>{ctx.t(`range.${item}`)}</ui.Button>
            )}</For>
          </div>
        </div>
        <Show when={warning()}>{(message) => <div class="opcode-cost-warning">{ctx.t("dialog.stale", { message: message() })}</div>}</Show>
        <div class="opcode-cost-body">
          <Show when={read().value} fallback={
            <Center>
              <Show when={read().error} fallback={<><ui.Loader /><span class="opcode-cost-muted">{ctx.t("dialog.loading")}</span></>}>
                {(message) => <span class="opcode-cost-warning">{ctx.t("dialog.failed", { message: message() })}</span>}
              </Show>
            </Center>
          }>{(ledger) => (
            <Switch>
              <Match when={section() === "overview"}><Overview ctx={ctx} ledger={ledger()} /></Match>
              <Match when={section() === "models"}><Breakdown ctx={ctx} ledger={ledger()} dimension="models" heading="column.model" /></Match>
              <Match when={section() === "projects"}><Breakdown ctx={ctx} ledger={ledger()} dimension="projects" heading="column.project" /></Match>
              <Match when={section() === "daily"}><Breakdown ctx={ctx} ledger={ledger()} dimension="daily" heading="column.date" /></Match>
              <Match when={section() === "turns"}><Turns ctx={ctx} ledger={ledger()} close={props.close} /></Match>
            </Switch>
          )}</Show>
        </div>
      </div>
    </ui.Dialog>
  )
}

function translate(ctx: Context, text: Text) {
  return text.count === undefined ? ctx.t(text.key, text.params) : ctx.plural(text.key, text.count, text.params)
}

function Center(props: { children: JSX.Element }) {
  return <div class="opcode-cost-center">{props.children}</div>
}

function Overview(props: { ctx: Context; ledger: Ledger }) {
  return <>
    <For each={overview(props.ledger)}>{(group) => (
      <div class="opcode-cost-stats">
        <For each={group}>{(stat) => (
          <div class="opcode-cost-stat">
            <span class="opcode-cost-muted">{translate(props.ctx, stat.label)}</span>
            <span class="opcode-cost-stat-value">{stat.value}</span>
            <span class="opcode-cost-muted">{translate(props.ctx, stat.detail)}</span>
          </div>
        )}</For>
      </div>
    )}</For>
    <Show when={isEmpty(props.ledger)}>
      <Center>
        <span>{props.ctx.t("dialog.empty")}</span>
        <span class="opcode-cost-muted">{props.ctx.t("dialog.empty.detail")}</span>
      </Center>
    </Show>
  </>
}

function Breakdown(props: { ctx: Context; ledger: Ledger; dimension: Dimension; heading: string }) {
  const t = props.ctx.t
  const table = () => breakdownTable(props.ledger, props.dimension)
  return (
    <Show when={table().rows.length} fallback={<span class="opcode-cost-muted">{t("table.empty")}</span>}>
      <table class="opcode-cost-table">
        <thead>
          <tr>
            <th>{t(props.heading)}</th>
            <th><span class="opcode-cost-muted">{t("column.share")}</span></th>
            <Show when={table().priced}><th class="opcode-cost-number">{t("column.cost")}</th></Show>
            <th class="opcode-cost-number">{t("column.tokens")}</th>
            <th class="opcode-cost-number">{t("column.messages")}</th>
            <th class="opcode-cost-number">{t("column.agent")}</th>
            <th class="opcode-cost-number">{t("column.turns")}</th>
            <th class="opcode-cost-number">{t("column.wait")}</th>
          </tr>
        </thead>
        <tbody>
          <For each={table().rows}>{(row) => (
            <tr>
              <td class="opcode-cost-label">{row.label}</td>
              <td><div class="opcode-cost-meter" aria-hidden="true"><div style={{ width: `${Math.round(row.share * 100)}%` }} /></div></td>
              <Show when={table().priced}><td class="opcode-cost-number">{row.cost}</td></Show>
              <td class="opcode-cost-number">{row.tokens}</td>
              <td class="opcode-cost-number">{row.messages}</td>
              <td class="opcode-cost-number">{row.agent}</td>
              <td class="opcode-cost-number">{row.turns}</td>
              <td class="opcode-cost-number">{row.wait}</td>
            </tr>
          )}</For>
        </tbody>
      </table>
    </Show>
  )
}

/** The longest turns. Opening one leaves the dialog for its session, when the app lists the plugin's server. */
function Turns(props: { ctx: Context; ledger: Ledger; close(): void }) {
  const t = props.ctx.t
  const rows = () => turnRows(props.ledger.time.longest)
  const open = (sessionID: string) => {
    props.close()
    props.ctx.tabs.open({ server: SERVER, id: sessionID }, { focus: true })
  }
  return (
    <Show when={rows().length} fallback={<span class="opcode-cost-muted">{t("turns.empty")}</span>}>
      <table class="opcode-cost-table">
        <thead>
          <tr>
            <th>{t("column.title")}</th>
            <th>{t("column.project")}</th>
            <th>{t("column.model")}</th>
            <th>{t("column.start")}</th>
            <th class="opcode-cost-number">{t("column.duration")}</th>
          </tr>
        </thead>
        <tbody>
          <For each={rows()}>{(row) => (
            <tr>
              <td class="opcode-cost-label">
                <Show when={props.ctx.servers.get(SERVER)} fallback={row.title}>
                  <button type="button" class="opcode-cost-link" title={t("turns.open")} onClick={() => open(row.sessionID)}>{row.title}</button>
                </Show>
              </td>
              <td>{row.project}</td>
              <td>{row.model}</td>
              <td>{row.start}</td>
              <td class="opcode-cost-number">{row.duration}</td>
            </tr>
          )}</For>
        </tbody>
      </table>
    </Show>
  )
}
