# @lidtop/opencode-media

Let the agent make the narration, sound effects, and images your project needs. Connect OpenRouter once, and every session can generate speech and images straight into your project, with no `.env` file and no API calls written by hand.

## Install

Requires OpenCode **2.2.0 or newer in the 2.x line**.

```sh
opencode plugin add @lidtop/opencode-media
```

Or add it to `plugins` in your global `~/.config/opencode/opencode.jsonc` (or `opencode.json`), keeping your existing entries:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@lidtop/opencode-media"]
}
```

Then connect OpenRouter: run `/connect`, choose **OpenRouter**, and enter an API key from [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys). An `OPENROUTER_API_KEY` environment variable works too.

**Where it runs.** Media has no terminal view. The OpenCode server runs the tools, reads the key, and writes the files. With a remote server, files are saved on that server.

## Use

Ask for what you want, such as "narrate this script with a warm voice and save it to `audio/intro.mp3`". The agent has three tools:

| Tool | What it does |
| --- | --- |
| `media_models` | Lists OpenRouter's speech or image models, or one model's voices, parameters, and prices. Free. |
| `media_speech` | Turns text into speech and saves it as `.mp3`, or `.wav` for uncompressed audio. With `bytedance-seed/seed-audio-1-0`, the text is a prompt, so it can make sound effects and ambience too. |
| `media_image` | Generates images from a prompt, optionally guided by reference images from the project or the web, and saves them. Several images are numbered: `art/hero.png` becomes `art/hero-1.png`, `art/hero-2.png`. |

Files are saved at the path the agent picks, relative to the project, and never outside it. An image's extension follows the format the model returns.

## Cost

Generating speech and images spends your OpenRouter credit. Each reply reports the image cost, when OpenRouter returns one, and the key's remaining credit.

**Set a credit limit on the key** in the OpenRouter dashboard. It's the cap OpenRouter enforces, however many tools or sessions use the key.

Listing models costs nothing and works before you connect.

## Permissions

Every generation is checked against your [permission rules](https://opencode.ai/v2/docs/permissions) before anything is spent. The action is the tool's name and the resource is the model, so you can ask before each image or block an expensive model:

```jsonc
{
  "permissions": [
    { "action": "media_image", "resource": "*", "effect": "ask" },
    { "action": "media_speech", "resource": "elevenlabs/*", "effect": "deny" }
  ]
}
```

Saving a file is checked as an `edit` of its path, so agents that can't edit files, like `plan`, can't save media either. Reference images from the project are uploaded to OpenRouter, so each one is checked as a `read`. Paths that lead outside the project, including through symlinks, are refused.

## Keep OpenRouter out of model selection

The key is an OpenCode integration credential, so the tools still work if a [policy](https://opencode.ai/v2/docs/policies) denies the OpenRouter provider. That keeps agents from choosing OpenRouter models for chats or subagents while they still generate media:

```jsonc
{
  "policies": [
    { "action": "provider.use", "resource": "openrouter", "effect": "deny" }
  ]
}
```

## Limitations

- `.wav` files come from OpenRouter's raw PCM, which is 24 kHz unless the response says otherwise. If a model's `.wav` sounds too fast or too slow, use `.mp3`. Gemini and HeyGen models only make `.wav`, and MiniMax models only make `.mp3`.
- Multi-speaker input, voice cloning, and video generation aren't supported yet.

## Development

From the repository root:

```sh
mise exec -- bun test plugins/media/test
mise exec -- bun run typecheck
mise run dev media
```

The build bundles the private `@opcode/core` workspace into the package; OpenCode stays external.
