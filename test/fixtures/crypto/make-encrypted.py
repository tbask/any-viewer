"""Builds password-protected test ppt and xls files (RC4 CryptoAPI) from unprotected ones. Verified with the third-party msoffcrypto library."""
import struct, os, sys, hashlib, olefile
from cryptography.hazmat.primitives.ciphers import Cipher
from cryptography.hazmat.decrepit.ciphers.algorithms import ARC4

def rc4(key, data):
    return Cipher(ARC4(key), mode=None).encryptor().update(bytes(data))

def write_cfb(path, streams):
    """A flat version 3 CFB: every stream is at least 4096 bytes and lies in regular sectors."""
    SEC = 512
    names = sorted(streams, key=lambda n: (len(n), n.upper()))
    datas = [streams[n] + b'\0' * (max(4096, len(streams[n])) - len(streams[n])) for n in names]
    datas = [d + b'\0' * (-len(d) % SEC) for d in datas]
    dir_secs = (len(names) + 1 + 3) // 4
    data_secs = [len(d) // SEC for d in datas]
    total = dir_secs + sum(data_secs)
    fat_secs = 1
    while fat_secs * 128 < total + fat_secs: fat_secs += 1
    assert fat_secs <= 109
    fat = [0xFFFFFFFD] * fat_secs
    def chain(n):
        start = len(fat)
        for i in range(n): fat.append(start + i + 1 if i < n - 1 else 0xFFFFFFFE)
        return start
    dir_start = chain(dir_secs)
    starts = [chain(n) for n in data_secs]
    fat += [0xFFFFFFFF] * (fat_secs * 128 - len(fat))
    def entry(name, typ, left, right, child, start, size):
        raw = name.encode('utf-16le') + b'\0\0'
        return raw.ljust(64, b'\0') + struct.pack('<HBBIII', len(raw), typ, 1, left, right, child) + b'\0' * 16 + struct.pack('<I', 0) + b'\0' * 16 + struct.pack('<IQ', start, size)
    NO = 0xFFFFFFFF
    ents = [entry('Root Entry', 5, NO, NO, 1 if names else NO, 0xFFFFFFFE, 0)]
    for i, n in enumerate(names):
        ents.append(entry(n, 2, NO, i + 2 if i < len(names) - 1 else NO, NO, starts[i], max(4096, len(streams[n]))))
    while len(ents) % 4: ents.append(b'\0' * 64 + struct.pack('<HBBIII', 0, 0, 1, NO, NO, NO) + b'\0' * 48)
    head = b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1' + b'\0' * 16 + struct.pack('<HHHHH', 0x3E, 3, 0xFFFE, 9, 6) + b'\0' * 6 + struct.pack('<IIIIIIIII', 0, fat_secs, dir_start, 0, 4096, 0xFFFFFFFE, 0, 0xFFFFFFFE, 0)
    head += b''.join(struct.pack('<I', i if i < fat_secs else NO) for i in range(109))
    with open(path, 'wb') as f:
        f.write(head); f.write(struct.pack('<%dI' % len(fat), *fat)); f.write(b''.join(ents)); [f.write(d) for d in datas]

def read_streams(path):
    ole = olefile.OleFileIO(path)
    out = {'/'.join(e): ole.openstream(e).read() for e in ole.listdir(streams=True, storages=False) if len(e) == 1}
    ole.close(); return out

SALT = bytes(range(16)); KEYBITS = 128
def makekey(pw, block):
    h = hashlib.sha1(hashlib.sha1(SALT + pw.encode('utf-16le')).digest() + struct.pack('<I', block)).digest()
    return h[:KEYBITS // 8]
def encryption_info(pw):
    csp = 'Microsoft Enhanced Cryptographic Provider v1.0\0'.encode('utf-16le')
    header = struct.pack('<IIIIIIII', 4, 0, 0x6801, 0x8004, KEYBITS, 1, 0, 0) + csp
    verifier = bytes(range(100, 116))
    enc = rc4(makekey(pw, 0), verifier + hashlib.sha1(verifier).digest())
    return struct.pack('<HHII', 2, 2, 4, len(header)) + header + struct.pack('<I', 16) + SALT + enc[:16] + struct.pack('<I', 20) + enc[16:]

def encrypt_ppt(src, dst, pw):
    st = read_streams(src)
    doc = bytearray(st['PowerPoint Document']); cu = bytearray(st['Current User'])
    edit = struct.unpack_from('<I', cu, 16)[0]
    persist = {}; first_edit = edit; seed = None; docref = None; lastslide = None
    while edit:
        rh = struct.unpack_from('<HHI', doc, edit); assert rh[1] == 0x0FF5
        lastSlide, ver, minor, major, offLast, offDir, dref, pseed = struct.unpack_from('<IHBBIIII', doc, edit + 8)
        if seed is None: seed, docref, lastslide, tail = pseed, dref, lastSlide, bytes(doc[edit + 8 + 4:edit + 8 + 8]) + bytes(doc[edit + 8 + 24:edit + 8 + 28])
        dl = struct.unpack_from('<I', doc, offDir + 4)[0]; p = offDir + 8
        while p < offDir + 8 + dl:
            h = struct.unpack_from('<I', doc, p)[0]; p += 4
            for i in range(h >> 20):
                persist.setdefault((h & 0xFFFFF) + i, struct.unpack_from('<I', doc, p)[0]); p += 4
        edit = offLast
    for pid, off in persist.items():
        ln = struct.unpack_from('<I', doc, off + 4)[0]
        doc[off:off + 8 + ln] = rc4(makekey(pw, pid), doc[off:off + 8 + ln])
    crypt_id = max(persist) + 1
    info = encryption_info(pw)
    persist[crypt_id] = len(doc)
    doc += struct.pack('<HHI', 0x000F, 0x2F14, len(info)) + info
    ids = sorted(persist); assert ids == list(range(ids[0], ids[0] + len(ids)))
    body = struct.pack('<I', (len(ids) << 20) | ids[0]) + b''.join(struct.pack('<I', persist[i]) for i in ids)
    dir_off = len(doc); doc += struct.pack('<HHI', 0, 0x1772, len(body)) + body
    new_edit = len(doc)
    doc += struct.pack('<HHI', 0, 0x0FF5, 32) + struct.pack('<I', lastslide) + tail[:4] + struct.pack('<IIII', 0, dir_off, docref, crypt_id + 1) + tail[4:8] + struct.pack('<I', crypt_id)
    struct.pack_into('<I', cu, 12, 0xF3D1C4DF); struct.pack_into('<I', cu, 16, new_edit)
    pic = bytearray(st.get('Pictures', b'')); p = 0; k0 = makekey(pw, 0)
    while p + 8 <= len(pic):
        vi, typ, ln = struct.unpack_from('<HHI', pic, p); inst = vi >> 4; end = p + 8 + ln
        meta = typ in (0xF01A, 0xF01B, 0xF01C)
        two = (inst & 1) == 1 if typ != 0xF01D else inst in (0x46B, 0x6E3)
        cuts = [p, p + 8, p + 24] + ([p + 40] if two else [])
        cuts.append(cuts[-1] + (34 if meta else 1)); cuts.append(end)
        for a, b in zip(cuts, cuts[1:]): pic[a:b] = rc4(k0, pic[a:b])
        p = end
    st['PowerPoint Document'] = bytes(doc); st['Current User'] = bytes(cu)
    if pic: st['Pictures'] = bytes(pic)
    write_cfb(dst, {k: v for k, v in st.items() if k in ('PowerPoint Document', 'Current User', 'Pictures')})

def encrypt_xls(src, dst, pw):
    st = read_streams(src); wb = st['Workbook']
    info = encryption_info(pw)
    fp = struct.pack('<HHH', 0x2F, 2 + len(info), 1) + info
    recs = []; p = 0
    while p + 4 <= len(wb):
        rid, ln = struct.unpack_from('<HH', wb, p); recs.append([rid, bytearray(wb[p + 4:p + 4 + ln])]); p += 4 + ln
    recs.insert(1, [0x2F, bytearray(fp[4:])])
    for rid, d in recs:
        if rid == 0x85: struct.pack_into('<I', d, 0, struct.unpack_from('<I', d, 0)[0] + len(fp))
    out = bytearray(); plain = {0x809, 0x2F, 0x194, 0x195, 0xE1, 0x196, 0x138}
    for rid, d in recs:
        out += struct.pack('<HH', rid, len(d)); start = len(out); out += d
        if rid in plain: continue
        a = start + (4 if rid == 0x85 else 0); end = start + len(d)
        while a < end:
            b = a // 1024; stop = min(end, (b + 1) * 1024)
            ks = rc4(makekey(pw, b), b'\0' * (stop - b * 1024))[a - b * 1024:]
            out[a:stop] = bytes(x ^ y for x, y in zip(out[a:stop], ks)); a = stop
    write_cfb(dst, {'Workbook': bytes(out)})

if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    office = os.path.join(here, '..', 'office')
    encrypt_ppt(os.path.join(office, 'ppt-features.ppt'), os.path.join(here, 'capi-password.ppt'), 'test123')
    encrypt_xls(os.path.join(office, 'excel-features.xls'), os.path.join(here, 'capi-password.xls'), 'test123')
    print('ok')