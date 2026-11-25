# Verification status

An honest account of what has been checked and how. If a claim is not on this page, assume it is untested.

## Automated

- **Unit tests** (`npm test`, about 285): the core (ZIP, DEFLATE, BZip2, LZMA, XML, encodings, CSV, number formats,
  formula evaluator) and every parser on the reference files in `test/fixtures` — the same document in each
  format of a family, with results compared across formats. Separately: graphics on files made by Microsoft Office
  (charts, shapes, SmartArt, equations, watermark, conditional formatting, comments, binary ppt), passwords for
  xls/ppt/doc, metafiles, sheet objects in xls and ods, OpenDocument graphics, extraction from archives
  (7z, zip with different methods), rar file lists, sparklines.
- **End-to-end checks in Chrome** (desktop and phone emulation): opening every format, switching sheets, errors,
  truncated and protected files, cancelling an open, a 300,000-row table, a 60-page PDF, ranged PDF loading,
  files inside archives, media playback, copy blocking.
- **Bindings**: the Angular package in applications on Angular 17.3 and 22 (the build made with Angular 17.3;
  the current build, made with Angular 22.3, was linked with the Angular 17.3 linker and its typings were checked
  with TypeScript 5.4), the React binding with React 18 in
  strict mode, the WebView host page over HTTP and from `file://` — all in desktop Chrome, each opening docx, xlsx,
  pptx, pdf, zip, a broken file, and surviving destroy/recreate.

## Checked against real files

- A set of 81 files produced by Microsoft Office 2024 (Word, Excel, PowerPoint in every format, PDF, images, text,
  CSV, edge cases): 76 open; 4 password-protected files open after the password; one file of random bytes named
  `.pdf` opens with nothing. Against reference PDFs from the same Office, marked fragments reach the screen:
  Word 59 of 60 in all four formats (the sixtieth is a tracked deletion, which must not show), Excel 54 of 54,
  PowerPoint all texts.
- Templates and macro-enabled files (dotx, docm, dot, xlsm, xltx, xlt, ppsx, pptm, potx, pps) saved by LibreOffice;
  rar 3 and 5 archives from the rarfile and libarchive test suites; 7z archives made by py7zr; CMS signatures made by OpenSSL.
- Five real-world documents (one xlsx, two docx, two doc): extracted text matches LibreOffice 100 %;
  appearance compared by screenshots.

Reference files in `test/fixtures` were generated with python-docx, openpyxl and python-pptx and re-saved by
LibreOffice into the other formats.

## Independent review

Version 0.7.0 was reviewed independently on 118 files, including documents created by LibreOffice itself and files
the author had not seen. All 118 open (4 after a password, 1 file of random bytes is reported as corrupt). The
status of every finding is in [review-0.7.0.md](./review-0.7.0.md).

## Known weak spots

- **Layout fidelity.** Comparison with Microsoft Office is by presence of text and by selected screenshots.
  Documents are a continuous scroll, not pages; exact layout parity is not a goal.
- **Office 2007 "standard" encryption** and **doc with a 40-bit key** follow the specification but were verified
  only on Office 2024 files (agile AES-256/SHA-512 and RC4 CryptoAPI with a 128-bit key).
- **Excel 5/95 xls** is read by a separate code path that no test file exercises.
- **Graphics** (charts, shapes, SmartArt, equations, conditional formatting, binary ppt) were compared with
  reference PDFs by eye, on one set of Office 2024 files. Newer chart types (Office 2016+) were checked only
  against hand-written XML.
- **ppt** from PowerPoint 97–2003 was not tested.
- **ppt passwords** and **xls with RC4 CryptoAPI**: no genuine Office files were available. Test files are built by
  `test/fixtures/crypto/make-encrypted.py`; the encryption was cross-checked with the msoffcrypto library
  (for ppt only the key check — it cannot decrypt the picture stream).
- **xls XOR obfuscation**: the test file is built by `make-xor.py` and decrypts correctly with msoffcrypto;
  no genuine Excel file was available.
- **RAR**: only the file list is read (versions 3–5, including solid archives, sub-folders and encrypted headers),
  plus files stored without compression. Compressed files are not extracted. Names in the packed Unicode form of
  rar 3–4 were checked on an archive made on Unix and on a hand-built header with a DOS code page name.
- **Metafiles** were compared with LibreOffice renders on three files; no EMF+ files or old WMF clip art.
- **xls charts** take values from sheet cells; a chart referring to another workbook or to named ranges stays empty.
- **Formula-based conditional formatting in xls** was verified on a LibreOffice-saved file, not an Excel one.

## Not tested at all

- Real Android WebView and iOS WKWebView (memory, gestures, speed).
- Pinch zoom on a real touch screen (only Chrome touch emulation).
- Safari and Firefox on desktop.
- A strict Content Security Policy.
- Applications on Angular 17–21 running the current Angular build: it is made with Angular 22.3 and declares
  `>=17.0.0`; linking and typings were checked for 17.3, a running application was not.
- The Flutter example.

Reports from these environments are very welcome — see [CONTRIBUTING.md](../CONTRIBUTING.md).
