# @lidtop/opencode-feed

## 0.3.0

### Minor Changes

- 8b163bd: Split `/feed` into **Status** and **Releases** tabs, and rename Edit to **Subscribe**: status pages and release feeds (releases, blogs, news) each get their own timeline, and `f` picks from the current tab's feeds. **Show updates** becomes **Show releases**, keeping your saved choice, and Statuspage's "Update" label now reads as "Ongoing".

## 0.2.0

### Minor Changes

- 2745c6e: Add a **Show updates** setting (Both, Sidebar, /feed, None) choosing where releases, blogs, and news from updates feeds appear. It defaults to /feed, so the sidebar shows status pages only; existing settings keep their values.

## 0.1.1

### Patch Changes

- a8e520d: Standardize the package READMEs: install with `opencode plugin add` first, show screenshots, and use the same sections and wording across every plugin.

## 0.1.0

### Minor Changes

- 9965abf: First release: `/feed` shows one timeline across subscribed status pages and release feeds, with in-progress incidents first, operational status pages grayed out, scheduled maintenance under Upcoming, search, a single-feed picker, and links that open in the browser. The session sidebar shows the latest updates and upcoming maintenance.
