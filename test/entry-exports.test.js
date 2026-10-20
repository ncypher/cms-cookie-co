// workerd rejects a Worker whose entry module has non-handler named exports
// ("Incorrect type for map entry ..."). Guard against that regression.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as entry from "../src/worker.js";

test("worker.js exports only the default handler", () => {
  assert.deepEqual(Object.keys(entry), ["default"]);
  assert.equal(typeof entry.default.fetch, "function");
});
