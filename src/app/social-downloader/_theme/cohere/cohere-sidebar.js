"use client";

/**
 * Cohere sidebar — the only place the search controls live in this theme.
 *
 * Layout contract (design-md/cohere/UI-PARADIGM.md §3):
 *   title → field → primary action → platform chips
 *   … flex spacer …
 *   footer: language + appearance segmented controls
 *
 * No eyebrow row and no marketing subtitle: the sidebar opens straight on the
 * product name. Keep it that way — the paradigm forbids re-adding filler labels.
 *
 * The input is a 1-row textarea that grows to fit long URLs (max ~4 lines), so a
 * pasted permalink stays readable instead of being clipped at the first fold.
 */

import { useEffect, useRef } from "react";

import { CohereButton, CohereChip, CohereFieldButton, CohereSegmented } from "./controls";

const MIN_INPUT_HEIGHT = 22;
const MAX_INPUT_HEIGHT = 92;

function SearchGlyph({ className }) {
  return (
    <svg aria-hidden="true" className={className} fill="none" height="15" viewBox="0 0 16 16" width="15">
      <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.4 10.4 13.5 13.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.3" />
    </svg>
  );
}

function ClearGlyph() {
  return (
    <svg aria-hidden="true" fill="none" height="10" viewBox="0 0 10 10" width="10">
      <path d="m2 2 6 6M8 2l-6 6" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
    </svg>
  );
}

export function CohereSidebar({
  appName,
  canSubmit,
  colorMode,
  copy,
  hasResult,
  isInputFocused,
  isInvalid,
  isKeywordMode,
  isLoading,
  language,
  loginLabel,
  onClearUrl,
  onColorModeChange,
  onInputBlur,
  onInputFocus,
  onLanguageChange,
  onOpenPlatformLogin,
  onReset,
  onSubmit,
  onTogglePlatform,
  onUrlChange,
  placeholder,
  platformChips,
  showLogin,
  url,
}) {
  const isZh = language === "zh";
  const inputRef = useRef(null);

  // Grow with the content so long permalinks wrap instead of scrolling sideways.
  useEffect(() => {
    const input = inputRef.current;

    if (!input) {
      return;
    }

    input.style.height = "auto";
    const next = Math.min(Math.max(input.scrollHeight, MIN_INPUT_HEIGHT), MAX_INPUT_HEIGHT);
    input.style.height = `${next}px`;
    input.style.overflowY = input.scrollHeight > MAX_INPUT_HEIGHT ? "auto" : "hidden";
  }, [url]);

  function handleKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();

      if (canSubmit && !isLoading) {
        event.currentTarget.form?.requestSubmit();
      }
    }
  }

  return (
    <aside className="c-sidebar">
      <div className="c-sidebar-body">
        <h1 className="c-title">{appName}</h1>

        <form className="c-form" noValidate onSubmit={onSubmit}>
          <label className="sr-only" htmlFor="social-url">
            {copy.urlLabel}
          </label>

          <div className="c-field" data-focused={isInputFocused ? "" : undefined} data-invalid={isInvalid ? "" : undefined}>
            <SearchGlyph className="c-field-icon" />
            <textarea
              aria-describedby={isInvalid ? "social-url-error" : undefined}
              aria-invalid={Boolean(isInvalid)}
              autoCapitalize="none"
              autoComplete="off"
              className="c-input"
              id="social-url"
              name="social-url"
              onBlur={onInputBlur}
              onChange={onUrlChange}
              onFocus={onInputFocus}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              ref={inputRef}
              rows={1}
              spellCheck={false}
              value={url}
              wrap="soft"
            />
            {url ? (
              <CohereFieldButton label={copy.clearUrl} onPress={onClearUrl}>
                <ClearGlyph />
              </CohereFieldButton>
            ) : null}
          </div>

          {isInvalid ? (
            <span className="c-form-note" id="social-url-error">
              {copy.invalidUrl}
            </span>
          ) : null}

          <CohereButton
            className="c-btn--block"
            isDisabled={!canSubmit || isLoading}
            size="lg"
            tone="primary"
            type="submit"
          >
            {isLoading ? (
              <>
                <span aria-hidden="true" className="c-spinner" />
                {isKeywordMode ? (isZh ? "搜索中..." : "Searching...") : copy.parsing}
              </>
            ) : (
              copy.search
            )}
          </CohereButton>

          {showLogin ? (
            <CohereButton className="c-btn--block" tone="quiet" onPress={onOpenPlatformLogin}>
              {loginLabel}
            </CohereButton>
          ) : null}

          {hasResult ? (
            <CohereButton className="c-btn--block" tone="ghost" onPress={onReset}>
              {copy.reset}
            </CohereButton>
          ) : null}
        </form>

        {isKeywordMode ? (
          <div className="c-platforms">
            <span className="c-field-label">{copy.searchPlatform}</span>
            <div className="c-chip-row">
              {platformChips.map((platform) => (
                <CohereChip
                  dotColor={platform.color}
                  isDisabled={!platform.enabled}
                  isSelected={platform.selected}
                  key={platform.id}
                  onChange={() => onTogglePlatform(platform.id)}
                >
                  {platform.label}
                </CohereChip>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="c-sidebar-foot">
        <CohereSegmented
          label={copy.language}
          onChange={onLanguageChange}
          options={[
            { id: "zh", label: "中文" },
            { id: "en", label: "EN" },
          ]}
          value={language}
        />
        <CohereSegmented
          label={copy.preferences}
          onChange={onColorModeChange}
          options={[
            { id: "light", label: copy.lightMode },
            { id: "dark", label: copy.darkMode },
          ]}
          value={colorMode}
        />
      </div>
    </aside>
  );
}
