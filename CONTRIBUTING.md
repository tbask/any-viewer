# Contributing

Thank you for helping. The most useful contributions, in order:

1. **A file that opens wrongly**, attached to an issue. Parsers improve only on real files.
2. **A report from an untested environment**: Safari, Firefox, Android WebView, iOS WKWebView, Flutter.
   See [docs/verification.md](./docs/verification.md) for the list.
3. Code.

## Reporting a bug

Open an issue with:

- the file, if you may share it (remove anything confidential first — a minimal file that still shows the problem is ideal);
- what you expected and what you see; a screenshot of the file in its native application helps a lot;
- browser and version, operating system, package version;
- the error `code`, if there is one.

Never attach files with personal or confidential data. For security problems see [SECURITY.md](./SECURITY.md).

## Development setup

Node.js 22 or newer.

```bash
git clone https://github.com/tbask/any-viewer.git
cd any-viewer
npm install
npm run dev        # demo page at http://localhost:5173
npm test           # unit tests (Vitest)
npm run typecheck
npm run build      # dist/
```

The Angular package is a separate project with its own dependencies:

```bash
npm run build                  # the core must be built first
cd packages/angular
npm install
npm run build                  # packages/angular/dist
```

### Fixtures

Test files live in `test/fixtures`. The documents in `test/fixtures/office` were made in Microsoft Office and
LibreOffice for this project; their author metadata was replaced with the placeholder `Test Test`. The password of
every protected fixture is `test123`. `test/fixtures/crypto` has the scripts that build the protected binary files.

Before adding a fixture, remove personal data from it: author and "last saved by" fields, comment and revision
authors, absolute paths, account identifiers.

## Project layout

```
src/
  index.ts        public API
  viewer.ts       shell: loading, format detection, toolbar, states
  detect.ts       format detection
  react.ts        React binding
  standalone.ts   entry of the single-file build
  core/           containers and codecs (zip, inflate, bzip2, lzma, rar, 7z, cfb, xml), crypto,
                  number formats, formulas, metafiles; the workbook, document, slide and chart models
  formats/        parsers: xlsx, xls, ods, docx, doc, odt, rtf, pptx, ppt, odp, mail, epub, …
  renderers/      DOM renderers for each kind of content
  workers/        Web Worker entry points
packages/angular/ Angular wrapper (ng-packagr)
standalone/       WebView host page
examples/         Flutter example
test/             unit tests and fixtures
demo/             demo page
docs/             documentation
```

## Guidelines

- **No runtime dependencies.** PDF.js is the single exception. A new dependency needs a very good reason.
- **No `innerHTML`** or other string-to-DOM APIs; content from files goes in as text nodes and attributes.
- **Every parser change comes with a test** on a fixture. Keep fixtures small, and only add files you have the right
  to publish; note their origin in [NOTICE.md](./NOTICE.md) if they are not your own.
- **Fail closed.** If a structure is not understood, skip it or throw a `ViewerError`; never show garbled content
  as if it were correct.
- **Say what is not verified.** If you could not test something on a genuine file, add it to `docs/verification.md`.
- TypeScript strict mode, English comments, two-space indentation (see `.editorconfig`).

## Pull requests

- One topic per pull request; describe what changed and how you verified it.
- `npm run check` must pass.
- Add a line to `CHANGELOG.md` under an `Unreleased` heading.

## Releasing (maintainers)

1. Update the version in `package.json` and `packages/angular/package.json` (and the `any-viewer` peer range there),
   and move the changelog entries under the new version.
2. Commit, tag `vX.Y.Z`, push the tag.
3. The `release` workflow publishes both packages to npm. See the comments in `.github/workflows/release.yml`
   for the one-time npm setup.

By contributing you agree that your contribution is licensed under the [MIT License](./LICENSE).
