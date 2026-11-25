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
| `options` | Viewer options, read once when the viewer is created |

| Output | |
| --- | --- |
| `loaded` | `OpenedFileInfo` — a file is on screen |
| `failed` | `ViewerError` — a file could not be opened |

Application-wide defaults:

```ts
import { provideAnyViewer } from 'any-viewer-angular';

bootstrapApplication(AppComponent, {
  providers: [provideAnyViewer({ pdf: { assetsUrl: 'pdfjs/' } })],
});
```

- Standalone component; works in `NgModule` applications through `imports`.
- The viewer core is loaded lazily and runs outside `NgZone`; zoneless and SSR applications are supported.
- Built with Angular 17.3 in partial compilation mode; verified on Angular 17.3 and 22.

Full guide: <https://github.com/tbask/any-viewer/blob/main/docs/angular.md>

## License

MIT
