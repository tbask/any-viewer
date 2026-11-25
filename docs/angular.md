# Angular

`any-viewer-angular` is a standalone component for **Angular 17 and newer**. It is built in Angular's partial
compilation mode with Angular 17.3 and verified in applications on Angular 17.3 and Angular 22.

## Install

```bash
npm install any-viewer any-viewer-angular
```

## Use

```ts
import { Component } from '@angular/core';
import { AnyViewerComponent, type OpenedFileInfo, type ViewerError } from 'any-viewer-angular';

@Component({
  selector: 'app-preview',
  standalone: true,
  imports: [AnyViewerComponent],
  template: `
    <input type="file" (change)="pick($event)" />
    <div class="frame">
      <any-viewer [source]="source" [name]="name" (loaded)="onLoaded($event)" (failed)="onFailed($event)" />
    </div>
  `,
  styles: ['.frame { height: 80vh; }'],
})
export class PreviewComponent {
  source: File | string | null = null;
  name?: string;

  pick(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) {
      this.source = file;
      this.name = file.name;
    }
  }

  onLoaded(info: OpenedFileInfo) {
    console.log(info.format, info.kind);
  }

  onFailed(error: ViewerError) {
    console.warn(error.code, error.message);
  }
}
```

`<any-viewer>` is a block that takes the full height of its parent, so the parent needs a height.

In an `NgModule`-based application add the component to `imports` of the module:

```ts
@NgModule({ imports: [AnyViewerComponent] })
export class PreviewModule {}
```

## Inputs and outputs

| Input | Type | |
| --- | --- | --- |
| `source` | `string \| URL \| Blob \| ArrayBuffer \| Uint8Array \| null` | The file. `null` clears the viewer |
| `name` | `string` | File name: toolbar and format hint |
| `format` | `FileFormat` | Explicit format |
| `mimeType` | `string` | MIME type |
| `password` | `string` | Password for a protected file |
| `locale` | `string` | Language as a BCP 47 tag: `en-GB`, `ru-RU`, `kk-KZ`. Can change at any time — see [Switching the language](#switching-the-language) |
| `options` | `AnyViewerOptions` | [Viewer options](./api.md#createviewercontainer-options) without `onLoad`/`onError`. Read once, when the viewer is created |

| Output | Payload | |
| --- | --- | --- |
| `loaded` | `OpenedFileInfo` | A file is on screen |
| `failed` | `ViewerError` | A file could not be opened |

Methods available through a template reference or `@ViewChild`: `zoomIn()`, `zoomOut()`, `zoomReset()`, `close()`,
`download()`, `print()`,
and the `instance` getter with the underlying [`Viewer`](./api.md#viewer) (`null` until it has been created).

```html
<any-viewer #viewer [source]="source" />
<button (click)="viewer.zoomIn()">+</button>
```

A new file opens whenever `source`, `name`, `format`, `mimeType` or `password` changes. To reopen the same
source, call `viewer.instance?.open(...)`.

## Switching the language

The interface has English, Russian and Kazakh built in. Bind `locale` to the language of your application:

```html
<any-viewer [source]="source" [locale]="currentLocale" />
```

When the value changes, the toolbar and messages switch at once and the opened file is rendered again with the
new number and date formats — from the data already loaded, without another request and without a second
`loaded` event. Scroll position and zoom are reset. `kz-KZ` is accepted and read as `kk-KZ`.

For any other language pass your own strings through `options.labels`.

## Download, print and copying

The viewer is view only by default: `download`, `print` and `allowCopy` are all `false`, and `suppressSaveUi`
(no context menu, no dragging out) is `true`. The full list of options with defaults is in the
[API reference](./api.md#createviewercontainer-options).

The buttons are off by default. Switch them on where they make sense — typically on desktop:

```html
<any-viewer [source]="source" [options]="{ download: isDesktop, print: isDesktop }" />
```

`options` is read once, so decide before the component is created. The `download()` and `print()` methods work
with or without the buttons, for your own toolbar. What is printed for each format: [API reference](./api.md#printing).

## Application-wide defaults

```ts
// app.config.ts
import { ApplicationConfig } from '@angular/core';
import { provideAnyViewer } from 'any-viewer-angular';

export const appConfig: ApplicationConfig = {
  providers: [
    provideAnyViewer({
      pdf: { assetsUrl: 'pdfjs/' },
      uiLanguage: 'en',
      allowCopy: false,
    }),
  ],
};
```

`[options]` on a component is merged over these defaults (shallowly: a `pdf` object replaces the default `pdf` object).

## PDF.js assets

Add the folder to `assets` in `angular.json`:

```json
{
  "glob": "**/*",
  "input": "node_modules/any-viewer/dist/pdfjs",
  "output": "pdfjs"
}
```

and pass `pdf: { assetsUrl: 'pdfjs/' }` as shown above. See [why they are needed](./getting-started.md#pdfjs-assets).

## Authorization

An Angular `HttpInterceptor` does not apply: the viewer loads files with `fetch`. Either pass headers,

```ts
provideAnyViewer({
  fetchOptions: { headers: { Authorization: `Bearer ${token}` } },
  pdf: { httpHeaders: { Authorization: `Bearer ${token}` } },
});
```

or load the file through `HttpClient` yourself and pass the `Blob`:

```ts
this.http.get(url, { responseType: 'blob' }).subscribe((blob) => (this.source = blob));
```

Options are read once per component, so with tokens that expire the `Blob` approach is the simpler one.

## How it behaves

- **Lazy.** The viewer core is imported dynamically when the first `<any-viewer>` is rendered; format code is
  loaded when a file of that format is opened. Nothing is added to the initial bundle except the small wrapper.
- **Outside the zone.** The viewer runs outside `NgZone`; only `loaded` and `failed` re-enter it. Zoneless
  applications work as well.
- **Server-side rendering.** On the server the component renders an empty host element; the viewer starts in the browser.
- **Bundle size.** The lazy chunks are large (the PDF.js worker is about 1.6 MB raw), but they are not part of the
  initial bundle and are downloaded only when a file of that format is opened.

## Without the wrapper

The core works in Angular directly, if you prefer no extra package:

```ts
import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild } from '@angular/core';
import { createViewer, type Viewer } from 'any-viewer';

@Component({ standalone: true, selector: 'app-raw', template: '<div #host style="height: 80vh"></div>' })
export class RawComponent implements AfterViewInit, OnDestroy {
  @ViewChild('host') host!: ElementRef<HTMLElement>;
  private viewer?: Viewer;

  ngAfterViewInit() {
    this.viewer = createViewer(this.host.nativeElement);
    void this.viewer.open('/files/report.xlsx').catch(() => {});
  }

  ngOnDestroy() {
    this.viewer?.destroy();
  }
}
```
