import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"

// Fixtures share the OS temp parent; custom TMPDIR paths may not exist yet.
await mkdir(tmpdir(), { recursive: true })
