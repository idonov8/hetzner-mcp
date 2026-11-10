import { describe, expect, it } from "vitest";
import { isAuthorizedKey } from "../src/access";

const KEY = "a".repeat(48);

describe("access key", () => {
  it("accepts only the exact key", () => {
    expect(isAuthorizedKey(KEY, KEY)).toBe(true);
    expect(isAuthorizedKey(KEY + "x", KEY)).toBe(false);
    expect(isAuthorizedKey(KEY.slice(1), KEY)).toBe(false);
    expect(isAuthorizedKey("", KEY)).toBe(false);
    expect(isAuthorizedKey(undefined, KEY)).toBe(false);
  });
  it("rejects everything when the key is unset or shorter than 32 chars", () => {
    expect(isAuthorizedKey("", undefined)).toBe(false);
    expect(isAuthorizedKey("short", "short")).toBe(false);
    const k31 = "b".repeat(31);
    expect(isAuthorizedKey(k31, k31)).toBe(false);
    const k32 = "b".repeat(32);
    expect(isAuthorizedKey(k32, k32)).toBe(true);
  });
});
