"use client";

/**
 * Cohere interaction primitives.
 *
 * Everything interactive in the Cohere theme is built on Adobe React Aria
 * Components (RAC) so keyboard, focus, press and disabled semantics come from
 * one implementation instead of ad-hoc click handlers.
 *
 * Rules (see design-md/cohere/UI-PARADIGM.md):
 * - Never re-implement hover/press/focus with JS. Style `data-hovered`,
 *   `data-pressed`, `data-selected`, `data-focus-visible`, `data-disabled`.
 * - New Cohere controls must be added here, not inline in page components.
 */

import { Button, ToggleButton, ToggleButtonGroup } from "react-aria-components";

function classes(...values) {
  return values.filter(Boolean).join(" ");
}

/**
 * Text button. tone: primary | quiet | ghost. size: md | lg.
 */
export function CohereButton({
  className,
  isDisabled = false,
  size = "md",
  tone = "quiet",
  type = "button",
  ...props
}) {
  return (
    <Button
      {...props}
      className={classes("c-btn", `c-btn--${tone}`, size === "lg" && "c-btn--lg", className)}
      isDisabled={isDisabled}
      type={type}
    />
  );
}

/**
 * Segmented control. Single selection, never empty.
 * options: [{ id, label }]
 */
export function CohereSegmented({ className, label, onChange, options, value }) {
  return (
    <ToggleButtonGroup
      aria-label={label}
      className={classes("c-seg", className)}
      disallowEmptySelection
      onSelectionChange={(keys) => {
        const [next] = Array.from(keys);

        if (next !== undefined) {
          onChange(String(next));
        }
      }}
      selectedKeys={new Set([value])}
      selectionMode="single"
    >
      {options.map((option) => (
        <ToggleButton className="c-seg-item" id={option.id} key={option.id}>
          {option.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

/**
 * Toggle chip used for keyword-search platform selection.
 */
export function CohereChip({ children, className, dotColor, isDisabled = false, isSelected, onChange }) {
  return (
    <ToggleButton
      className={classes("c-chip", className)}
      isDisabled={isDisabled}
      isSelected={isSelected}
      onChange={onChange}
    >
      {dotColor ? (
        <span aria-hidden="true" className="c-chip-dot" style={{ backgroundColor: dotColor }} />
      ) : null}
      {children}
    </ToggleButton>
  );
}

/**
 * Small square control for icons inside a field (e.g. clear input).
 */
export function CohereFieldButton({ className, label, ...props }) {
  return (
    <Button
      {...props}
      aria-label={label}
      className={classes("c-field-clear", className)}
      type="button"
    />
  );
}
