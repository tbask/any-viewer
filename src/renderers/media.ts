/**
 * Audio and video playback with the browser's built-in player.
 * Format support depends on the browser: mp3, wav, m4a, ogg, mp4 and webm play almost everywhere,
 * avi and some mov usually do not. The download button of the player is disabled.
 *
 * A file by URL is read by the player itself, in ranges. When that is impossible (authorization headers are needed,
 * the server does not serve ranges) the file is downloaded whole and played from memory.
 */
import { ViewerError } from '../types';
import { el, type RenderContext, type RendererHandle } from './types';

const CODECS: Record<string, string> = {
  hvc1: 'HEVC (H.265)', hev1: 'HEVC (H.265)', dvh1: 'Dolby Vision', dvhe: 'Dolby Vision', av01: 'AV1', vp09: 'VP9', mp4v: 'MPEG-4 Visual',
  apcn: 'Apple ProRes', apch: 'Apple ProRes', apcs: 'Apple ProRes', apco: 'Apple ProRes', ap4h: 'Apple ProRes', 'mjp2': 'Motion JPEG 2000', jpeg: 'Motion JPEG', s263: 'H.263',
};

/** Content type from the start of the file: without it some browsers (Safari, iOS WebView) do not play video from memory. */
function mediaType(head: Uint8Array, name: string, isVideo: boolean, probe: HTMLMediaElement): string {
  const ascii = (at: number, n: number) => String.fromCharCode(...head.subarray(at, at + n));
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (brand.startsWith('M4A') || brand.startsWith('M4B') || (!isVideo && ext !== 'mp4')) return 'audio/mp4';
    // Only Safari plays QuickTime files under their own type; other browsers get the same file as mp4.
    if (brand.startsWith('qt') && probe.canPlayType('video/quicktime')) return 'video/quicktime';
    return 'video/mp4';
  }
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return isVideo ? 'video/webm' : 'audio/webm';
  if (ascii(0, 4) === 'OggS') return isVideo ? 'video/ogg' : 'audio/ogg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'AVI ') return 'video/x-msvideo';
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && ext !== 'aac')) return 'audio/mpeg';
  if (ext === 'aac') return 'audio/aac';
  return '';
}

/** Video codec of an mp4/mov file: looked up in the track description (it lies at the start or at the end of the file). */
async function videoCodec(blob: Blob): Promise<string | undefined> {
  const span = 2 * 1024 * 1024;
  const parts = blob.size <= span * 2 ? [blob] : [blob.slice(0, span), blob.slice(blob.size - span)];
  for (const part of parts) {
    const bytes = new Uint8Array(await part.arrayBuffer());
    for (let i = 4; i + 20 <= bytes.length; i++) {
      // The "stsd" table: version and flags, entry count, size of the first entry, its four-character code.
      if (bytes[i] !== 0x73 || bytes[i + 1] !== 0x74 || bytes[i + 2] !== 0x73 || bytes[i + 3] !== 0x64) continue;
      const code = String.fromCharCode(bytes[i + 16], bytes[i + 17], bytes[i + 18], bytes[i + 19]);
      if (CODECS[code]) return CODECS[code];
    }
  }
  return undefined;
}

export async function createMediaRenderer(ctx: RenderContext): Promise<RendererHandle> {
  const isVideo = ctx.format === 'video';
  const player = el(isVideo ? 'video' : 'audio', 'fv-media-player');
  player.controls = true;
  player.preload = 'metadata';
  player.setAttribute('controlsList', 'nodownload noremoteplayback');
  if (isVideo) {
    (player as HTMLVideoElement).playsInline = true;
    player.setAttribute('playsinline', '');
    player.setAttribute('webkit-playsinline', '');
    player.setAttribute('disablePictureInPicture', '');
  }

  let objectUrl: string | null = null;
  const release = () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  };
  /** Waits until the player has read the file description. Rejects with 'aborted', 'network' or 'decode'. */
  const attempt = (src: string, timeoutMs: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        player.removeEventListener('loadedmetadata', onReady);
        player.removeEventListener('error', onError);
        ctx.signal.removeEventListener('abort', onAbort);
      };
      const onReady = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error(player.error?.code === 2 ? 'network' : 'decode')); };
      const onAbort = () => { cleanup(); reject(new Error('aborted')); };
      if (timeoutMs > 0) timer = setTimeout(() => { cleanup(); reject(new Error('network')); }, timeoutMs);
      player.addEventListener('loadedmetadata', onReady);
      player.addEventListener('error', onError);
      ctx.signal.addEventListener('abort', onAbort);
      player.src = src;
      player.load();
    });
  const typed = async (blob: Blob): Promise<Blob> => {
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const type = mediaType(head, ctx.name, isVideo, player);
    return type && blob.type !== type ? blob.slice(0, blob.size, type) : blob;
  };
  const fail = async (reason: string, blob: Blob | null, cause: unknown): Promise<never> => {
    player.removeAttribute('src');
    release();
    if (reason === 'aborted' || ctx.signal.aborted) throw new ViewerError('aborted', 'aborted');
    if (reason === 'network') throw new ViewerError('load-failed', ctx.labels.loadFailed, ctx.format, cause);
    const codec = blob && isVideo ? await videoCodec(blob).catch(() => undefined) : undefined;
    throw new ViewerError('unsupported', codec ? ctx.labels.mediaCodecUnsupported.replace('{codec}', codec) : ctx.labels.mediaUnsupported, ctx.format, cause);
  };

  let blob = ctx.blob;
  if (blob) {
    blob = await typed(blob);
    objectUrl = URL.createObjectURL(blob);
    try {
      await attempt(objectUrl, 30_000);
    } catch (err) {
      await fail((err as Error).message === 'network' ? 'decode' : (err as Error).message, blob, err);
    }
  } else {
    // The player cannot send authorization headers, so such a file is downloaded here right away.
    const headers = ctx.options.fetchOptions?.headers;
    const needsFetch = !!headers && (headers instanceof Headers ? [...headers.keys()].length > 0 : Array.isArray(headers) ? headers.length > 0 : Object.keys(headers).length > 0);
    let direct = false;
    if (!needsFetch) {
      try {
        await attempt(ctx.url!, 0);
        direct = true;
      } catch (err) {
        if ((err as Error).message === 'aborted') await fail('aborted', null, err);
      }
    }
    if (!direct) {
      let response: Response;
      try {
        response = await fetch(ctx.url!, { ...ctx.options.fetchOptions, signal: ctx.signal });
      } catch (err) {
        return fail('network', null, err);
      }
      if (!response.ok) throw new ViewerError('load-failed', `${ctx.labels.loadFailed} (HTTP ${response.status})`, ctx.format);
      if (Number(response.headers.get('content-length') ?? 0) > ctx.limits.maxFileBytes) throw new ViewerError('too-large', ctx.labels.tooLarge, ctx.format);
      try {
        blob = await typed(await response.blob());
      } catch (err) {
        return fail('network', null, err);
      }
      if (blob.size > ctx.limits.maxFileBytes) throw new ViewerError('too-large', ctx.labels.tooLarge, ctx.format);
      objectUrl = URL.createObjectURL(blob);
      try {
        await attempt(objectUrl, 30_000);
      } catch (err) {
        await fail((err as Error).message === 'network' ? 'decode' : (err as Error).message, blob, err);
      }
    }
  }

  // A file with a video extension but no picture: either it has only audio, or the browser does not know the video codec.
  const hasPicture = isVideo && (player as HTMLVideoElement).videoWidth > 0;
  if (isVideo && !hasPicture && blob) {
    const codec = await videoCodec(blob).catch(() => undefined);
    if (codec) ctx.setNotice(ctx.labels.mediaCodecUnsupported.replace('{codec}', codec));
  }
  const wrap = el('div', hasPicture ? 'fv-media fv-media-video' : 'fv-media');
  wrap.appendChild(player);
  ctx.host.appendChild(wrap);

  return {
    destroy() {
      player.pause();
      player.removeAttribute('src');
      player.load();
      wrap.remove();
      release();
    },
  };
}
