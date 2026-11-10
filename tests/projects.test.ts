import { describe, expect, it } from "vitest";
import { ConfigError, parseProjectIds, parseProjects } from "../src/projects";

describe("parseProjects", () => {
  it("parses HCLOUD_TOKENS name:token pairs in order", () => {
    expect(parseProjects({ HCLOUD_TOKENS: "personal:abc,we4water:def" })).toEqual([
      { name: "personal", token: "abc" },
      { name: "we4water", token: "def" },
    ]);
  });

  it("splits on the first colon only, trims, and skips empty entries", () => {
    expect(parseProjects({ HCLOUD_TOKENS: " a_1 : x:y:z , ,b-2:t," })).toEqual([
      { name: "a_1", token: "x:y:z" },
      { name: "b-2", token: "t" },
    ]);
  });

  it("prefers HCLOUD_TOKENS over HCLOUD_TOKEN", () => {
    expect(parseProjects({ HCLOUD_TOKENS: "p:1", HCLOUD_TOKEN: "legacy" })).toEqual([{ name: "p", token: "1" }]);
  });

  it("falls back to HCLOUD_TOKEN as project 'default'", () => {
    expect(parseProjects({ HCLOUD_TOKEN: "legacy" })).toEqual([{ name: "default", token: "legacy" }]);
    expect(parseProjects({ HCLOUD_TOKENS: "  ", HCLOUD_TOKEN: "legacy" })).toEqual([{ name: "default", token: "legacy" }]);
  });

  it("errors when nothing is configured", () => {
    expect(() => parseProjects({})).toThrow(new ConfigError("HCLOUD_TOKENS not configured"));
    expect(() => parseProjects({ HCLOUD_TOKENS: ",", HCLOUD_TOKEN: "" })).toThrow("HCLOUD_TOKENS not configured");
  });

  it("rejects bad names, missing tokens and duplicates without echoing tokens", () => {
    const cases = ["Personal:secret1", "toolong-name-xxxxxxxxxxxxxxxxxxxxxxx:secret1", "a b:secret1", "secret1", "p:", "p:secret1,p:secret2"];
    for (const HCLOUD_TOKENS of cases) {
      let msg = "";
      try {
        parseProjects({ HCLOUD_TOKENS });
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        msg = (e as Error).message;
      }
      expect(msg, HCLOUD_TOKENS).not.toBe("");
      expect(msg).not.toContain("secret");
    }
  });
});

describe("parseProjectIds", () => {
  it("parses name:id pairs and ignores malformed entries", () => {
    const ids = parseProjectIds({ HCLOUD_PROJECT_IDS: "personal:123, we4water:456, bad:abc, Nope:1" });
    expect(Object.fromEntries(ids)).toEqual({ personal: "123", we4water: "456" });
  });
  it("uses HCLOUD_PROJECT_ID as the fallback for 'default'", () => {
    expect(parseProjectIds({ HCLOUD_PROJECT_ID: "999" }).get("default")).toBe("999");
    expect(parseProjectIds({ HCLOUD_PROJECT_IDS: "default:1", HCLOUD_PROJECT_ID: "999" }).get("default")).toBe("1");
  });
});
