// Pure unit tests for the shared document model and the formula engine.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const DocSchema = require('../public/js/doc-schema');

test('normalize fills defaults, folds a legacy top-level table and drops junk', () => {
  const doc = DocSchema.normalize({ sections: [{ heading: 'A', paragraphs: 'x' }], table: { headers: ['h'], rows: [['1']] }, extra: 1 });
  assert.equal(doc.title, 'Untitled document');
  assert.deepEqual(doc.sections[0].paragraphs, []);
  assert.deepEqual(doc.sections[1].table, { headers: ['h'], rows: [['1']] });
  assert.equal(doc.extra, undefined);
  assert.equal(DocSchema.normalize(null).sections.length, 0);
});

test('hasContent and plain text', () => {
  assert.equal(DocSchema.hasContent(DocSchema.normalize({ title: 'Only title' })), false);
  const doc = DocSchema.normalize({ title: 'T', sections: [{ heading: 'H', bullets: ['b1'] }] });
  assert.equal(DocSchema.hasContent(doc), true);
  assert.match(DocSchema.toPlainText(doc), /b1/);
});

test('explicit format detection for new documents vs conversions of existing ones', () => {
  assert.equal(DocSchema.detectExplicitFormat('make a budget spreadsheet'), 'xlsx');
  assert.equal(DocSchema.detectExplicitFormat('write a CV as a Word document'), 'docx');
  assert.equal(DocSchema.detectExplicitFormat('write a CV'), null);
  assert.equal(DocSchema.detectConversion('add a table like in Excel'), null);
  assert.equal(DocSchema.detectConversion('change the title to Excel Report'), null);
  assert.equal(DocSchema.detectConversion('convert it to PDF please'), 'pdf');
  assert.equal(DocSchema.detectConversion('export this as a Word document'), 'docx');
});

test('safe filenames keep letters in any script', () => {
  assert.equal(DocSchema.safeFilename('Hisob-faktura №12 / 2026', 'pdf'), 'Hisob-faktura_No12_2026.pdf');
  assert.equal(DocSchema.safeFilename('Счёт', 'xlsx'), 'Счет.xlsx');
  assert.equal(DocSchema.safeFilename('***', 'docx'), 'document.docx');
});

test('formula engine (browser module) evaluates, formats and rebases', async () => {
  const f = await import('../public/js/formula.js');
  const table = { headers: ['Item', 'Qty', 'Price', 'Amount'], rows: [['A', '2', '10', '=B2*C2'], ['B', '3', '1,000.50', '=B3*C3'], ['Total', '', '', '=SUM(D2:D3)']] };
  assert.equal(f.evaluate('=B2*C2', table), 20);
  assert.equal(f.evaluate('=SUM(D2:D3)', table), 3021.5, 'formulas can reference formulas');
  assert.equal(f.displayValue('=ROUND(AVERAGE(B2:B3),1)', table), '2.5');
  assert.equal(f.displayValue('=B2/0', table), '=B2/0', 'errors show the raw formula');
  assert.equal(f.displayValue('=A1+', table), '=A1+');
  assert.equal(f.rebaseFormula('=SUM(D2:D3)+$B$1', 4), '=SUM(D6:D7)+$B$1');
  assert.ok(Number.isNaN(f.parseNumber('Rent')), 'text is not a number');
  assert.equal(f.parseNumber('1 234'), 1234);
  assert.equal(f.parseNumber('15%'), 0.15);
  assert.equal(f.parseNumber('$1,234.50'), 1234.5);
});

test('large plain numbers get thousands separators for display, identifiers do not', async () => {
  const f = await import('../public/js/formula.js');
  const t = { headers: ['Item', 'Amount (UZS)', 'Year', 'Phone'], rows: [['Rent', '4500000', '2026', '998901234567']] };
  assert.equal(f.displayCell('4500000', t, 1), '4,500,000');
  assert.equal(f.displayCell('2026', t, 2), '2026');
  assert.equal(f.displayCell('998901234567', t, 3), '998901234567');
  assert.equal(f.displayCell('0012', t, 1), '0012');
  assert.equal(f.displayCell('950', t, 1), '950');
  assert.equal(f.displayCell('Rent', t, 0), 'Rent');
});
