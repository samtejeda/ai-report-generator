"use client";

import { useId, useState } from "react";
import { passwordToggle } from "@/lib/auth/password-field";
import { useResetWhenHidden } from "@/lib/ui/reset-when-hidden";
import { fieldClass } from "./auth-card";

// A password input with a "Show password" button. The field is type="password" until the button is
// pressed; the choice is this component's state only (never stored) and goes back to hidden when
// the page is hidden, so a revealed password is not left showing in a page Next keeps alive.
export function PasswordField({
  label,
  hint,
  name,
  autoComplete,
  required = true,
  minLength,
  maxLength,
}: {
  label: string;
  /** Extra words after the label, e.g. "(12 to 128 characters)". Not part of the button's name. */
  hint?: string;
  name: string;
  autoComplete: "current-password" | "new-password";
  required?: boolean;
  minLength?: number;
  maxLength?: number;
}) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  useResetWhenHidden(() => setVisible(false));
  const toggle = passwordToggle(visible, label);
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label htmlFor={id}>{hint ? `${label} ${hint}` : label}</label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          name={name}
          type={toggle.inputType}
          autoComplete={autoComplete}
          required={required}
          minLength={minLength}
          maxLength={maxLength}
          className={`${fieldClass} min-w-0 flex-1`}
        />
        <button type="button" className="shrink-0 underline" onClick={() => setVisible((v) => !v)} aria-label={toggle.buttonName} aria-controls={id}>
          {toggle.buttonText}
        </button>
      </div>
    </div>
  );
}
