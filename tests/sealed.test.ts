import { describe, expect, it } from "vitest";
import { MAX_PROJECTS, SealError, seal, sealingEnabled, unseal } from "../src/sealed";

const SECRET = "s".repeat(48);
const OTHER = "o".repeat(48);
const projects = [
  { name: "personal", token: "tok-personal-123" },
  { name: "we4water", token: "tok-we4water-456", consoleId: "654321" },
];

describe("sealed URLs", () => {
  it("round-trips projects, including optional console ids", () => {
    const blob = seal(projects, SECRET);
    expect(blob.startsWith("v1.")).toBe(true);
    expect(blob).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(unseal(blob, SECRET)).toEqual(projects);
  });

  it("never contains the token in clear and is different every time", () => {
    const a = seal(projects, SECRET);
    const b = seal(projects, SECRET);
    expect(a).not.toEqual(b);
    for (const p of projects) expect(a).not.toContain(p.token);
  });

  it("rejects blobs sealed under another secret", () => {
    expect(unseal(seal(projects, OTHER), SECRET)).toBeNull();
  });

  it("rejects any tampering", () => {
    const blob = seal(projects, SECRET);
    for (const i of [3, Math.floor(blob.length / 2), blob.length - 1]) {
      const flipped = blob.slice(0, i) + (blob[i] === "A" ? "B" : "A") + blob.slice(i + 1);
      expect(unseal(flipped, SECRET)).toBeNull();
    }
    expect(unseal(blob.slice(0, -4), SECRET)).toBeNull();
    expect(unseal(blob.replace("v1.", "v2."), SECRET)).toBeNull();
  });

  it("rejects garbage, empty and oversized input", () => {
    for (const bad of [undefined, "", "v1.", "v1.AAAA", "nope", "a".repeat(5000), `v1.${"A".repeat(5000)}`]) {
      expect(unseal(bad, SECRET)).toBeNull();
    }
  });

  it("is disabled without a strong secret", () => {
    expect(sealingEnabled(undefined)).toBe(false);
    expect(sealingEnabled("short")).toBe(false);
    expect(sealingEnabled(SECRET)).toBe(true);
    expect(() => seal(projects, "short")).toThrow(SealError);
    expect(unseal(seal(projects, SECRET), "short")).toBeNull();
  });

  it("validates input without echoing tokens", () => {
    const cases: Array<[Parameters<typeof seal>[0], RegExp]> = [
      [[], /at least one/],
      [[{ name: "Bad Name", token: "t" }], /name must be/],
      [[{ name: "a", token: "t" }, { name: "a", token: "u" }], /Duplicate/],
      [[{ name: "a", token: "has space secret" }], /malformed/],
      [[{ name: "a", token: "t", consoleId: "12x" }], /console project id/],
      [Array.from({ length: MAX_PROJECTS + 1 }, (_, i) => ({ name: `p${i}`, token: "t" })), /At most/],
    ];
    for (const [input, msg] of cases) {
      try {
        seal(input, SECRET);
        throw new Error("expected seal to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(SealError);
        expect((err as Error).message).toMatch(msg);
        expect((err as Error).message).not.toContain("secret");
      }
    }
  });
});
