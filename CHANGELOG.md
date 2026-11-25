# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/). While the version is 0.x, minor releases may contain breaking changes.

## [0.11.0] - 2026-11-25

### Removed

- Extraction of compressed files from RAR archives. The RAR compression algorithm has no public specification
  and is available only as the UnRAR source code under its own license, so the decompressor is gone from the
  package. A RAR archive still shows its file list, and files stored without compression still open; a click on
  a compressed file gives the "could not open the file from the archive" notice.
- Decoding of the packed Unicode form of file names in RAR 3–4 archives, for the same reason. The plain form of
  the name is shown: UTF-8 from Unix and macOS, the DOS code page from Windows.

### Changed

- `NOTICE.md` lists every resource bundled with PDF.js with its license, the references the format readers
  follow, and the bzip2 license.
- `any-viewer-angular` is built with Angular 22.3 instead of 17.3, which clears the security advisories in its
  build dependencies. Applications on Angular 17 and newer are still supported. The typings moved to
  `types/any-viewer-angular.d.ts`; the `esm2022/` and `lib/` folders are no longer in the package, so deep
  imports into them stop working (the package entry point is unchanged).

Versions 0.9.0 and 0.10.0 contained the RAR decompressor and were withdrawn from npm.

## [0.10.0] - 2026-11-25

### Added

- Kazakh interface (`kk`; `kz` and `kz-KZ` are accepted). `LABELS_KK` and `normalizeLanguageTag` are exported.
- `viewer.setLocale(locale)`: switches the interface language and the number and date formats at run time; the
  opened file is rendered again without being loaded a second time. The Angular and React components get a
  `locale` input/prop that can change at any time; the WebView host page accepts `locale` and a `locale` message.
- `download` and `print` options add toolbar buttons (both off by default), with `viewer.download()` and
  `viewer.print()` for custom controls. A PDF is printed from the original file by the browser; other formats are
  printed as rendered, a spreadsheet as a plain table of the active sheet.

### Changed

- `Labels` has two new strings, `download` and `print`: a complete custom label set has to add them.
- `uiLanguage`, when set, keeps the interface language fixed even after `setLocale()`.

## [0.9.0] - 2026-11-25

Answers an independent review of 0.7.0 (72 findings on 118 test files). The status of every finding is in
[docs/review-0.7.0.md](./docs/review-0.7.0.md).

### Security

- odt: a paragraph hidden by a "hidden paragraph" field and a conditionally hidden section are no longer shown.

### Added

- `links` and `onLinkClick` options: the application decides what a click on a link does, so a WebView never leaves its page.
- Text: small and all capitals, letter spacing, character scale, double strikethrough, underline kinds, overline,
  shadow, outline and glow; drop caps; paragraph borders; tab stops with leaders (tables of contents).
- Documents: numbered headings (docx multilevel lists, odt chapter numbering), custom bullet characters with
  symbol fonts mapped to Unicode, legacy form fields (check box, drop-down), vertical text and vertical alignment
  in table cells, row heights, floating tables, pictures with text wrapping, behind text, cropping, border and
  rotation, picture watermarks, frames (odt), nested tables and paragraph shading in RTF.
- LibreOffice Math formulas in odt and odp (MathML).
- Spreadsheets: border kinds (thick, double, dashed, dotted) and colours, pattern and gradient fills, typefaces,
  rotated text, several formats inside one cell, built-in styles of tables and pivot tables.
- Presentations: freeform outlines (theme decorations), about 70 more preset shapes, table styles, real bullet
  characters and numbering kinds, link styling, theme shadows; in odp also text effects, dashed outlines,
  routed connectors, background pictures, footer, date and slide number, Fontwork, vertical text.
- Charts: dates on a category axis are formatted instead of shown as serial numbers.

### Fixed

- xlsx: a column that holds only sparklines was not shown.
- pptx: a placeholder took position and alignment from an unrelated master placeholder with the same index.
- odt: one shape with a malformed arc produced a 27 MB outline (100 MB of memory); arcs are now bounded.
- rtf: footnotes written by LibreOffice (`{\*\footnote …}`) were skipped.
- odp: table header rows without their own cell style lost text colour and fill; a fill colour without a fill kind
  was treated as a solid fill.
- SmartArt organisation charts: connector lines were drawn as empty frames.

## [0.8.0] - 2026-11-25

First public release.

### Added

- Published to npm as `any-viewer` under the MIT license.
- `any-viewer-angular`: standalone component for Angular 17+, with `provideAnyViewer()` for application-wide defaults.
- `any-viewer/react`: React component `AnyViewer`.
- Standalone build `dist/standalone/any-viewer.global.js` (global `AnyViewer`) and a WebView host page
  `dist/standalone/viewer.html` with a message bridge for Flutter, React Native and native WebViews.
- `uiLanguage` option; `LABEL_SETS` and `resolveLabels()` exports.
- English documentation in `docs/`.

### Changed

- **Breaking:** the interface language now follows `uiLanguage`, then `locale`, then the browser language, and is
  English unless that language is Russian. Previously it was always Russian. Pass `uiLanguage: 'ru'` to keep the old behaviour.
- Developer-facing error messages, code comments and tests are now in English.
- File sizes in the archive list use the interface language.

## Before 0.8.0

Internal development, not published: the viewer shell, images, text, CSV and PDF; spreadsheets, documents and
presentations in the Office, legacy binary and OpenDocument formats; e-mail, archives with extraction (zip, 7z, tar),
signatures, charts, shapes, metafiles, password-protected Office files, media playback and copy blocking.
