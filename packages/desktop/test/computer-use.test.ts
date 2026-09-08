import { expect, test } from "bun:test"
import { keyCode } from "../src/main/computer-use"

test("computer use maps bounded Windows key names", () => {
  expect(keyCode("a")).toBe(0x41)
  expect(keyCode("Enter")).toBe(0x0d)
  expect(keyCode("ArrowDown")).toBe(0x28)
  expect(keyCode("F24")).toBe(0x87)
  expect(() => keyCode("Control+A")).toThrow("Unsupported key")
})
