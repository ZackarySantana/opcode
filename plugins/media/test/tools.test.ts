import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenRouter } from "../src/openrouter"
import { mediaTools } from "../src/tools"

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

type Reply = (url: string, body: any) => Response

/** The tools on a temporary project, with OpenRouter replaced by `reply` and every request and permission check recorded. */
function fixture(reply: Reply, { key = "sk-or-test", credit = 7.5 as number | null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "opcode-media-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const project = join(root, "project")
  mkdirSync(project)
  const requests: { url: string; authorization?: string; body: any }[] = []
  const checks: { action: string; resources: string[] }[] = []
  let deny: string | undefined
  const openrouter = new OpenRouter(async () => {
    if (!key) throw new Error("OpenRouter isn't connected.")
    return key
  }, async (url, init) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined
    requests.push({ url, authorization: (init.headers as Record<string, string>).authorization, body })
    if (url.endsWith("/key")) return Response.json({ data: { limit_remaining: credit } })
    return reply(url, body)
  })
  const tools = mediaTools({
    openrouter, directory: project,
    assert: (async ({ action, resources }: { action: string; resources: string[] }) => {
      checks.push({ action, resources })
      if (action === deny) throw new Error(`${action} denied`)
    }) as any,
  })
  const call = async (name: string, input: unknown) =>
    (await tools.find((tool) => tool.name === name)!.execute(input, { sessionID: "s", agent: "build", messageID: "m", id: "c", signal: new AbortController().signal } as any)).content
  return { root, project, requests, checks, call, deny: (action: string) => { deny = action } }
}

const unreachable = () => { throw new Error("should not be called") }

test("speech is saved where asked, as mp3 or as playable wav, after the model and file are allowed", async () => {
  const pcm = new Uint8Array(48_000) // one second of 24 kHz 16-bit mono
  const f = fixture((_url, body) => new Response(body.response_format === "pcm" ? pcm : "mp3 bytes", {
    headers: { "content-type": body.response_format === "pcm" ? "audio/pcm" : "audio/mpeg" },
  }))
  const reply = await f.call("media_speech", { text: "Hello", model: "elevenlabs/eleven-v3", voice: "Rachel", path: "audio/intro.mp3" })
  expect(reply).toContain("audio/intro.mp3")
  expect(reply).toContain("$7.50")
  expect(await Bun.file(join(f.project, "audio/intro.mp3")).text()).toBe("mp3 bytes")
  expect(f.requests[0]).toMatchObject({
    url: "https://openrouter.ai/api/v1/audio/speech", authorization: "Bearer sk-or-test",
    body: { model: "elevenlabs/eleven-v3", input: "Hello", voice: "Rachel", response_format: "mp3" },
  })
  expect(f.checks).toEqual([{ action: "media_speech", resources: ["elevenlabs/eleven-v3"] }, { action: "edit", resources: ["audio/intro.mp3"] }])

  expect(await f.call("media_speech", { text: "Hi", model: "google/gemini-3.8-flash-tts", path: "audio/line.wav" })).toContain("1.00 s")
  const wav = new Uint8Array(await Bun.file(join(f.project, "audio/line.wav")).arrayBuffer())
  expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF")
  expect(new DataView(wav.buffer).getUint32(24, true)).toBe(24_000)
  expect(wav.length).toBe(44 + pcm.length)
})

test("images take the returned format's extension, are numbered when several, and send references in order", async () => {
  const f = fixture(() => Response.json({
    data: [{ b64_json: Buffer.from("image").toString("base64"), media_type: "image/jpeg" }, { b64_json: "", media_type: "image/jpeg" }],
    usage: { cost: 0.08 },
  }), { credit: null })
  await Bun.write(join(f.project, "art/sketch.png"), "sketch")
  const reply = await f.call("media_image", { prompt: "a collage", model: "openai/gpt-image-2", path: "art/hero.png", count: 2, references: ["https://example.com/a.png", "art/sketch.png"] })
  expect(reply).toContain("art/hero-1.jpg, art/hero-2.jpg")
  expect(reply).toContain("$0.08")
  expect(await Bun.file(join(f.project, "art/hero-1.jpg")).text()).toBe("image")
  expect(f.requests[0]!.body).toMatchObject({
    model: "openai/gpt-image-2", prompt: "a collage", n: 2,
    input_references: [
      { type: "image_url", image_url: { url: "https://example.com/a.png" } },
      { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from("sketch").toString("base64")}` } },
    ],
  })
  // The planned .png names were approved before spending; the .jpg names the model chose are checked before saving.
  expect(f.checks.filter((check) => check.action !== "media_image")).toEqual([
    { action: "edit", resources: ["art/hero-1.png", "art/hero-2.png"] },
    { action: "read", resources: ["art/sketch.png"] },
    { action: "edit", resources: ["art/hero-1.jpg", "art/hero-2.jpg"] },
  ])
})

test("fewer images than requested keep the approved numbered names, without another edit check", async () => {
  const f = fixture(() => Response.json({ data: [{ b64_json: Buffer.from("image").toString("base64"), media_type: "image/png" }] }))
  expect(await f.call("media_image", { prompt: "x", model: "openai/gpt-image-2", path: "art/hero.png", count: 2 })).toContain("Saved art/hero-1.png.")
  expect(await Bun.file(join(f.project, "art/hero-1.png")).text()).toBe("image")
  expect(f.checks.filter((check) => check.action === "edit")).toEqual([{ action: "edit", resources: ["art/hero-1.png", "art/hero-2.png"] }])
})

test("an extension that already names the returned format is kept as written", async () => {
  let type = "image/jpeg"
  const f = fixture(() => Response.json({ data: [{ b64_json: Buffer.from("image").toString("base64"), media_type: type }] }))
  const image = (path: string) => f.call("media_image", { prompt: "x", model: "openai/gpt-image-2", path })
  expect(await image("photo.jpeg")).toContain("Saved photo.jpeg.")
  type = "image/png"
  expect(await image("Hero.PNG")).toContain("Saved Hero.PNG.")
  expect(f.checks.filter((check) => check.action === "edit")).toEqual([{ action: "edit", resources: ["photo.jpeg"] }, { action: "edit", resources: ["Hero.PNG"] }])
})

test("no audio from OpenRouter is an error, and nothing is saved", async () => {
  const f = fixture(() => new Response(new Uint8Array(0), { headers: { "content-type": "audio/mpeg" } }))
  await expect(f.call("media_speech", { text: "x", model: "elevenlabs/eleven-v3", path: "a.mp3" })).rejects.toThrow("OpenRouter returned no audio.")
  expect(await Bun.file(join(f.project, "a.mp3")).exists()).toBe(false)
})

test("nothing is spent on a request that can't be saved, read, or allowed, or has no key", async () => {
  const f = fixture(unreachable)
  mkdirSync(join(f.root, "elsewhere"))
  symlinkSync(join(f.root, "elsewhere"), join(f.project, "link"))
  await Bun.write(join(f.root, "secret.png"), "secret")
  symlinkSync(join(f.root, "secret.png"), join(f.project, "logo.png"))
  const image = (input: object) => f.call("media_image", { prompt: "x", model: "openai/gpt-image-2", path: "a.png", ...input })
  for (const path of ["../outside.png", "/tmp/outside.png", "link/a.png"]) await expect(image({ path })).rejects.toThrow("outside the project")
  for (const reference of ["../secret.png", "logo.png"]) await expect(image({ references: [reference] })).rejects.toThrow("outside the project")
  await expect(f.call("media_speech", { text: "x", model: "elevenlabs/eleven-v3", path: "voice.ogg" })).rejects.toThrow("Save speech as .mp3")
  await expect(image({ model: "../key" })).rejects.toThrow("not an OpenRouter model ID")
  await expect(image({ references: ["missing.png"] })).rejects.toThrow("missing.png doesn't exist in the project.")
  // None of these asked the user anything.
  expect(f.checks).toEqual([])
  await Bun.write(join(f.project, "private.png"), "private")
  for (const action of ["media_image", "edit", "read"]) {
    f.deny(action)
    await expect(image({ references: ["private.png"] })).rejects.toThrow(`${action} denied`)
  }
  expect(f.requests).toEqual([])
  expect(await Bun.file(join(f.root, "elsewhere/a.png")).exists()).toBe(false)

  const unconnected = fixture(unreachable, { key: "" })
  await expect(unconnected.call("media_speech", { text: "x", model: "elevenlabs/eleven-v3", path: "a.mp3" })).rejects.toThrow("isn't connected")
  expect(unconnected.requests).toEqual([])
})

test("OpenRouter's error message and suggested next step reach the agent", async () => {
  const f = fixture(() => Response.json({
    error: { code: 403, message: "Key limit exceeded.", metadata: { remedy_hint: "Raise the key's credit limit." } },
  }, { status: 403 }))
  await expect(f.call("media_image", { prompt: "x", model: "openai/gpt-image-2", path: "a.png" }))
    .rejects.toThrow("OpenRouter 403: Key limit exceeded. Raise the key's credit limit.")
})

test("model lists never carry the key, and a model's details include its voices", async () => {
  const speech = [{ id: "elevenlabs/eleven-v3", name: "Eleven v3", pricing: { prompt: "0.00008" }, supported_voices: ["Rachel", "Adam"] }]
  const f = fixture(() => Response.json({ data: speech }))
  expect(JSON.parse(await f.call("media_models", { kind: "speech" }))).toMatchObject([{ id: "elevenlabs/eleven-v3", voices: 2 }])
  expect(JSON.parse(await f.call("media_models", { kind: "speech", model: "elevenlabs/eleven-v3" })).voices).toEqual(["Rachel", "Adam"])
  expect(f.requests.map((request) => request.authorization)).toEqual([undefined, undefined])
})
