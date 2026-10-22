import { Rpc } from "@opencode/plugin/rpc"
import { DATE_RANGES, IMPORT_BATCH_SIZE, MAX_COST, MAX_ID_LENGTH, MAX_MODEL_FILTER_LENGTH, MAX_TIME, MAX_TOKENS } from "./domain.js"

const id = { type: "string", minLength: 1, maxLength: MAX_ID_LENGTH } as const
const number = { type: "number", minimum: 0, maximum: MAX_TOKENS } as const
const time = { type: "number", minimum: 0, maximum: MAX_TIME } as const
const cost = { type: "number", minimum: 0, maximum: MAX_COST } as const
const empty = { type: "object", additionalProperties: false } as const
// Undeclared handler errors reach clients only as a generic rpc.internal failure.
const errors = { failed: empty }
const usage = {
  type: "object", additionalProperties: false,
  properties: {
    messageID: id, providerID: id, modelID: id, createdAt: time, completedAt: time,
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
const options = {
  type: "array", items: {
    type: "object", additionalProperties: false, properties: { id: { type: "string" }, label: { type: "string" } }, required: ["id", "label"],
  },
} as const
const projectOptions = {
  type: "array", items: {
    type: "object", additionalProperties: false,
    properties: { id: { type: "string" }, label: { type: "string" }, directory: { type: "string" } },
    required: ["id", "label", "directory"],
  },
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
    projects: breakdown, models: breakdown, daily: breakdown, projectOptions, modelOptions: options,
  },
  required: ["total", "projects", "models", "daily", "projectOptions", "modelOptions"],
} as const

export const CostRpc = Rpc.define({
  id: "opcode-cost",
  methods: {
    dashboard: {
      input: {
        type: "object", additionalProperties: false, required: ["range"],
        properties: { range: { type: "string", enum: DATE_RANGES }, projectID: id, model: { type: "string", maxLength: MAX_MODEL_FILTER_LENGTH } },
      },
      output: dashboard,
      errors,
    },
    status: {
      input: empty,
      output: {
        type: "object", additionalProperties: false,
        properties: { projectID: id, directory: { type: "string" }, lastImport: { type: ["number", "null"] } },
        required: ["projectID", "directory", "lastImport"],
      },
      errors,
    },
    importBatch: {
      input: {
        type: "object", additionalProperties: false, required: ["sessionID", "records"],
        properties: { sessionID: id, records: { type: "array", minItems: 1, maxItems: IMPORT_BATCH_SIZE, items: usage } },
      },
      output: empty,
      errors,
    },
    completeImport: { input: empty, output: empty, errors },
  },
  events: {},
})
