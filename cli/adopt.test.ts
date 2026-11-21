import { expect, test } from "bun:test";
import { managedNames, ownershipConflicts } from "./adopt";
import { FIXTURES } from "./fixtures";

test("names the repository declares are never the kit's to replace", () => {
  expect(managedNames(FIXTURES.full).has("COOKIE_SECRET")).toBe(true);
  const managed = managedNames(FIXTURES.full, new Set(["PERSONALITY_SECRET", "VITE_RUNTIME"]));
  expect(managed.has("VITE_RUNTIME")).toBe(false);
  expect(managed.has("PERSONALITY_SECRET")).toBe(false);
  expect(managed.has("COOKIE_SECRET")).toBe(true);
  expect(managed.has("APP_ENV")).toBe(true);
});

test("a name in the settings and in the repository is a conflict, whichever kind it is in the settings", () => {
  const owned = new Set(["COOKIE_SECRET", "SMTP_URL", "VITE_RUNTIME", "PUBLIC_BOT"]);
  expect(ownershipConflicts(FIXTURES.full, owned).sort()).toEqual(["COOKIE_SECRET", "SMTP_URL", "VITE_RUNTIME"]);
  expect(ownershipConflicts(FIXTURES.minimal, owned)).toEqual([]);
});
