import { describe, expect, test } from "bun:test";
import type { Adoption } from "./adopt";
import { createsProjectFirst, PROJECT_ADDRESS } from "./commands/apply";

const adoption = (imports: Adoption["imports"] = {}): Adoption => ({ imports, conflicts: [], integrations: [] });
const DOMAIN = "module.platform.vercel_project_domain.production";

describe("createsProjectFirst", () => {
  test("a project that exists nowhere is created alone first, so its default domain can be adopted", () => {
    expect(createsProjectFirst(adoption(), new Set())).toBe(true);
  });

  test("a project in the state applies in one go", () => {
    expect(createsProjectFirst(adoption(), new Set([PROJECT_ADDRESS, DOMAIN]))).toBe(false);
  });

  test("a project on Vercel but not in the state is adopted, with its domains, in one go", () => {
    expect(createsProjectFirst(adoption({ [PROJECT_ADDRESS]: "team/prj", [DOMAIN]: "team/prj/app.vercel.app" }), new Set())).toBe(false);
  });
});
