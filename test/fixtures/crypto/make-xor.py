"""xls with XOR obfuscation: built from an unprotected file and verified with the third-party msoffcrypto library."""
import struct, os, io, importlib.util, olefile, msoffcrypto
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', 'office', 'excel-features.xls')
DST = os.path.join(HERE, 'xor-password.xls')
_spec = importlib.util.spec_from_file_location('make_encrypted', os.path.join(HERE, 'make-encrypted.py'))
_enc = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(_enc)
write_cfb, read_streams = _enc.write_cfb, _enc.read_streams
from msoffcrypto.method.xor_obfuscation import DocumentXOR as X
def verifier(pw):
    v = 0
    for b in reversed([len(pw)] + [ord(c) for c in pw]):
        v = ((1 if v & 0x4000 else 0) ^ ((v * 2) & 0x7FFF)) ^ b
    return v ^ 0xCE4B
def encrypt(src, dst, pw):
    wb = read_streams(src)['Workbook']; arr = X.create_xor_array_method1(pw); key = X.create_xor_key_method1(pw)
    fp = struct.pack('<HHHHH', 0x2F, 6, 0, key, verifier(pw))
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
        a = start + (4 if rid == 0x85 else 0); k = (a + len(d)) % 16
        for i in range(a, start + len(d)):
            out[i] = X.rol(out[i], 5, 8) ^ arr[k]; k = (k + 1) % 16
    write_cfb(dst, {'Workbook': bytes(out)})
encrypt(SRC, DST, 'test123')
f = msoffcrypto.OfficeFile(open(DST, 'rb')); f.load_key(password='test123'); o = io.BytesIO(); f.decrypt(o)
a = olefile.OleFileIO(io.BytesIO(o.getvalue())).openstream('Workbook').read(); b = olefile.OleFileIO(SRC).openstream('Workbook').read()
print('reference decrypt: type', f.type, '| tail equal to original:', a[200:len(b) + 10] == b[190:], '| wrong pw:', end=' ')
try: g = msoffcrypto.OfficeFile(open(DST, 'rb')); g.load_key(password='nope'); print('accepted?!')
except Exception as e: print(type(e).__name__)
