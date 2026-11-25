/**
 * Viewer shell: loading the source, detecting the format,
 * lazy loading of the right renderer, the toolbar and states (loading, error).
 */
import { CorruptFileError, detectFile, detectFormat, EncryptedFileError, FormatMismatchError, formatFromMime, formatFromName, isImplemented, kindOf } from './detect';
import { resolveLabels } from './labels';
import { STYLES } from './styles';
import {
  DEFAULT_LIMITS,
  ViewerError,
  type FileFormat,
  type FileSource,
  type Labels,
  type OpenedFileInfo,
  type OpenOptions,
  type SignatureInfo,
  type Viewer,
  type ViewerLimits,
  type ViewerOptions,
} from './types';
import { el, type RenderContext, type RendererFactory, type RendererHandle } from './renderers/types';

/** Renderers are loaded on demand: a user who opens a picture does not download the PDF code. */
const image = () => import('./renderers/image').then((m) => m.createImageRenderer);
const plainText = () => import('./renderers/text').then((m) => m.createTextRenderer);
const table = () => import('./renderers/table').then((m) => m.createTableRenderer);
const documentView = () => import('./renderers/document').then((m) => m.createDocumentRenderer);
const slides = () => import('./renderers/slides').then((m) => m.createSlidesRenderer);
const archive = () => import('./renderers/archive').then((m) => m.createArchiveRenderer);
const media = () => import('./renderers/media').then((m) => m.createMediaRenderer);

const RENDERERS: Partial<Record<FileFormat, () => Promise<RendererFactory>>> = {
  jpg: image, png: image, webp: image, bmp: image, gif: image, svg: image, tiff: image, heic: image,
  txt: plainText, json: plainText, xml: plainText, yaml: plainText, sql: plainText,
  csv: table, xlsx: table, ods: table, xls: table,
  pdf: () => import('./renderers/pdf').then((m) => m.createPdfRenderer),
  docx: documentView, odt: documentView, rtf: documentView, doc: documentView,
  md: documentView, eml: documentView, mbox: documentView, ics: documentView, msg: documentView, epub: documentView,
  pptx: slides, odp: slides, ppt: slides,
  zip: archive, tar: archive, gz: archive, rar: archive, '7z': archive,
  html: documentView,
  p7s: () => import('./renderers/signature').then((m) => m.createSignatureRenderer),
  p7m: () => import('./renderers/signature').then((m) => m.createSignatureRenderer),
  audio: media, video: media,
};

interface ResolvedSource {
  blob: Blob | null;
  url: string | null;
  name: string;
  mimeType?: string;
  size?: number;
  /** Format known without reading the content (PDF by URL). */
  format?: FileFormat;
}

function nameFromUrl(url: string): string {
  try {
    const path = new URL(url, typeof location !== 'undefined' ? location.href : 'http://localhost/').pathname;
    const last = path.slice(path.lastIndexOf('/') + 1);
    return last ? decodeURIComponent(last) : '';
  } catch {
    return '';
  }
}

export function createViewer(container: HTMLElement, options: ViewerOptions = {}): Viewer {
  const labels: Labels = { ...resolveLabels(options.uiLanguage ?? options.locale), ...options.labels };
  const limits: ViewerLimits = { ...DEFAULT_LIMITS, ...options.limits };

  const root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
  const style = el('style');
  style.textContent = STYLES;

  const frame = el('div', 'fv');
  const bar = el('div', 'fv-bar');
  const nameEl = el('span', 'fv-name');
  const pagesEl = el('span', 'fv-pages');
  const zoomBox = el('div', 'fv-zoom');
  const zoomLabel = el('span', 'fv-zoom-label');
  const makeButton = (text: string, label: string, action: () => void) => {
    const b = el('button', 'fv-btn', text);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', action);
    return b;
  };
  zoomBox.append(
    makeButton('−', labels.zoomOut, () => handle?.zoomOut?.()),
    zoomLabel,
    makeButton('+', labels.zoomIn, () => handle?.zoomIn?.()),
    makeButton('⤢', labels.zoomReset, () => handle?.zoomReset?.()),
  );
  // A file opened from an archive: the button returns to the archive file list.
  const parents: { source: FileSource; options: OpenOptions }[] = [];
  const backButton = makeButton('←', labels.backToArchive, () => {
    const parent = parents.pop();
    if (parent) void openInner(parent.source, parent.options).catch(() => undefined);
  });
  backButton.classList.add('fv-back');
  backButton.hidden = true;
  bar.append(backButton, nameEl, pagesEl, zoomBox);
  bar.hidden = options.toolbar === false;

  const notice = el('div', 'fv-notice');
  notice.hidden = true;
  const stage = el('div', 'fv-stage');
  const overlay = el('div', 'fv-overlay');
  overlay.setAttribute('role', 'status');
  overlay.hidden = true;
  stage.appendChild(overlay);
  frame.append(bar, notice, stage);
  root.replaceChildren(style, frame);

  /** What to remove from the container itself when the viewer is destroyed. */
  const cleanups: (() => void)[] = [];
  if (options.allowCopy !== true) {
    // Copy blocking: text cannot be selected and copy events are cancelled, both inside the viewer
    // and on the container (the copy event arrives where the selection is).
    frame.classList.add('fv-nocopy');
    const editable = (e: Event) => {
      const target = e.composedPath()[0];
      return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    };
    const block = (e: Event) => {
      if (!editable(e)) e.preventDefault();
    };
    for (const type of ['copy', 'cut', 'selectstart'] as const) {
      frame.addEventListener(type, block, true);
      container.addEventListener(type, block, true);
      cleanups.push(() => container.removeEventListener(type, block, true));
    }
    frame.addEventListener(
      'keydown',
      (e) => {
        // Ctrl/Cmd + C, X, A, Insert: copy, cut, "select all".
        if (!(e.ctrlKey || e.metaKey) || editable(e)) return;
        const key = e.key.toLowerCase();
        if (key === 'c' || key === 'x' || key === 'a' || key === 'insert' || e.code === 'KeyC' || e.code === 'KeyX' || e.code === 'KeyA') e.preventDefault();
      },
      true,
    );
  }

  // Links inside files: the application may take them over or switch them off, so that a WebView never leaves its page.
  if (options.onLinkClick || options.links === 'none') {
    stage.addEventListener(
      'click',
      (e) => {
        const link = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
        if (!link) return;
        e.preventDefault();
        e.stopPropagation();
        if (options.onLinkClick) options.onLinkClick(link.href);
      },
      true,
    );
    stage.addEventListener('auxclick', (e) => {
      if ((e.target as Element | null)?.closest?.('a[href]')) e.preventDefault();
    });
  }

  if (options.suppressSaveUi !== false) {
    // Remove the obvious ways to save content. This is a UI convenience, not protection.
    stage.addEventListener('contextmenu', (e) => e.preventDefault());
    stage.addEventListener('dragstart', (e) => e.preventDefault());
  }

  let handle: RendererHandle | null = null;
  let host: HTMLDivElement | null = null;

  // Pinch and Ctrl+wheel zoom for documents, tables, slides and text. Images and PDF have their own gesture.
  // While fingers are on the screen the content is stretched as a whole (cheap and smooth), and the real zoom
  // is applied once, when the gesture ends.
  let ownGestures = false;
  let pinchBase = 0;
  let pinchRatio = 1;
  const distance = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  const zoomable = () => !ownGestures && !!handle?.zoomBy && !!host;
  // Listen in the capture phase: the table grid recreates cells, and a gesture started on a vanished cell
  // would otherwise never reach the shell.
  stage.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 2 || !zoomable()) return;
      pinchBase = distance(e);
      pinchRatio = 1;
      const box = host!.getBoundingClientRect();
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - box.left;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - box.top;
      host!.style.transformOrigin = `${cx}px ${cy}px`;
    },
    { passive: true, capture: true },
  );
  stage.addEventListener(
    'touchmove',
    (e) => {
      if (!pinchBase || e.touches.length !== 2 || !host) return;
      // Otherwise the browser or WebView would start zooming the whole page.
      e.preventDefault();
      pinchRatio = Math.min(4, Math.max(0.3, distance(e) / pinchBase));
      host.style.transform = `scale(${pinchRatio})`;
    },
    { passive: false, capture: true },
  );
  const endPinch = () => {
    if (!pinchBase) return;
    pinchBase = 0;
    if (host) {
      host.style.transform = '';
      host.style.transformOrigin = '';
    }
    if (Math.abs(pinchRatio - 1) > 0.03) handle?.zoomBy?.(pinchRatio);
    pinchRatio = 1;
  };
  stage.addEventListener('touchend', endPinch, { capture: true });
  stage.addEventListener('touchcancel', endPinch, { capture: true });
  let wheelSum = 0;
  stage.addEventListener(
    'wheel',
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || ownGestures || !handle?.zoomIn || !handle.zoomOut) return;
      e.preventDefault();
      wheelSum += e.deltaY;
      if (wheelSum <= -40) {
        handle!.zoomIn!();
        wheelSum = 0;
      } else if (wheelSum >= 40) {
        handle!.zoomOut!();
        wheelSum = 0;
      }
    },
    { passive: false },
  );
  let abort: AbortController | null = null;
  let destroyed = false;

  const setText = (node: HTMLElement, text: string | null) => {
    node.textContent = text ?? '';
    node.hidden = !text;
  };

  const resetChrome = () => {
    setText(notice, null);
    setText(pagesEl, null);
    zoomLabel.textContent = '';
    zoomBox.hidden = true;
  };

  const showLoading = () => {
    overlay.replaceChildren(el('div', 'fv-spinner'), el('div', '', labels.loading));
    overlay.hidden = false;
  };

  /** The last opened source: needed to repeat the open with the entered password. */
  let last: { source: FileSource; options: OpenOptions } | null = null;

  const showError = (error: ViewerError) => {
    const promptable = error.code === 'password' && error.passwordState !== 'unsupported' && options.passwordPrompt !== false && last;
    if (!promptable) {
      overlay.replaceChildren(el('div', 'fv-overlay-title', labels.errorTitle), el('div', '', error.message));
      overlay.hidden = false;
      return;
    }
    // A password-protected file is not an error but a question to the user.
    const form = el('form', 'fv-password');
    const input = el('input', 'fv-password-input');
    input.type = 'password';
    input.placeholder = labels.passwordPlaceholder;
    input.setAttribute('aria-label', labels.passwordPlaceholder);
    input.autocomplete = 'off';
    const button = el('button', 'fv-btn fv-password-btn', labels.passwordSubmit);
    button.type = 'submit';
    form.append(input, button);
    const target = last!;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!input.value) return;
      void openInner(target.source, { ...target.options, password: input.value }).catch(() => undefined);
    });
    const message = el('div', error.passwordState === 'wrong' ? 'fv-password-wrong' : '', error.passwordState === 'wrong' ? labels.wrongPassword : '');
    overlay.replaceChildren(el('div', 'fv-overlay-title', labels.passwordProtected), message, form);
    overlay.hidden = false;
    input.focus({ preventScroll: true });
  };

  const passwordError = (state: 'required' | 'wrong' | 'unsupported', format?: FileFormat, cause?: unknown) => {
    const text = state === 'wrong' ? labels.wrongPassword : state === 'unsupported' ? labels.encryptionUnsupported : labels.passwordProtected;
    const error = new ViewerError('password', text, format, cause);
    error.passwordState = state;
    return error;
  };
  /** A parser's password error → a viewer error. */
  const mapPasswordError = (err: unknown, _hadPassword: boolean): ViewerError | null => {
    type Named = { errorName?: string; name?: string };
    const inner = err instanceof ViewerError ? (err as { cause?: Named }).cause : undefined;
    const cause: Named | undefined = inner ?? (err as Named | undefined);
    const name = cause?.errorName ?? cause?.name;
    if (name === 'PasswordRequiredError') return passwordError('required', undefined, err);
    if (name === 'WrongPasswordError') return passwordError('wrong', undefined, err);
    // Parsers that cannot decrypt (archives) report only that a password is present.
    if (name === 'EncryptionUnsupportedError' || (err instanceof ViewerError && err.code === 'password' && !err.passwordState)) return passwordError('unsupported', undefined, err);
    return null;
  };

  const close = () => {
    abort?.abort();
    abort = null;
    try {
      handle?.destroy();
    } catch {
      /* the renderer may already be destroyed */
    }
    handle = null;
    host?.remove();
    host = null;
    resetChrome();
    nameEl.textContent = '';
    overlay.hidden = true;
  };

  const resolveSource = async (source: FileSource, open: OpenOptions, signal: AbortSignal): Promise<ResolvedSource> => {
    if (source instanceof Blob) {
      const fileName = typeof File !== 'undefined' && source instanceof File ? source.name : '';
      return { blob: source, url: null, name: open.name ?? fileName, mimeType: open.mimeType ?? source.type, size: source.size };
    }
    if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
      const blob = new Blob([source as BlobPart]);
      return { blob, url: null, name: open.name ?? '', mimeType: open.mimeType, size: blob.size };
    }
    const url = String(source);
    const name = open.name ?? nameFromUrl(url);
    const hinted = open.format ?? (formatFromName(name) !== 'unknown' ? formatFromName(name) : formatFromMime(open.mimeType));
    // A PDF by URL is not downloaded whole: the engine requests the parts it needs.
    // Audio and video are also handed to the player by URL: it loads the fragments it needs.
    if ((hinted === 'pdf' || hinted === 'audio' || hinted === 'video') && !url.startsWith('blob:') && !url.startsWith('data:')) {
      return { blob: null, url, name, mimeType: open.mimeType, format: hinted };
    }
    let response: Response;
    try {
      response = await fetch(url, { ...options.fetchOptions, signal });
    } catch (err) {
      if (signal.aborted) throw new ViewerError('aborted', 'aborted');
      throw new ViewerError('load-failed', labels.loadFailed, undefined, err);
    }
    if (!response.ok) throw new ViewerError('load-failed', `${labels.loadFailed} (HTTP ${response.status})`);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > limits.maxFileBytes) throw new ViewerError('too-large', labels.tooLarge);
    const blob = await response.blob();
    return {
      blob,
      url: null,
      name,
      mimeType: open.mimeType ?? response.headers.get('content-type') ?? blob.type,
      size: blob.size,
    };
  };

  const openInner = async (source: FileSource, openOptions: OpenOptions = {}): Promise<OpenedFileInfo> => {
    if (destroyed) throw new ViewerError('aborted', 'Viewer destroyed');
    close();
    backButton.hidden = parents.length === 0;
    last = { source, options: { ...openOptions, password: undefined } };
    const controller = new AbortController();
    abort = controller;
    const { signal } = controller;
    const stale = () => signal.aborted;
    showLoading();

    try {
      const src = await resolveSource(source, openOptions, signal);
      if (stale()) throw new ViewerError('aborted', 'aborted');
      nameEl.textContent = src.name;
      nameEl.title = src.name;
      // The player reads audio and video in pieces, so they have their own, much higher size limit.
      const hintedKind = openOptions.format ?? src.format ?? (formatFromName(src.name) !== 'unknown' ? formatFromName(src.name) : formatFromMime(src.mimeType));
      const mediaHint = hintedKind === 'audio' || hintedKind === 'video';
      if (src.blob && src.blob.size > (mediaHint ? limits.maxMediaBytes : limits.maxFileBytes)) throw new ViewerError('too-large', labels.tooLarge);

      let format: FileFormat;
      let expectedFormat: FileFormat | undefined;
      let damaged = false;
      let blob = src.blob;
      const detectIn = async (data: Blob) => {
        const found = await detectFile(data, { name: src.name, mimeType: src.mimeType, strict: options.strictExtension === true });
        expectedFormat = found.expected;
        damaged = found.damaged === true;
        if (found.empty) {
          // An empty file is not an error: show that it is empty.
          const hostEl = el('div', 'fv-host');
          hostEl.appendChild(el('div', 'fv-empty', labels.empty));
          stage.insertBefore(hostEl, overlay);
          host = hostEl;
          overlay.hidden = true;
        }
        return found;
      };
      try {
        if (openOptions.format ?? src.format) format = (openOptions.format ?? src.format)!;
        else {
          let found;
          try {
            found = await detectIn(blob!);
          } catch (err) {
            if (!(err instanceof EncryptedFileError)) throw err;
            // docx, xlsx, pptx with a password: an encrypted archive inside.
            if (openOptions.password === undefined) throw passwordError('required', undefined, err);
            const { decryptOoxml } = await import('./core/office-crypto');
            try {
              blob = new Blob([(await decryptOoxml(blob!, openOptions.password)) as BlobPart]);
            } catch (inner) {
              throw mapPasswordError(inner, true) ?? new ViewerError('corrupt', labels.corrupt, undefined, inner);
            }
            if (stale()) throw new ViewerError('aborted', 'aborted');
            found = await detectIn(blob);
          }
          format = found.format;
          if (found.empty) {
            const info: OpenedFileInfo = { name: src.name, format, kind: kindOf(format), size: 0, empty: true };
            options.onLoad?.(info);
            return info;
          }
        }
      } catch (err) {
        if (err instanceof FormatMismatchError) throw new ViewerError('mismatch', labels.mismatch, err.expected, err);
        if (err instanceof CorruptFileError) throw new ViewerError('corrupt', labels.corrupt, err.expected, err);
        throw err;
      }
      if (stale()) throw new ViewerError('aborted', 'aborted');
      if (format === 'unknown') throw new ViewerError('unsupported', labels.unsupported, format);
      // The permanent part of the notice above the content: the renderer may add its own (about truncation, say).
      let fixedNotice = [
        expectedFormat ? (format === 'txt' ? labels.shownAsText : labels.shownByContent.replace('{format}', format.toUpperCase())) : '',
        damaged ? labels.damagedShown : '',
      ].filter(Boolean).join(' ');
      let renderFormat: FileFormat = format;
      let signature: SignatureInfo | undefined;
      if ((format === 'p7s' || format === 'p7m') && blob) {
        // A signed file: show the document itself, with the signature details as a notice above it.
        try {
          const { parseCms } = await import('./core/cms');
          const cms = parseCms(new Uint8Array(await blob.arrayBuffer()));
          signature = { detached: !cms.content, signers: cms.signers, signingTime: cms.signingTime };
          if (cms.content) {
            const innerBlob = new Blob([cms.content as BlobPart]);
            const innerName = src.name.replace(/\.(p7m|p7s|sig|cms)$/i, '');
            const inner = await detectFormat(innerBlob, { name: innerName });
            if (inner !== 'p7s' && inner !== 'p7m' && RENDERERS[inner] && isImplemented(inner)) {
              blob = innerBlob;
              renderFormat = inner;
              const who = cms.signers.map((s) => [s.name, s.organization].filter(Boolean).join(', ')).filter(Boolean).join('; ');
              fixedNotice = [who && `${labels.signedBy}: ${who}.`, cms.signingTime && `${labels.signedAt}: ${cms.signingTime}.`, labels.signatureNotVerified].filter(Boolean).join(' ');
            }
          }
        } catch (err) {
          throw new ViewerError('corrupt', labels.corrupt, format, err);
        }
        if (stale()) throw new ViewerError('aborted', 'aborted');
      }
      if (renderFormat === 'html' && options.htmlMode === 'source') renderFormat = 'txt';
      const load = RENDERERS[renderFormat];
      if (!load || !isImplemented(renderFormat)) throw new ViewerError('not-implemented', labels.notImplemented, format);

      const factory = await load();
      if (stale()) throw new ViewerError('aborted', 'aborted');

      const hostEl = el('div', 'fv-host');
      stage.insertBefore(hostEl, overlay);
      host = hostEl;
      const ctx: RenderContext = {
        host: hostEl,
        blob,
        url: src.url,
        name: src.name,
        format: renderFormat,
        labels,
        limits,
        options,
        password: openOptions.password,
        signal,
        openEntry: (entryBlob, entryName) => {
          if (stale() || parents.length >= 8) return;
          parents.push({ source, options: { ...openOptions, password: undefined } });
          void openInner(entryBlob, { name: entryName }).catch(() => undefined);
        },
        setNotice: (text) => !stale() && setText(notice, [fixedNotice, text].filter(Boolean).join(' ') || null),
        setPageInfo: (text) => !stale() && setText(pagesEl, text),
        setZoomLabel: (text) => {
          if (!stale()) zoomLabel.textContent = text ?? '';
        },
      };
      if (fixedNotice) setText(notice, fixedNotice);
      let created: RendererHandle;
      try {
        created = await factory(ctx);
      } catch (err) {
        throw mapPasswordError(err, openOptions.password !== undefined) ?? err;
      }
      if (stale()) {
        created.destroy();
        throw new ViewerError('aborted', 'aborted');
      }
      handle = created;
      ownGestures = kindOf(renderFormat) === 'image' || kindOf(renderFormat) === 'pdf';
      zoomBox.hidden = !(created.zoomIn && created.zoomOut);
      overlay.hidden = true;

      const info: OpenedFileInfo = { name: src.name, format, kind: kindOf(format), size: src.size };
      if (expectedFormat) info.expectedFormat = expectedFormat;
      if (signature) info.signature = signature;
      if (damaged) info.damaged = true;
      options.onLoad?.(info);
      return info;
    } catch (err) {
      const error =
        err instanceof ViewerError ? err : new ViewerError('load-failed', labels.loadFailed, undefined, err);
      if (error.code !== 'aborted' && abort === controller) {
        host?.remove();
        host = null;
        resetChrome();
        showError(error);
        options.onError?.(error);
      }
      throw error;
    }
  };

  /** An open from outside starts over: the "archive → file" chain is reset. */
  const open = (source: FileSource, openOptions: OpenOptions = {}): Promise<OpenedFileInfo> => {
    parents.length = 0;
    return openInner(source, openOptions);
  };

  return {
    open,
    close: () => {
      parents.length = 0;
      backButton.hidden = true;
      close();
    },
    destroy() {
      if (destroyed) return;
      for (const undo of cleanups.splice(0)) undo();
      close();
      destroyed = true;
      root.replaceChildren();
    },
    zoomIn: () => handle?.zoomIn?.(),
    zoomOut: () => handle?.zoomOut?.(),
    zoomReset: () => handle?.zoomReset?.(),
  };
}
