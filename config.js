// One place that reads environment variables, so the rest of the code never
// has to guess at defaults or fallbacks.

function trimSlash(url) {
  return (url || '').replace(/\/+$/, '');
}

function list(value) {
  return (value || '').split(',').map(s => s.trim()).filter(Boolean);
}

// Any OpenAI-compatible chat-completions API works. DeepSeek is the default;
// the OpenRouter fallback only exists so an old deployment that still has
// just OPENROUTER_API_KEY set keeps working through the switch.
function resolveAi() {
  const key = process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY;
  if (key) {
    return {
      apiKey: key,
      baseUrl: trimSlash(process.env.AI_BASE_URL || 'https://api.deepseek.com'),
      model: process.env.AI_MODEL || 'deepseek-flash'
    };
  }
  if (process.env.OPENROUTER_API_KEY) {
    return {
      apiKey: process.env.OPENROUTER_API_KEY,
      baseUrl: 'https://openrouter.ai/api/v1',
      model: process.env.AI_MODEL || 'google/gemini-2.5-flash'
    };
  }
  return { apiKey: null, baseUrl: trimSlash(process.env.AI_BASE_URL || 'https://api.deepseek.com'), model: process.env.AI_MODEL || 'deepseek-flash' };
}

const ai = resolveAi();

module.exports = {
  // Used to build links that leave the server (password-reset emails,
  // payment return URLs). Never derived from the request's Host header,
  // which an attacker controls.
  publicUrl: trimSlash(process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'),

  jwtSecret: process.env.JWT_SECRET,

  ai: {
    ...ai,
    // DeepSeek's models think before answering by default; for structured
    // document JSON that only adds latency and cost.
    disableThinking: /deepseek\.com/.test(ai.baseUrl),
    maxOutputTokens: Number(process.env.AI_MAX_OUTPUT_TOKENS) || 8000,
    // Images are forwarded to the model as vision input. Turn off if you
    // switch to a text-only model.
    vision: process.env.AI_VISION !== 'false'
  },

  google: {
    // The Web client ID (…apps.googleusercontent.com). The Android app's
    // native sign-in also mints tokens for this audience.
    clientIds: list(process.env.GOOGLE_CLIENT_IDS || process.env.GOOGLE_WEB_CLIENT_ID)
  },

  paddle: {
    clientToken: process.env.PADDLE_CLIENT_TOKEN || null,
    priceId: process.env.PADDLE_PRICE_ID || null,
    webhookSecret: process.env.PADDLE_WEBHOOK_SECRET || null,
    apiKey: process.env.PADDLE_API_KEY || null,
    environment: process.env.PADDLE_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production'
  },

  payme: {
    merchantId: process.env.PAYME_MERCHANT_ID || null,
    key: process.env.PAYME_KEY || null,
    checkoutUrl: trimSlash(process.env.PAYME_CHECKOUT_URL || 'https://checkout.paycom.uz')
  },

  click: {
    serviceId: process.env.CLICK_SERVICE_ID || null,
    merchantId: process.env.CLICK_MERCHANT_ID || null,
    secretKey: process.env.CLICK_SECRET_KEY || null
  }
};
