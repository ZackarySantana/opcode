/** Layout, plus a text area shaped like the app's fields; text and colors follow the app's theme. */
export const css = `
.opcode-snippets { display: flex; gap: 16px; min-height: 0; height: 100%; }
.opcode-snippets-side { display: flex; flex-direction: column; gap: 8px; flex: 0 0 280px; min-width: 0; min-height: 0; }
.opcode-snippets-list { display: flex; flex-direction: column; gap: 2px; overflow-y: auto; min-height: 0; flex: 1; }
.opcode-snippets-heading { margin: 8px 0 4px; font-size: 0.75em; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.6; }
.opcode-snippets-row { display: flex; flex-direction: column; gap: 2px; width: 100%; padding: 6px 8px; border: 0; border-radius: 6px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.opcode-snippets-row:hover { background: color-mix(in srgb, currentColor 6%, transparent); }
.opcode-snippets-row[aria-selected="true"] { background: color-mix(in srgb, currentColor 12%, transparent); }
.opcode-snippets-row:focus-visible { outline: 2px solid var(--border-interactive-base, currentColor); outline-offset: -2px; }
.opcode-snippets-line { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.opcode-snippets-name { font-weight: 600; overflow-wrap: anywhere; }
.opcode-snippets-muted { color: var(--text-weak, color-mix(in srgb, currentColor 60%, transparent)); }
.opcode-snippets-small { font-size: 0.85em; }
.opcode-snippets-clip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.opcode-snippets-flag { flex: none; margin-left: auto; font-size: 0.8em; color: var(--text-warning, inherit); }
.opcode-snippets-preview { display: flex; flex-direction: column; gap: 10px; flex: 1; min-width: 0; min-height: 0; overflow-y: auto; }
.opcode-snippets-title { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; }
.opcode-snippets-title h3 { margin: 0; font-size: 1.1em; overflow-wrap: anywhere; }
.opcode-snippets-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.opcode-snippets-path { font-family: var(--font-mono, ui-monospace, monospace); font-size: 0.85em; overflow-wrap: anywhere; }
.opcode-snippets-warning { margin: 0; padding-left: 18px; color: var(--text-warning, inherit); }
.opcode-snippets-center { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; flex: 1; padding: 32px 16px; text-align: center; }
.opcode-snippets-error { color: var(--text-warning, inherit); overflow-wrap: anywhere; white-space: pre-wrap; }
.opcode-snippets-footer { display: flex; justify-content: flex-end; align-items: center; gap: 8px; width: 100%; }
.opcode-snippets-footer > .opcode-snippets-hint { margin-right: auto; }
.opcode-snippets-form { display: flex; flex-direction: column; gap: 12px; min-height: 0; }
.opcode-snippets-fields { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: end; }
.opcode-snippets-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.opcode-snippets-label { font-size: 0.85em; font-weight: 600; }
.opcode-snippets-scope { display: flex; gap: 2px; padding: 2px; border: 1px solid var(--border-weak, color-mix(in srgb, currentColor 15%, transparent)); border-radius: 6px; }
.opcode-snippets-scope button { padding: 4px 10px; border: 0; border-radius: 4px; background: transparent; color: inherit; font: inherit; cursor: pointer; opacity: 0.7; }
.opcode-snippets-scope button[aria-checked="true"] { opacity: 1; font-weight: 600; background: color-mix(in srgb, currentColor 12%, transparent); }
.opcode-snippets-scope button:focus-visible { outline: 2px solid var(--border-interactive-base, currentColor); outline-offset: -2px; }
.opcode-snippets-textarea {
  box-sizing: border-box; width: 100%; min-height: 220px; resize: vertical; padding: 8px 10px;
  border: 1px solid var(--border-weak, color-mix(in srgb, currentColor 15%, transparent)); border-radius: 6px;
  background: var(--surface-raised-base, transparent); color: inherit;
  font-family: var(--font-mono, ui-monospace, monospace); font-size: 0.9em; line-height: 1.5;
}
.opcode-snippets-textarea:focus { outline: none; border-color: var(--border-interactive-base, currentColor); }
`
