/** @jsxImportSource @opentui/solid */

import { ItemList, Picker, SettingsTab, TabbedDialog, useTab, type SettingRow, type TabHandlers } from "@opcode/tabs"
import { age } from "@opcode/tabs/format"
import { openLink } from "@opcode/tabs/open"
import { usePalette, type KeyHint } from "@opcode/ui"
import { usePlugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, Show } from "solid-js"
import type { PullRequestsController } from "./host"
import { matches, onTeam, ordered, refreshChoices, sidebarItemChoices, teamChoices, view, type Entry, type Order, type Search, type Settings } from "./model"
import { card } from "./style"

export const PREFIX = "opcode-gh-pr-status"
export const TITLE = "Pull requests"

export function PullRequestsDialog(props: { prs: PullRequestsController }) {
  const current = createMemo(() => view(props.prs.snapshot()))
  return (
    <TabbedDialog prefix={PREFIX} refreshing={props.prs.refreshing()} refresh={() => props.prs.refresh()} tabs={[
      { label: "Mine", placeholder: "search your pull requests", render: () => (
        <PullList prs={props.prs} searches={[props.prs.snapshot()?.mine]} groups={[
          { title: "NEEDS YOU", entries: current().mine.filter((entry) => entry.pending) },
          { title: "WAITING", entries: current().mine.filter((entry) => !entry.pending && !entry.pr.draft) },
          { title: "DRAFTS", entries: current().mine.filter((entry) => entry.pr.draft) },
        ]} />
      ) },
      { label: "Reviewing", placeholder: "search pull requests you review", render: () => (
        <PullList prs={props.prs} searches={[props.prs.snapshot()?.requested, props.prs.snapshot()?.reviewed]} groups={[
          { title: "AWAITING YOUR REVIEW", entries: current().reviewing.filter((entry) => entry.pending) },
          { title: "REVIEWED BY YOU", entries: current().reviewing.filter((entry) => !entry.pending) },
        ]} />
      ) },
      { label: "Teams", placeholder: "search your teams' review requests", render: () => <Teams prs={props.prs} entries={current().teams} /> },
      { label: "Settings", placeholder: "search settings",
        render: () => <SettingsTab rows={settingRows(props.prs.settings().team)} settings={props.prs.settings()} update={(change) => props.prs.updateSettings(change)} /> },
    ]} />
  )
}

/** Grouped pull requests, each group in the chosen order; enter or a click opens one. Lists the refresh error and anything GitHub withheld above them. */
function PullList(props: {
  prs: PullRequestsController
  groups: readonly { title: string; entries: readonly Entry[] }[]
  /** The searches the tab draws on, for what they withheld. */
  searches: readonly (Search | undefined)[]
  hints?: readonly KeyHint[]
  handlers?: Partial<TabHandlers>
}) {
  const api = usePlugin()
  const tab = useTab()
  const palette = usePalette()
  const hidden = () => props.searches.reduce((sum, search) => sum + (search?.hidden ?? 0), 0)
  const reason = () => props.searches.find((search) => search?.reason)?.reason
  const empty = () => tab.query() ? "No matching pull requests." : props.prs.snapshot() ? "Nothing here." : props.prs.error() ? "Couldn't load pull requests." : "Loading…"
  return (
    <ItemList handlers={props.handlers} empty={empty()}
      // An item's key is its pull request's URL; cards leave the URL out, since the title and author identify it.
      open={(item) => openLink(api, TITLE, item.key)}
      groups={props.groups.map((group) => ({
        title: group.title,
        items: ordered(group.entries.filter((entry) => matches(entry, tab.query())), props.prs.settings().order)
          .map((entry) => card(entry, props.prs.snapshot()!.viewer, props.prs.now(), palette)),
      }))}
      hints={[
        ...tab.navigation,
        { key: "enter", label: "open in browser", command: tab.command("activate") },
        ...props.hints ?? [],
        { key: "/", label: "search", command: tab.command("search") },
        { key: "r", label: "refresh", command: tab.command("refresh") },
      ]}
      header={<>
        <Show when={props.prs.error()}>{(error) => <text minWidth={0} wrapMode="word" fg={palette.error}>! {error()}</text>}</Show>
        <Show when={hidden()}>{(count) => (
          <text minWidth={0} wrapMode="word" fg={palette.warning}>! {count()} pull request{count() === 1 ? "" : "s"} hidden{reason() ? `: ${reason()}` : ""}</text>
        )}</Show>
      </>} />
  )
}

/** Review requests for your teams; f filters to one team, and the filter is saved. */
function Teams(props: { prs: PullRequestsController; entries: readonly Entry[] }) {
  const tab = useTab()
  const [picking, setPicking] = createSignal(false)
  const team = () => props.prs.settings().team
  const options = createMemo(() => {
    const snapshot = props.prs.snapshot()
    return snapshot ? teamChoices(snapshot, props.entries, team()).map((name) => {
      const count = onTeam(props.entries, name).length
      return { key: name, label: name, detail: count ? `${count} awaiting review` : "none waiting" }
    }) : []
  })
  return (
    <Show when={!picking()} fallback={
      <Picker options={options()} all="All your teams" noun="teams" action="filter" initial={team()}
        pick={(team) => { props.prs.updateSettings({ team }); setPicking(false) }} close={() => setPicking(false)} />
    }>
      <PullList prs={props.prs} searches={[props.prs.snapshot()?.requested]} handlers={{ prefix: team, pick: () => setPicking(true) }}
        groups={[{ title: "AWAITING REVIEW", entries: onTeam(props.entries, team()) }]}
        hints={[{ key: "f", label: "change team", command: tab.command("pick") }]} />
    </Show>
  )
}

const yesNo = [{ value: false, label: "No" }, { value: true, label: "Yes" }]

const orders: { value: Order; label: string }[] = [{ value: "smart", label: "Smart" }, { value: "newest", label: "Newest" }, { value: "oldest", label: "Oldest" }]

const settingRows = (team: string | undefined) => [
  {
    id: "order", label: "Order",
    description: "Smart prioritizes pull requests that need your eyes.",
    choices: orders,
    current: (settings) => settings.order,
    update: (order) => ({ order }),
  } satisfies SettingRow<Settings, Order>,
  {
    id: "teams", label: "Sidebar team reviews",
    description: `Whether review requests for your teams appear in the sidebar, narrowed to the Teams tab's filter (${team ?? "all your teams"}). Requests for you always do.`,
    choices: yesNo,
    current: (settings) => settings.sidebarTeams,
    update: (sidebarTeams) => ({ sidebarTeams }),
  } satisfies SettingRow<Settings, boolean>,
  {
    id: "mine", label: "Sidebar own PRs",
    description: "Whether your open pull requests appear in the sidebar.",
    choices: yesNo,
    current: (settings) => settings.sidebarMine,
    update: (sidebarMine) => ({ sidebarMine }),
  } satisfies SettingRow<Settings, boolean>,
  {
    id: "items", label: "Sidebar items",
    description: "How many pull requests the sidebar lists before pointing to /ghpr.",
    choices: sidebarItemChoices.map((count) => ({ value: count, label: `${count}` })),
    current: (settings) => settings.sidebarItems,
    update: (sidebarItems) => ({ sidebarItems }),
  } satisfies SettingRow<Settings, number>,
  {
    id: "refresh", label: "Refresh every",
    description: "How often to refresh from GitHub; r refreshes now.",
    choices: refreshChoices.map((minutes) => ({ value: minutes, label: age(0, minutes * 60_000) })),
    current: (settings) => settings.refreshMinutes,
    update: (refreshMinutes) => ({ refreshMinutes }),
  } satisfies SettingRow<Settings, number>,
] as SettingRow<Settings>[]
