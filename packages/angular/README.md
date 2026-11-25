# any-viewer-angular

Angular 17+ component for [any-viewer](https://github.com/tbask/any-viewer) — a client-side file viewer for PDF,
Word, Excel, PowerPoint, OpenDocument, images, archives, e-mail, media and more. No server conversion;
the file never leaves the browser.

```bash
npm install any-viewer any-viewer-angular
```

```ts
import { Component } from '@angular/core';
import { AnyViewerComponent } from 'any-viewer-angular';

@Component({
  standalone: true,
  imports: [AnyViewerComponent],
  template: `
    <div style="height: 80vh">
      <any-viewer [source]="source" (loaded)="loaded($event)" (failed)="failed($event)" />
    </div>
  `,
})
export class PreviewComponent {
  source: string | File = '/files/report.docx';
  loaded(info: { format: string }) {}
  failed(error: { code: string }) {}
}
```

| Input | |
| --- | --- |
| `source` | URL, `File`/`Blob`, `ArrayBuffer`, `Uint8Array`; `null` clears the viewer |
| `name`, `format`, `mimeType`, `password` | Open options |
| `locale` | Language (`en-GB`, `ru-RU`, `kk-KZ`); can change at run time, the interface and the opened file follow |
| `options` | Viewer options, read once when the viewer is created; `{ download: true, print: true }` adds the toolbar buttons |

| Output | |
| --- | --- |
| `loaded` | `OpenedFileInfo` — a file is on screen |
| `failed` | `ViewerError` — a file could not be opened |

## Options

The viewer is view only by default: no download, no printing, no copying. Open up what you need through `options`
(read once, when the component is created) or for the whole application with `provideAnyViewer()`:

```html
<any-viewer [source]="source" [locale]="locale" [options]="{ download: true, print: true, allowCopy: true }" />
```

| Option | Default | |
| --- | --- | --- |
| `download` | `false` | Toolbar button that saves the file |
| `print` | `false` | Toolbar button that prints the file |
| `allowCopy` | `false` | Text selection and copying |
| `suppressSaveUi` | `true` | No context menu, no dragging content out |
| `links` | `'new-tab'` | Links inside files: `'new-tab'` or `'none'` |
| `toolbar` | `true` | Top bar with the file name, pages and zoom |
| `uiLanguage`, `labels` | — | Pin the interface language; your own strings |
| `passwordPrompt` | `true` | Ask for the password of a protected file |
| `pdf.assetsUrl` | — | Folder with PDF.js assets |

All options: <https://github.com/tbask/any-viewer/blob/main/docs/api.md#createviewercontainer-options>

Application-wide defaults:

```ts
import { provideAnyViewer } from 'any-viewer-angular';

bootstrapApplication(AppComponent, {
  providers: [provideAnyViewer({ pdf: { assetsUrl: 'pdfjs/' } })],
});
```

- Standalone component; works in `NgModule` applications through `imports`.
- The viewer core is loaded lazily and runs outside `NgZone`; zoneless and SSR applications are supported.
- Built with Angular 22.3 in partial compilation mode; the declarations link with Angular 17 and newer.

Full guide: <https://github.com/tbask/any-viewer/blob/main/docs/angular.md>

## License

MIT
