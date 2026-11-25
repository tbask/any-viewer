/**
 * Reader of CMS / PKCS#7 digital signature files (p7s, p7m, sig).
 *
 * Extracted from a signature: the embedded document (if the signature is "attached"), details of the signers'
 * certificates and the signing time. The signature is NOT verified: that takes cryptography
 * and a certificate authority trust chain, which the viewer does not have.
 */

export class CmsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CmsError';
  }
}

export interface CmsSigner {
  name?: string;
  organization?: string;
  /** Subject serial number (a personal identification number in some national certificate schemes). */
  serialNumber?: string;
  issuer?: string;
  validFrom?: string;
  validTo?: string;
}

export interface CmsInfo {
  /** The signed document; undefined for a detached signature. */
  content?: Uint8Array;
  signers: CmsSigner[];
  signingTime?: string;
}

interface Node {
  tag: number;
  /** Content of a primitive element. */
  data: Uint8Array;
  children: Node[];
}

const OID_SIGNED_DATA = '2a864886f70d010702';
const OID_SIGNING_TIME = '2a864886f70d010905';
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Parses DER/BER-encoded ASN.1 into a tree. */
function parse(buf: Uint8Array, start: number, end: number, depth: number, out: Node[]): number {
  let p = start;
  while (p + 2 <= end) {
    const tag = buf[p++];
    if (tag === 0 && buf[p] === 0) return p + 1; // end of indefinite-length content
    let len = buf[p++];
    let indefinite = false;
    if (len === 0x80) indefinite = true;
    else if (len & 0x80) {
      const n = len & 0x7f;
      if (n > 4 || p + n > end) throw new CmsError('The signature file is corrupt');
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + buf[p++];
    }
    if (!indefinite && p + len > end) throw new CmsError('The signature file is corrupt');
    const node: Node = { tag, data: buf.subarray(p, indefinite ? p : p + len), children: [] };
    if (tag & 0x20) {
      if (depth > 40) throw new CmsError('The signature file is nested too deeply');
      const stop = parse(buf, p, indefinite ? end : p + len, depth + 1, node.children);
      p = indefinite ? stop : p + len;
    } else {
      if (indefinite) throw new CmsError('The signature file is corrupt');
      p += len;
    }
    out.push(node);
  }
  return p;
}

function text(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (node.tag === 0x1e) return new TextDecoder('utf-16be').decode(node.data);
  if (node.tag === 0x0c || node.tag === 0x13 || node.tag === 0x16 || node.tag === 0x14 || node.tag === 0x17 || node.tag === 0x18) return new TextDecoder('utf-8').decode(node.data);
  return undefined;
}

/** ASN.1 time (250101120000Z) → "01.01.2025 12:00 UTC". */
export function formatAsn1Time(value: string | undefined): string | undefined {
  const m = value ? /^(\d{2}|\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(value) : null;
  if (!m) return undefined;
  const year = m[1].length === 2 ? (Number(m[1]) < 50 ? 2000 : 1900) + Number(m[1]) : Number(m[1]);
  return `${m[3]}.${m[2]}.${year} ${m[4]}:${m[5]} UTC`;
}

/** X.500 name fields: attribute code → value. */
function nameFields(name: Node | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const set of name?.children ?? []) {
    for (const pair of set.children) {
      const oid = pair.children[0] ? hex(pair.children[0].data) : '';
      const value = text(pair.children[1]);
      if (value && !(oid in out)) out[oid] = value;
    }
  }
  return out;
}

function octets(node: Node): Uint8Array {
  if (!(node.tag & 0x20)) return node.data;
  // Constructed octet string: join the parts.
  const parts = node.children.map(octets);
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

function find(node: Node, predicate: (n: Node, parent: Node, index: number) => boolean, hits: { parent: Node; index: number }[] = []): { parent: Node; index: number }[] {
  node.children.forEach((c, i) => {
    if (predicate(c, node, i)) hits.push({ parent: node, index: i });
    find(c, predicate, hits);
  });
  return hits;
}

/** Mark of a CMS file: an ASN.1 sequence that starts with the "signed data" identifier. */
export function looksLikeCms(head: Uint8Array): boolean {
  return head.length > 20 && head[0] === 0x30 && hex(head.subarray(0, 32)).includes(`0609${OID_SIGNED_DATA}`);
}

/** Text form (PEM): "-----BEGIN PKCS7-----" with base64 inside. */
export function pemToDer(bytes: Uint8Array): Uint8Array | undefined {
  if (bytes[0] !== 0x2d) return undefined;
  const m = /-----BEGIN (?:PKCS7|CMS)-----([\s\S]+?)-----END/.exec(new TextDecoder().decode(bytes.subarray(0, 50_000_000)));
  if (!m) return undefined;
  try {
    return Uint8Array.from(atob(m[1].replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

export function parseCms(input: Uint8Array): CmsInfo {
  const bytes = pemToDer(input) ?? input;
  const top: Node[] = [];
  parse(bytes, 0, bytes.length, 0, top);
  const root = top[0];
  if (!root || root.tag !== 0x30 || hex(root.children[0]?.data ?? new Uint8Array()) !== OID_SIGNED_DATA) throw new CmsError('The file is not a CMS signature');
  const signed = root.children[1]?.children[0];
  if (!signed) throw new CmsError('The signature file is corrupt');

  const info: CmsInfo = { signers: [] };
  // encapContentInfo: the content type and, for an attached signature, the content itself.
  const encap = signed.children[2];
  const wrapper = encap?.children[1];
  if (wrapper?.children[0]) info.content = octets(wrapper.children[0]);

  // Certificates lie in the optional field [0].
  const certs = signed.children.find((c, i) => i > 2 && c.tag === 0xa0);
  for (const cert of certs?.children ?? []) {
    const tbs = cert.children[0];
    if (!tbs) continue;
    const off = tbs.children[0]?.tag === 0xa0 ? 1 : 0;
    const subject = nameFields(tbs.children[off + 4]);
    const issuer = nameFields(tbs.children[off + 2]);
    const validity = tbs.children[off + 3];
    info.signers.push({
      name: subject['550403'],
      organization: subject['55040a'],
      serialNumber: subject['550405'],
      issuer: issuer['550403'] ?? issuer['55040a'],
      validFrom: formatAsn1Time(text(validity?.children[0])),
      validTo: formatAsn1Time(text(validity?.children[1])),
    });
  }
  // Self-signed authority certificates in the chain are not signers: keep the end-entity ones.
  const issuers = new Set(info.signers.map((s) => s.issuer));
  const leaves = info.signers.filter((s) => !issuers.has(s.name) || s.issuer === s.name);
  if (leaves.length && leaves.length < info.signers.length) info.signers = leaves;

  const time = find(signed, (n) => n.tag === 0x06 && hex(n.data) === OID_SIGNING_TIME)[0];
  if (time) info.signingTime = formatAsn1Time(text(time.parent.children[time.index + 1]?.children[0]));
  return info;
}
