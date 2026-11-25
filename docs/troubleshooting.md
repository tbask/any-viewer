# Troubleshooting

## Nothing is visible

The container has no height. The viewer fills its container; give it `height`, or `flex: 1; min-height: 0` in a
flex column. See [Getting started](./getting-started.md#the-container-needs-a-height).

## `unsupported` for a file served from `/api/files/42`

Without an extension the format can only come from the content. Most formats are recognised by signature;
plain text, CSV and Markdown are not. Pass `name` or `mimeType`:

```ts
viewer.open('/api/files/42', { name: 'data.csv' });
```

## `load-failed` for a URL

The file is fetched from the page, so the usual browser rules apply:

- another origin needs CORS headers (`Access-Control-Allow-Origin`);
- authorization needs `fetchOptions` (and `pdf.httpHeaders` for PDF) — see
  [Files behind authorization](./getting-started.md#files-behind-authorization);
- a page on HTTPS cannot load a file over HTTP.

## Some PDFs show empty boxes instead of text, or blank scanned pages

The PDF needs fonts or image decoders from the PDF.js assets. Serve `dist/pdfjs/` and set `pdf.assetsUrl`
([how](./getting-started.md#pdfjs-assets)). Check the network tab: requests to `cmaps/`, `standard_fonts/` or
`wasm/` must return 200.

## The video does not play

- "The video is encoded as HEVC…" — the browser has no decoder for the codec. Phones often record HEVC (H.265),
  which Chrome plays only with hardware support. Nothing can be done on the client; transcode to H.264 on the server.
- A URL with authorization headers is downloaded whole before playing (the `<video>` element cannot send headers),
  so the file must fit `maxFileBytes`. Prefer cookies or signed URLs for large videos.
- Under a CSP, allow `media-src blob:`.

## Cyrillic or accented text is garbled in a text or CSV file

The file is in a legacy single-byte encoding. The default guess is `windows-1251`; set `fallbackEncoding`
to the encoding of your users, e.g. `'windows-1252'`.

## Numbers and dates look wrong in a spreadsheet

They follow the browser locale. Set `locale: 'en-GB'` (or another tag) explicitly.

## The interface is in the wrong language

The interface follows `locale` (`en`, `ru` and `kk` are built in) and can be switched with `viewer.setLocale()`.
If `uiLanguage` is set, it wins: remove it to let `locale` decide. For another language provide your own strings
through `labels`.

## Workers are blocked by CSP

Add `worker-src blob:`. Without it parsing runs on the main thread (slower, but works); for PDF you must then set
`pdf.workerSrc` to a hosted copy of the PDF.js worker. See [Security](./security.md#content-security-policy).

## Jest cannot import the package

The package is ESM-only and needs a real DOM (Shadow DOM, canvas, workers). In unit tests mock the module:

```ts
jest.mock('any-viewer', () => ({ createViewer: () => ({ open: async () => ({}), close() {}, destroy() {}, zoomIn() {}, zoomOut() {}, zoomReset() {}, setLocale() {}, download: async () => {}, print: async () => {} }) }));
```

and test the real viewer in a browser runner (Playwright, Cypress).

## Angular: `'any-viewer' is not a known element`

Import `AnyViewerComponent` into the standalone component or `NgModule` that uses it.

## A file inside a RAR or 7z archive will not open

The list is shown for every archive. Files inside a RAR archive open only when they were stored without
compression: RAR compression is proprietary and the viewer does not implement it. In 7z, PPMd compression and
encrypted archives are not covered. See [Formats](./formats.md).

## Something else

Open an issue with the file (if you can share it), the browser and the error code:
<https://github.com/tbask/any-viewer/issues>.
