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

import { Button, Menu, MenuItem, ToggleButton, ToggleButtonGroup } from "react-aria-components";

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

/**
 * Action menu. RAC owns arrow keys, typeahead, focus and press semantics.
 * items: [{ id, label, hint, iconId? }]
 */
export function CohereActionMenu({ className, items, label, onAction }) {
  return (
    <Menu
      aria-label={label}
      className={classes("c-menu", className)}
      onAction={(key) => onAction?.(String(key))}
    >
      {items.map((item) => (
        <MenuItem
          className="c-menu-item"
          id={item.id}
          isDisabled={Boolean(item.disabled)}
          key={item.id}
          textValue={item.label}
        >
          {item.iconId ? <MenuIcon id={item.iconId} /> : null}
          <span className="c-menu-item-body">
            <span className="c-menu-item-label">{item.label}</span>
            <span className="c-menu-item-hint">{item.hint}</span>
          </span>
          <ChevronRightIcon />
        </MenuItem>
      ))}
    </Menu>
  );
}

function MenuIcon({ id }) {
  if (id === "zip") {
    return (
      <svg aria-hidden="true" className="c-menu-item-icon" fill="none" viewBox="0 0 24 24">
        <rect height="4" rx="1.4" stroke="currentColor" strokeWidth="2" width="18" x="3" y="4" />
        <path d="M5 8v10.2A1.8 1.8 0 0 0 6.8 20h10.4a1.8 1.8 0 0 0 1.8-1.8V8" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
        <path d="M10 12.5h4" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
      </svg>
    );
  }

  if (id === "images") {
    return (
      <svg aria-hidden="true" className="c-menu-item-icon" fill="none" viewBox="0 0 24 24">
        <path d="M8.5 7V5.8A1.8 1.8 0 0 1 10.3 4h8.9A1.8 1.8 0 0 1 21 5.8v8.9a1.8 1.8 0 0 1-1.8 1.8H18" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
        <rect height="12" rx="1.8" stroke="currentColor" strokeWidth="2" width="15" x="3" y="8" />
        <path d="m6.5 16.8 2.8-2.8a1.1 1.1 0 0 1 1.6 0l2.3 2.3 1.1-1.1a1.1 1.1 0 0 1 1.6 0l1.6 1.6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
        <circle cx="7.8" cy="11.6" fill="currentColor" r="1.1" />
      </svg>
    );
  }

  if (id === "photos") {
    return (
      <svg aria-hidden="true" className="c-menu-item-icon" fill="none" viewBox="0 0 24 24">
        <rect height="16" rx="2.4" stroke="currentColor" strokeWidth="2" width="20" x="2" y="4" />
        <path d="m4.5 17 4.3-4.3a1.4 1.4 0 0 1 2 0l3.2 3.2 2-2a1.4 1.4 0 0 1 2 0l2.5 2.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
        <circle cx="16.4" cy="8.6" fill="currentColor" r="1.4" />
      </svg>
    );
  }

  return null;
}

function ChevronRightIcon() {
  return (
    <svg aria-hidden="true" className="c-menu-item-chevron" fill="none" viewBox="0 0 16 16">
      <path d="m6 3.5 4.5 4.5L6 12.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
    </svg>
  );
}
