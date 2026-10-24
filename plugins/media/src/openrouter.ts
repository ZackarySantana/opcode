const API = "https://openrouter.ai/api/v1"

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

export interface SpeechRequest {
  model: string
  input: string
  voice?: string
  instructions?: string
  speed?: number
  response_format: "mp3" | "pcm"
}

export interface ImageRequest {
  model: string
  prompt: string
  n?: number
  aspect_ratio?: string
  resolution?: string
  quality?: string
  background?: string
  output_format?: string
  seed?: number
  input_references?: { type: "image_url"; image_url: { url: string } }[]
}

export interface Image {
  bytes: Uint8Array
  mediaType?: string
}

export interface SpeechModel { id: string; name: string; description?: string; pricing: Record<string, string>; supported_voices?: string[] }
export interface ImageModel { id: string; name: string; supported_parameters?: Record<string, unknown> }
export interface ImageEndpoint { provider_name: string; supported_parameters?: Record<string, unknown>; pricing?: unknown }

/** OpenRouter's media endpoints. The key is read for each request, so connecting OpenRouter takes effect right away. */
export class OpenRouter {
  constructor(private readonly key: () => Promise<string>, private readonly fetch: Fetch = globalThis.fetch) {}

  /** The audio, and the sample rate of PCM: 16-bit mono at 24 kHz unless the content type says otherwise. */
  async speech(body: SpeechRequest, signal?: AbortSignal): Promise<{ bytes: Uint8Array; rate: number }> {
    const response = await this.request("/audio/speech", { body, signal })
    const rate = /(?:^|;)\s*(?:rate|sample_rate)=(\d+)/i.exec(response.headers.get("content-type") ?? "")?.[1]
    return { bytes: new Uint8Array(await response.arrayBuffer()), rate: rate ? Number(rate) : 24_000 }
  }

  async image(body: ImageRequest, signal?: AbortSignal): Promise<{ images: Image[]; cost?: number }> {
    const result = await (await this.request("/images", { body, signal })).json() as {
      data: { b64_json: string; media_type?: string }[]
      usage?: { cost?: number }
    }
    return {
      images: result.data.map((image) => ({ bytes: Uint8Array.from(Buffer.from(image.b64_json, "base64")), mediaType: image.media_type })),
      cost: result.usage?.cost,
    }
  }

  /** The key's remaining credit, null when the key has no limit, or undefined when OpenRouter doesn't say. */
  async creditRemaining(signal?: AbortSignal): Promise<number | null | undefined> {
    const { data } = await (await this.request("/key", { signal })).json() as { data?: { limit_remaining?: unknown } }
    const remaining = data?.limit_remaining
    return typeof remaining === "number" || remaining === null ? remaining : undefined
  }

  // The catalog is public, so it works before OpenRouter is connected and never carries the key.
  async speechModels(signal?: AbortSignal): Promise<SpeechModel[]> {
    return (await (await this.request("/models?output_modalities=speech", { signal, anonymous: true })).json() as { data: SpeechModel[] }).data
  }

  async imageModels(signal?: AbortSignal): Promise<ImageModel[]> {
    return (await (await this.request("/images/models", { signal, anonymous: true })).json() as { data: ImageModel[] }).data
  }

  async imageEndpoints(model: string, signal?: AbortSignal): Promise<ImageEndpoint[]> {
    const path = `/images/models/${model.split("/").map(encodeURIComponent).join("/")}/endpoints`
    return (await (await this.request(path, { signal, anonymous: true })).json() as { endpoints: ImageEndpoint[] }).endpoints
  }

  private async request(path: string, { body, signal, anonymous }: { body?: unknown; signal?: AbortSignal; anonymous?: boolean }) {
    const headers: Record<string, string> = anonymous ? {} : { authorization: `Bearer ${await this.key()}` }
    if (body !== undefined) headers["content-type"] = "application/json"
    const response = await this.fetch(`${API}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      // Never follow a redirect with the key attached.
      redirect: "error",
    })
    if (!response.ok) throw new Error(await failure(response))
    return response
  }
}

/** OpenRouter's error message and its suggested next step, when the body has them. */
async function failure(response: Response): Promise<string> {
  const text = await response.text()
  try {
    const { error } = JSON.parse(text) as { error?: { message?: string; metadata?: { remedy_hint?: string } } }
    if (error?.message) return [`OpenRouter ${response.status}: ${error.message}`, error.metadata?.remedy_hint].filter(Boolean).join(" ")
  } catch { /* Not JSON; fall through to the raw text. */ }
  return `OpenRouter ${response.status}: ${text.slice(0, 500) || response.statusText}`
}
