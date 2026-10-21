# Independent plugin releases

Run `mise exec -- bun run changeset` and select only affected `opcode-*` packages.
Do not select private `@opcode/core` or `@opcode/ui`: their changes must be explicitly
covered by changesets for every consuming plugin. Shared OpenCode catalog upgrades
also require changesets for every affected consumer. There are no fixed or linked
version groups. See [the release guide](../docs/releases.md).
