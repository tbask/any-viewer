/*
 * Public API of any-viewer-angular.
 */
export { AnyViewerComponent } from './lib/any-viewer.component';
export { ANY_VIEWER_OPTIONS, provideAnyViewer } from './lib/any-viewer.config';
export type { AnyViewerOptions } from './lib/any-viewer.config';
export type {
  FileFormat,
  FileKind,
  FileSource,
  Labels,
  OpenedFileInfo,
  OpenOptions,
  PdfOptions,
  Viewer,
  ViewerError,
  ViewerErrorCode,
  ViewerLimits,
  ViewerOptions,
} from 'any-viewer';
