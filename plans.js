// Single source of truth for what each plan gets. Tune freely — the server,
// the /api/config endpoint and the app's upgrade screen all read from here.
const PLANS = {
  free: {
    id: 'free',
    label: 'Free',
    // AI generations per rolling 30 days. A generation is any AI call that
    // produces or rewrites a document; chat replies and manual edits are free.
    monthlyDocs: 10
  },
  pro: {
    id: 'pro',
    label: 'Pro',
    monthlyDocs: Infinity,
    priceUsd: 9,       // charged worldwide via Paddle (set the real price in Paddle too)
    priceUzs: 49000,   // charged in Uzbekistan via Payme/Click
    periodDays: 30
  }
};

function getPlan(planId) {
  return PLANS[planId] || PLANS.free;
}

// Grants (or extends) Pro by `days`. Extends from the current expiry if the
// user still has Pro time left, so paying early never loses days.
async function grantProDays(client, userId, days) {
  const { rows } = await client.query(
    `UPDATE users
        SET plan = 'pro',
            plan_expires_at = GREATEST(now(), COALESCE(plan_expires_at, now())) + make_interval(days => $2)
      WHERE id = $1
      RETURNING plan_expires_at`,
    [userId, days]
  );
  return rows[0]?.plan_expires_at || null;
}

module.exports = { PLANS, getPlan, grantProDays };
