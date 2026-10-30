import { describe, expect, it } from "vitest";
import { passwordToggle } from "./password-field";

describe("passwordToggle", () => {
  it("starts hidden: a password field with a button that offers to show it", () => {
    expect(passwordToggle(false, "Current password")).toEqual({ inputType: "password", buttonText: "Show password", buttonName: "Show password: Current password" });
  });
  it("when shown the field is text and the button offers to hide it", () => {
    expect(passwordToggle(true, "Current password")).toEqual({ inputType: "text", buttonText: "Hide password", buttonName: "Hide password: Current password" });
  });
  it("the accessible name starts with the visible text, and names the field", () => {
    for (const visible of [true, false]) {
      const t = passwordToggle(visible, "New password");
      expect(t.buttonName.startsWith(t.buttonText)).toBe(true);
      expect(t.buttonName).toContain("New password");
    }
  });
});
