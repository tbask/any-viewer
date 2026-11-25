/**
 * React binding for any-viewer: `import { AnyViewer } from 'any-viewer/react'`.
 *
 * The component owns one viewer instance for its lifetime. Changing `source` opens the new file in the same
 * instance; unmounting destroys it. Written with `createElement`, so the package needs no JSX runtime.
 */
import { createElement, forwardRef, useEffect, useImperativeHandle, useRef, type CSSProperties, type ReactElement, type Ref } from 'react';
import { createViewer } from './viewer';
import { ViewerError } from './types';
import type { FileSource, OpenedFileInfo, OpenOptions, Viewer, ViewerOptions } from './types';

export interface AnyViewerProps extends OpenOptions {
  /** The file to show: URL, `File`/`Blob`, `ArrayBuffer` or `Uint8Array`. `null` or `undefined` clears the viewer. */
  source?: FileSource | null;
  /**
   * Viewer options. They are read once, when the component mounts; to apply different options
   * remount the component (for example with a different `key`).
   */
  options?: Omit<ViewerOptions, 'onLoad' | 'onError'>;
  /** Called after a file has been opened and rendered. */
  onLoad?: (info: OpenedFileInfo) => void;
  /** Called when a file could not be opened. */
  onError?: (error: ViewerError) => void;
  className?: string;
  /** The host element needs a height: the viewer fills it. Defaults to `{ height: '100%' }`. */
  style?: CSSProperties;
}

/** What a `ref` on `<AnyViewer>` gives access to. */
export type AnyViewerHandle = Pick<Viewer, 'zoomIn' | 'zoomOut' | 'zoomReset' | 'close'> & {
  /** The underlying viewer, or `null` before mount and after unmount. */
  readonly viewer: Viewer | null;
};

function AnyViewerInner(props: AnyViewerProps, ref: Ref<AnyViewerHandle>): ReactElement {
  const { source, options, onLoad, onError, className, style, name, format, mimeType, password } = props;
  const host = useRef<HTMLDivElement | null>(null);
  const viewer = useRef<Viewer | null>(null);
  const callbacks = useRef({ onLoad, onError });
  callbacks.current = { onLoad, onError };

  useEffect(() => {
    if (!host.current) return;
    // A fresh child element per mount: a shadow root cannot be detached, and React's strict mode mounts twice.
    const mount = document.createElement('div');
    mount.style.cssText = 'width:100%;height:100%';
    host.current.appendChild(mount);
    const created = createViewer(mount, {
      ...options,
      onLoad: (info) => callbacks.current.onLoad?.(info),
      onError: (error) => callbacks.current.onError?.(error),
    });
    viewer.current = created;
    return () => {
      viewer.current = null;
      created.destroy();
      mount.remove();
    };
    // Options are read once by design (see the `options` prop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const current = viewer.current;
    if (!current) return;
    if (source == null) {
      current.close();
      return;
    }
    const openOptions: OpenOptions = { name, format, mimeType, password };
    // Failures are reported through onError; an unhandled rejection here would only add console noise.
    current.open(source, openOptions).catch((error: unknown) => {
      if (!(error instanceof ViewerError)) throw error;
    });
  }, [source, name, format, mimeType, password]);

  useImperativeHandle(
    ref,
    () => ({
      get viewer() {
        return viewer.current;
      },
      zoomIn: () => viewer.current?.zoomIn(),
      zoomOut: () => viewer.current?.zoomOut(),
      zoomReset: () => viewer.current?.zoomReset(),
      close: () => viewer.current?.close(),
    }),
    [],
  );

  return createElement('div', { ref: host, className, style: { height: '100%', ...style } });
}

/** React component that shows a file. See {@link AnyViewerProps}. */
export const AnyViewer = forwardRef<AnyViewerHandle, AnyViewerProps>(AnyViewerInner);
AnyViewer.displayName = 'AnyViewer';

export { ViewerError } from './types';
export type { FileSource, OpenedFileInfo, OpenOptions, Viewer, ViewerOptions } from './types';
