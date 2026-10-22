import { repositoryRoot } from "./packaging"
import { validatePendingChangesets } from "./release-policy"

// Coverage was enforced on each PR; on main, only re-validate what is about to be consumed.
await validatePendingChangesets(repositoryRoot)

for (const command of [
  [process.execPath, "run", "changeset", "version"],
  [process.execPath, "install", "--lockfile-only", "--ignore-scripts"],
]) {
  const child = Bun.spawn(command, { cwd: repositoryRoot, stdout: "inherit", stderr: "inherit" })
  if (await child.exited) throw new Error(`Version command failed: ${command.join(" ")}`)
}
