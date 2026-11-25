# Flutter example

`lib/any_viewer_view.dart` is a reusable widget around the any-viewer host page, built on
[`webview_flutter`](https://pub.dev/packages/webview_flutter) 4.x.

> This example has not been run on a device. Treat it as a starting point and see
> [docs/flutter.md](../../docs/flutter.md) for the trade-offs.

## Setup

1. Add the dependency:

   ```yaml
   dependencies:
     webview_flutter: ^4.0.0
   ```

2. Either host `dist/standalone/` and `dist/pdfjs/` of the npm package on your server (hosted mode), or copy
   `dist/standalone/viewer.html` and `dist/standalone/any-viewer.global.js` to `assets/any_viewer/` and declare the
   folder in `pubspec.yaml` (bundled mode).

## Use

```dart
// Hosted page, file by URL
AnyViewerView.url(
  pageUrl: Uri.parse('https://app.example.com/any-viewer/standalone/viewer.html'),
  fileUrl: 'https://app.example.com/api/files/42',
  fileName: 'contract.pdf',
  onError: (code, message) => debugPrint('viewer error: $code'),
);

// Bundled page, file as bytes
AnyViewerView.bytes(
  bytes: bytes,
  fileName: 'report.xlsx',
);
```
