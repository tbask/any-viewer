/**
 * Entry point of the standalone build (`dist/standalone/any-viewer.global.js`): one classic script without
 * imports, for pages that cannot use ES modules — above all the host page loaded into a mobile WebView.
 * It exposes the public API as the global `AnyViewer`.
 */
export { createViewer } from './viewer';
export { detectFormat, formatFromName, formatFromMime, kindOf, isImplemented, IMPLEMENTED_FORMATS } from './detect';
export { LABELS_RU, LABELS_EN, LABEL_SETS, resolveLabels } from './labels';
export { ViewerError, DEFAULT_LIMITS } from './types';
