# Independent review of 0.7.0 and what 0.9.0 does about it

Version 0.7.0 was reviewed by a team evaluating the library against server-side conversion. They ran 118 files:
a set made by Microsoft Office 2024, a second Word document with 30 more features, a workbook with sparklines,
and documents created by LibreOffice 26.8 itself (odt, ods, odp and their exports). The review listed 72 findings
(D1–D72): 24 of the first 50 were already fixed in 0.7.0, 26 were open or partial, and 22 were new.

This page is the status of the 48 open findings in 0.9.0. "Verified" means checked on the reviewers' own files,
by the parsed model and by screenshots in Chrome; nothing here has been checked by the reviewers yet.

| Status | Count | Findings |
| --- | --- | --- |
| Fixed, verified | 33 | D6, D17–D24, D32, D34–D36, D40, D41, D45, D47, D49–D53, D56–D58, D60–D64, D66, D67, D72 |
| Fixed in part | 11 | D16, D33, D42, D46, D48, D54, D55, D65, D68, D71, D59 |
| Not fixed | 3 | D25, D69, D70 |
| Out of scope | 1 | D26 |

## Fixed in part — what remains

| Finding | Done | Remains |
| --- | --- | --- |
| D16 pictures with wrapping | docx: text flows around the picture; a picture behind text lies behind it | rtf and odt pictures stay inline |
| D33 wrap and rotation in cells | xlsx | xls and ods rotation |
| D42 shape effects | pptx shadows, including theme shadows; odp dashed outlines and routed connectors | volume (3D) is shown as a shadow |
| D46 bullets and numbering | pptx and odp: real bullet characters, numbering kinds, colours; ppt: real bullet characters | automatic numbering in binary ppt |
| D48 WordArt and vertical text in odp | vertical text; Fontwork as large text | WordArt effects; text is not bent along a path |
| D54 text effects | character scale, shadow, outline, glow | reflection |
| D55 legacy form fields | docx check box and drop-down | doc, rtf and odt |
| D59 dates on a chart axis | shown as dates by the stored format | the locale's short date is not substituted for the generic `m/d/yyyy` |
| D65 odp master background | background picture; gradient | the reviewed file names no gradient for its master, so the first gradient of the file is used and the colours differ |
| D68 LibreOffice shapes | outlines, gradients, Fontwork | text colour of shape captions; the flat shapes of the reviewed file are flat in LibreOffice too |
| D71 files exported by LibreOffice | rtf footnotes and endnotes | the value of an input field in doc |

## Not fixed

- **D25** — list numbering and font names in binary doc: items still get bullets.
- **D69** — data bars of LibreOffice conditional formatting in ods.
- **D70** — a star shape on an ods sheet is a rectangle; several formats inside one ods cell.
- **D26** — pagination. Documents are a continuous scroll by design; page layout is not planned.

## What the review got right about process

The fixes before 0.7.0 were checked on the same file set that had exposed the defects, so new files exposed new
ones. Two changes address that:

- Features are now implemented per construct, not per test file — for example all symbol font bullets through one
  mapping table, about 120 preset shapes, every Excel fill pattern, every built-in table style family.
- Unit tests for these features are built from small hand-written inputs (`test/review-fixes.test.ts`), independent
  of any review file.

New files will still find new differences: the formats are large. The honest claim is "what is listed in
[formats.md](./formats.md) works on the files listed in [verification.md](./verification.md)".
