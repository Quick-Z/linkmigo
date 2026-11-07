/**
 * Cohere surface tokens.
 *
 * Scope: ONLY consumed when `themeName === "cohere"`. The default theme reads
 * `colorModeTokens` + `buttonThemes` and never touches this file.
 *
 * Normative reference: design-md/cohere/UI-PARADIGM.md
 * - Material: Apple HIG — every surface is a translucent gradient layer with a
 *   long blur behind it, so the aurora underneath tints the glass.
 * - Colour: Adobe Spectrum 2 gray scale; one functional blue for focus only.
 * - Shape: one radius scale (6 / 8 / 10 / 12 / 18 / pill), no ad-hoc radii.
 *
 * Values here feed the shared `build*Style()` helpers (inline styles). The
 * `.c-*` layer in cohere.css owns the shells; keep the two in sync.
 */

const light = {
  // Canvas + text
  pageBackground: "#dfe3ec",
  pageText: "#1d1d1f",
  titleText: "#0d0d0f",
  bodyText: "#1d1d1f",
  mutedText: "#6e6e73",
  subtleText: "#8e8e93",
  placeholderText: "#a1a1a6",

  // Structure
  panelBorder: "rgba(0,0,0,0.08)",
  panelClass: "",
  pageBackdrop: "radial-gradient(115% 90% at 4% -10%, #f4f7ff 0%, rgba(244,247,255,0) 58%), radial-gradient(85% 70% at 100% 4%, #f7f2ff 0%, rgba(247,242,255,0) 52%), radial-gradient(70% 60% at 60% 110%, #eefaf7 0%, rgba(238,250,247,0) 60%), linear-gradient(162deg, #e9ecf5 0%, #e2e5ee 46%, #d9dce6 100%)",
  glowA: "rgba(96,140,255,0.34)",
  glowB: "rgba(167,130,255,0.24)",
  glowC: "rgba(74,214,196,0.18)",

  // Materials — translucent gradient glass, never a flat white plate
  glassGradient: "linear-gradient(180deg, rgba(255,255,255,0.86) 0%, rgba(250,252,255,0.62) 100%)",
  glassGradientSoft: "linear-gradient(180deg, rgba(255,255,255,0.78) 0%, rgba(244,247,253,0.50) 100%)",
  resultGradient: "linear-gradient(172deg, rgba(255,255,255,0.72) 0%, rgba(240,244,251,0.42) 100%)",

  // Chips / labels
  chipText: "#3a3a3c",
  chipBackground: "rgba(255,255,255,0.42)",
  chipBorder: "rgba(255,255,255,0.58)",
  chipShadow: "inset 0 0.5px 0 rgba(255,255,255,0.9)",

  // Inputs
  inputText: "#0d0d0f",
  invalidBackground: "rgba(255,245,245,0.80)",
  invalidText: "#c9252d",

  // Cards
  cardBackground: "rgba(255,255,255,0.46)",
  cardGradient: "linear-gradient(180deg, rgba(255,255,255,0.64) 0%, rgba(245,249,255,0.30) 100%)",
  cardBorder: "rgba(255,255,255,0.62)",
  cardShadow: "0 1px 2px rgba(30,40,60,0.06), 0 0 0 0.5px rgba(30,40,60,0.04)",

  // Disabled
  disabledBackground: "rgba(255,255,255,0.28)",
  disabledBorder: "rgba(0,0,0,0.06)",
  disabledText: "#a1a1a6",

  // Misc surfaces
  iconBackground: "rgba(255,255,255,0.50)",
  mediaOverlay: "rgba(0,0,0,0.04)",
  modalHeaderBackground: "rgba(255,255,255,0.72)",
  modalPanelBackground: "rgba(250,252,255,0.74)",
  selectionBackground: "rgba(20,115,230,0.12)",
  modalButtonBackground: "rgba(255,255,255,0.60)",
  modalButtonText: "#1d1d1f",
  previewBackdropOverlay: "radial-gradient(circle at center, rgba(20,30,50,0.34), rgba(10,16,28,0.66) 72%)",
  previewBackdropVeil: "linear-gradient(135deg, rgba(20,30,50,0.18) 0%, rgba(20,30,50,0.30) 48%, rgba(10,16,28,0.58) 100%)",
  toolbarBackground: "rgba(255,255,255,0.62)",
  toolbarText: "#1d1d1f",

  // Semantic
  accent: "#1d1d1f",
  accentStrong: "#000000",
  accentText: "#1d1d1f",
  accentMuted: "#6e6e73",
  buttonText: "#ffffff",
  border: "rgba(0,0,0,0.10)",
  borderStrong: "rgba(0,0,0,0.18)",
  ring: "rgba(20,115,230,0.30)",

  // Elevation
  panelShadow: "0 18px 44px -18px rgba(34,45,66,0.20)",
  buttonShadow: "0 1px 2px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.14)",
  selectedShadow: "0 0 0 1.5px rgba(20,115,230,0.60)",

  // Legacy helpers kept for the shared builders
  glassEnd: "rgba(250,252,255,0.62)",
  cardEnd: "rgba(245,249,255,0.30)",
  buttonGradient: "linear-gradient(180deg,#3d3d46 0%,#141419 100%)",
  progressGradient: "linear-gradient(90deg,#1d1d1f 0%,#48484a 100%)",
  skeletonGradient: "linear-gradient(90deg, rgba(255,255,255,0.20) 0%, rgba(255,255,255,0.70) 50%, rgba(255,255,255,0.20) 100%)",
  previewGradient: "linear-gradient(160deg, rgba(238,242,250,0.90) 0%, rgba(228,234,246,0.90) 100%)",
  mediaTint: "rgba(255,255,255,0.72)",
};

const dark = {
  pageBackground: "#1b1d24",
  pageText: "#eef1f7",
  titleText: "#ffffff",
  bodyText: "#eef1f7",
  mutedText: "#b6bcc9",
  subtleText: "#9aa2b2",
  placeholderText: "#9aa2b2",

  panelBorder: "rgba(255,255,255,0.12)",
  panelClass: "",
  pageBackdrop: "radial-gradient(100% 80% at 8% -10%, #26304d 0%, rgba(38,48,77,0) 58%), radial-gradient(80% 70% at 96% 2%, #35264d 0%, rgba(53,38,77,0) 52%), radial-gradient(70% 60% at 50% 108%, #1b3a3c 0%, rgba(27,58,60,0) 58%), linear-gradient(180deg, #24262f 0%, #1b1d24 58%, #14161b 100%)",
  glowA: "rgba(74,122,255,0.26)",
  glowB: "rgba(146,104,255,0.22)",
  glowC: "rgba(52,196,196,0.16)",

  glassGradient: "linear-gradient(180deg, rgba(68,74,92,0.58) 0%, rgba(42,46,58,0.52) 100%)",
  glassGradientSoft: "linear-gradient(180deg, rgba(74,81,100,0.54) 0%, rgba(46,50,62,0.48) 100%)",
  resultGradient: "linear-gradient(172deg, rgba(58,63,78,0.55) 0%, rgba(36,39,49,0.60) 100%)",

  chipText: "#d5dae4",
  chipBackground: "rgba(150,160,186,0.18)",
  chipBorder: "rgba(255,255,255,0.12)",
  chipShadow: "inset 0 0.5px 0 rgba(255,255,255,0.08)",

  inputText: "#ffffff",
  invalidBackground: "rgba(96,34,32,0.55)",
  invalidText: "#ff8a84",

  cardBackground: "rgba(60,66,82,0.46)",
  cardGradient: "linear-gradient(180deg, rgba(68,75,92,0.54) 0%, rgba(48,53,66,0.46) 100%)",
  cardBorder: "rgba(255,255,255,0.10)",
  cardShadow: "0 1px 2px rgba(0,0,0,0.28)",

  disabledBackground: "rgba(150,160,186,0.16)",
  disabledBorder: "rgba(255,255,255,0.08)",
  disabledText: "#828a9b",

  iconBackground: "rgba(150,160,186,0.20)",
  mediaOverlay: "rgba(0,0,0,0.20)",
  modalHeaderBackground: "rgba(50,55,68,0.70)",
  modalPanelBackground: "rgba(46,50,62,0.72)",
  selectionBackground: "rgba(55,142,240,0.20)",
  modalButtonBackground: "rgba(150,160,186,0.22)",
  modalButtonText: "#f4f6fa",
  previewBackdropOverlay: "radial-gradient(circle at center, rgba(0,0,0,0.42), rgba(0,0,0,0.72) 72%)",
  previewBackdropVeil: "linear-gradient(135deg, rgba(0,0,0,0.24) 0%, rgba(0,0,0,0.36) 48%, rgba(0,0,0,0.62) 100%)",
  toolbarBackground: "rgba(50,55,68,0.70)",
  toolbarText: "#f4f6fa",

  accent: "#f4f6fa",
  accentStrong: "#ffffff",
  accentText: "#f4f6fa",
  accentMuted: "#b6bcc9",
  buttonText: "#1d1d1f",
  border: "rgba(255,255,255,0.14)",
  borderStrong: "rgba(255,255,255,0.24)",
  ring: "rgba(55,142,240,0.45)",

  panelShadow: "0 22px 55px -22px rgba(0,0,0,0.60)",
  buttonShadow: "inset 0 1px 0 rgba(255,255,255,0.55), 0 1px 2px rgba(0,0,0,0.40)",
  selectedShadow: "0 0 0 1.5px rgba(55,142,240,0.70)",

  glassEnd: "rgba(42,46,58,0.52)",
  cardEnd: "rgba(48,53,66,0.46)",
  buttonGradient: "linear-gradient(180deg,#ffffff 0%,#dde0e8 100%)",
  progressGradient: "linear-gradient(90deg,#f4f6fa 0%,#9aa2b2 100%)",
  skeletonGradient: "linear-gradient(90deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.14) 50%, rgba(255,255,255,0.04) 100%)",
  previewGradient: "linear-gradient(160deg, rgba(50,55,68,0.90) 0%, rgba(38,42,52,0.90) 100%)",
  mediaTint: "rgba(45,49,61,0.72)",
};

export const cohereThemeTokens = { light, dark };
