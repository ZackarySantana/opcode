/** @jsxImportSource @opentui/solid */

import { centered, Choices, LABEL_WIDTH, Line, Row, TabFrame, useFocus, useTab } from "@opcode/tabs"
import { usePalette } from "@opcode/ui"
import { createMemo, For, Show } from "solid-js"
import type { PullRequestsClient } from "./client"
import { scopeChoices, scopeCount, scopeModes, type ScopeChoice, type ScopeMode } from "./model"

const modeLabels: Record<ScopeMode, string> = { exclude: "Exclude", include: "Include" }
const modes = scopeModes.map((value) => ({ value, label: modeLabels[value] }))

const keyOf = (choice: ScopeChoice) => choice.name.toLowerCase()

/**
 * The orgs whose pull requests every list shows. Enter, space, or a click chooses one; ←/→ switches between showing all
 * but the chosen orgs' and only theirs. The box searches them.
 */
export function OrgsTab(props: { prs: PullRequestsClient }) {
  const tab = useTab()
  const palette = usePalette()
  const scope = () => props.prs.settings().scope
  const filter = createMemo(() => ({ ignoreDays: props.prs.settings().ignoreDays, scope: scope() }))
  const choices = createMemo(() => scopeChoices(props.prs.snapshot(), filter(), tab.query(), props.prs.now()))
  const count = createMemo(() => scopeCount(props.prs.snapshot(), filter(), props.prs.now()))
  const focus = useFocus(choices, keyOf)
  // The mode, what it does, a refresh error, and a gap.
  const header = () => 3 + (props.prs.error() ? 1 : 0)
  const visible = createMemo(() => centered(choices(), focus.current(), tab.height() - header()))
  const choose = (choice: ScopeChoice) => props.prs.updateSettings({ scopeOrg: { name: choice.name, chosen: !choice.chosen } })
  tab.handle({
    move: focus.move,
    activate() {
      const choice = focus.current()
      if (choice) choose(choice)
    },
    adjust(direction) {
      const index = scopeModes.indexOf(scope().mode)
      const next = scopeModes[Math.max(0, Math.min(scopeModes.length - 1, index + direction))]!
      if (next !== scope().mode) props.prs.updateSettings({ scopeMode: next })
    },
  })
  const summary = () => !scope().orgs.length
    ? "Nothing chosen: pull requests from every org show."
    : `${scope().mode === "include" ? "Only the chosen orgs show" : "The chosen orgs are hidden"}, everywhere: ${count().shown} of ${count().total} pull requests show.`
  const empty = () => tab.query() ? "No matching orgs." : props.prs.snapshot() ? "No orgs yet." : props.prs.error() ? "Couldn't load pull requests." : "Loading…"
  const detail = (choice: ScopeChoice) => choice.count ? `${choice.count} pull request${choice.count === 1 ? "" : "s"}` : "none listed"
  return (
    <TabFrame hints={[
      ...tab.navigation,
      { key: "enter", label: "choose", command: tab.command("activate") },
      { key: "←/→ h/l", label: "exclude/include", command: tab.command("adjust.next") },
      { key: "/", label: "search", command: tab.command("search") },
    ]}>
      <box flexDirection="column" minWidth={0} flexShrink={0} paddingLeft={2} paddingBottom={1}>
        {/* The modes line up with the rows' details: the indent, the label, then the row's gap. */}
        <box flexDirection="row" height={1}>
          <text width={LABEL_WIDTH} flexShrink={0} fg={palette.text}>Mode</text>
          <Choices choices={modes} current={scope().mode} />
        </box>
        <text minWidth={0} wrapMode="none" fg={palette.muted}>{summary()}</text>
        <Show when={props.prs.error()}>{(error) => <text minWidth={0} wrapMode="none" fg={palette.error}>! {error()}</text>}</Show>
      </box>
      <For each={visible()} fallback={<text fg={palette.muted}>{empty()}</text>}>{(choice) => {
        const selected = () => choice === focus.current()
        return (
          <box minWidth={0} onMouseDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); focus.focus(keyOf(choice)); choose(choice) }}>
            <Row selected={selected()}>
              <Line label={`${selected() ? ">" : " "} [${choice.chosen ? "x" : " "}] ${choice.name}`} labelColor={choice.chosen ? palette.value : palette.text}
                detail={detail(choice)} selected={selected()} />
            </Row>
          </box>
        )
      }}</For>
    </TabFrame>
  )
}
