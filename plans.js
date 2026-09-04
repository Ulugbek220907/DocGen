// Single source of truth for what each plan gets. Tune these freely — every
// consumer (usage.js, billing-routes.js, the frontend upgrade modal) reads
// from here rather than hardcoding numbers.
const PLANS = {
  free: {
    id: 'free',
    label: 'Free',
    monthlyDocs: 5
  },
  pro: {
    id: 'pro',
    label: 'Pro',
    monthlyDocs: Infinity,
    // Adjust to whatever you land on — these are placeholders.
    priceUsd: 9,       // charged worldwide via Paddle
    priceUzs: 49000,   // charged in Uzbekistan via Payme/Click
    periodDays: 30
  }
};

function getPlan(planId) {
  return PLANS[planId] || PLANS.free;
}

module.exports = { PLANS, getPlan };
