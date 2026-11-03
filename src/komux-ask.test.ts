import { describe, expect, test } from "bun:test";
import { askedRoot, rootForm } from "./komux-ask.ts";

const roots = ["/home/me/work/stories", "/home/me/notes"];

describe("rootForm", () => {
  test("offers only the configured roots, shortening the home directory", () => {
    const [choice] = rootForm("Notebook root for remax", roots, "/home/me").elements;
    expect(choice).toMatchObject({
      type: "choice",
      other: false,
      default: "/home/me/work/stories",
      options: [
        { value: "/home/me/work/stories", label: "~/work/stories" },
        { value: "/home/me/notes", label: "~/notes" },
      ],
    });
  });
});

describe("askedRoot", () => {
  test("reads the picked root", () => {
    expect(askedRoot(JSON.stringify({ id: "a", status: "submitted", values: { root: "/home/me/notes" } }), roots)).toEqual({
      status: "picked",
      root: "/home/me/notes",
    });
  });

  test("reads a cancel", () => {
    expect(askedRoot(JSON.stringify({ id: "a", status: "cancelled" }), roots)).toEqual({ status: "cancelled" });
  });

  test("gives up on anything else so the viewer can ask itself", () => {
    expect(askedRoot(JSON.stringify({ id: "a", status: "pending" }), roots)).toBeUndefined();
    expect(askedRoot(JSON.stringify({ status: "submitted", values: { root: "/elsewhere" } }), roots)).toBeUndefined();
    expect(askedRoot("not json", roots)).toBeUndefined();
  });
});
