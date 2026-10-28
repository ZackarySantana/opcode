import { mkdir } from "node:fs/promises"
import { dirname, extname } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { errorMessage, formatMoney } from "@opcode/core"
import { object } from "@opcode/core/rpc"
import { imagePaths, imageType, projectPath, wav, wavSeconds, type ProjectPath } from "./files"
import type { OpenRouter } from "./openrouter"

export interface ToolDependencies {
  openrouter: OpenRouter
  /** The project directory that paths are relative to. */
  directory: string
  assert: Plugin.Context["permission"]["assert"]
}

const model = { type: "string", description: "Model ID from media_models." }
const MODEL_ID = /^\w[\w.-]*\/\w[\w.:-]*$/
/** OpenRouter's limit on decoded reference media. */
const REFERENCE_BYTES = 15 * 1024 * 1024

/** Agent tools that generate media with the user's OpenRouter key and save it into the project. */
export function mediaTools({ openrouter, directory, assert }: ToolDependencies) {
  const check = (context: ToolContext, action: string, resources: string[], save: string[]) => assert({
    sessionID: context.sessionID, agent: context.agent, action, resources, save, metadata: {},
    source: { type: "tool", messageID: context.messageID, id: context.id },
  })
  // Checked before anything is spent: rules can ask for or deny a tool or model, and edit rules cover the files.
  const approve = async (context: ToolContext, tool: string, model: string, files: ProjectPath[]) => {
    await check(context, tool, [model], [model])
    await check(context, "edit", files.map((file) => file.relative), ["*"])
  }
  const validModel = (model: string) => {
    if (!MODEL_ID.test(model)) throw new Error(`${model} is not an OpenRouter model ID. Call media_models for the available models.`)
  }
  const save = async (file: ProjectPath, bytes: Uint8Array) => {
    await mkdir(dirname(file.absolute), { recursive: true })
    await Bun.write(file.absolute, bytes)
  }
  // Best effort: the files are already saved, so a failed credit read only shortens the reply.
  const credit = (signal: AbortSignal) => openrouter.creditRemaining(signal).then(
    (remaining) => remaining === null ? " The OpenRouter key has no credit limit."
      : remaining === undefined ? "" : ` OpenRouter key credit remaining: ${formatMoney(remaining)}.`,
    () => "",
  )

  return [
    {
      name: "media_speech",
      description: "Generate speech or other audio with OpenRouter and save it into the project. Spends the user's OpenRouter credit. bytedance-seed/seed-audio-1-0 treats text as a prompt, so it can make sound effects or ambience too.",
      input: object({
        text: { type: "string", description: "What to say. Most models read it verbatim; put delivery directions in instructions." },
        model,
        voice: { type: "string", description: "Voice ID. Voices vary by model; media_models with this model lists them." },
        instructions: { type: "string", description: "Tone, pacing, or emotion. Supported by OpenAI, Gemini, and Fish Audio models." },
        speed: { type: "number", description: "Playback speed multiplier, for models that support it." },
        path: { type: "string", description: "Where to save it, relative to the project: .mp3, or .wav for uncompressed audio. Gemini and HeyGen models only make .wav; MiniMax models only make .mp3." },
      }, ["text", "model", "path"]),
      options: { codemode: false },
      execute: async (input: unknown, context: ToolContext) => {
        const { text, model, voice, instructions, speed, path } = input as { text: string; model: string; voice?: string; instructions?: string; speed?: number; path: string }
        validModel(model)
        const file = await projectPath(directory, path)
        const format = extname(file.relative).toLowerCase()
        if (format !== ".mp3" && format !== ".wav") throw new Error(`Save speech as .mp3, or .wav for uncompressed audio, not ${path}.`)
        await approve(context, "media_speech", model, [file])
        const audio = await openrouter.speech({ model, input: text, voice, instructions, speed, response_format: format === ".wav" ? "pcm" : "mp3" }, context.signal)
        if (!audio.bytes.length) throw new Error("OpenRouter returned no audio.")
        const bytes = format === ".wav" ? wav(audio.bytes, audio.rate) : audio.bytes
        await save(file, bytes)
        const length = format === ".wav" ? ` (${wavSeconds(bytes).toFixed(2)} s)` : ""
        return { content: `Saved ${file.relative}${length}.${await credit(context.signal)}` }
      },
    },
    {
      name: "media_image",
      description: "Generate an image with OpenRouter and save it into the project. Spends the user's OpenRouter credit. Optional parameters depend on the model; media_models with this model lists them.",
      input: object({
        prompt: { type: "string", description: "What the image shows, including style." },
        model,
        path: { type: "string", description: "Where to save it, relative to the project. The extension follows the format the model returns, and several images are numbered: art/hero.png becomes art/hero-1.png, art/hero-2.png." },
        aspect_ratio: { type: "string", description: "Such as 1:1, 16:9, or 9:16." },
        resolution: { type: "string", description: "512, 768, 1K, 1.5K, 2K, or 4K." },
        quality: { type: "string", enum: ["auto", "low", "medium", "high"] },
        background: { type: "string", enum: ["auto", "transparent", "opaque"], description: "transparent needs PNG or WebP output." },
        output_format: { type: "string", enum: ["png", "jpeg", "webp", "svg"], description: "svg only for vector models." },
        seed: { type: "integer" },
        count: { type: "integer", minimum: 1, maximum: 4, description: "How many images to make. Each one costs." },
        references: { type: "array", items: { type: "string" }, description: "Reference images to guide or edit: project PNG, JPEG, WebP, or GIF files, or https URLs." },
      }, ["prompt", "model", "path"]),
      options: { codemode: false },
      execute: async (input: unknown, context: ToolContext) => {
        const { prompt, model, path, count, references = [], aspect_ratio, resolution, quality, background, output_format, seed } = input as {
          prompt: string; model: string; path: string; count?: number; references?: string[]
          aspect_ratio?: string; resolution?: string; quality?: string; background?: string; output_format?: string; seed?: number
        }
        validModel(model)
        const n = Math.min(Math.max(Math.trunc(count ?? 1), 1), 4)
        const requested = await projectPath(directory, path)
        const expected = imageType(output_format ? `.${output_format}` : requested.relative)
        const planned = await Promise.all(imagePaths(requested.relative, Array(n).fill(expected), n > 1).map((file) => projectPath(directory, file)))
        // In the agent's order, since prompts can refer to references by position.
        const sources = await Promise.all(references.map(async (reference): Promise<{ url: string } | { file: ProjectPath; type: string }> => {
          if (/^https?:\/\//i.test(reference)) return { url: reference }
          const type = imageType(reference)
          if (!type || type === "image/svg+xml") throw new Error(`${reference} is not a PNG, JPEG, WebP, or GIF image.`)
          const file = await projectPath(directory, reference)
          if (!await Bun.file(file.absolute).exists()) throw new Error(`${reference} doesn't exist in the project.`)
          return { file, type }
        }))
        await approve(context, "media_image", model, planned)
        // Reference files are sent to OpenRouter, so they need the same read permission as any other read.
        const files = sources.flatMap((source) => "file" in source ? [source.file.relative] : [])
        if (files.length) await check(context, "read", files, ["*"])
        const input_references = await Promise.all(sources.map(async (source) => {
          if ("url" in source) return { type: "image_url" as const, image_url: { url: source.url } }
          const reference = Bun.file(source.file.absolute)
          if (reference.size > REFERENCE_BYTES) throw new Error(`${source.file.relative} is larger than OpenRouter's 15 MiB reference limit.`)
          return { type: "image_url" as const, image_url: { url: `data:${source.type};base64,${Buffer.from(await reference.arrayBuffer()).toString("base64")}` } }
        }))
        const { images, cost } = await openrouter.image({
          model, prompt, n: n > 1 ? n : undefined, aspect_ratio, resolution, quality, background, output_format, seed,
          input_references: input_references.length ? input_references : undefined,
        }, context.signal)
        if (!images.length) throw new Error("OpenRouter returned no images.")
        const spent = cost === undefined ? "" : ` Cost: ${formatMoney(cost)}.`
        const saved = await Promise.all(imagePaths(requested.relative, images.map((image) => image.mediaType), n > 1 || images.length > 1).map((file) => projectPath(directory, file)))
        // A different format or more images than asked for lands on paths that weren't approved yet.
        const unplanned = saved.filter((file) => !planned.some((approved) => approved.relative === file.relative))
        if (unplanned.length) {
          await check(context, "edit", unplanned.map((file) => file.relative), ["*"]).catch((error) => {
            throw new Error(`${errorMessage(error)} The images were generated but not saved.${spent}`)
          })
        }
        await Promise.all(saved.map((file, index) => save(file, images[index]!.bytes)))
        return { content: `Saved ${saved.map((file) => file.relative).join(", ")}.${spent}${await credit(context.signal)}` }
      },
    },
    {
      name: "media_models",
      description: "List OpenRouter's speech or image models, or pass a model for its voices (speech) or its providers, parameters, and prices (image). Free.",
      input: object({
        kind: { type: "string", enum: ["speech", "image"] },
        model: { type: "string", description: "A model ID, for its details." },
      }, ["kind"]),
      options: { codemode: false },
      execute: async (input: unknown, context: ToolContext) => {
        const { kind, model } = input as { kind: "speech" | "image"; model?: string }
        if (model !== undefined) validModel(model)
        if (kind === "speech") {
          const models = await openrouter.speechModels(context.signal)
          if (model === undefined) return { content: JSON.stringify(models.map(({ id, name, pricing, supported_voices }) => ({ id, name, pricing, voices: supported_voices?.length ?? 0 }))) }
          const found = models.find((entry) => entry.id === model)
          if (!found) throw new Error(`No speech model ${model}. Call media_models without a model to list them.`)
          return { content: JSON.stringify({ id: found.id, name: found.name, description: found.description, pricing: found.pricing, voices: found.supported_voices ?? [] }) }
        }
        if (model === undefined) {
          const models = await openrouter.imageModels(context.signal)
          return { content: JSON.stringify(models.map(({ id, name, supported_parameters }) => ({ id, name, parameters: Object.keys(supported_parameters ?? {}) }))) }
        }
        const endpoints = await openrouter.imageEndpoints(model, context.signal)
        return { content: JSON.stringify({ id: model, endpoints: endpoints.map(({ provider_name, supported_parameters, pricing }) => ({ provider: provider_name, parameters: supported_parameters, pricing })) }) }
      },
    },
  ]
}
