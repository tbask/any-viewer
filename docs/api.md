# API reference

Everything is exported from the package root:

```ts
import {
  createViewer, ViewerError, DEFAULT_LIMITS,
  detectFormat, formatFromName, formatFromMime, kindOf, isImplemented, IMPLEMENTED_FORMATS,
  LABELS_EN, LABELS_RU, LABELS_KK, LABEL_SETS, resolveLabels, normalizeLanguageTag,
} from 'any-viewer';
import type {
  Viewer, ViewerOptions, OpenOptions, OpenedFileInfo, FileSource, FileFormat, FileKind,
  ViewerLimits, PdfOptions, Labels, ViewerErrorCode,
} from 'any-viewer';
```

## `createViewer(container, options?)`

Creates a viewer inside `container` and returns a [`Viewer`](#viewer).

| Option | Default | Purpose |
| --- | --- | --- |
| `toolbar` | `true` | Top bar with the file name, pages and zoom |
| `uiLanguage` | from `locale`, then the browser | Interface language: `'en'`, `'ru'` or `'kk'`. Set it only to pin the interface to one language: it wins over `locale` and `setLocale()` |
| `labels` | — | Overrides for individual interface strings |
| `locale` | browser language | BCP 47 tag, e.g. `'en-GB'`, `'ru-RU'`, `'kk-KZ'`: numbers and dates in spreadsheets and charts, and the interface language unless `uiLanguage` is set. Can be changed later with `setLocale()` |
| `download` | `false` | Show a "Download" button in the toolbar; it saves the file as it was received |
| `print` | `false` | Show a "Print" button in the toolbar. See [Printing](#printing) |
| `limits` | see [Limits](#limits) | Size limits |
| `pdf.assetsUrl` | — | URL of the folder with PDF.js assets |
| `pdf.workerSrc` | bundled | URL of an external PDF.js worker file (needed under a strict CSP) |
| `pdf.httpHeaders`, `pdf.withCredentials` | — | Authorization when a PDF is loaded by URL |
| `fetchOptions` | — | `fetch` options for every other format loaded by URL |
| `fallbackEncoding` | `'windows-1251'` | Encoding for text that is neither UTF-8 nor UTF-16 |
| `suppressSaveUi` | `true` | Turns off the context menu and dragging content out |
| `allowCopy` | `false` | `false`: text cannot be selected or copied (no selection, Ctrl/Cmd+C, X, A and the copy event are blocked). `true`: normal selection and copying |
| `strictExtension` | `false` | `true`: reject files whose extension does not match the content (error `mismatch`). By default the file opens by content |
| `openArchiveEntries` | `true` | Open files from an archive by clicking a row; `false` shows the list only |
| `passwordPrompt` | `true` | Show a password field for protected files; `false` gives only the `password` error |
| `htmlMode` | `'document'` | `'document'`: HTML as a document without scripts and external resources; `'source'`: the markup as text |
| `useWorkers` | `true` | Parse in Web Workers; falls back to the main thread automatically on failure |
| `links` | `'new-tab'` | What a click on a link inside a file does: `'new-tab'` opens it in a new tab (in a WebView: whatever the host does with new windows), `'none'` ignores the click |
| `onLinkClick` | — | `(url: string) => void`. When set, the viewer never navigates by itself: the application decides (system browser, confirmation, nothing) |
| `onLoad` | — | `(info: OpenedFileInfo) => void`, called when a file is on screen |
| `onError` | — | `(error: ViewerError) => void` |

> If most of your text files are not Cyrillic, set `fallbackEncoding` to the legacy encoding of your users,
> for example `'windows-1252'`.

## `Viewer`

| Method | |
| --- | --- |
| `open(source, options?)` | Opens a file. Returns `Promise<OpenedFileInfo>`; rejects with `ViewerError` |
| `close()` | Closes the current file and frees its memory |
| `destroy()` | Removes the viewer. The instance cannot be used afterwards |
| `zoomIn()`, `zoomOut()`, `zoomReset()` | Zoom, the same as the toolbar buttons |
| `setLocale(locale)` | Changes the language at run time: interface strings and number and date formats. The opened file is rendered again from the bytes already loaded (scroll position and zoom are reset); `onLoad` is not called again. `undefined` returns to the browser language |
| `download()` | Saves the opened file. Works whether or not the button is shown. Returns a `Promise` |
| `print()` | Prints the opened file. Works whether or not the button is shown. Returns a `Promise` |

### Printing

A PDF is handed to the browser's own PDF engine, so the original file is printed, not its picture on screen.
Other formats are printed as the viewer renders them: documents, slides (one per landscape page), text, images,
archive listings. Of a spreadsheet the active sheet is printed as a plain table, up to 5000 rows, without the
pictures and charts placed on the sheet. Audio and video cannot be printed, and the button is hidden for them.

Printing uses a hidden same-origin `<iframe>`; under a Content Security Policy it needs the same
`style-src 'unsafe-inline'` as the viewer itself, and for PDF `frame-src blob:`. In mobile WebViews printing is
usually unavailable: leave the option off there.

### `FileSource`

`string | URL | Blob | ArrayBuffer | Uint8Array`. A string is a URL. `File` is a `Blob`, and its name is used automatically.

### `OpenOptions`

| Option | Purpose |
| --- | --- |
| `name` | File name: shown in the toolbar and used as a hint for format detection |
| `format` | Explicit [`FileFormat`](#fileformat-and-filekind); turns detection off |
| `mimeType` | MIME type, when known |
| `password` | Password for a protected file |

### `OpenedFileInfo`

| Field | |
| --- | --- |
| `name` | File name |
| `format` | Detected [`FileFormat`](#fileformat-and-filekind) |
| `kind` | [`FileKind`](#fileformat-and-filekind): which renderer shows the file |
| `size` | Size in bytes, when known |
| `expectedFormat` | Set when the extension promised another format and the file was opened by content |
| `damaged` | `true` when the file is truncated and only the readable part is shown |
| `empty` | `true` for a zero-length file |
| `signature` | Signer details for `p7s` / `p7m`. **The signature is not verified** |

### `FileFormat` and `FileKind`

```ts
type FileFormat =
  | 'jpg' | 'png' | 'webp' | 'bmp' | 'gif' | 'svg' | 'tiff' | 'heic'
  | 'txt' | 'md' | 'json' | 'xml' | 'html' | 'yaml' | 'sql' | 'csv' | 'pdf'
  | 'docx' | 'doc' | 'odt' | 'rtf' | 'xlsx' | 'xls' | 'ods' | 'pptx' | 'ppt' | 'odp'
  | 'eml' | 'mbox' | 'ics' | 'msg' | 'zip' | 'tar' | 'gz' | 'rar' | '7z' | 'epub'
  | 'audio' | 'video' | 'dwg' | 'p7s' | 'p7m' | 'unknown';

type FileKind = 'image' | 'text' | 'table' | 'pdf' | 'document' | 'slides' | 'archive' | 'media' | 'signature' | 'unknown';
```

Variants are folded into their base format: templates and macro-enabled files (`docm`, `dotx`, `xlsm`, `ppsx`, …)
report `docx`, `xlsx` or `pptx`.

## Limits

Pass any subset as `limits`; the rest comes from `DEFAULT_LIMITS`.

| Key | Default | When exceeded |
| --- | --- | --- |
| `maxFileBytes` | 200 MB | error `too-large` |
| `maxMediaBytes` | 8 GB | audio and video from a `File`/`Blob`: error `too-large` |
| `maxTextBytes` | 5 MB | the beginning of the file is shown with a notice |
| `maxTableBytes` | 50 MB | error `too-large` |
| `maxTableRows` | 500,000 | the first rows are shown with a notice |
| `maxImagePixels` | 16 MP | the image is downscaled while decoding |
| `maxCanvasPixels` | 8 MP | PDF page canvases get a lower density |
| `maxPixelRatio` | 2 | cap on `devicePixelRatio` |

## Errors

`open()` rejects with a `ViewerError`. The message is also shown on screen and passed to `onError`
(except `aborted`, which is the normal cancellation when another file is opened on top).

```ts
class ViewerError extends Error {
  code: ViewerErrorCode;
  format?: FileFormat;
  passwordState?: 'required' | 'wrong' | 'unsupported';
  cause?: unknown;
}
```

| `code` | Meaning |
| --- | --- |
| `unsupported` | The format is not supported, or the browser cannot decode it (for example an unknown video codec) |
| `not-implemented` | The format is recognised but has no renderer (`dwg`) |
| `load-failed` | The file could not be fetched |
| `too-large` | A [limit](#limits) is exceeded |
| `password` | The file is protected; see `passwordState` |
| `corrupt` | The data is damaged or is not the format it claims to be |
| `mismatch` | Extension and content differ, with `strictExtension: true` |
| `aborted` | Another `open()`, `close()` or `destroy()` interrupted this one |

`passwordState`: `required` — a password is needed (the field is on screen), `wrong` — the password did not fit,
`unsupported` — the encryption method is not supported. After the right password is entered the viewer opens the
file again and `onLoad` fires as usual.

Error messages are in English and meant for developers; what the user sees comes from [`labels`](#labels).

## Labels

`Labels` is the interface with every UI string. `LABELS_EN`, `LABELS_RU` and `LABELS_KK` (Kazakh) are complete
sets; `resolveLabels(tag?)` picks one of them for a BCP 47 tag. Kazakh is `kk`; the country code written as a
language (`kz`, `kz-KZ`) is accepted and read as `kk` — `normalizeLanguageTag(tag)` does that conversion. Two strings contain placeholders:
`shownByContent` (`{format}`) and `mediaCodecUnsupported` (`{codec}`).

## Format helpers

| Function | |
| --- | --- |
| `detectFormat(blob, { name?, mimeType? })` | `Promise<FileFormat>`: detects the format from the content of a `Blob`, then the name and MIME type |
| `formatFromName(name)` | Format by extension |
| `formatFromMime(mimeType)` | Format by MIME type |
| `kindOf(format)` | The `FileKind` of a format |
| `isImplemented(format)` | Whether the viewer can render the format |
| `IMPLEMENTED_FORMATS` | `ReadonlySet<FileFormat>` of every format with a renderer |

Use them to decide in advance whether to offer a preview:

```ts
import { formatFromName, isImplemented } from 'any-viewer';

const canPreview = isImplemented(formatFromName(file.name));
```
