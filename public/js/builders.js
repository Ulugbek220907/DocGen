// Turns a document (see doc-schema.js) into a real PDF, DOCX or XLSX file,
// entirely on the device. The heavy libraries (~3.8 MB) are loaded on first
// use instead of at app start.
import './doc-schema.js';
import { isFormula, displayValue, displayCell, rebaseFormula, parseNumber } from './formula.js';

const DocSchema = globalThis.DocSchema;

const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

const scriptPromises = new Map();
function loadScript(src) {
  if (!scriptPromises.has(src)) {
    scriptPromises.set(src, new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.async = true;
      el.onload = resolve;
      el.onerror = () => { scriptPromises.delete(src); reject(new Error('Could not load the document engine. Check your connection and try again.')); };
      document.head.appendChild(el);
    }));
  }
  return scriptPromises.get(src);
}

async function ensureLibs(format) {
  if (format === 'pdf') {
    await loadScript('vendor/pdfmake.min.js');
    await loadScript('vendor/vfs_fonts.js');
  } else if (format === 'docx') {
    await loadScript('vendor/docx.umd.js');
  } else if (format === 'xlsx') {
    await loadScript('vendor/exceljs.min.js');
  }
}

// Warm the cache in the background so the first download is instant.
export function preloadLibs() {
  const idle = window.requestIdleCallback || (cb => setTimeout(cb, 1500));
  idle(() => { ['pdf', 'docx', 'xlsx'].forEach(f => ensureLibs(f).catch(() => {})); });
}

// ---------- inline formatting shared by all formats ----------

export function parseInlineSegments(text) {
  const regex = /\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|\^\(([^)]+)\)|\^([A-Za-z0-9+\-=]+)|_\(([^)]+)\)/g;
  const segments = [];
  let last = 0;
  let m;
  const src = String(text ?? '');
  while ((m = regex.exec(src)) !== null) {
    if (m.index > last) segments.push({ text: src.slice(last, m.index) });
    if (m[1] !== undefined) segments.push({ text: m[1], bold: true });
    else if (m[2] !== undefined) segments.push({ text: m[2], italic: true });
    else if (m[3] !== undefined) segments.push({ text: m[3], code: true });
    else if (m[4] !== undefined) segments.push({ text: m[4], superscript: true });
    else if (m[5] !== undefined) segments.push({ text: m[5], superscript: true });
    else if (m[6] !== undefined) segments.push({ text: m[6], subscript: true });
    last = regex.lastIndex;
  }
  if (last < src.length) segments.push({ text: src.slice(last) });
  if (!segments.length) segments.push({ text: src });
  return segments;
}

const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ' };
const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', o: 'ₒ', x: 'ₓ' };
const mapChars = (s, map) => s.split('').map(ch => map[ch.toLowerCase()] || ch).join('');

export function plainText(text) {
  return parseInlineSegments(text).map(seg => {
    if (seg.superscript) return mapChars(seg.text, SUP);
    if (seg.subscript) return mapChars(seg.text, SUB);
    return seg.text;
  }).join('');
}

function looksNumeric(value) {
  return !Number.isNaN(parseNumber(value));
}

// Which columns are mostly numbers — those get right-aligned.
function numericColumns(table) {
  return table.headers.map((_, c) => {
    const vals = table.rows.map(r => r[c]).filter(v => String(v).trim());
    if (!vals.length) return false;
    const numeric = vals.filter(v => isFormula(v) || looksNumeric(v)).length;
    return numeric / vals.length >= 0.6;
  });
}

// ---------- PDF ----------

const ACCENT = '#1a56db';

function pdfRuns(text) {
  return parseInlineSegments(text).map(seg => {
    let t = seg.text;
    if (seg.superscript) t = mapChars(t, SUP);
    if (seg.subscript) t = mapChars(t, SUB);
    const run = { text: t };
    if (seg.bold) run.bold = true;
    if (seg.italic) run.italics = true;
    if (seg.code) run.background = '#f1f3f4';
    return run;
  });
}

function pdfTable(table) {
  const numeric = numericColumns(table);
  const body = [
    table.headers.map((h, c) => ({ text: pdfRuns(h), style: 'th', alignment: numeric[c] ? 'right' : 'left' })),
    ...table.rows.map((row, r) => row.map((cell, c) => {
      const isTotal = /total|итого|jami/i.test(String(row[0] || ''));
      return {
        text: pdfRuns(displayCell(cell, table, c)),
        alignment: numeric[c] ? 'right' : 'left',
        bold: isTotal,
        fillColor: r % 2 ? '#f8fafc' : null
      };
    }))
  ];
  return {
    table: { headerRows: 1, widths: table.headers.map(() => '*'), body },
    layout: {
      hLineWidth: (i, node) => (i === 0 || i === 1 || i === node.table.body.length ? 1 : 0.5),
      vLineWidth: () => 0,
      hLineColor: (i) => (i === 1 ? ACCENT : '#d9dee7'),
      paddingTop: () => 6,
      paddingBottom: () => 6,
      paddingLeft: () => 6,
      paddingRight: () => 6
    },
    margin: [0, 6, 0, 14]
  };
}

async function buildPdf(doc, filename) {
  await ensureLibs('pdf');
  const content = [{ text: pdfRuns(doc.title), style: 'title' }];
  if (doc.subtitle) content.push({ text: pdfRuns(doc.subtitle), style: 'subtitle' });
  content.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 2, lineColor: ACCENT }], margin: [0, 4, 0, 16] });

  doc.sections.forEach(sec => {
    if (sec.heading) content.push({ text: pdfRuns(sec.heading), style: 'heading' });
    sec.paragraphs.filter(p => p.trim()).forEach(p => content.push({ text: pdfRuns(p), style: 'body' }));
    const bullets = sec.bullets.filter(b => b.trim());
    if (bullets.length) content.push({ ul: bullets.map(b => ({ text: pdfRuns(b) })), style: 'body', margin: [8, 0, 0, 10] });
    if (sec.table) content.push(pdfTable(sec.table));
  });

  const definition = {
    info: { title: plainText(doc.title), creator: 'DocGen AI' },
    pageSize: 'A4',
    pageMargins: [40, 48, 40, 56],
    content,
    footer: (page, pages) => ({
      columns: [
        { text: plainText(doc.title), color: '#9aa0a6', fontSize: 8 },
        { text: `${page} / ${pages}`, alignment: 'right', color: '#9aa0a6', fontSize: 8 }
      ],
      margin: [40, 16, 40, 0]
    }),
    styles: {
      title: { fontSize: 22, bold: true, color: '#111827' },
      subtitle: { fontSize: 12, color: '#5f6368', margin: [0, 4, 0, 0] },
      heading: { fontSize: 14, bold: true, color: ACCENT, margin: [0, 10, 0, 6] },
      body: { fontSize: 10.5, lineHeight: 1.3, margin: [0, 0, 0, 8], color: '#1f2937' },
      th: { bold: true, fontSize: 10, color: '#111827' }
    },
    defaultStyle: { fontSize: 10, color: '#1f2937' }
  };

  const blob = await new Promise((resolve, reject) => {
    try {
      window.pdfMake.createPdf(definition).getBlob(resolve);
    } catch (e) { reject(e); }
  });
  return { blob, filename, mime: MIME.pdf };
}

// ---------- DOCX ----------

async function buildDocx(doc, filename) {
  await ensureLibs('docx');
  const {
    Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, TextRun,
    WidthType, ShadingType, AlignmentType, Footer, PageNumber, BorderStyle
  } = window.docx;

  const runs = (text, extra = {}) => parseInlineSegments(text).map(seg => new TextRun({
    text: seg.text,
    bold: extra.bold || seg.bold || undefined,
    italics: seg.italic || undefined,
    superScript: seg.superscript || undefined,
    subScript: seg.subscript || undefined,
    font: seg.code ? 'Consolas' : undefined,
    color: extra.color
  }));

  const children = [new Paragraph({ children: runs(doc.title), heading: HeadingLevel.TITLE })];
  if (doc.subtitle) children.push(new Paragraph({ children: runs(doc.subtitle, { color: '5F6368' }), spacing: { after: 240 } }));

  const border = { style: BorderStyle.SINGLE, size: 4, color: 'D9DEE7' };
  doc.sections.forEach(sec => {
    if (sec.heading) children.push(new Paragraph({ children: runs(sec.heading), heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 } }));
    sec.paragraphs.filter(p => p.trim()).forEach(p => children.push(new Paragraph({ children: runs(p), spacing: { after: 120 } })));
    sec.bullets.filter(b => b.trim()).forEach(b => children.push(new Paragraph({ children: runs(b), bullet: { level: 0 } })));
    if (sec.table) {
      const t = sec.table;
      const numeric = numericColumns(t);
      const cell = (text, c, header, shade) => new TableCell({
        children: [new Paragraph({ children: runs(text, { bold: header }), alignment: numeric[c] ? AlignmentType.RIGHT : AlignmentType.LEFT })],
        shading: header ? { type: ShadingType.CLEAR, fill: 'E8EEF9', color: 'auto' } : (shade ? { type: ShadingType.CLEAR, fill: 'F8FAFC', color: 'auto' } : undefined),
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
        borders: { top: border, bottom: border, left: border, right: border }
      });
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ tableHeader: true, children: t.headers.map((h, c) => cell(h, c, true)) }),
          ...t.rows.map((row, r) => new TableRow({ children: row.map((v, c) => cell(displayCell(v, t, c), c, false, r % 2 === 1)) }))
        ]
      }));
      children.push(new Paragraph({ children: [], spacing: { after: 120 } }));
    }
  });

  const file = new Document({
    creator: 'DocGen AI',
    title: plainText(doc.title),
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{
      properties: {},
      footers: {
        default: new Footer({
          children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ children: [PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES], size: 16, color: '9AA0A6' })] })]
        })
      },
      children
    }]
  });
  const blob = await Packer.toBlob(file);
  return { blob, filename, mime: MIME.docx };
}

// ---------- XLSX ----------

async function buildXlsx(doc, filename) {
  await ensureLibs('xlsx');
  const workbook = new window.ExcelJS.Workbook();
  // Excel recomputes every formula on open, so edits made in the app never
  // leave stale cached values behind.
  workbook.calcProperties.fullCalcOnLoad = true;
  workbook.creator = 'DocGen AI';
  const sheetName = plainText(doc.title).replace(/[\\/?*[\]:]/g, '').slice(0, 31) || 'Sheet1';
  const sheet = workbook.addWorksheet(sheetName, { views: [{ showGridLines: true }] });

  const widest = Math.max(1, ...doc.sections.map(s => (s.table ? s.table.headers.length : 1)));
  const colWidths = new Array(widest).fill(12);
  const track = (c, text) => { colWidths[c] = Math.min(60, Math.max(colWidths[c], String(text).length + 2)); };

  let row = 1;
  sheet.getCell(row, 1).value = plainText(doc.title);
  sheet.getCell(row, 1).font = { bold: true, size: 16 };
  if (widest > 1) sheet.mergeCells(row, 1, row, widest);
  row += 1;
  if (doc.subtitle) {
    sheet.getCell(row, 1).value = plainText(doc.subtitle);
    sheet.getCell(row, 1).font = { italic: true, color: { argb: 'FF5F6368' } };
    row += 1;
  }
  row += 1;

  for (const sec of doc.sections) {
    if (sec.heading) {
      sheet.getCell(row, 1).value = plainText(sec.heading);
      sheet.getCell(row, 1).font = { bold: true, size: 12, color: { argb: 'FF1A56DB' } };
      row += 1;
    }
    for (const p of sec.paragraphs.filter(x => x.trim())) {
      const c = sheet.getCell(row, 1);
      c.value = plainText(p);
      c.alignment = { wrapText: true, vertical: 'top' };
      if (widest > 1) sheet.mergeCells(row, 1, row, widest);
      row += 1;
    }
    for (const b of sec.bullets.filter(x => x.trim())) {
      sheet.getCell(row, 1).value = `• ${plainText(b)}`;
      if (widest > 1) sheet.mergeCells(row, 1, row, widest);
      row += 1;
    }
    if (sec.table) {
      const t = sec.table;
      const numeric = numericColumns(t);
      const headerRow = row;
      t.headers.forEach((h, c) => {
        const cell = sheet.getCell(row, c + 1);
        cell.value = plainText(h);
        cell.font = { bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF9' } };
        cell.border = { bottom: { style: 'thin', color: { argb: 'FF1A56DB' } } };
        cell.alignment = { horizontal: numeric[c] ? 'right' : 'left' };
        track(c, plainText(h));
      });
      row += 1;
      // Formulas were written relative to the table (header = row 1).
      const offset = headerRow - 1;
      t.rows.forEach(r => {
        r.forEach((v, c) => {
          const cell = sheet.getCell(row, c + 1);
          if (isFormula(v)) {
            let computed;
            try { computed = Number(displayValue(v, t).replace(/,/g, '')); } catch { computed = undefined; }
            cell.value = { formula: rebaseFormula(String(v).trim().slice(1), offset), result: Number.isFinite(computed) ? computed : undefined };
            cell.numFmt = '#,##0.##';
          } else if (String(v).trim() && looksNumeric(v) && !/^0\d/.test(String(v).trim())) {
            cell.value = parseNumber(v);
            if (/%\s*$/.test(String(v))) cell.numFmt = '0.##%';
            else cell.numFmt = '#,##0.##';
          } else {
            cell.value = plainText(v);
          }
          if (numeric[c]) cell.alignment = { horizontal: 'right' };
          if (/total|итого|jami/i.test(String(r[0] || ''))) cell.font = { bold: true };
          track(c, displayValue(v, t));
        });
        row += 1;
      });
      row += 1;
    }
    if (!sec.table) row += 1;
  }

  colWidths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });
  const buffer = await workbook.xlsx.writeBuffer();
  return { blob: new Blob([buffer], { type: MIME.xlsx }), filename, mime: MIME.xlsx };
}

// ---------- entry point ----------

export async function buildDocument(schema, format) {
  const doc = DocSchema.normalize(schema);
  const filename = DocSchema.safeFilename(doc.title, format);
  if (format === 'pdf') return buildPdf(doc, filename);
  if (format === 'docx') return buildDocx(doc, filename);
  if (format === 'xlsx') return buildXlsx(doc, filename);
  throw new Error('Unknown format');
}

export { MIME };
