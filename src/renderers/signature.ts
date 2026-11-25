/**
 * A digital signature file without an embedded document (or with one that cannot be shown):
 * a card with details of the signers. The signature is not verified.
 */
import { parseCms, type CmsInfo } from '../core/cms';
import { ViewerError } from '../types';
import { el, type RenderContext, type RendererHandle } from './types';

export async function createSignatureRenderer(ctx: RenderContext): Promise<RendererHandle> {
  let info: CmsInfo;
  try {
    info = parseCms(new Uint8Array(await ctx.blob!.arrayBuffer()));
  } catch (err) {
    throw new ViewerError('corrupt', ctx.labels.corrupt, ctx.format, err);
  }
  const { labels } = ctx;
  const wrap = el('div', 'fv-archive fv-signature');
  wrap.tabIndex = 0;
  if (!info.content) wrap.appendChild(el('p', 'fv-signature-note', labels.signatureDetached));
  const addCard = (rows: [string, string | undefined][]) => {
    const table = el('table', 'fv-archive-table');
    for (const [key, value] of rows) {
      if (!value) continue;
      const tr = el('tr');
      tr.append(el('th', undefined, key), el('td', undefined, value));
      table.appendChild(tr);
    }
    if (table.childElementCount) wrap.appendChild(table);
  };
  for (const s of info.signers) {
    addCard([
      [labels.signer, s.name],
      [labels.organization, s.organization],
      [labels.serialNumber, s.serialNumber],
      [labels.issuer, s.issuer],
      [labels.validity, s.validFrom && s.validTo ? `${s.validFrom} — ${s.validTo}` : undefined],
    ]);
  }
  addCard([[labels.signedAt, info.signingTime]]);
  wrap.appendChild(el('p', 'fv-signature-note', labels.signatureNotVerified));
  ctx.host.appendChild(wrap);
  return { destroy: () => wrap.remove() };
}
