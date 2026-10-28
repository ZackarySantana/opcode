import { Rpc } from "@opencode/plugin/rpc"
import { empty, failed } from "@opcode/core/rpc"
import { ACTIVITY_KINDS, DATE_RANGES, IMPORT_BATCH_SIZE, MAX_COST, MAX_ID_LENGTH, MAX_TIME, MAX_TOKENS } from "./domain.js"

const id = { type: "string", minLength: 1, maxLength: MAX_ID_LENGTH } as const
const number = { type: "number", minimum: 0, maximum: MAX_TOKENS } as const
const time = { type: "number", minimum: 0, maximum: MAX_TIME } as const
const cost = { type: "number", minimum: 0, maximum: MAX_COST } as const
const usage = {
  type: "object", additionalProperties: false,
  properties: {
    messageID: id, providerID: id, modelID: id, variant: id, createdAt: time, completedAt: time,
    cost, input: number, output: number, reasoning: number, cacheRead: number, cacheWrite: number,
  },
  required: ["messageID", "providerID", "modelID", "createdAt", "cost", "input", "output", "reasoning", "cacheRead", "cacheWrite"],
} as const
const breakdown = {
  type: "array", items: {
    type: "object", additionalProperties: false,
    properties: { id: { type: "string" }, label: { type: "string" }, cost: { type: "number" }, messages: number, tokens: { type: "number" } },
    required: ["id", "label", "cost", "messages", "tokens"],
  },
} as const
const activity = {
  type: "object", additionalProperties: false,
  properties: { kind: { type: "string", enum: ACTIVITY_KINDS }, at: time }, required: ["kind", "at"],
} as const
const timeBreakdown = {
  type: "array", items: {
    type: "object", additionalProperties: false,
    properties: { id: { type: "string" }, label: { type: "string" }, agent: { type: "number" }, wait: { type: "number" }, turns: { type: "number" } },
    required: ["id", "label", "agent", "wait", "turns"],
  },
} as const
const timeDashboard = {
  type: "object", additionalProperties: false,
  properties: {
    total: {
      type: "object", additionalProperties: false,
      properties: { agent: { type: "number" }, turns: { type: "number" }, wait: { type: "number" }, parallel: { type: "number" }, peak: { type: "number" } },
      required: ["agent", "turns", "wait", "parallel", "peak"],
    },
    projects: timeBreakdown, models: timeBreakdown, daily: timeBreakdown,
    longest: {
      type: "array", items: {
        type: "object", additionalProperties: false,
        properties: {
          sessionID: { type: "string" }, title: { type: "string" }, project: { type: "string" }, directory: { type: "string" },
          model: { type: "string" }, start: { type: "number" }, duration: { type: "number" },
        },
        required: ["sessionID", "title", "project", "directory", "model", "start", "duration"],
      },
    },
  },
  required: ["total", "projects", "models", "daily", "longest"],
} as const
const filter = {
  type: "object", additionalProperties: false, required: ["range"],
  properties: { range: { type: "string", enum: DATE_RANGES } },
} as const
const dashboard = {
  type: "object", additionalProperties: false,
  properties: {
    total: {
      type: "object", additionalProperties: false,
      properties: {
        cost: { type: "number" }, messages: number, tokens: { type: "number" }, input: { type: "number" }, output: { type: "number" },
        reasoning: { type: "number" }, cacheRead: { type: "number" }, cacheWrite: { type: "number" },
      },
      required: ["cost", "messages", "tokens", "input", "output", "reasoning", "cacheRead", "cacheWrite"],
    },
    projects: breakdown, models: breakdown, daily: breakdown,
  },
  required: ["total", "projects", "models", "daily"],
} as const

export const CostRpc = Rpc.define({
  id: "opcode-cost",
  methods: {
    dashboard: { input: filter, output: dashboard, errors: failed },
    time: { input: filter, output: timeDashboard, errors: failed },
    status: {
      input: empty,
      output: {
        type: "object", additionalProperties: false,
        properties: { projectID: id, directory: { type: "string" }, lastImport: { type: ["number", "null"] } },
        required: ["projectID", "directory", "lastImport"],
      },
      errors: failed,
    },
    importBatch: {
      input: {
        type: "object", additionalProperties: false, required: ["sessionID", "records"],
        properties: { sessionID: id, records: { type: "array", minItems: 1, maxItems: IMPORT_BATCH_SIZE, items: usage } },
      },
      output: empty,
      errors: failed,
    },
    importActivity: {
      input: {
        type: "object", additionalProperties: false, required: ["sessionID", "activity"],
        properties: { sessionID: id, activity: { type: "array", minItems: 1, maxItems: IMPORT_BATCH_SIZE, items: activity } },
      },
      output: empty,
      errors: failed,
    },
    completeImport: { input: empty, output: empty, errors: failed },
  },
  // Throttled: the ledger recorded usage or activity, live or imported. Readers reread what they show.
  events: { updated: { schema: empty } },
})
