import { isPlatformBrowser } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  NgZone,
  OnChanges,
  OnDestroy,
  Output,
  PLATFORM_ID,
  SimpleChanges,
  inject,
} from '@angular/core';
import type { FileFormat, FileSource, OpenedFileInfo, Viewer, ViewerError } from 'any-viewer';
import { ANY_VIEWER_OPTIONS, type AnyViewerOptions } from './any-viewer.config';

/**
 * Shows a file: PDF, Word, Excel, PowerPoint, OpenDocument, images, archives and the other formats of any-viewer.
 *
 * ```html
 * <any-viewer [source]="file" (loaded)="onLoaded($event)" (failed)="onFailed($event)" />
 * ```
 *
 * The host element is a block that fills the height of its parent, so give the parent (or the element itself)
 * a height. The viewer core is loaded lazily in the browser; on the server the component renders an empty element.
 */
@Component({
  selector: 'any-viewer',
  standalone: true,
  template: '',
  styles: [':host { display: block; height: 100%; }'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AnyViewerComponent implements AfterViewInit, OnChanges, OnDestroy {
  /** The file to show: URL, `File`/`Blob`, `ArrayBuffer` or `Uint8Array`. `null` clears the viewer. */
  @Input() source: FileSource | null | undefined;
  /** File name: shown in the toolbar and used as a hint when detecting the format. */
  @Input() name: string | undefined;
  /** Explicit format; turns format detection off. */
  @Input() format: FileFormat | undefined;
  /** MIME type, when known. */
  @Input() mimeType: string | undefined;
  /** Password for a protected file. Without it the viewer asks the user. */
  @Input() password: string | undefined;
  /**
   * Viewer options, merged over the defaults from `provideAnyViewer()`. They are read once, when the viewer
   * is created; to apply different options recreate the component (for example with `@if`).
   */
  @Input() options: AnyViewerOptions | undefined;

  /** Emits after a file has been opened and rendered. */
  @Output() readonly loaded = new EventEmitter<OpenedFileInfo>();
  /** Emits when a file could not be opened. */
  @Output() readonly failed = new EventEmitter<ViewerError>();

  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);
  private readonly zone = inject(NgZone);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly defaults = inject(ANY_VIEWER_OPTIONS, { optional: true });

  private viewer: Viewer | null = null;
  private mount: HTMLElement | null = null;
  private destroyed = false;

  /** The underlying viewer, or `null` until it has been created (it is created asynchronously after the view is ready). */
  get instance(): Viewer | null {
    return this.viewer;
  }

  ngAfterViewInit(): void {
    if (!this.isBrowser) return;
    // The viewer listens to scroll, pointer and resize events; none of them should trigger change detection.
    this.zone.runOutsideAngular(() => {
      void import('any-viewer').then(({ createViewer }) => {
        if (this.destroyed) return;
        const mount = document.createElement('div');
        mount.style.cssText = 'width:100%;height:100%';
        this.host.nativeElement.appendChild(mount);
        this.mount = mount;
        this.viewer = createViewer(mount, {
          ...this.defaults,
          ...this.options,
          onLoad: (info) => this.zone.run(() => this.loaded.emit(info)),
          onError: (error) => this.zone.run(() => this.failed.emit(error)),
        });
        this.open();
      });
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.viewer) return;
    if (changes['source'] || changes['name'] || changes['format'] || changes['mimeType'] || changes['password']) this.open();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.viewer?.destroy();
    this.viewer = null;
    this.mount?.remove();
    this.mount = null;
  }

  zoomIn(): void {
    this.viewer?.zoomIn();
  }

  zoomOut(): void {
    this.viewer?.zoomOut();
  }

  zoomReset(): void {
    this.viewer?.zoomReset();
  }

  /** Closes the current file and frees its resources; the component stays usable. */
  close(): void {
    this.viewer?.close();
  }

  private open(): void {
    const viewer = this.viewer;
    if (!viewer) return;
    if (this.source == null) {
      viewer.close();
      return;
    }
    const source = this.source;
    this.zone.runOutsideAngular(() => {
      // Failures arrive through `failed`; the rejection is swallowed so it does not surface as an unhandled error.
      viewer.open(source, { name: this.name, format: this.format, mimeType: this.mimeType, password: this.password }).catch(() => undefined);
    });
  }
}
