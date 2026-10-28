import { expect, test } from "bun:test"
import { createPending } from "../src/pending"
import { eventually } from "../test-support/server"

test("changes are listed until answered, sent one at a time in order, and a refused one leaves the list", async () => {
  const sent: { change: string; answer: ReturnType<typeof Promise.withResolvers<string>> }[] = []
  const lists: (readonly string[])[] = []
  const answers: string[] = []
  const failures: unknown[] = []
  const send = createPending<string, string>({
    send: (change) => { const answer = Promise.withResolvers<string>(); sent.push({ change, answer }); return answer.promise },
    answered: (answer) => answers.push(answer),
    failed: (error) => { failures.push(error) },
    changed: (pending) => lists.push(pending),
  })
  const first = send("a")
  const second = send("b")
  const third = send("b")
  expect(lists.at(-1)).toEqual(["a", "b", "b"])
  await eventually(() => expect(sent.map((call) => call.change)).toEqual(["a"]))
  sent[0]!.answer.resolve("A")
  await first
  expect(lists.at(-1)).toEqual(["b", "b"])
  await eventually(() => expect(sent.map((call) => call.change)).toEqual(["a", "b"]))
  sent[1]!.answer.reject(new Error("refused"))
  await second
  expect(lists.at(-1)).toEqual(["b"])
  await eventually(() => expect(sent).toHaveLength(3))
  sent[2]!.answer.resolve("B")
  await third
  expect(lists.at(-1)).toEqual([])
  expect(answers).toEqual(["A", "B"])
  expect(failures).toMatchObject([{ message: "refused" }])
})
