/** Generators of sample files for the demo: nothing is downloaded, everything is created in the browser. */

export function makeSamplePng(): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 1600;
  canvas.height = 1000;
  const g = canvas.getContext('2d')!;
  const gradient = g.createLinearGradient(0, 0, 1600, 1000);
  gradient.addColorStop(0, '#1d4ed8');
  gradient.addColorStop(1, '#9333ea');
  g.fillStyle = gradient;
  g.fillRect(0, 0, 1600, 1000);
  g.strokeStyle = 'rgba(255,255,255,0.25)';
  for (let x = 0; x <= 1600; x += 100) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, 1000);
    g.stroke();
  }
  for (let y = 0; y <= 1000; y += 100) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(1600, y);
    g.stroke();
  }
  g.fillStyle = '#fff';
  g.font = 'bold 96px system-ui, sans-serif';
  g.fillText('1600 × 1000', 120, 300);
  g.font = '40px system-ui, sans-serif';
  g.fillText('Wheel or pinch to zoom, drag to pan', 120, 380);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
}

/** Builds a simple multi-page PDF by hand (text in the standard Helvetica font). */
export function makeSamplePdf(pages: number): Blob {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);
  const kids: string[] = [];
  add('<< /Type /Catalog /Pages 2 0 R >>'); // 1
  add(''); // 2 is filled in below
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); // 3
  for (let i = 0; i < pages; i++) {
    const lines = [`BT /F1 28 Tf 60 760 Td (Sample PDF - page ${i + 1} of ${pages}) Tj ET`];
    for (let k = 0; k < 30; k++) lines.push(`BT /F1 12 Tf 60 ${720 - k * 20} Td (Line ${k + 1}: the quick brown fox jumps over the lazy dog.) Tj ET`);
    lines.push(`${0.1 + (i % 5) * 0.15} 0.4 0.8 rg 60 60 ${200 + (i % 7) * 40} 40 re f`);
    const content = lines.join('\n');
    const pageId = objects.length + 1;
    kids.push(`${pageId} 0 R`);
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`);
    add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Blob([out], { type: 'application/pdf' });
}
