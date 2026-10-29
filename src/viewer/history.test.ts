import { expect, test } from "bun:test";
import { History } from "./history.ts";

test("back and forward walk visited pages and a new visit drops the forward ones", () => {
  const history = new History();
  history.visit("a");
  history.visit("b");
  history.visit("c");
  expect(history.back()?.page).toBe("b");
  expect(history.back()?.page).toBe("a");
  expect(history.back()).toBeUndefined();
  expect(history.forward()?.page).toBe("b");
  history.visit("d");
  expect(history.forward()).toBeUndefined();
  expect(history.back()?.page).toBe("b");
});

test("following replaces the previous followed page instead of piling up", () => {
  const history = new History();
  history.visit("index");
  history.visit("plan", true);
  history.visit("notes", true);
  expect(history.back()?.page).toBe("index");
});
