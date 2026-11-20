import { expect, test } from "bun:test";
import { applyAssignments } from "./commands/settings";
import { FIXTURES } from "./fixtures";
import { parseSettings } from "./settings";

test("dotted paths, JSON values, strings otherwise", () => {
  const edited = parseSettings(applyAssignments(FIXTURES.minimal, ["domains.production=other.example.com", "protectBranches=false"]));
  expect(edited.domains.production).toBe("other.example.com");
  expect(edited.domains.dev).toBe(FIXTURES.minimal.domains.dev);
  expect(edited.protectBranches).toBe(false);
});

test("the name can't change, and assignments must be path=value", () => {
  expect(() => applyAssignments(FIXTURES.minimal, ["name=other"])).toThrow("name can't change");
  expect(() => applyAssignments(FIXTURES.minimal, ["domains.production"])).toThrow("expected path=value");
});

test("the result is still checked against the schema", () => {
  expect(() => parseSettings(applyAssignments(FIXTURES.minimal, ["domains.production=https://bad"]))).toThrow("Invalid project settings");
});
