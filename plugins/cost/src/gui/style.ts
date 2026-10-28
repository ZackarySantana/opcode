/** Inherits the dialog's font and color; app variables only for weak text and borders, with fallbacks. */
export const css = `
.opcode-cost { display: flex; flex-direction: column; gap: 12px; min-height: 0; height: 100%; }
.opcode-cost-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.opcode-cost-group { display: flex; flex-wrap: wrap; gap: 4px; }
.opcode-cost-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
.opcode-cost-muted { color: var(--text-weak, color-mix(in srgb, currentColor 60%, transparent)); }
.opcode-cost-warning { color: var(--text-warning, inherit); }
.opcode-cost-center { padding: 32px 0; display: flex; flex-direction: column; align-items: center; gap: 4px; text-align: center; }
.opcode-cost-stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; }
.opcode-cost-stat { border: 1px solid var(--border-weak, color-mix(in srgb, currentColor 15%, transparent)); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 2px; }
.opcode-cost-stat-value { font-size: 1.4em; font-variant-numeric: tabular-nums; }
.opcode-cost-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.opcode-cost-table th { text-align: left; font-weight: normal; position: sticky; top: 0; background: var(--surface-raised-base, Canvas); }
.opcode-cost-table th, .opcode-cost-table td { padding: 6px 8px; border-bottom: 1px solid var(--border-weak, color-mix(in srgb, currentColor 10%, transparent)); white-space: nowrap; }
.opcode-cost-table .opcode-cost-number { text-align: right; }
.opcode-cost-table .opcode-cost-label { white-space: normal; overflow-wrap: anywhere; min-width: 160px; }
.opcode-cost-link { all: unset; cursor: pointer; overflow-wrap: anywhere; }
.opcode-cost-link:hover { text-decoration: underline; }
.opcode-cost-link:focus-visible { outline: 2px solid var(--border-interactive-base, currentColor); outline-offset: 2px; }
.opcode-cost-meter { width: 120px; height: 6px; border-radius: 3px; background: color-mix(in srgb, currentColor 12%, transparent); overflow: hidden; }
.opcode-cost-meter > div { height: 100%; background: var(--text-interactive-base, currentColor); }
`
