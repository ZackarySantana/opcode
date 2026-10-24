# Opcode

Use mise and Bun (`mise exec -- bun …`). The only migration sources are the four sibling `opencode-*` repositories; do not modify them.

- `plugins/{context,cost,feed,gh-pr-status,later,sessions,snippets}` are independently released npm packages named `@lidtop/opencode-*`. Runtime plugin/command IDs remain `opcode-*`; do not tie storage or navigation identity to npm names.
- `packages/ui`, `packages/tabs`, and `packages/core` are private source workspaces, bundled into each plugin that uses them. Do not bundle OpenCode, OpenTUI, or Solid.
- Keep all third-party dependency versions in the root Bun workspace catalog. OpenCode packages move together.
- Use documented OpenCode V2 APIs and the installed types. No host-tree introspection or V1 compatibility layers.
- Separate domain logic, host adapters, and presentation. Share actual recurring patterns, not speculative frameworks.
- Tests should protect observable behavior and regressions, not source text or incidental implementation details.
- Review changes from design/reuse, correctness/separation, and test-value perspectives.
