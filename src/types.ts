/** A specific file format. Variants are folded together: templates and macro-enabled files report docx/xlsx/pptx and so on. */
export type FileFormat =
  | 'jpg' | 'png' | 'webp' | 'bmp' | 'gif' | 'svg' | 'tiff' | 'heic'
  | 'txt' | 'md' | 'json' | 'xml' | 'html' | 'yaml' | 'sql' | 'csv' | 'pdf'
  | 'docx' | 'doc' | 'odt' | 'rtf'
  | 'xlsx' | 'xls' | 'ods'
  | 'pptx' | 'ppt' | 'odp'
  | 'eml' | 'mbox' | 'ics' | 'msg'
  | 'zip' | 'tar' | 'gz' | 'rar' | '7z' | 'epub'
  | 'audio' | 'video'
  | 'dwg' | 'p7s' | 'p7m'
  | 'unknown';

/** Format family: decides which renderer shows the file. */
export type FileKind = 'image' | 'text' | 'table' | 'pdf' | 'document' | 'slides' | 'archive' | 'media' | 'signature' | 'unknown';

export type FileSource = string | URL | Blob | ArrayBuffer | Uint8Array;

export interface Labels {
  loading: string;
  errorTitle: string;
  unsupported: string;
  notImplemented: string;
  loadFailed: string;
  tooLarge: string;
  truncatedText: string;
  truncatedRows: string;
  zoomIn: string;
  zoomOut: string;
  zoomReset: string;
  page: string;
  slide: string;
  chart: string;
  object: string;
  of: string;
  passwordProtected: string;
  empty: string;
  mismatch: string;
  mediaUnsupported: string;
  /** A video codec the browser cannot play; "{codec}" is replaced with its name. */
  mediaCodecUnsupported: string;
  imageUnsupported: string;
  fileName: string;
  fileSize: string;
  /** Unit names for file sizes: bytes, kilobytes, megabytes, gigabytes. */
  sizeUnits: readonly [string, string, string, string];
  /** Decimal separator in file sizes. */
  decimalSeparator: string;
  /** Button that returns from an opened file to the archive file list. */
  backToArchive: string;
  /** A file could not be extracted from the archive. */
  archiveEntryFailed: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  attachments: string;
  location: string;
  header: string;
  footer: string;
  footnotes: string;
  endnotes: string;
  comments: string;
  /** A text file under a foreign extension is shown as text. */
  shownAsText: string;
  /** {format} is replaced with the format name. */
  shownByContent: string;
  damagedShown: string;
  passwordPlaceholder: string;
  passwordSubmit: string;
  wrongPassword: string;
  encryptionUnsupported: string;
  corrupt: string;
  signedBy: string;
  signedAt: string;
  signatureNotVerified: string;
  signatureDetached: string;
  signer: string;
  organization: string;
  serialNumber: string;
  issuer: string;
  validity: string;
}

export interface PdfOptions {
  /**
   * Base URL of the folder with PDF.js static assets (cmaps/, standard_fonts/, wasm/, iccs/).
   * In the package it is dist/pdfjs. Most PDFs open without it,
   * but files with non-embedded fonts, CJK and JPEG 2000 / JBIG2 may render incompletely.
   */
  assetsUrl?: string;
  /** URL of an external PDF.js worker file. By default the worker is bundled. */
  workerSrc?: string;
  /** Headers for PDF requests by URL (for example Authorization). */
  httpHeaders?: Record<string, string>;
  withCredentials?: boolean;
}

export interface ViewerLimits {
  /** Maximum file size in bytes the library will attempt to open at all. */
  maxFileBytes: number;
  /** Maximum size of audio and video opened from a File or Blob: the player reads them in pieces without holding them in memory. */
  maxMediaBytes: number;
  /** How many bytes of a text file to show (the rest is cut off with a notice). */
  maxTextBytes: number;
  /** Maximum size of a table (csv) in bytes. */
  maxTableBytes: number;
  /** Maximum number of table rows shown. */
  maxTableRows: number;
  /** Maximum image pixels decoded at full size; larger images are downscaled. */
  maxImagePixels: number;
  /** Maximum pixels of one PDF page canvas. */
  maxCanvasPixels: number;
  /** Cap on devicePixelRatio when rendering. */
  maxPixelRatio: number;
}

export interface ViewerOptions {
  /** Whether to show the top bar (file name, zoom, pages). Default: true. */
  toolbar?: boolean;
  /**
   * Interface language: `'en'` or `'ru'` (a full tag such as `ru-RU` also works). By default it follows `locale`,
   * and without `locale` the browser language; anything but Russian gives English.
   */
  uiLanguage?: string;
  /** Overrides for individual interface strings, applied on top of the language chosen by `uiLanguage`. */
  labels?: Partial<Labels>;
  limits?: Partial<ViewerLimits>;
  pdf?: PdfOptions;
  /** fetch options for loading by URL (credentials, headers and so on). */
  fetchOptions?: RequestInit;
  /**
   * Language for numbers and dates in tables and charts (BCP 47, for example `en-GB`): group separators, month names,
   * the short date pattern. Default: the browser language.
   */
  locale?: string;
  /** Encoding for text that is neither UTF-8 nor UTF-16. Default: windows-1251. */
  fallbackEncoding?: string;
  /**
   * Turns off the context menu and dragging content out.
   * This removes the obvious ways to save the file but is not copy protection.
   * Default: true.
   */
  suppressSaveUi?: boolean;
  /**
   * Allow selecting and copying text. Default: false — text cannot be selected; copy, cut
   * and "select all" are disabled. This is a UI convenience, not protection: screenshots and developer tools remain.
   */
  allowCopy?: boolean;
  /**
   * Reject files whose extension does not match the content (error `mismatch`).
   * Default: false — the file opens by content (a docx or RTF under `.doc`, a jpg under `.png`),
   * and when the mismatch is significant (a spreadsheet under `.docx`), with a notice above the content.
   * Plain text under a foreign extension is shown as text in both modes.
   */
  strictExtension?: boolean;
  /**
   * How to show html: 'document' (default) — as a document, without scripts, styles and external resources;
   * 'source' — the markup as text.
   */
  htmlMode?: 'document' | 'source';
  /**
   * Show a password field for protected files (docx, xlsx, pptx, doc). Default: true.
   * The password can also be passed in advance: `open(source, { password })`.
   */
  passwordPrompt?: boolean;
  /** Whether to open files from an archive when a list row is clicked. Default: true. */
  openArchiveEntries?: boolean;
  /** Whether to parse in a Web Worker. Default: true; on failure parsing falls back to the main thread. */
  useWorkers?: boolean;
  /**
   * What a click on a link inside a file does: `'new-tab'` (default) opens it in a new tab — in a WebView that is
   * whatever the host application does with new windows; `'none'` ignores the click.
   */
  links?: 'new-tab' | 'none';
  /**
   * Called when the user clicks a link inside a file. With this callback the viewer never navigates by itself:
   * the application decides (open the system browser, ask the user, ignore).
   */
  onLinkClick?: (url: string) => void;
  onLoad?: (info: OpenedFileInfo) => void;
  onError?: (error: ViewerError) => void;
}

export interface OpenOptions {
  /** File name: shown in the toolbar and used as a hint for format detection. */
  name?: string;
  /** Explicit format; turns detection off. */
  format?: FileFormat;
  /** MIME type, when known. */
  mimeType?: string;
  /** Password for a protected file. */
  password?: string;
}

export interface OpenedFileInfo {
  name: string;
  format: FileFormat;
  kind: FileKind;
  size?: number;
  /** The extension promised another format: the file was opened by content. */
  expectedFormat?: FileFormat;
  /** Digital signature details when a p7s / p7m file is opened. The signature is not verified. */
  signature?: SignatureInfo;
  /** The file is truncated or damaged: what could be read is shown. */
  damaged?: boolean;
  /** Zero-length file. */
  empty?: boolean;
}

export interface SignatureInfo {
  /** true: the signature is detached from the document (the file holds only the signature). */
  detached: boolean;
  signers: { name?: string; organization?: string; serialNumber?: string; issuer?: string; validFrom?: string; validTo?: string }[];
  signingTime?: string;
}

export type ViewerErrorCode =
  | 'unsupported' | 'not-implemented' | 'load-failed' | 'too-large'
  | 'password' | 'corrupt' | 'aborted' | 'mismatch';

export class ViewerError extends Error {
  readonly code: ViewerErrorCode;
  readonly format?: FileFormat;
  /** For code `password`: a password is required, did not fit, or the encryption method is not supported. */
  passwordState?: 'required' | 'wrong' | 'unsupported';
  constructor(code: ViewerErrorCode, message: string, format?: FileFormat, cause?: unknown) {
    super(message);
    this.name = 'ViewerError';
    this.code = code;
    this.format = format;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export interface Viewer {
  open(source: FileSource, options?: OpenOptions): Promise<OpenedFileInfo>;
  close(): void;
  destroy(): void;
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
}

export const DEFAULT_LIMITS: ViewerLimits = {
  maxFileBytes: 200 * 1024 * 1024,
  maxMediaBytes: 8 * 1024 * 1024 * 1024,
  maxTextBytes: 5 * 1024 * 1024,
  maxTableBytes: 50 * 1024 * 1024,
  maxTableRows: 500_000,
  maxImagePixels: 16_000_000,
  maxCanvasPixels: 8_000_000,
  maxPixelRatio: 2,
};
