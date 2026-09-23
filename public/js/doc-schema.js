// The document model shared by the server (validation of AI output) and the
// app (editor, previews, file builders). Written as a plain script — no
// import/export — so Node can require() it and the browser can load it as
// a module side-effect; it exposes itself as globalThis.DocSchema.
//
// Shape:
// {
//   title: string,
//   subtitle?: string,
//   sections: [{
//     heading: string,
//     paragraphs: string[],
//     bullets: string[],
//     table?: { headers: string[], rows: string[][] }
//   }]
// }
// Older documents had a single top-level `table`; normalize() folds it into
// a final section so everything downstream deals with one shape.
(function (root) {
  const FORMATS = ['pdf', 'docx', 'xlsx'];
  const MAX_SECTIONS = 60;
  const MAX_ITEMS = 200;
  const MAX_TEXT = 8000;
  const MAX_COLS = 20;
  const MAX_ROWS = 500;

  function str(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.slice(0, MAX_TEXT);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
  }

  function strList(value, limit = MAX_ITEMS) {
    if (!Array.isArray(value)) return [];
    return value.map(str).slice(0, limit);
  }

  function normalizeTable(table) {
    if (!table || typeof table !== 'object') return null;
    let headers = strList(table.headers, MAX_COLS);
    let rows = Array.isArray(table.rows) ? table.rows.slice(0, MAX_ROWS) : [];
    rows = rows.map(row => strList(Array.isArray(row) ? row : [row], MAX_COLS));
    const width = Math.max(headers.length, ...rows.map(r => r.length), 0);
    if (width === 0) return null;
    while (headers.length < width) headers.push('');
    rows = rows.map(r => {
      const copy = r.slice(0, width);
      while (copy.length < width) copy.push('');
      return copy;
    });
    return { headers, rows };
  }

  function normalizeSection(section) {
    const s = section && typeof section === 'object' ? section : {};
    const out = {
      heading: str(s.heading),
      paragraphs: strList(s.paragraphs),
      bullets: strList(s.bullets)
    };
    const table = normalizeTable(s.table);
    if (table) out.table = table;
    return out;
  }

  function normalize(schema) {
    const s = schema && typeof schema === 'object' ? schema : {};
    const sections = (Array.isArray(s.sections) ? s.sections : [])
      .slice(0, MAX_SECTIONS)
      .map(normalizeSection);
    const legacyTable = normalizeTable(s.table);
    if (legacyTable) sections.push({ heading: '', paragraphs: [], bullets: [], table: legacyTable });
    const out = { title: str(s.title).trim() || 'Untitled document', sections };
    const subtitle = str(s.subtitle).trim();
    if (subtitle) out.subtitle = subtitle;
    return out;
  }

  function hasContent(schema) {
    return (schema.sections || []).some(sec =>
      (sec.paragraphs || []).some(p => p.trim()) ||
      (sec.bullets || []).some(b => b.trim()) ||
      (sec.table && sec.table.rows.some(r => r.some(c => String(c).trim())))
    );
  }

  // Text for search and for showing the model what a document contains.
  function toPlainText(schema) {
    const parts = [schema.title];
    if (schema.subtitle) parts.push(schema.subtitle);
    (schema.sections || []).forEach(sec => {
      if (sec.heading) parts.push(sec.heading);
      (sec.paragraphs || []).forEach(p => parts.push(p));
      (sec.bullets || []).forEach(b => parts.push('• ' + b));
      if (sec.table) {
        parts.push(sec.table.headers.join(' | '));
        sec.table.rows.forEach(r => parts.push(r.join(' | ')));
      }
    });
    return parts.join('\n');
  }

  function isFormat(value) {
    return FORMATS.includes(value);
  }

  // Only the CURRENT message's own words can override the chosen format, so
  // an old message can't make a format "stick" across turns.
  function detectExplicitFormat(text) {
    const t = String(text || '');
    if (/\b(docx|word doc(ument)?|ms word|\.docx|ворд|word fayl)\b/i.test(t)) return 'docx';
    if (/\b(xlsx|excel|spreadsheet|\.xlsx|эксель|jadval fayl)\b/i.test(t)) return 'xlsx';
    if (/\b(pdf|\.pdf)\b/i.test(t)) return 'pdf';
    return null;
  }

  // Stricter version for edits of an existing document: only a clear
  // conversion request ("convert it to PDF", "export as Word") changes the
  // format — "add a table like in Excel" must not.
  function detectConversion(text) {
    const m = String(text || '').match(/\b(convert|export|save|switch|change|turn|make)\b[^.?!\n]{0,40}?\b(to|into|as)\s+(an?\s+)?(pdf|word|docx|excel|xlsx|spreadsheet)(\s+(file|format|document|doc|version|spreadsheet|sheet))?(\s+(please|instead|now|too))?\s*([.!?,]|$)/i);
    if (!m) return null;
    const w = m[4].toLowerCase();
    return w === 'pdf' ? 'pdf' : (w === 'word' || w === 'docx') ? 'docx' : 'xlsx';
  }

  function safeFilename(title, format) {
    const base = String(title || 'document')
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}\-_ ]/gu, '')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 60) || 'document';
    return `${base}.${format}`;
  }

  const api = { FORMATS, normalize, hasContent, toPlainText, isFormat, detectExplicitFormat, detectConversion, safeFilename };
  root.DocSchema = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
