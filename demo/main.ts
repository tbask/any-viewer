import { createViewer, ViewerError, type FileSource, type OpenOptions } from '../src/index';
import { makeSamplePdf, makeSamplePng } from './samples';

const status = document.getElementById('status')!;
const viewer = createViewer(document.getElementById('viewer')!, {
  pdf: { assetsUrl: new URL('./pdfjs/', location.href).href },
  locale: new URLSearchParams(location.search).get('locale') ?? undefined,
  download: true,
  print: true,
  onLoad: (info) => (status.textContent = `${info.format.toUpperCase()} · ${info.size != null ? formatSize(info.size) : 'by URL'}`),
  onError: (error) => (status.textContent = `Error: ${error.code}`),
});
// For debugging and automated tests.
(window as unknown as { viewer: typeof viewer }).viewer = viewer;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function open(source: FileSource, options?: OpenOptions) {
  status.textContent = 'Opening…';
  const started = performance.now();
  try {
    await viewer.open(source, options);
    status.textContent += ` · ${Math.round(performance.now() - started)} ms`;
  } catch (err) {
    if (!(err instanceof ViewerError)) throw err;
  }
}
(window as unknown as { openFile: typeof open }).openFile = open;
(window as unknown as { createViewer: typeof createViewer }).createViewer = createViewer;

document.getElementById('file')!.addEventListener('change', (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) void open(file);
});

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('drag');
});
window.addEventListener('dragleave', () => document.body.classList.remove('drag'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('drag');
  const file = e.dataTransfer?.files[0];
  if (file) void open(file);
});

const samples: Record<string, () => Promise<[FileSource, OpenOptions]>> = {
  png: async () => [await makeSamplePng(), { name: 'sample.png' }],
  txt: async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `${String(i + 1).padStart(5, ' ')}  Line of text number ${i + 1}: the quick brown fox jumps over the lazy dog.`);
    return [new Blob([lines.join('\r\n')]), { name: 'sample.txt' }];
  },
  csv: async () => {
    const rows = ['Item;Price;Quantity;Comment'];
    for (let i = 1; i <= 500; i++) rows.push(`Item ${i};${(i * 12.5).toFixed(2).replace('.', ',')};${i % 17};"A note ""in quotes""; row ${i}"`);
    return [new Blob([rows.join('\n')]), { name: 'prices.csv' }];
  },
  bigcsv: async () => {
    const parts: string[] = ['id,name,email,amount,date,comment\n'];
    for (let i = 1; i <= 300_000; i++) parts.push(`${i},User ${i},user${i}@example.com,${(i * 3.7).toFixed(2)},2026-01-${String((i % 28) + 1).padStart(2, '0')},"A comment, with a comma #${i}"\n`);
    return [new Blob(parts), { name: 'large-table.csv' }];
  },
  pdf: async () => [makeSamplePdf(40), { name: 'sample.pdf' }],
};

document.querySelectorAll<HTMLButtonElement>('button[data-sample]').forEach((button) => {
  button.addEventListener('click', async () => {
    const [source, options] = await samples[button.dataset.sample!]();
    void open(source, options);
  });
});

// Language switch: the interface and the opened file follow at once.
document.getElementById('locale')?.addEventListener('change', (e) => viewer.setLocale((e.target as HTMLSelectElement).value || undefined));