/** @jsxImportSource @opentui/solid */

import { ItemList, Picker, SettingsTab, TabbedDialog, useTab, type SettingRow, type TabHandlers } from "@opcode/tabs"
import { age } from "@opcode/tabs/format"
import { openLink } from "@opcode/tabs/open"
import { usePalette, type KeyHint } from "@opcode/ui"
import { useDialogCommands } from "@opcode/ui/screen"
import { usePlugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, Show, type Accessor } from "solid-js"
import type { PullRequestsController } from "./host"
import { matches, onTeam, refreshChoices, sidebarItemChoices, teamChoices, view, type Entry, type Search, type Settings, type View } from "./model"
import { card } from "./style"

export const PREFIX = "opcode-gh-pr-status"
export const TITLE = "Pull requests"

export function PullRequestsDialog(props: { prs: PullRequestsController }) {
  const current = createMemo(() => { const snapshot = props.prs.snapshot(); return snapshot && view(snapshot) })
  const entries = (pick: (view: View) => readonly Entry[]) => current() ? pick(current()!) : []
  return (
    <TabbedDialog prefix={PREFIX} refreshing={props.prs.refreshing()} refresh={() => props.prs.refresh()} tabs={[
      { id: "mine", label: "Mine", placeholder: "search your pull requests", render: () => {
        const mine = () => entries((view) => view.mine)
        return <PullList prs={props.prs} search={props.prs.snapshot()?.mine} groups={[
          { title: "NEEDS YOU", entries: mine().filter((entry) => entry.pending) },
          { title: "WAITING", entries: mine().filter((entry) => !entry.pending && !entry.pr.draft) },
          { title: "DRAFTS", entries: mine().filter((entry) => !entry.pending && entry.pr.draft) },
        ]} />
      } },
      { id: "reviewing", label: "Reviewing", placeholder: "search pull requests you review", render: () => {
        const reviewing = () => entries((view) => view.reviewing)
        return <PullList prs={props.prs} search={props.prs.snapshot()?.requested} groups={[
          { title: "AWAITING YOUR REVIEW", entries: reviewing().filter((entry) => entry.pending) },
          { title: "REVIEWED BY YOU", entries: reviewing().filter((entry) => !entry.pending) },
        ]} />
      } },
      { id: "teams", label: "Teams", placeholder: "search your teams' review requests", render: () => <Teams prs={props.prs} entries={() => entries((view) => view.teams)} /> },
      { id: "settings", label: "Settings", placeholder: "search settings",
        render: () => <SettingsTab rows={settingRows} settings={props.prs.settings()} update={(change) => props.prs.updateSettings(change)} /> },
    ]} />
  )
}

/** Grouped pull requests; enter or a click opens one. Lists the refresh error and anything GitHub withheld above them. */
function PullList(props: {
  prs: PullRequestsController
  groups: readonly { title: string; entries: readonly Entry[] }[]
  /** The search the tab draws on, for what it withheld. */
  search?: Search
  hints?: readonly KeyHint[]
  handlers?: Partial<TabHandlers>
}) {
  const api = usePlugin()
  const tab = useTab()
  const palette = usePalette()
  const empty = () => tab.query() ? "No matching pull requests." : props.prs.snapshot() ? "Nothing here." : props.prs.error() ? "Couldn't load pull requests." : "Loading…"
  return (
    <ItemList handlers={props.handlers} empty={empty()}
      // An item's key is its pull request's URL; cards leave the URL out, since the title and author identify it.
      open={(item) => openLink(api, TITLE, item.key)}
      groups={props.groups.map((group) => ({
        title: group.title,
        items: group.entries.filter((entry) => matches(entry, tab.query())).map((entry) => card(entry, props.prs.snapshot()!.viewer, props.prs.now(), palette)),
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
        <Show when={props.search?.hidden}>
          <text minWidth={0} wrapMode="word" fg={palette.warning}>! {props.search!.hidden} hidden by GitHub{props.search!.reason ? `: ${props.search!.reason}` : ""}</text>
        </Show>
      </>} />
  )
}

/** Review requests for your teams; f filters to one team, and the filter is saved. */
function Teams(props: { prs: PullRequestsController; entries: Accessor<readonly Entry[]> }) {
  const api = usePlugin()
  const tab = useTab()
  const [picking, setPicking] = createSignal(false)
  const team = () => props.prs.settings().team
  const options = createMemo(() => {
    const snapshot = props.prs.snapshot()
    return snapshot ? teamChoices(snapshot, props.entries(), team()).map((name) => {
      const count = onTeam(props.entries(), name).length
      return { key: name, label: name, detail: count ? `${count} awaiting review` : "" }
    }) : []
  })
  useDialogCommands(api, () => [{
    id: `${PREFIX}.pick`, bind: "f", enabled: () => !tab.typing() && !picking(),
    run: () => { tab.reset(); setPicking(true) },
  }])
  return (
    <Show when={!picking()} fallback={
      <Picker options={options()} all="All your teams" noun="teams" action="filter" initial={team()}
        pick={(team) => { props.prs.updateSettings({ team }); setPicking(false) }} close={() => setPicking(false)} />
    }>
      <PullList prs={props.prs} search={props.prs.snapshot()?.requested} handlers={{ prefix: team }}
        groups={[{ title: team() ? `AWAITING ${team()!.toUpperCase()}` : "AWAITING YOUR TEAMS", entries: onTeam(props.entries(), team()) }]}
        hints={[{ key: "f", label: team() ? "change team" : "team", command: `${PREFIX}.pick` }]} />
    </Show>
  )
}

const yesNo = [{ value: false, label: "No" }, { value: true, label: "Yes" }]

const settingRows = [
  {
    id: "teams", label: "Sidebar team reviews",
    description: "Whether review requests for your teams appear in the sidebar, narrowed to the team chosen on the Teams tab. Requests for you always do.",
    choices: yesNo,
    current: (settings) => settings.sidebarTeams,
    update: (sidebarTeams) => ({ sidebarTeams }),
  } satisfies SettingRow<Settings, boolean>,
  {
    id: "mine", label: "Sidebar your PRs",
    description: "Whether your pull requests that need you appear in the sidebar: conflicts, failing checks, changes requested, or approved and ready to merge.",
    choices: yesNo,
    current: (settings) => settings.sidebarMine,
    update: (sidebarMine) => ({ sidebarMine }),
  } satisfies SettingRow<Settings, boolean>,
  {
    id: "items", label: "Sidebar items",
    description: "How many pull requests the sidebar lists, your review requests first, before pointing to /ghpr.",
    choices: sidebarItemChoices.map((count) => ({ value: count, label: `${count}` })),
    current: (settings) => settings.sidebarItems,
    update: (sidebarItems) => ({ sidebarItems }),
  } satisfies SettingRow<Settings, number>,
  {
    id: "refresh", label: "Refresh every",
    description: "How often gh is asked for your pull requests again; r refreshes now.",
    choices: refreshChoices.map((minutes) => ({ value: minutes, label: age(0, minutes * 60_000) })),
    current: (settings) => settings.refreshMinutes,
    update: (refreshMinutes) => ({ refreshMinutes }),
  } satisfies SettingRow<Settings, number>,
] as SettingRow<Settings>[]
