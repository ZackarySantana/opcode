import { lstat, realpath } from "node:fs/promises"
import { dirname, extname, isAbsolute, relative, resolve } from "node:path"

/** A path inside the project, as an absolute path and the project-relative form used for permissions and replies. */
export interface ProjectPath {
  absolute: string
  relative: string
}

const escapes = (path: string) => path.split(/[\\/]/)[0] === ".." || isAbsolute(path)
const exists = (path: string) => lstat(path).then(() => true, () => false)

/** `path` inside the project. Symlinks are followed, so neither a write nor a read can reach outside it. */
export async function projectPath(directory: string, path: string): Promise<ProjectPath> {
  const outside = () => new Error(`${path} is outside the project. Use a path inside ${directory}.`)
  const absolute = resolve(directory, path)
  const inside = relative(directory, absolute)
  if (!inside || escapes(inside)) throw outside()
  // The path itself, or its deepest existing ancestor, decides where a write or read really lands.
  let existing = absolute
  while (!await exists(existing)) existing = dirname(existing)
  const [root, real] = await Promise.all([realpath(directory), realpath(existing).catch(() => undefined)])
  if (!real || escapes(relative(root, real))) throw outside()
  return { absolute, relative: inside.replaceAll("\\", "/") }
}

const imageTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
}

/** The image type a path's extension names, if any. */
export function imageType(path: string): string | undefined {
  return imageTypes[extname(path).toLowerCase()]
}

/** Where each image goes: the requested path with its format's extension, numbered when there are several. */
export function imagePaths(path: string, types: (string | undefined)[]): string[] {
  const stem = path.slice(0, path.length - extname(path).length)
  const extension = (type: string | undefined) => Object.keys(imageTypes).find((key) => imageTypes[key] === type) ?? (extname(path) || ".png")
  return types.map((type, index) => `${stem}${types.length > 1 ? `-${index + 1}` : ""}${extension(type)}`)
}

/** Raw 16-bit mono PCM framed as WAV, so players and browsers can open it. Audio that is already WAV is kept. */
export function wav(pcm: Uint8Array, rate: number): Uint8Array {
  if (new TextDecoder().decode(pcm.subarray(0, 4)) === "RIFF") return pcm
  const samples = pcm.subarray(0, pcm.length - pcm.length % 2)
  const file = new Uint8Array(44 + samples.length)
  const view = new DataView(file.buffer)
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)) }
  text(0, "RIFF")
  view.setUint32(4, 36 + samples.length, true)
  text(8, "WAVE")
  text(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true) // bytes per second
  view.setUint16(32, 2, true) // bytes per frame
  view.setUint16(34, 16, true) // bits per sample
  text(36, "data")
  view.setUint32(40, samples.length, true)
  file.set(samples, 44)
  return file
}

/** Seconds of audio in a WAV file with the canonical 44-byte header. */
export function wavSeconds(file: Uint8Array): number {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  return view.getUint32(40, true) / view.getUint32(28, true)
}
