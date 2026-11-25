# React

The binding ships inside the main package at `any-viewer/react` and works with React 16.8 and newer
(verified with React 18 in strict mode). React is an optional peer dependency.

```bash
npm install any-viewer
```

```tsx
import { useRef, useState } from 'react';
import { AnyViewer, type AnyViewerHandle } from 'any-viewer/react';

export function Preview() {
  const [file, setFile] = useState<File | null>(null);
  const viewer = useRef<AnyViewerHandle>(null);

  return (
    <>
      <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <button onClick={() => viewer.current?.zoomIn()}>+</button>
      <div style={{ height: '80vh' }}>
        <AnyViewer
          ref={viewer}
          source={file}
          options={{ pdf: { assetsUrl: '/pdfjs/' } }}
          onLoad={(info) => console.log(info.format)}
          onError={(error) => console.warn(error.code)}
        />
      </div>
    </>
  );
}
```

## Props

| Prop | Type | |
| --- | --- | --- |
| `source` | `string \| URL \| Blob \| ArrayBuffer \| Uint8Array \| null` | The file. `null` clears the viewer |
| `name`, `format`, `mimeType`, `password` | | [Open options](./api.md#openoptions) |
| `locale` | `string` | Language as a BCP 47 tag (`en-GB`, `ru-RU`, `kk-KZ`). Can change at any time: the interface switches and the opened file is rendered again without being loaded a second time |
| `options` | `ViewerOptions` without callbacks | [Viewer options](./api.md#createviewercontainer-options). Read once on mount; change `key` to apply new ones |
| `onLoad` | `(info: OpenedFileInfo) => void` | A file is on screen |
| `onError` | `(error: ViewerError) => void` | A file could not be opened |
| `className`, `style` | | Applied to the host `div`. Default style: `height: 100%` |

The `ref` exposes `zoomIn()`, `zoomOut()`, `zoomReset()`, `close()`, `download()`, `print()` and `viewer` (the underlying [`Viewer`](./api.md#viewer)).

## Notes

- **Keep `source` stable.** A new `ArrayBuffer` or `Uint8Array` created on every render reopens the file every
  render. Keep it in state or `useMemo`.
- **The parent needs a height**, as the component fills it.
- **Next.js and other SSR frameworks.** The component touches the DOM only in effects, so it renders an empty
  `div` on the server. In the App Router use it from a client component (`'use client'`).
- **React Native** has no DOM: use the [WebView host page](./flutter.md#react-native).

## Without the binding

```tsx
import { useEffect, useRef } from 'react';
import { createViewer } from 'any-viewer';

export function RawViewer({ url }: { url: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = document.createElement('div');
    mount.style.height = '100%';
    host.current!.appendChild(mount);
    const viewer = createViewer(mount);
    viewer.open(url).catch(() => {});
    return () => {
      viewer.destroy();
      mount.remove();
    };
  }, [url]);

  return <div ref={host} style={{ height: '80vh' }} />;
}
```

A fresh child element per effect matters: a shadow root cannot be detached from an element,
and strict mode runs effects twice.
