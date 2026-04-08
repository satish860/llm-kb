import { describe, it, expect } from "vitest";
import { checkAuth } from "../src/auth.js";

describe("checkAuth", () => {
  it("returns ollama by default", () => {
    const result = checkAuth();
    expect(result.ok).toBe(true);
    if (result.ok) {
        expect(result.method).toBe("ollama");
        expect(result.authStorage).toBeDefined();
    }
  });
});
