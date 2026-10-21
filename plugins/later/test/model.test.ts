import { afterEach, expect, test } from "bun:test"
import { LaterModel } from "../src/model"
import { LaterDatabase } from "../src/sqlite"

const databases: LaterDatabase[] = []
afterEach(() => { for (const database of databases.splice(0)) database.close() })
function fixture() {
  const database = new LaterDatabase(":memory:")
  databases.push(database)
  const first = database.add("first", 1)
  const second = database.add("second", 2)
  const model = new LaterModel(database)
  return { database, model, first, second }
}

test("external deletion repairs the visible selection without retargeting the current action", () => {
  const { database, model, first, second } = fixture()
  database.delete(database.get(first)!)
  expect(model.target()).toBeUndefined()
  expect(model.view().selectedID).toBe(second)
  expect(model.target()?.id).toBe(second)
  expect(database.get(second)?.completedAt).toBeUndefined()
})

test("polling reconciles completion and empty-to-active selection", () => {
  const { database, model, first, second } = fixture()
  database.complete(database.get(first)!, 0)
  expect(model.refresh()).toBe(true)
  expect(model.view().selectedID).toBe(second)
  database.delete(database.get(second)!)
  model.refresh()
  expect(model.view().selectedID).toBeUndefined()
  const added = database.add("new")
  model.refresh()
  expect(model.view().selectedID).toBe(added)
  expect(model.refresh()).toBe(false)
})

test("a completed target visible in history cannot turn a stale completion into restoration", () => {
  const { database, model, first } = fixture()
  model.toggleHistory()
  database.complete(database.get(first)!, 0)
  expect(model.target()).toBeUndefined()
  expect(model.view().selectedID).toBe(first)
  expect(model.target()?.completedAt).toBe(0)
})

test("navigation clamps, history preserves valid selection, and reopening resets it", () => {
  const { database, model, first, second } = fixture()
  model.select(-1)
  expect(model.view().selectedID).toBe(first)
  model.select(1)
  model.select(1)
  expect(model.view().selectedID).toBe(second)
  database.complete(database.get(second)!, 10)
  model.refresh()
  model.toggleHistory()
  model.select(1)
  expect(model.view().selectedID).toBe(second)
  expect(model.predecessor(second)).toBe(first)
  model.toggleHistory()
  expect(model.view().selectedID).toBe(first)
  model.toggleHistory()
  model.open()
  expect(model.view()).toMatchObject({ history: false, selectedID: first })
})
