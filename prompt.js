const DocSchema = require('./public/js/doc-schema');

// Best-effort language detection for the user's message. Models tend to
// switch to Uzbek or Russian as soon as they see "UZS" or "Tashkent", so the
// detected language is stated explicitly in the prompt. Returns null when
// unsure, in which case the model decides.
const UZ_WORDS = new Set(('va uchun bilan menga menga kerak qilib qil yoz yozing tayyorla tayyorlab yarat yarating haqida bo\'yicha boyicha ' +
  'yoki ham emas bu shu uning mening bizning sizning bir ikki uch yil oy kun hisobot xat ro\'yxat royxat jadval hujjat ' +
  'narx summa soni oylik kompaniya ishchi ish uchun qo\'sh qosh o\'zgartir ozgartir iltimos rahmat salom kerakli').split(/\s+/));
const EN_WORDS = new Set(('the and for with a an of to in on my me please make create write add change from about this that ' +
  'is are be it its i you your we our need want can could would should include list table report letter invoice ' +
  'budget plan month year total per each all into as at by').split(/\s+/));

function detectLanguage(text) {
  const t = String(text || '').toLowerCase();
  const letters = t.match(/\p{L}/gu) || [];
  if (letters.length < 3) return null;
  const cyr = letters.filter(ch => /[\u0400-\u04FF]/.test(ch)).length;
  if (cyr / letters.length > 0.5) return /[ўқғҳ]/.test(t) ? 'Uzbek (Cyrillic script)' : 'Russian';
  const words = t.replace(/[‘’ʻʼ`]/g, "'").match(/[a-z']+/g) || [];
  let uz = 0;
  let en = 0;
  for (const w of words) {
    if (UZ_WORDS.has(w)) uz++;
    if (EN_WORDS.has(w)) en++;
    if (/^[a-z]*(o'|g')[a-z]*$/.test(w) || /(lar|lari|ning|dagi|ga|da|dan|ni)$/.test(w) && w.length > 4 && !EN_WORDS.has(w)) uz += 0.5;
  }
  if (en >= 2 && en > uz * 1.5) return 'English';
  if (uz >= 2 && uz > en * 1.5) return 'Uzbek (Latin script)';
  return null;
}

function buildSystemPrompt({ defaultFormat, currentDocument, today = new Date(), userText = '' }) {
  const fmt = defaultFormat.toUpperCase();
  const isoDate = today.toISOString().slice(0, 10);
  let prompt = `You are DocGen AI, an expert document writer inside a mobile/web app that turns conversations into real PDF, Word (DOCX) and Excel (XLSX) files.

Today's date is ${isoDate}. Use it for document dates, due dates and anything time-relative.

Always answer with ONE valid json object and nothing else — no markdown fences, no text outside the json.

LANGUAGE: reply and write the document in the language of the words in the user's LATEST message (English stays English, Uzbek stays Uzbek, Russian stays Russian), unless they explicitly ask for another language. Currencies, countries, cities or names (UZS, so'm, Tashkent…) never change the language.

Choose one of two actions:

1) Chat, or ask ONE short clarifying question:
{"action":"reply","message":"..."}

2) Produce or update a document:
{
  "action":"generate",
  "target":"new" | "update",
  "format":"pdf" | "docx" | "xlsx",
  "message":"one short sentence telling the user what you made or changed",
  "suggestions":["up to 3 very short follow-up edits the user might want"],
  "document":{
    "title":"...",
    "subtitle":"optional short line under the title",
    "sections":[
      {
        "heading":"section heading or empty string",
        "paragraphs":["full paragraph text", "..."],
        "bullets":["optional list items"],
        "table":{"headers":["..."],"rows":[["...","..."]]}
      }
    ]
  }
}

WHEN TO GENERATE: if the request is clear enough to produce a genuinely useful draft, generate it right away instead of asking questions. Fill every detail the user didn't give with realistic sample values (plausible names, companies, amounts; today's date for dates) — never leave bracketed placeholders like [Client name] or [Month Year]. The user edits the document afterwards, so a complete, realistic draft is far more useful. Only use "reply" for greetings/small talk, questions about the app, or when the request is far too vague to draft anything.

QUALITY RULES for "generate":
- Write the COMPLETE content — every paragraph, every question, every row. Never return an empty or placeholder-only document, never summarise what you "would" write.
- Structure: use sections with headings; put key facts/lists in "bullets"; put tabular data (line items, schedules, budgets, comparisons) in a section "table". Omit "bullets"/"table" when not needed.
- Invoices/quotes: a details section (from, to, date, number, due date) + an items table (description, qty, unit price, amount) + totals.
- XLSX: tables are the main content.
- Calculations in tables (any format): write formulas as cell text starting with "=" instead of pre-computed numbers, e.g. "=B2*C2" or "=SUM(D2:D4)". Supported: + - * / parentheses, SUM, AVERAGE, MIN, MAX, COUNT, ROUND. References are relative to the SAME table: its header row is row 1, the first data row is row 2, columns are A, B, C… in header order. The app computes them for PDF/Word and keeps them live in Excel. Cells that formulas use must hold plain numbers (no currency symbols or thousands separators) — put the currency in the column header, e.g. "Amount (USD)".
- Inline formatting inside any text: **bold**, *italic*, ^(superscript), _(subscript). Use unicode symbols (×, ÷, √, ±, °, π, ≤, ≥) — NEVER LaTeX or backslashes, they break the json.
- Numbers: keep currency and units consistent; make arithmetic correct.

FORMAT: the user's selected format is ${fmt}. Use it unless the user's LATEST message explicitly asks for a different format.`;

  if (currentDocument) {
    prompt += `

CURRENT DOCUMENT: the user is working on the document below (format ${currentDocument.format.toUpperCase()}). If their message asks to change, extend, fix, translate or restyle it, respond with "action":"generate", "target":"update", and the COMPLETE updated document — keep everything they did not ask to change exactly as it is. If they clearly want a different, separate document, use "target":"new".
${JSON.stringify(currentDocument.schema)}`;
  } else {
    prompt += `

There is no current document yet, so "target" is always "new".`;
  }

  const language = detectLanguage(userText);
  if (language) {
    prompt += currentDocument
      ? `\n\nThe user's latest message is in ${language}. Write "message" and "suggestions" in ${language}. Keep the document in the language it is already written in, unless the user asks to translate it.`
      : `\n\nThe user's latest message is in ${language}. Write "message", "suggestions" and the entire document in ${language}.`;
  }

  return prompt;
}

// Model output containing math sometimes includes raw backslashes (LaTeX
// habits) which are invalid inside a JSON string unless escaped.
function sanitizeJsonText(text) {
  return text.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
}

class ModelOutputError extends Error {}

function parseModelResponse(raw) {
  let text = String(raw || '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new ModelOutputError('The AI response was not valid JSON.');
  text = text.slice(start, end + 1);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = JSON.parse(sanitizeJsonText(text));
    } catch {
      throw new ModelOutputError('The AI response was not valid JSON.');
    }
  }

  if (parsed.action === 'reply') {
    const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
    if (!message) throw new ModelOutputError('The AI returned an empty reply.');
    return { action: 'reply', message };
  }

  if (parsed.action === 'generate') {
    // Accept the legacy key too, in case a model echoes the older shape.
    const doc = DocSchema.normalize(parsed.document || parsed.schema);
    if (!DocSchema.hasContent(doc)) {
      throw new ModelOutputError('The AI returned a document with no real content.');
    }
    return {
      action: 'generate',
      target: parsed.target === 'update' ? 'update' : 'new',
      format: DocSchema.isFormat(parsed.format) ? parsed.format : null,
      message: typeof parsed.message === 'string' ? parsed.message.trim().slice(0, 500) : '',
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim().slice(0, 80)).slice(0, 3)
        : [],
      document: doc
    };
  }

  throw new ModelOutputError('The AI returned an unexpected response.');
}

module.exports = { buildSystemPrompt, parseModelResponse, ModelOutputError, detectLanguage };
