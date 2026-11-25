# Security and privacy

## Where the file goes

Nowhere. Parsing, decryption and rendering happen in the browser. The library makes no network requests except:

- fetching the file itself, when you pass a URL;
- fetching PDF.js assets from `pdf.assetsUrl`, when a PDF needs them.

There is no telemetry and no third-party service.

## Untrusted files

Viewers are a classic target, so this is how hostile input is handled:

- **No `innerHTML`.** The interface and the document content are built with DOM APIs; text from files is
  inserted as text nodes.
- **HTML files** are rendered from a parsed, filtered tree: scripts, styles, forms, frames, event attributes and
  images are dropped, and the page makes no network requests. `htmlMode: 'source'` shows the markup as text.
- **SVG** is shown through an `<img>` element, where scripts do not run and external resources do not load.
- **Links** in documents open in a new tab with `rel="noopener noreferrer"`; only `http`, `https` and `mailto` are kept.
  In a WebView set `onLinkClick` (hand the URL to the system browser) or `links: 'none'`, so that a link cannot
  replace the application page.
- **Hidden content** is not shown: hidden text, tracked deletions, hidden rows, columns, sheets and slides, and in
  OpenDocument files hidden sections and paragraphs hidden by a field.
- **Macros and embedded scripts** in Office files are never executed. PDF JavaScript is not executed and XFA is off.
- **Archives** are unpacked in memory, one file at a time, with a cap on the unpacked size; nothing is written to disk.
  Checksums are verified where the format has them.
- **Size limits** (`limits`) bound memory use; exceeding them gives `too-large` instead of a frozen tab.

The parsers are new code and have not had an independent security review or fuzzing campaign.
A malformed file can still, at worst, throw an error or use a lot of memory inside the tab. If you show files
from anonymous users on a sensitive origin, consider hosting the viewer in a sandboxed iframe on a separate origin.

## Content Security Policy

| Directive | Why |
| --- | --- |
| `worker-src blob:` | Parsers and PDF.js run in workers created from `blob:` URLs. Without it parsing falls back to the main thread; for PDF set `pdf.workerSrc` to a hosted worker file instead |
| `img-src blob: data:` | Images inside documents and decoded pictures |
| `media-src blob:` | Audio and video opened from a `File`, `Blob` or bytes |
| `style-src 'unsafe-inline'` | Styles are injected into the Shadow DOM, and document content uses inline styles for fonts, colours and positions |
| `connect-src` | The origins of your files and of `pdf.assetsUrl` |
| `script-src 'wasm-unsafe-eval'` | Only for PDFs that need the wasm image decoders (JPEG 2000, JBIG2) |

Operation under a strict CSP has not been tested end to end; treat the table as a starting point.

## "No download button" is not copy protection

The viewer offers no way to download the file and, by default, turns off the context menu, dragging content out,
text selection and copying (`allowCopy: true` brings copying back; `suppressSaveUi: false` the context menu).

This removes the obvious paths. It is **not** a protection: anything shown on a device can be extracted with
developer tools, a network proxy or a screenshot. If you need protection, do it on the server — serve pages as
watermarked images through short-lived links, and accept that screenshots remain possible.

## Passwords

A password entered for a protected file is used for key derivation in memory and is not stored or sent anywhere.

## Digital signatures

For `p7s` / `p7m` files the viewer shows who signed the document and when, as written in the file.
It **does not verify** the signature or the certificate chain. Do not use it to decide whether a document is authentic.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
