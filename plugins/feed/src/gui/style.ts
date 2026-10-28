/** Layout only, plus the urgency dots; text inherits the app's theme, and muted text fades from it. */
export const css = `
.opcode-feed { display: flex; flex-direction: column; gap: 12px; min-height: 0; }
.opcode-feed-tabs { display: flex; gap: 4px; }
.opcode-feed-tab { padding: 4px 10px; border: 0; border-radius: 6px; background: transparent; color: inherit; font: inherit; cursor: pointer; opacity: 0.7; }
.opcode-feed-tab:hover { opacity: 1; }
.opcode-feed-tab[aria-selected="true"] { opacity: 1; font-weight: 600; background: color-mix(in srgb, currentColor 10%, transparent); }
.opcode-feed-body { display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
.opcode-feed-group { display: flex; flex-direction: column; gap: 2px; }
.opcode-feed-heading { margin: 0 0 4px; font-size: 0.75em; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.6; }
.opcode-feed-row, .opcode-feed-subscription { display: flex; align-items: flex-start; gap: 10px; width: 100%; padding: 6px 8px; border: 0; border-radius: 6px; background: transparent; color: inherit; font: inherit; text-align: left; }
.opcode-feed-row:not(:disabled) { cursor: pointer; }
.opcode-feed-row:not(:disabled):hover, .opcode-feed-subscription:hover { background: color-mix(in srgb, currentColor 6%, transparent); }
.opcode-feed-main { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.opcode-feed-line { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.opcode-feed-time { margin-left: auto; white-space: nowrap; font-size: 0.85em; opacity: 0.6; }
.opcode-feed-muted { opacity: 0.65; }
.opcode-feed-error, [data-tone="danger"].opcode-feed-muted { color: #e5484d; opacity: 1; }
.opcode-feed-title[data-tone="muted"] { opacity: 0.65; }
.opcode-feed-dot { flex: none; width: 8px; height: 8px; margin-top: 6px; border-radius: 50%; background: currentColor; opacity: 0.5; }
.opcode-feed-dot[data-tone="danger"] { background: #e5484d; opacity: 1; }
.opcode-feed-dot[data-tone="warning"] { background: #f5a524; opacity: 1; }
.opcode-feed-muted[data-tone="warning"] { color: #f5a524; opacity: 1; }
.opcode-feed-dot[data-tone="info"] { background: #3e9cf5; opacity: 1; }
.opcode-feed-dot[data-tone="accent"] { background: #8e6cf0; opacity: 1; }
.opcode-feed-center { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 48px 16px; text-align: center; }
.opcode-feed-empty-title { font-weight: 600; }
.opcode-feed-footer { display: flex; justify-content: flex-end; gap: 8px; width: 100%; }
`
