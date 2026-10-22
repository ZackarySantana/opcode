# @lidtop/opencode-context

## 0.2.1

### Patch Changes

- e2b016b: Let history pagination cursors carry the sort order after the first page. Prevent OpenCode from rejecting subsequent pages and incorrectly showing a degraded cached-history warning.

## 0.2.0

### Minor Changes

- 805bb55: Publish independently versioned OpenCode V2 plugins with bundled private helpers and terminal extensions.

### Patch Changes

- 8f1a01b: Balance theme colors: use normal foreground for page/dialog titles and shortcut keys, muted labels and neutral borders, accent hues for sections/charts, and interactive hues for values. Preserve the theme's contrasting selection foreground/background pair.
- 572b6e9: Restore consistent theme-aware colors for headings, borders, metrics, keyboard hints, charts, and statuses. Follow live light/dark theme changes and preserve dialog and selection colors.
