# Flutter and other WebViews

Flutter, React Native and native apps show the viewer inside a WebView. The package contains everything for that
in `dist/standalone/`:

| File | |
| --- | --- |
| `viewer.html` | A ready host page: creates the viewer, accepts commands, reports events |
| `any-viewer.global.js` | The whole library as one classic script (global `AnyViewer`), about 2.6 MB / 880 kB gzipped |
| `../pdfjs/` | Optional [PDF.js assets](./getting-started.md#pdfjs-assets) |

> **Not tested on devices.** The host page is verified in desktop Chrome, both over HTTP and from `file://`.
> It has not been run in a real Android WebView or iOS WKWebView yet. Test on your target devices before release
> and please report what you find.

## The host page

### Opening a file

1. **URL parameters** — `viewer.html?src=<url>&name=<file name>`
2. **JavaScript call** — `AnyViewerHost.open({ url, name })` or `AnyViewerHost.open({ base64, name })`
3. **`postMessage`** — `{ "type": "open", "url" | "base64": …, "name": … }` (object or JSON string)

| URL parameter | |
| --- | --- |
| `src` | URL of the file |
| `name` | File name (toolbar, format hint) |
| `format` | Explicit format |
| `lang` | `en` or `ru`; default is the WebView language |
| `toolbar=0` | Hide the toolbar |
| `copy=1` | Allow text selection and copying |
| `pdfAssets` | URL of the `pdfjs/` folder; default `../pdfjs/` relative to the page |

`AnyViewerHost` also has `close()`, `zoomIn()`, `zoomOut()`, `zoomReset()` and `viewer` (the [`Viewer`](./api.md#viewer)).

### Events

The page sends JSON strings to the first bridge it finds: a JavaScript channel named `AnyViewerChannel`
(Flutter `webview_flutter`), `window.ReactNativeWebView`, a `flutter_inappwebview` handler named `AnyViewer`,
or the parent window (iframe).

```json
{ "type": "ready" }
{ "type": "load", "name": "report.docx", "format": "docx", "kind": "document", "size": 48211 }
{ "type": "error", "code": "password", "message": "…", "passwordState": "required" }
```

## Option A — host the page on your server (recommended)

Copy `dist/standalone/` and `dist/pdfjs/` to your web server and load the page by URL. The page then has a normal
HTTPS origin: workers, `fetch` and PDF.js assets behave exactly as in a browser.

```dart
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

class FileViewerPage extends StatefulWidget {
  const FileViewerPage({super.key, required this.fileUrl, required this.fileName});
  final String fileUrl;
  final String fileName;

  @override
  State<FileViewerPage> createState() => _FileViewerPageState();
}

class _FileViewerPageState extends State<FileViewerPage> {
  late final WebViewController _controller;

  @override
  void initState() {
    super.initState();
    final page = Uri.parse('https://app.example.com/any-viewer/standalone/viewer.html').replace(
      queryParameters: {'src': widget.fileUrl, 'name': widget.fileName, 'lang': 'en'},
    );
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..addJavaScriptChannel('AnyViewerChannel', onMessageReceived: _onMessage)
      ..loadRequest(page);
  }

  void _onMessage(JavaScriptMessage message) {
    final event = jsonDecode(message.message) as Map<String, dynamic>;
    switch (event['type']) {
      case 'load':
        debugPrint('opened ${event['format']}');
      case 'error':
        debugPrint('failed: ${event['code']}');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.fileName)),
      body: WebViewWidget(controller: _controller),
    );
  }
}
```

The file URL must be reachable from the page: same origin, or with CORS headers. For files behind a token see
[Files that need authorization](#files-that-need-authorization).

## Option B — bundle the page with the app

Works offline and needs no server, at the price of the `file://` origin.

1. Copy `dist/standalone/viewer.html` and `any-viewer.global.js` to `assets/any_viewer/` and list the folder in `pubspec.yaml`:

   ```yaml
   flutter:
     assets:
       - assets/any_viewer/
   ```

2. Load the page and pass the file as bytes after the `ready` event:

   ```dart
   _controller = WebViewController()
     ..setJavaScriptMode(JavaScriptMode.unrestricted)
     ..addJavaScriptChannel('AnyViewerChannel', onMessageReceived: (message) {
       final event = jsonDecode(message.message) as Map<String, dynamic>;
       if (event['type'] == 'ready') _open(bytes, 'report.docx');
     })
     ..loadFlutterAsset('assets/any_viewer/viewer.html');

   Future<void> _open(Uint8List bytes, String name) {
     final request = jsonEncode({'base64': base64Encode(bytes), 'name': name});
     return _controller.runJavaScript('AnyViewerHost.open($request)');
   }
   ```

Limits of this option:

- A page from `file://` usually cannot `fetch` other local files or cross-origin URLs, so pass bytes, not URLs.
  PDF.js assets are affected too: PDFs that need them (scans with JPEG 2000 / JBIG2, non-embedded fonts) may
  render incompletely.
- Base64 through `runJavaScript` suits files up to a few megabytes. For larger files prefer Option A, or serve the
  assets from a local HTTP server inside the app (for example `InAppLocalhostServer` of `flutter_inappwebview`)
  and pass a URL.

A complete widget is in [`examples/flutter`](../examples/flutter).

## Files that need authorization

- **Cookies**: if the WebView shares the session with your backend, a same-origin `src` just works.
- **Token**: download the file in Dart with your HTTP client and pass the bytes (`base64`), or
  give the page a short-lived signed URL.
- The host page does not accept headers by design: a token in a page URL ends up in logs.
  If you need `fetchOptions`, copy `viewer.html` and adjust the `createViewer` call — the page is forty lines of script.

## React Native

```tsx
import { WebView } from 'react-native-webview';

<WebView
  source={{ uri: 'https://app.example.com/any-viewer/standalone/viewer.html?src=' + encodeURIComponent(fileUrl) }}
  onMessage={(event) => {
    const message = JSON.parse(event.nativeEvent.data);
    if (message.type === 'error') console.warn(message.code);
  }}
/>;
```

## Native Android and iOS

Load the page in `WebView` / `WKWebView` and call `AnyViewerHost.open(...)` with `evaluateJavascript` /
`evaluateJavaScript`. To receive events on Android, add a JavaScript interface named `AnyViewerChannel` with a
`postMessage(String)` method. On iOS a script message handler lives at `webkit.messageHandlers`, which the page
does not look at; either poll, or add one line to your copy of `viewer.html`:
`window.AnyViewerChannel = { postMessage: (t) => webkit.messageHandlers.AnyViewer.postMessage(t) };`.

## Things to check on devices

- Memory on large PDFs and images; lower [`limits`](./api.md#limits) if the WebView is killed.
- Pinch zoom and scrolling inside the WebView next to native gestures.
- Video: iOS needs `allowsInlineMediaPlayback`; a strict CSP needs `media-src blob:`.
- Android: keep the system WebView reasonably current (ES2020 is required).
