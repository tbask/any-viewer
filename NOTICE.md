# Third-party code and data

## In the published package

The only third-party component in the build is **PDF.js** (Mozilla Foundation), licensed under Apache-2.0.
Its version is pinned in `package.json` (`pdfjs-dist`); the license text is copied to `dist/pdfjs/LICENSE`
during the build. PDF.js is loaded only when a PDF is opened (a separate lazy chunk).

Everything else in the package is original code without runtime dependencies.

## Archive formats

The RAR decompression code (`src/core/unrar5.ts`, `src/core/unrar3.ts`) was written for this project and only extracts archives. RAR is a proprietary format of Alexander Roshal / win.rar GmbH;
this project contains no code for creating RAR archives.

## Test data (not published to npm)

- `test/fixtures/ext/rar3-*.rar`, `rar5-*.rar` — from the test suite of the rarfile project
  (Marko Kreen, ISC license) and the libarchive project (BSD 2-Clause license).
- `test/fixtures/office`, `test/fixtures/crypto` — documents made for testing this project in Microsoft Office and
  LibreOffice, with the author metadata replaced by a placeholder.
- The other Office fixtures were generated with python-docx, openpyxl and python-pptx (MIT license);
  the presentation ones keep the metadata of the default python-pptx template.
