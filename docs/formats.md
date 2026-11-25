# Supported formats

Documents are shown as one continuous scroll, without page breaks. The goal is content that is readable
and recognisable, not a pixel-exact copy of the printed page.

| Format | What is shown | What is not |
| --- | --- | --- |
| jpg, jpeg, png, webp, bmp, gif, svg | The image, with zoom and pan. SVG is shown as an image; scripts inside it do not run | — |
| tiff | Own decoder: uncompressed, LZW, PackBits, Deflate; 1/8/16 bit; first page | JPEG and CCITT fax compression, tiled files, CMYK, further pages |
| heic | Only in browsers that decode it natively (Safari); elsewhere error `unsupported` | An own decoder |
| txt, json, xml, xsd, yaml, sql and other text (dxf, stl, obj, fdf, xfdf) | The source text; JSON is indented | Syntax highlighting; dxf/stl/obj are not visualised |
| html, htm | As a document: headings, paragraphs, lists, tables, emphasis, links; encoding from `<meta charset>`. Scripts, styles, forms, frames and images are dropped; the page makes no network requests. `htmlMode: 'source'` shows the markup | CSS, images, page layout |
| md | Headings, lists, tables, code blocks, emphasis, links | Embedded HTML |
| csv, tsv | A table; delimiter and encoding are detected | — |
| pdf | Pages (PDF.js engine); password-protected files open after the password is entered | Text selection and search, links |
| xlsx, xls, ods (and xlsm, xltx, xltm, xlt) | Sheets, number and date formats, merged cells, borders, bold/italic/underline/strike, font size, colours, alignment, wrapping, column widths and row heights, text overflowing into empty cells, cell comments; fractions, conditional sections and month language in number formats; images, shapes and charts on a sheet. Conditional formatting: colour scales, data bars, icon sets, value rules, top/bottom, above/below average, duplicates, text rules. Sparklines in xlsx. Hidden sheets, rows, columns and collapsed groups are not shown. An `.xls` that is really XML Spreadsheet 2003 or an HTML table opens as a table | Pivot charts, slicers; sparklines outside xlsx; formula-based conditional formatting only for formulas the built-in evaluator understands (same-sheet references, arithmetic, comparisons, about 45 functions); macros never run |
| docx, odt, rtf (and docm, dotx, dotm) | Headings, fonts, emphasis, sizes and colours, lists, tables with merged cells, PNG/JPEG images and EMF/WMF metafiles, links, page breaks; footnotes, endnotes and reviewer comments (at the end), headers and footers (once), text boxes; shapes with outline, fill and text; charts, SmartArt, equations, embedded Excel workbooks (as the snapshot Word saved); WordArt as large text, watermark (docx, odt). Hidden text and tracked deletions are not shown | Curved WordArt, pagination; in rtf, outlines with curves are drawn as rectangles |
| doc (and dot) | The same text features as docx, including paragraph styles and images (inline and floating, EMF/WMF included); charts, SmartArt and equations as the pictures Word saved; shapes with outlines and fills. Password-protected files (RC4 and RC4 CryptoAPI) | Word 6/95, hyperlinks, watermark; list numbers are shown as bullets; font names are not read |
| pptx, odp (and pptm, ppsx, ppsm, potx) | Slides with object positions, text, images (EMF/WMF included), tables, background, layout inheritance, charts, rotation; hidden slides are skipped. In pptx: about 50 preset shapes, gradient fills and backgrounds, transparency, dashes, shadow, arrowheads, elbow and curved connectors, image cropping, vertical text, links, text outline and shadow, SmartArt. In odp: shape outlines computed from the file (any shape), gradients, transparency | In pptx the remaining preset shapes are drawn as rectangles; 3D, glow, animation, video; in odp elbow connectors are drawn straight |
| ppt (and pps, pot) | Slides in show order: text with font, size, colour, emphasis, alignment and bullets of every level, links; shapes (preset and freeform), fills and gradients, transparency, lines, dashes, arrows, elbow connectors, shadow, rotation; groups and tables; PNG/JPEG images with cropping, EMF/WMF metafiles and DIB bitmaps; master styling and background; slide number and date. Charts and SmartArt are stored by PowerPoint as pictures and are shown. Password-protected files. Hidden slides are skipped | LibreOffice shapes with formula-based outlines (except ellipses) are drawn as rectangles; animation, sound |
| eml, mbox, msg | Message headers, body, list of attachments; HTML mail as text | Opening attachments, inline images |
| ics | Events: title, time, place, organiser, description | Recurring events are not expanded |
| zip, tar, gz, tar.gz, rar, 7z (and asice, asics signature containers) | The file list with sizes; a file opens by clicking its row, in the same viewer, with a "back to archive" button (archives inside archives and password-protected documents included). Extraction: zip (Deflate, BZip2, LZMA, stored), tar, gz, 7z (LZMA, LZMA2, BZip2, Deflate, Copy, x86 BCJ filter; solid blocks), rar 2.9–5, i.e. WinRAR 3 and newer (solid archives and filters included; the checksum of every file is verified) | From rar: files compressed with PPMd ("text compression" in WinRAR 3–4), RAR 1.5–2 archives (except stored files), audio and Itanium filters; 7z with PPMd and filters other than x86; encrypted archives; multi-volume rar shows only the opened volume |
| p7s, p7m, sig, cms (CMS / PKCS#7, binary and PEM) | If the document is embedded in the signature, the document itself with who signed it and when above it; a detached signature shows a card: signer, organisation, issuer, certificate validity, time | **The signature is not verified.** XAdES inside asice is not parsed |
| epub | Chapters in order: headings, paragraphs, lists, emphasis, images | The book's CSS, table of contents |
| mp3, wav, m4a, ogg, mp4, webm, mov | The browser's player without a download button. A `File`/`Blob` is read in pieces (limit `maxMediaBytes`, 8 GB). A URL is played directly; if `fetchOptions` has headers or the server does not serve the file the way the player needs, it is downloaded whole (up to `maxFileBytes`) and played from memory. An unknown video codec (for example HEVC from a phone in Chrome) gives a message naming the codec | Formats and codecs the browser does not know (avi, some mov, HEVC in some browsers): error `unsupported`. There is no transcoding |
| dwg | Recognised, not rendered (`not-implemented`) | — |

## Detection by content

The format is detected from the content: a file opens as what it really is. A docx or RTF named `.doc` and a jpg
named `.png` open as usual. When the difference is significant (an Excel workbook named `.docx`), a notice appears
above the content and `onLoad` receives `expectedFormat`. `strictExtension: true` turns any mismatch into the
`mismatch` error, except plain text, which is harmless and shown as text.

## Password-protected files

- docx, xlsx, pptx from Office 2007 onwards (ECMA-376 standard and agile encryption);
- doc, xls, ppt with RC4 CryptoAPI; doc and xls with the older 40-bit RC4; xls with XOR obfuscation;
- pdf (decrypted by PDF.js).

Decryption happens in the browser; the password is not sent anywhere. Key derivation is deliberately slow
(100,000 hash rounds, as the format requires): about half a second on a desktop, several seconds on a weak phone.
Encrypted archives are not decrypted.

## Damaged and empty files

A truncated zip-based file (docx, xlsx, pptx, odt, …) opens as far as it survived, with a "file is damaged" notice
and `damaged: true` in `onLoad`. An empty file is shown as empty. Data that resembles no format gives `corrupt`.

## Windows metafiles

EMF and WMF — vector pictures in older documents and snapshots of embedded objects — are converted to SVG by an own
parser: lines, polygons, curves, arcs, paths, text, bitmaps, rectangular clipping. EMF+ (GDI+) records, pattern
brushes and complex raster operations are not supported.

## Charts

Charts are rebuilt from the values stored in the file, so fonts, spacing and labels differ from Office.
Rare types are approximated: stock and surface as lines, waterfall as columns of increments, funnel as horizontal
bars, treemap and sunburst as a pie of shares, histogram as columns per bin. Box-and-whisker and map charts are not drawn.

## Other limits

- A table cell without wrapping shows the first line of its text; the full text appears in a panel below the table on click.
- Numbers in ods are shown as the editor saved them (in its locale); in xlsx and xls they follow the browser locale or `locale`.
- Document zoom uses the CSS `zoom` property (Firefox supports it from version 126).
- A document becomes DOM as a whole: very large documents (thousands of pages) open slowly.
