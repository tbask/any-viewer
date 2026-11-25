/**
 * Viewer styles. They live inside the Shadow DOM and do not interfere with application styles.
 * Colours are configured from outside through the --fv-* CSS variables on the container element.
 */
export const STYLES = /* css */ `
:host {
  display: block;
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 120px;
  color-scheme: light dark;
  --_bg: var(--fv-bg, #f1f3f5);
  --_surface: var(--fv-surface, #ffffff);
  --_text: var(--fv-text, #1f2328);
  --_muted: var(--fv-muted, #6b7280);
  --_border: var(--fv-border, #d9dde3);
  --_accent: var(--fv-accent, #2563eb);
  --_bar-bg: var(--fv-bar-bg, #ffffff);
  --_notice-bg: var(--fv-notice-bg, #fff7e0);
  --_notice-text: var(--fv-notice-text, #6b4e00);
  --_head-bg: var(--fv-head-bg, #f6f7f9);
  --_font: var(--fv-font, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  --_mono: var(--fv-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace);
}
@media (prefers-color-scheme: dark) {
  :host {
    --_bg: var(--fv-bg, #16181c);
    --_surface: var(--fv-surface, #1f2227);
    --_text: var(--fv-text, #e6e8eb);
    --_muted: var(--fv-muted, #9aa1ab);
    --_border: var(--fv-border, #343840);
    --_accent: var(--fv-accent, #6ea0ff);
    --_bar-bg: var(--fv-bar-bg, #1f2227);
    --_notice-bg: var(--fv-notice-bg, #3a3115);
    --_notice-text: var(--fv-notice-text, #f1dc9c);
    --_head-bg: var(--fv-head-bg, #262a30);
  }
}
* { box-sizing: border-box; }
.fv {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: var(--_bg);
  color: var(--_text);
  font: 14px/1.45 var(--_font);
  overflow: hidden;
  -webkit-text-size-adjust: 100%;
}
.fv-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 44px;
  padding: 4px 8px 4px 12px;
  background: var(--_bar-bg);
  border-bottom: 1px solid var(--_border);
}
.fv-bar[hidden], .fv-notice[hidden], .fv-overlay[hidden], .fv-zoom[hidden], .fv-pages[hidden], .fv-grid-detail[hidden] { display: none; }
.fv-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.fv-pages { flex: none; color: var(--_muted); font-variant-numeric: tabular-nums; margin-right: 6px; white-space: nowrap; }
.fv-zoom { flex: none; display: flex; align-items: center; gap: 2px; }
.fv-zoom-label { min-width: 46px; text-align: center; color: var(--_muted); font-variant-numeric: tabular-nums; font-size: 13px; }
.fv-btn {
  flex: none;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.fv-btn svg { display: block; margin: auto; }
.fv-btn[hidden] { display: none; }
.fv-actions { flex: none; display: flex; align-items: center; gap: 2px; }
.fv-btn:hover { background: color-mix(in srgb, var(--_text) 9%, transparent); }
.fv-btn:active { background: color-mix(in srgb, var(--_text) 16%, transparent); }
.fv-btn:focus-visible, .fv-text:focus-visible, .fv-grid:focus-visible, .fv-pdf:focus-visible { outline: 2px solid var(--_accent); outline-offset: -2px; }
.fv-notice {
  flex: none;
  padding: 6px 12px;
  background: var(--_notice-bg);
  color: var(--_notice-text);
  font-size: 13px;
  border-bottom: 1px solid var(--_border);
}
.fv-stage { position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden; }
.fv-stage > *, .fv-host > * { position: absolute; inset: 0; }
.fv-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  text-align: center;
  background: var(--_bg);
  color: var(--_muted);
}
.fv-overlay-title { color: var(--_text); font-weight: 600; font-size: 16px; }
.fv-spinner {
  width: 28px;
  height: 28px;
  border: 3px solid var(--_border);
  border-top-color: var(--_accent);
  border-radius: 50%;
  animation: fv-spin 0.8s linear infinite;
}
@keyframes fv-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .fv-spinner { animation-duration: 2.4s; } }
.fv-empty { display: flex; align-items: center; justify-content: center; color: var(--_muted); }

/* --- images --- */
.fv-panzoom { overflow: hidden; touch-action: none; cursor: grab; user-select: none; -webkit-user-select: none; }
.fv-panzoom:active { cursor: grabbing; }
.fv-image {
  position: absolute;
  left: 0;
  top: 0;
  max-width: none;
  transform-origin: 0 0;
  will-change: transform;
  -webkit-touch-callout: none;
  -webkit-user-drag: none;
  /* checkerboard under transparent images */
  background: repeating-conic-gradient(#d7d9dd 0% 25%, #f4f5f6 0% 50%) 0 0 / 16px 16px;
}

/* --- text --- */
.fv-text {
  overflow: auto;
  padding: 12px 16px;
  background: var(--_surface);
  font-family: var(--_mono);
  line-height: 1.5;
  tab-size: 4;
  -webkit-overflow-scrolling: touch;
}
.fv-text-chunk {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  content-visibility: auto;
  contain-intrinsic-size: auto 450em;
}

/* --- table --- */
.fv-grid-wrap { display: flex; flex-direction: column; background: var(--_surface); font-family: var(--_font); }
.fv-grid { position: relative; flex: 1 1 auto; min-height: 0; overflow: auto; -webkit-overflow-scrolling: touch; }
.fv-grid-head {
  position: sticky;
  top: 0;
  z-index: 3;
  background: var(--_head-bg);
  border-bottom: 1px solid var(--_border);
  color: var(--_muted);
}
.fv-grid-colhead {
  position: absolute;
  top: 0;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  border-right: 1px solid var(--_border);
  font-size: 0.92em;
}
.fv-grid-corner {
  position: sticky;
  left: 0;
  z-index: 1;
  height: 100%;
  background: var(--_head-bg);
  border-right: 1px solid var(--_border);
}
.fv-grid-body { position: relative; }
.fv-grid[hidden], .fv-grid-empty[hidden], .fv-tabs[hidden] { display: none; }
.fv-grid-empty { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; color: var(--_muted); }
.fv-grid-rows, .fv-grid-merges { position: absolute; inset: 0; }
.fv-grid-merges { z-index: 1; pointer-events: none; }
.fv-grid-cell.fv-merged { pointer-events: auto; background: var(--_surface); border-bottom: 1px solid var(--_border); }
/* Styled workbooks are shown on light "paper" regardless of the theme. */
.fv-paper {
  --_surface: #ffffff;
  --_text: #1f2328;
  --_muted: #6b7280;
  --_border: #d9dde3;
  --_head-bg: #f6f7f9;
  --_bar-bg: #ffffff;
  --_accent: #2563eb;
  color: var(--_text);
  color-scheme: light;
}
.fv-tabs {
  flex: none;
  display: flex;
  gap: 2px;
  overflow-x: auto;
  padding: 4px 8px 0;
  background: var(--_head-bg);
  border-top: 1px solid var(--_border);
  scrollbar-width: none;
}
.fv-tab {
  flex: none;
  max-width: 220px;
  padding: 7px 14px;
  border: 1px solid transparent;
  border-bottom: 0;
  border-radius: 8px 8px 0 0;
  background: transparent;
  color: var(--_muted);
  font: inherit;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.fv-tab:hover { color: var(--_text); }
.fv-tab-active { background: var(--_surface); border-color: var(--_border); color: var(--_text); font-weight: 600; }
.fv-grid-row {
  position: absolute;
  left: 0;
  width: 100%;
  height: var(--fv-row-h);
  border-bottom: 1px solid var(--_border);
}
.fv-grid-rownum {
  position: sticky;
  left: 0;
  z-index: 2;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--_head-bg);
  border-right: 1px solid var(--_border);
  color: var(--_muted);
  font-size: 0.92em;
  font-variant-numeric: tabular-nums;
}
.fv-grid-cell {
  position: absolute;
  top: 0;
  height: 100%;
  padding: 0 8px;
  line-height: var(--fv-row-h);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  border-right: 1px solid var(--_border);
  cursor: default;
}
.fv-grid-cell.fv-wrap { display: flex; line-height: 1.25; padding-top: 2px; padding-bottom: 2px; white-space: normal; }
.fv-grid-wraptext { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 100%; overflow: hidden; }
.fv-grid-icon { margin-right: 4px; font-weight: 700; }
.fv-grid-cell.fv-noted::after { content: ''; position: absolute; top: 0; right: 0; border: 4px solid transparent; border-top-color: #d8392b; border-right-color: #d8392b; }
.fv-grid-objects { position: absolute; inset: 0; z-index: 2; pointer-events: none; }
.fv-grid-object { position: absolute; overflow: hidden; }
.fv-grid-object img { width: 100%; height: 100%; display: block; }
.fv-grid-shape { display: flex; align-items: center; justify-content: center; text-align: center; padding: 4px; box-sizing: border-box; white-space: pre-wrap; font-size: 0.95em; }
.fv-grid-detail-note { display: block; margin-top: 6px; padding: 6px 8px; border-left: 3px solid #d8392b; background: color-mix(in srgb, #d8392b 8%, transparent); }
.fv-grid-cell.fv-overflow { border-right-color: transparent; background: var(--_surface); z-index: 1; }
.fv-grid-cell.fv-bordered { z-index: 1; }
.fv-grid-cell.fv-num { text-align: right; font-variant-numeric: tabular-nums; }
.fv-grid-cell.fv-selected { outline: 2px solid var(--_accent); outline-offset: -2px; }
.fv-grid-detail {
  flex: none;
  display: flex;
  gap: 10px;
  max-height: 30%;
  overflow: auto;
  padding: 8px 12px;
  border-top: 1px solid var(--_border);
  background: var(--_bar-bg);
  font-size: 14px;
}
.fv-grid-detail-ref { flex: none; color: var(--_muted); font-variant-numeric: tabular-nums; }
.fv-grid-detail-text { white-space: pre-wrap; overflow-wrap: anywhere; }

/* --- text documents --- */
.fv-doc { overflow: auto; background: var(--fv-bg, #e9ecef); padding: 12px 8px; -webkit-overflow-scrolling: touch; }
.fv-doc-page {
  box-sizing: border-box;
  max-width: 612pt;
  margin: 0 auto;
  padding: 36pt min(72pt, 9%);
  background: #ffffff;
  color: #1f2328;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
  font: 11pt/1.4 "Times New Roman", Times, "Liberation Serif", serif;
  overflow-wrap: break-word;
  min-height: 60%;
}
.fv-doc-section { content-visibility: auto; contain-intrinsic-size: auto 900px; }
.fv-doc-p, .fv-doc-h { margin: 0; white-space: pre-wrap; }
/* The document itself sets the heading weight: the "Title" style in Word, for example, is not bold. */
.fv-doc-h { font-weight: 400; line-height: 1.25; }
h1.fv-doc-h { font-size: 1.6em; margin: 0.5em 0 0.3em; }
h2.fv-doc-h { font-size: 1.35em; margin: 0.5em 0 0.3em; }
h3.fv-doc-h { font-size: 1.15em; margin: 0.4em 0 0.2em; }
h4.fv-doc-h, h5.fv-doc-h, h6.fv-doc-h { font-size: 1em; margin: 0.4em 0 0.2em; }
.fv-doc-li { text-indent: 0; }
.fv-doc-marker { display: inline-block; min-width: 1.4em; margin-left: -1.6em; padding-right: 0.2em; text-align: right; white-space: nowrap; }
.fv-doc-tab { display: inline-block; min-width: 2.5em; white-space: pre; }
.fv-doc-mono { font-family: var(--_mono); }
.fv-doc-h > .fv-doc-marker { margin-left: 0; min-width: 0; padding-right: 0.35em; text-align: left; }
.fv-doc-link { color: #1d4ed8; text-decoration: underline; }
.fv-doc-img { max-width: 100%; height: auto; vertical-align: bottom; -webkit-touch-callout: none; }
.fv-doc-noimg { display: inline-block; padding: 6px 10px; border: 1px dashed #c5cad1; border-radius: 6px; color: #9aa1ab; }
.fv-doc-break { border: 0; border-top: 1px dashed #c5cad1; margin: 18pt -4%; }
.fv-doc-rule { display: flex; align-items: center; gap: 8px; margin: 14pt 0 6pt; color: #6b7280; font: 12px/1.3 var(--_font); }
.fv-doc-rule::after { content: ''; flex: 1; border-top: 1px solid #c5cad1; }
.fv-doc-rule-label { flex: none; text-transform: uppercase; letter-spacing: 0.04em; }
.fv-doc-chart, .fv-doc-canvas { position: relative; max-width: 100%; margin: 6pt 0; }
.fv-doc-canvas { overflow: hidden; }
.fv-doc-canvas-stage { position: absolute; left: 0; top: 0; transform-origin: 0 0; font: 11pt/1.2 Calibri, Arial, sans-serif; }
.fv-doc-watermark { position: sticky; bottom: 0; left: 0; height: 0; pointer-events: none; z-index: 1; }
.fv-doc-watermark span { position: absolute; left: 50%; bottom: 40vh; transform: translate(-50%, 50%) rotate(-40deg); white-space: nowrap; font: 700 min(9vw, 64px) Arial, sans-serif; color: rgba(128, 128, 128, 0.22); }
.fv-math { display: inline-flex; align-items: center; vertical-align: middle; font-family: "Cambria Math", "STIX Two Math", "Latin Modern Math", Cambria, "Times New Roman", serif; font-size: 1.3em; line-height: 1.2; margin: 0.15em 0; }
.fv-math-row { display: inline-flex; align-items: center; }
.fv-math-t { font-style: italic; white-space: pre; }
.fv-math-up { white-space: pre; }
.fv-math-frac { display: inline-flex; flex-direction: column; align-items: center; margin: 0 0.18em; }
.fv-math-num { padding: 0 0.25em 0.05em; border-bottom: 1px solid currentColor; display: flex; justify-content: center; align-self: stretch; }
.fv-math-den { padding: 0.05em 0.25em 0; display: flex; justify-content: center; }
.fv-math-scripts { display: inline-flex; flex-direction: column; justify-content: space-between; align-self: stretch; font-size: 0.68em; line-height: 1; margin: -0.25em 0 -0.25em 0.05em; }
.fv-math-sup { min-height: 0.6em; }
.fv-math-sub { min-height: 0.2em; }
.fv-math-radsign { width: 0.55em; height: auto; align-self: stretch; margin-top: 0.08em; overflow: visible; }
.fv-math-radbody { border-top: 1px solid currentColor; padding: 0.08em 0.12em 0; margin-top: 0.08em; display: inline-flex; align-items: center; }
.fv-math-deg { align-self: flex-start; }
.fv-math-deg { font-size: 0.6em; align-self: flex-start; margin-right: -0.3em; }
.fv-math-nary { display: inline-flex; flex-direction: column; align-items: center; margin: 0 0.15em; }
.fv-math-op { font-size: 1.6em; line-height: 1; }
.fv-math-lim { font-size: 0.7em; min-height: 0.2em; }
.fv-math-paren { transform: scaleY(1.25); }
.fv-math-bar { border-top: 1px solid currentColor; padding-top: 0.05em; }
.fv-math-acc { display: inline-flex; flex-direction: column; align-items: center; }
.fv-math-accmark { line-height: 0.5; font-size: 0.8em; }
.fv-math-matrix { display: inline-grid; gap: 0.2em 0.8em; justify-items: center; margin: 0 0.2em; }
.fv-doc-table-wrap { overflow-x: auto; margin: 6pt 0; }
.fv-doc-table { border-collapse: collapse; width: 100%; table-layout: auto; }
.fv-grid-cell.fv-rotated { display: flex; align-items: flex-end; overflow: hidden; }
.fv-grid-rot { display: inline-block; white-space: nowrap; line-height: 1.1; }
.fv-grid-vertical { writing-mode: vertical-rl; }
.fv-grid-stacked { writing-mode: vertical-rl; text-orientation: upright; letter-spacing: -0.1em; }
.fv-doc-watermark-img img { position: absolute; left: 50%; bottom: 40vh; transform: translate(-50%, 50%); max-width: 70%; max-height: 60vh; opacity: 0.18; mix-blend-mode: multiply; }
.fv-doc-leader { flex: 1 1 auto; min-width: 1.5em; margin: 0 4px 0.28em; align-self: flex-end; height: 0; }
.fv-doc-tabbed { display: grid; column-gap: 0; align-items: baseline; }
.fv-doc-tabcell { grid-row: 1; min-width: 0; }
.fv-doc-tabflex { display: flex; align-items: baseline; }
.fv-doc-tabcenter { justify-self: start; transform: translateX(-50%); white-space: nowrap; }
.fv-doc-dropcap { float: left; line-height: 0.82; padding: 0.04em 0.08em 0 0; font-weight: inherit; }
.fv-doc-crop { display: inline-block; overflow: hidden; vertical-align: bottom; max-width: 100%; line-height: 0; }
.fv-doc-crop img { display: block; }
.fv-doc-float { clear: none; }
.fv-doc-has-behind { position: relative; isolation: isolate; }
.fv-doc-behind { position: absolute; z-index: -1; max-width: 100%; }
.fv-doc-frame { overflow: hidden; margin: 4pt 0; }
.fv-doc-vert { writing-mode: vertical-rl; white-space: nowrap; max-height: 16em; }
.fv-doc-vert-bt { transform: rotate(180deg); }
.fv-doc-section::after { content: ''; display: block; clear: both; }
.fv-doc-table td { border: 1px solid #9aa1ab; padding: 3pt 5pt; vertical-align: top; min-width: 2em; }
.fv-doc-empty { color: #6b7280; text-align: center; padding: 40px 0; }

/* --- audio and video --- */
.fv-media { display: flex; align-items: center; justify-content: center; padding: 16px; background: var(--_bg); }
.fv-media-video { background: #000000; padding: 0; }
.fv-media-player { max-width: 100%; max-height: 100%; }
audio.fv-media-player { width: min(560px, 100%); }

/* --- archives --- */
.fv-archive { overflow: auto; background: var(--_surface); -webkit-overflow-scrolling: touch; }
.fv-archive-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.fv-archive-table th { position: sticky; top: 0; background: var(--_head-bg); color: var(--_muted); font-weight: 600; text-align: left; }
.fv-archive-table th, .fv-archive-table td { padding: 8px 12px; border-bottom: 1px solid var(--_border); overflow-wrap: anywhere; }
.fv-password { display: flex; gap: 8px; margin-top: 12px; justify-content: center; flex-wrap: wrap; pointer-events: auto; }
.fv-nocopy, .fv-nocopy * { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
.fv-nocopy input, .fv-nocopy textarea { -webkit-user-select: text; user-select: text; }
.fv-password-input { font: inherit; font-size: 16px; padding: 8px 10px; min-width: 0; width: 220px; max-width: 70vw; border: 1px solid var(--_border); border-radius: 6px; background: var(--_surface); color: var(--_text); }
.fv-password-btn { padding: 8px 16px; border: 1px solid var(--_border); border-radius: 6px; width: auto; height: auto; }
.fv-password-wrong { color: #c62828; }
.fv-signature { padding: 8px 0; }
.fv-signature .fv-archive-table { margin-bottom: 12px; }
.fv-signature .fv-archive-table th { position: static; width: 34%; vertical-align: top; }
.fv-signature-note { margin: 12px; color: var(--_muted); font-size: 14px; }
.fv-archive-table .fv-archive-size { width: 110px; text-align: right; white-space: nowrap; color: var(--_muted); font-variant-numeric: tabular-nums; }
.fv-archive-dir { color: var(--_muted); }
.fv-archive-open { cursor: pointer; }
.fv-archive-open td:first-child { color: var(--_accent, #1d4ed8); }
.fv-archive-open:hover td, .fv-archive-open:focus-visible td { background: var(--_head-bg); }
.fv-archive-open:focus-visible { outline: 2px solid var(--_accent, #1d4ed8); outline-offset: -2px; }
.fv-archive-busy { opacity: 0.55; pointer-events: none; }
.fv-back { margin-right: 4px; }

/* --- presentations --- */
.fv-slides { overflow: auto; background: var(--fv-bg, #e9ecef); padding: 12px; -webkit-overflow-scrolling: touch; }
.fv-slides-list { display: flex; flex-direction: column; align-items: center; gap: 12px; width: max-content; min-width: 100%; }
.fv-slide-frame { position: relative; flex: none; overflow: hidden; background: #ffffff; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25); content-visibility: auto; }
.fv-slide { position: absolute; left: 0; top: 0; transform-origin: 0 0; overflow: hidden; color: #1f2328; font: 18pt/1.2 Arial, "Liberation Sans", Helvetica, sans-serif; }
.fv-slide-bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.fv-shape { position: absolute; box-sizing: border-box; }
.fv-shape-img { position: absolute; inset: 0; width: 100%; height: 100%; -webkit-touch-callout: none; }
.fv-shape-svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.fv-shape > svg[role=img] { position: absolute; inset: 0; }
.fv-shape-text { position: absolute; inset: 0; display: flex; flex-direction: column; padding: 3.6pt 7.2pt; overflow: visible; }
.fv-shape-text p { margin: 0; white-space: pre-wrap; overflow-wrap: break-word; }
.fv-shape-marker { display: inline-block; width: 1em; margin-left: -1em; }
.fv-shape-note { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; border: 2px dashed #c5cad1; color: #9aa1ab; font-size: 16pt; }
.fv-shape table { border-collapse: collapse; width: 100%; height: 100%; table-layout: fixed; }
.fv-shape td { border: 1px solid #9aa1ab; padding: 3.6pt 7.2pt; vertical-align: top; overflow: hidden; }
.fv-shape td p { margin: 0; white-space: pre-wrap; }

/* --- PDF --- */
.fv-pdf { overflow: auto; -webkit-overflow-scrolling: touch; }
.fv-pdf-pages { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 12px; width: max-content; min-width: 100%; }
.fv-pdf-page {
  position: relative;
  flex: none;
  background: #ffffff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  overflow: hidden;
}
.fv-pdf-canvas { display: block; -webkit-touch-callout: none; }
.fv-pdf-page-error { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #9aa1ab; font-size: 28px; }
`;
