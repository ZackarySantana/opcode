export const css = `
.opcode-later { display: flex; flex-direction: column; gap: 12px; padding: 12px; overflow-y: auto; height: 100%; box-sizing: border-box; }
.opcode-later-add { display: flex; gap: 8px; align-items: flex-end; }
.opcode-later-add > :first-child { flex: 1; min-width: 0; }
.opcode-later-muted { color: var(--text-weak, color-mix(in srgb, currentColor 60%, transparent)); }
.opcode-later-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.opcode-later-item { display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; border-bottom: 1px solid var(--border-weak, color-mix(in srgb, currentColor 10%, transparent)); }
.opcode-later-number { flex: none; min-width: 2ch; font-variant-numeric: tabular-nums; }
.opcode-later-message { flex: 1; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.opcode-later-actions { flex: none; display: flex; gap: 2px; align-items: center; }
.opcode-later-problem { margin: 0; overflow-wrap: anywhere; color: var(--text-warning); }
`
