import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/widgets.dart';
import 'package:webview_flutter/webview_flutter.dart';

/// Shows a file with any-viewer inside a WebView.
///
/// Two modes:
///  * [AnyViewerView.url] loads the host page from your server and opens a file by URL;
///  * [AnyViewerView.bytes] loads the host page bundled with the app and passes the file as bytes.
class AnyViewerView extends StatefulWidget {
  /// Hosted page, file by URL. [fileUrl] must be reachable from [pageUrl] (same origin or CORS).
  const AnyViewerView.url({
    super.key,
    required Uri this.pageUrl,
    required String this.fileUrl,
    this.fileName,
    this.language,
    this.onLoad,
    this.onError,
  })  : bytes = null,
        assetPath = null;

  /// Bundled page, file as bytes. [assetPath] is the Flutter asset key of `viewer.html`.
  const AnyViewerView.bytes({
    super.key,
    required Uint8List this.bytes,
    required String this.fileName,
    this.assetPath = 'assets/any_viewer/viewer.html',
    this.language,
    this.onLoad,
    this.onError,
  })  : pageUrl = null,
        fileUrl = null;

  final Uri? pageUrl;
  final String? fileUrl;
  final Uint8List? bytes;
  final String? assetPath;
  final String? fileName;

  /// Interface language: `en` or `ru`. Defaults to the WebView language.
  final String? language;

  /// Called with the detected format (`docx`, `pdf`, ...) when the file is on screen.
  final void Function(String format)? onLoad;

  /// Called with the error code (`unsupported`, `password`, `corrupt`, ...) and a developer-facing message.
  final void Function(String code, String message)? onError;

  @override
  State<AnyViewerView> createState() => _AnyViewerViewState();
}

class _AnyViewerViewState extends State<AnyViewerView> {
  late final WebViewController _controller;
  bool _ready = false;

  @override
  void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..addJavaScriptChannel('AnyViewerChannel', onMessageReceived: _onMessage);

    final pageUrl = widget.pageUrl;
    if (pageUrl != null) {
      _controller.loadRequest(pageUrl.replace(queryParameters: {
        ...pageUrl.queryParameters,
        'src': widget.fileUrl!,
        if (widget.fileName != null) 'name': widget.fileName!,
        if (widget.language != null) 'lang': widget.language!,
      }));
    } else {
      _controller.loadFlutterAsset(widget.assetPath!);
    }
  }

  @override
  void didUpdateWidget(AnyViewerView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!_ready) return;
    if (widget.bytes != null && !identical(widget.bytes, oldWidget.bytes)) {
      _openBytes();
    } else if (widget.fileUrl != null && widget.fileUrl != oldWidget.fileUrl) {
      _run('AnyViewerHost.open(${jsonEncode({'url': widget.fileUrl, 'name': widget.fileName})})');
    }
  }

  void _onMessage(JavaScriptMessage message) {
    final Object? decoded;
    try {
      decoded = jsonDecode(message.message);
    } on FormatException {
      return;
    }
    if (decoded is! Map<String, dynamic>) return;
    switch (decoded['type']) {
      case 'ready':
        _ready = true;
        if (widget.bytes != null) _openBytes();
      case 'load':
        widget.onLoad?.call('${decoded['format']}');
      case 'error':
        widget.onError?.call('${decoded['code']}', '${decoded['message']}');
    }
  }

  void _openBytes() {
    // Base64 through runJavaScript suits files up to a few megabytes; use the hosted mode for larger ones.
    final request = jsonEncode({'base64': base64Encode(widget.bytes!), 'name': widget.fileName});
    _run('AnyViewerHost.open($request)');
  }

  Future<void> _run(String script) => _controller.runJavaScript(script);

  @override
  Widget build(BuildContext context) => WebViewWidget(controller: _controller);
}
