# any-viewer

[![npm](https://img.shields.io/npm/v/any-viewer.svg)](https://www.npmjs.com/package/any-viewer)
[![CI](https://github.com/tbask/any-viewer/actions/workflows/ci.yml/badge.svg)](https://github.com/tbask/any-viewer/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/any-viewer.svg)](./LICENSE)

View files right in the browser or in a mobile WebView — no download, no server-side conversion,
no third-party services. The file never leaves the device.

- **40+ formats**: PDF, Word, Excel, PowerPoint (modern and legacy binary), OpenDocument, RTF, CSV, images,
  archives (ZIP, 7z, RAR, tar), e-mail, e-books, audio and video. [Full list →](./docs/formats.md)
- **Client-side only**: parsers are written from scratch in TypeScript. The only third-party code is PDF.js,
  bundled for PDF.
- **Light on the client**: the core is about 12 kB gzipped; the code for each format is loaded on first use.
  Parsing runs in Web Workers, tables and PDF pages are virtualized.
- **Framework-agnostic**: plain DOM API, plus ready bindings for [Angular 17+](./docs/angular.md),
  [React](./docs/react.md) and a host page for [Flutter and other WebViews](./docs/flutter.md).
- **View only**: no download button; context menu, drag-out, text selection and copying are off by default.
  This is a UI convenience, [not copy protection](./docs/security.md#no-download-button-is-not-copy-protection).

> **Status: 0.x.** The API may still change between minor versions. Rendering aims to make content readable
> and recognisable, not to reproduce the printed page pixel for pixel. See [what is and is not verified](./docs/verification.md).

## Install

```bash
npm install any-viewer
```

## Quick start

```ts
import { createViewer } from 'any-viewer';

const viewer = createViewer(document.getElementById('viewer')!, {
  pdf: { assetsUrl: '/pdfjs/' }, // optional, see "PDF.js assets" below
  onError: (error) => console.warn(error.code, error.message),
});

await viewer.open('/api/files/42', { name: 'contract.pdf' }); // by URL
await viewer.open(file);                                      // File or Blob
await viewer.open(arrayBuffer, { name: 'report.csv' });       // raw bytes

viewer.close();   // close the file and free memory
viewer.destroy(); // remove the viewer
```

The container needs a size (for example `height: 100%` or `100vh`); the viewer fills it.
The UI lives in a Shadow DOM, so it neither picks up nor leaks styles.

### Angular 17+

```bash
npm install any-viewer any-viewer-angular
```

```ts
import { Component } from '@angular/core';
import { AnyViewerComponent } from 'any-viewer-angular';

@Component({
  standalone: true,
  imports: [AnyViewerComponent],
  template: `<any-viewer [source]="url" name="contract.pdf" (failed)="onFailed($event)" />`,
  styles: [':host { display: block; height: 100vh; }'],
})
export class PreviewComponent {
  url = '/api/files/42';
  onFailed(error: { code: string }) { console.warn(error.code); }
}
```

[Angular guide →](./docs/angular.md)

### React

```tsx
import { AnyViewer } from 'any-viewer/react';

export function Preview({ file }: { file: File }) {
  return (
    <div style={{ height: '100vh' }}>
      <AnyViewer source={file} onError={(error) => console.warn(error.code)} />
    </div>
  );
}
```

[React guide →](./docs/react.md)

### Flutter, React Native, native WebView

The package ships a ready host page (`dist/standalone/viewer.html`) and a single-file build without ES modules.
Load the page into a WebView and pass a URL or the file bytes. [WebView guide →](./docs/flutter.md)

### Plain `<script>` tag

```html
<div id="viewer" style="height: 100vh"></div>
<script src="https://unpkg.com/any-viewer/dist/standalone/any-viewer.global.js"></script>
<script>
  const viewer = AnyViewer.createViewer(document.getElementById('viewer'));
  viewer.open('/files/report.xlsx');
</script>
```

The single-file build is about 2.6 MB (880 kB gzipped) because everything, PDF.js included, is inlined.
Prefer the npm package with a bundler: it loads only the code a given file needs.

## Supported formats

| Family | Formats |
| --- | --- |
| Documents | pdf, docx, doc, odt, rtf, epub, html, md, txt and other plain text |
| Spreadsheets | xlsx, xls, ods, csv, tsv |
| Presentations | pptx, ppt, odp |
| Images | jpg, png, webp, gif, bmp, svg, tiff; heic where the browser supports it |
| Archives | zip, 7z, rar, tar, gz — with opening files from inside the archive |
| E-mail and calendar | eml, msg, mbox, ics |
| Media | mp3, wav, m4a, ogg, mp4, webm, mov (browser codecs) |
| Signatures | p7s, p7m (CMS / PKCS#7) — shows who signed; **does not verify** the signature |

Password-protected Office files and PDFs open after the password is entered; decryption happens in the browser.
The format is detected from the content, so a renamed file opens as what it really is.
Details, limits and what is not rendered: [docs/formats.md](./docs/formats.md).

## Documentation

| | |
| --- | --- |
| [Getting started](./docs/getting-started.md) | Installation, bundlers, sizing, theming, PDF.js assets |
| [API reference](./docs/api.md) | `createViewer`, options, limits, errors, labels |
| [Formats](./docs/formats.md) | What is rendered for every format and what is not |
| [Angular](./docs/angular.md) | `any-viewer-angular` for Angular 17+ |
| [React](./docs/react.md) | `any-viewer/react` |
| [Flutter and WebViews](./docs/flutter.md) | Host page, message bridge, Dart example |
| [Security and privacy](./docs/security.md) | CSP, untrusted files, copy protection caveats |
| [Verification status](./docs/verification.md) | What has been tested and what has not |
| [Independent review](./docs/review-0.7.0.md) | Findings of an external review of 0.7.0 and their status |
| [Troubleshooting](./docs/troubleshooting.md) | Common problems |

## PDF.js assets

The package contains `dist/pdfjs/` with CMaps, standard fonts, wasm decoders and ICC profiles (about 4 MB).
Serve the folder as static files and pass its URL as `pdf.assetsUrl`. Most PDFs open without it; it is needed
for files with non-embedded standard fonts, CJK encodings and JPEG 2000 / JBIG2 images (typical for scans).
Files are fetched on demand, only those a particular document needs.

## Browser support

Evergreen browsers with ES2020, Shadow DOM and Web Workers. Automated tests run in Chrome (desktop and
phone emulation). Safari, Firefox and real mobile WebViews have **not** been tested yet — see
[verification status](./docs/verification.md).

## Contributing

Bug reports with a sample file are the most valuable contribution. See [CONTRIBUTING.md](./CONTRIBUTING.md).
To report a vulnerability, follow [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE). Bundled third-party code (PDF.js, Apache-2.0) is listed in [NOTICE.md](./NOTICE.md).
