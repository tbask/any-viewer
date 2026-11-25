# Getting started

## Requirements

- A bundler that understands ES modules and dynamic `import()` (Vite, webpack 5, esbuild, Rollup, the Angular CLI),
  **or** the single-file build for pages without a bundler.
- A browser with ES2020, Shadow DOM and Web Workers.

The package is ESM-only. There is no CommonJS build.

## Install

```bash
npm install any-viewer
```

| You use | Install | Guide |
| --- | --- | --- |
| Angular 17 or newer | `any-viewer` + `any-viewer-angular` | [angular.md](./angular.md) |
| React 16.8 or newer | `any-viewer` (binding is at `any-viewer/react`) | [react.md](./react.md) |
| Flutter, React Native, native WebView | `any-viewer` (host page in `dist/standalone/`) | [flutter.md](./flutter.md) |
| Vue, Svelte, plain TypeScript | `any-viewer` | this page |

## Create a viewer

```ts
import { createViewer } from 'any-viewer';

const viewer = createViewer(document.getElementById('viewer')!, {
  onLoad: (info) => console.log(info.format, info.kind),
  onError: (error) => console.warn(error.code, error.message),
});
```

`createViewer` attaches a Shadow DOM to the container and draws the interface inside it. One viewer shows one file
at a time; opening another file replaces the current one.

### The container needs a height

The viewer fills its container and scrolls inside it. A container without a height collapses to zero:

```css
#viewer { height: 100vh; }           /* full screen */
.dialog-body { height: 70vh; }       /* inside a dialog */
.layout { display: flex; flex-direction: column; height: 100%; }
.layout > #viewer { flex: 1; min-height: 0; } /* the rest of a flex column */
```

## Open a file

```ts
await viewer.open('https://example.com/files/report.docx');   // URL (string or URL object)
await viewer.open(fileFromInput);                             // File or Blob
await viewer.open(arrayBuffer, { name: 'report.docx' });      // ArrayBuffer or Uint8Array
```

`open()` resolves with information about the file once it is on screen and rejects with a
[`ViewerError`](./api.md#errors). The same error is shown to the user and passed to `onError`,
so you may ignore the rejection if `onError` is enough:

```ts
viewer.open(url).catch(() => {});
```

### How the format is detected

1. `format` from the open options, when given.
2. The signature in the file content — a renamed file opens as what it really is.
3. The extension from `name` or the URL, then the MIME type.

When a file is served from a URL without an extension (`/api/files/42`), pass `name` or `mimeType`.
A PDF by URL is loaded in ranges only when the format is known in advance — from `name`, the URL or `format`.

### Files behind authorization

```ts
createViewer(container, {
  fetchOptions: { headers: { Authorization: `Bearer ${token}` } }, // or { credentials: 'include' }
  pdf: { httpHeaders: { Authorization: `Bearer ${token}` } },      // PDF is loaded by PDF.js separately
});
```

Alternatively fetch the file yourself and pass the `Blob`.

### Password-protected files

By default the viewer shows a password field. To supply the password in advance:

```ts
await viewer.open(file, { password: 'secret' });
```

With `passwordPrompt: false` no field is shown and `open()` rejects with code `password`.

## PDF.js assets

`node_modules/any-viewer/dist/pdfjs/` holds four folders — `cmaps`, `standard_fonts`, `wasm`, `iccs` (about 4 MB).
Copy them to your static files and pass the URL:

```ts
createViewer(container, { pdf: { assetsUrl: '/pdfjs/' } });
```

Most PDFs open without them. They are required for files with non-embedded standard fonts, CJK encodings
and JPEG 2000 / JBIG2 images (typical for scans). Only the files a document needs are fetched.

With Vite:

```ts
// vite.config.ts
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default {
  plugins: [viteStaticCopy({ targets: [{ src: 'node_modules/any-viewer/dist/pdfjs/*', dest: 'pdfjs' }] })],
};
```

For the Angular CLI see [angular.md](./angular.md#pdfjs-assets).

## Interface language

The interface is English, Russian or Kazakh. It follows `uiLanguage`, then `locale`, then the browser language;
other languages give English.

```ts
const viewer = createViewer(container, { locale: 'kk-KZ' });

// Later, when the user switches the language of the application:
viewer.setLocale('ru-RU');
```

`setLocale` changes the interface at once and renders the opened file again with the new number and date formats,
without loading it a second time. Set `uiLanguage` only if the interface must stay in one language whatever the
locale is.

For another language, or to change single strings, pass `labels`:

```ts
import { createViewer, LABELS_EN } from 'any-viewer';

createViewer(container, { labels: { ...LABELS_EN, loading: 'Wird geladen…', page: 'Seite' } });
```

`locale` (a BCP 47 tag such as `en-GB`) controls how numbers and dates are formatted in spreadsheets and charts.

## Download and print

By default the viewer has no way to save or print the file. Both buttons are opt-in:

```ts
createViewer(container, { download: true, print: true });
```

They suit desktop browsers; in a mobile WebView leave them off. `viewer.download()` and `viewer.print()` do the
same from your own controls. See [what is printed](./api.md#printing).

## Theming

Colours are CSS custom properties set on the container:

```css
#viewer {
  --fv-bg: #f3f4f6;       /* background behind the content */
  --fv-surface: #ffffff;  /* pages, tables */
  --fv-text: #111827;
  --fv-muted: #6b7280;
  --fv-border: #d1d5db;
  --fv-accent: #2563eb;
  --fv-bar-bg: #ffffff;   /* toolbar */
  --fv-head-bg: #f9fafb;  /* table headers */
  --fv-font: system-ui, sans-serif;
  --fv-mono: ui-monospace, monospace;
}
```

Light and dark themes follow the system setting (`prefers-color-scheme`).

## Tuning for weak devices

```ts
createViewer(container, {
  limits: {
    maxImagePixels: 8_000_000,  // large images are downscaled while decoding
    maxCanvasPixels: 4_000_000, // PDF page canvases get a lower density
    maxFileBytes: 50 * 1024 * 1024,
  },
});
```

All limits are listed in the [API reference](./api.md#limits).

## Clean up

```ts
viewer.close();   // close the file, keep the viewer
viewer.destroy(); // remove the viewer and its listeners; the instance cannot be reused
```

Call `destroy()` when the page or component goes away; object URLs, workers and canvases are released there.
