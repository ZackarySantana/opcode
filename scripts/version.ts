import { repositoryRoot } from "./packaging"
import { checkReleasePolicy } from "./release-policy"

await checkReleasePolicy(repositoryRoot)

for (const command of [
  [process.execPath, "run", "changeset", "version"],
  [process.execPath, "install", "--lockfile-only", "--ignore-scripts"],
]) {
  const child = Bun.spawn(command, { cwd: repositoryRoot, stdout: "inherit", stderr: "inherit" })
  if (await child.exited) throw new Error(`Version command failed: ${command.join(" ")}`)
}
