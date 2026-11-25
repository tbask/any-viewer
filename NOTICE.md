# Third-party code and data

The project's own code is under the [MIT license](./LICENSE). This file lists everything else that is shipped
or used, and the references the format readers follow.

## Bundled in the published package: PDF.js

PDF files are rendered by **PDF.js** (Mozilla Foundation, Apache-2.0). Its version is pinned in `package.json`
(`pdfjs-dist`) and it is loaded only when a PDF is opened. The build copies the PDF.js license to
`dist/pdfjs/LICENSE` and, unchanged, the resources PDF.js needs at run time. Each comes with its own license
file:

| Files | What | License | License file |
| --- | --- | --- | --- |
| `dist/pdfjs/cmaps` | Adobe CMap resources | BSD 3-Clause | `cmaps/LICENSE` |
| `dist/pdfjs/standard_fonts/Foxit*` | Foxit fonts (PDFium) | BSD 3-Clause | `standard_fonts/LICENSE_FOXIT` |
| `dist/pdfjs/standard_fonts/LiberationSans*` | Liberation Sans fonts (Red Hat) | GPL v2 with font exceptions | `standard_fonts/LICENSE_LIBERATION` |
| `dist/pdfjs/wasm/openjpeg*` | OpenJPEG decoder | BSD 2-Clause | `wasm/LICENSE_OPENJPEG` |
| `dist/pdfjs/wasm/jbig2*` | JBIG2 decoder (PDFium) | BSD 3-Clause | `wasm/LICENSE_JBIG2` |
| `dist/pdfjs/wasm/qcms*` | qcms colour management | MIT | `wasm/LICENSE_QCMS` |
| `dist/pdfjs/wasm/quickjs*` | QuickJS engine | MIT | `wasm/LICENSE_QUICKJS` |
| `dist/pdfjs/wasm/*` | PDF.js bindings for the decoders above | Apache-2.0 | `wasm/LICENSE_PDFJS_*` |
| `dist/pdfjs/iccs` | ICC colour profile | CC0 1.0 | `iccs/LICENSE` |

The fonts and decoders are separate files that PDF.js fetches when a document needs them; they are not compiled
into the library code. An application that does not want to host the Liberation fonts can leave
`dist/pdfjs/standard_fonts` out: PDF.js then substitutes system fonts for PDF fonts that are not embedded.

## Format readers

Everything else in the package is the project's own TypeScript, with no runtime dependencies. The formats are
read as their public descriptions define them:

| Formats | Reference |
| --- | --- |
| zip | PKWARE APPNOTE |
| Deflate, zlib, gzip | RFC 1950, 1951, 1952 |
| tar | POSIX.1 (ustar, pax) |
| 7z, LZMA, LZMA2, x86 BCJ filter | Format description and LZMA specification of the LZMA SDK by Igor Pavlov (public domain) |
| BZip2 | bzip2/libbzip2 by Julian Seward — see below |
| rar | File list only — see below |
| docx, xlsx, pptx | ECMA-376 (Office Open XML) |
| odt, ods, odp | OASIS OpenDocument |
| doc, xls, ppt, msg, EMF, WMF, compound files, Office encryption | Microsoft Open Specifications ([MS-DOC], [MS-XLS], [MS-PPT], [MS-ODRAW], [MS-OXMSG], [MS-EMF], [MS-WMF], [MS-CFB], [MS-OFFCRYPTO]) |
| rtf | Rich Text Format Specification (Microsoft) |
| tiff | TIFF Revision 6.0 (Adobe) |
| eml, mbox, ics | RFC 5322, RFC 2045–2049, RFC 4155, RFC 5545 |
| p7s, p7m | RFC 5652 (CMS), ITU-T X.690 |
| epub | EPUB 3 (W3C) |
| SHA-1, SHA-2, AES, MD5 | FIPS 180-4, FIPS 197, RFC 1321 |

### BZip2

BZip2 has no formal specification: the format is defined by its reference implementation, bzip2/libbzip2.
The decoder in `src/core/bzip2.ts` follows that format, and the bzip2 license is reproduced here:

```
This program, "bzip2", the associated library "libbzip2", and all
documentation, are copyright (C) 1996-2010 Julian R Seward.  All
rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.

2. The origin of this software must not be misrepresented; you must
   not claim that you wrote the original software.  If you use this
   software in a product, an acknowledgment in the product
   documentation would be appreciated but is not required.

3. Altered source versions must be plainly marked as such, and must
   not be misrepresented as being the original software.

4. The name of the author may not be used to endorse or promote
   products derived from this software without specific prior written
   permission.

THIS SOFTWARE IS PROVIDED BY THE AUTHOR ``AS IS'' AND ANY EXPRESS
OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED.  IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE
GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

Julian Seward, jseward@acm.org
bzip2/libbzip2 version 1.1.0 of 6 September 2010
```

### RAR

RAR is a proprietary format of Alexander Roshal / win.rar GmbH. RARLAB publishes the layout of the archive
container ("RAR 5.0 archive format", <https://www.rarlab.com/technote.htm>, and the `technote.txt` distributed
with RAR 3–4) but not the compression algorithm, which is available only as the UnRAR source code under its own
license.

This project reads the container only: it lists the files in a RAR archive and returns files that were stored
without compression. It contains no RAR decompression and no code from UnRAR, so files compressed with RAR are
listed but cannot be opened. For the same reason the packed Unicode form of file names in RAR 3–4 archives is
not decoded; the plain form of the name is shown.

Versions 0.9.0 and 0.10.0 contained a RAR decompressor and were withdrawn.

## Test data (in the repository, not published to npm)

- `test/fixtures/ext/*.rar` — archives from the test suites of the rarfile project (ISC license) and the
  libarchive project (BSD 2-Clause license). Their notices:

  ```
  Copyright (c) 2005-2026 Marko Kreen <markokr@gmail.com>

  Permission to use, copy, modify, and/or distribute this software for any
  purpose with or without fee is hereby granted, provided that the above
  copyright notice and this permission notice appear in all copies.

  THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
  WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
  MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
  ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
  WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
  ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
  OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
  ```

  ```
  The libarchive distribution as a whole is Copyright by Tim Kientzle

  Copyright (c) 2003-2018 <author(s)>
  All rights reserved.

  Redistribution and use in source and binary forms, with or without
  modification, are permitted provided that the following conditions
  are met:
  1. Redistributions of source code must retain the above copyright
     notice, this list of conditions and the following disclaimer
     in this position and unchanged.
  2. Redistributions in binary form must reproduce the above copyright
     notice, this list of conditions and the following disclaimer in the
     documentation and/or other materials provided with the distribution.

  THIS SOFTWARE IS PROVIDED BY THE AUTHOR(S) ``AS IS'' AND ANY EXPRESS OR
  IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES
  OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
  IN NO EVENT SHALL THE AUTHOR(S) BE LIABLE FOR ANY DIRECT, INDIRECT,
  INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
  DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
  THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
  (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
  THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
  ```

- `test/fixtures/office`, `test/fixtures/crypto` — documents made for testing this project in Microsoft Office and
  LibreOffice, with the author metadata replaced by a placeholder.
- The other Office fixtures were generated with python-docx, openpyxl and python-pptx (MIT license);
  the presentation ones keep the metadata of the default python-pptx template.
- In `test/fixtures/ext`, the 7z archives were made with py7zr, the TIFF images and their reference pixels with
  Pillow, and the CMS signatures with OpenSSL.
