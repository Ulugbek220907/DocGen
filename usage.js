const pool = require('./db-pool');
const { getPlan } = require('./plans');

// A paid plan that expired without a renewal webhook (e.g. a failed renewal
// charge) is treated as free until a webhook says otherwise.
function effectivePlan(user) {
  if (user.plan !== 'free' && user.plan_expires_at && new Date(user.plan_expires_at) < new Date()) {
    return 'free';
  }
  return user.plan || 'free';
}

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

async function getUsageStatus(userId) {
  const { rows } = await pool.query(
    'SELECT plan, plan_expires_at, monthly_usage_count, usage_reset_at FROM users WHERE id = $1',
    [userId]
  );
  const user = rows[0];
  if (!user) return null;

  const plan = effectivePlan(user);
  const resetAt = new Date(user.usage_reset_at);
  const windowExpired = Date.now() - resetAt.getTime() > WINDOW_MS;
  const usageCount = windowExpired ? 0 : user.monthly_usage_count;
  const limit = getPlan(plan).monthlyDocs;

  return {
    plan,
    planExpiresAt: user.plan_expires_at,
    usageCount,
    limit,
    remaining: limit === Infinity ? Infinity : Math.max(0, limit - usageCount),
    resetsAt: windowExpired ? null : new Date(resetAt.getTime() + WINDOW_MS)
  };
}

// Counts one AI generation. Called only after a document was actually
// produced, so failed calls and plain chat replies never cost the user.
// The rolling-window reset happens in the same statement, so it's atomic.
async function recordGeneration(userId) {
  await pool.query(
    `UPDATE users
        SET monthly_usage_count = CASE WHEN usage_reset_at < now() - interval '30 days' THEN 1 ELSE monthly_usage_count + 1 END,
            usage_reset_at      = CASE WHEN usage_reset_at < now() - interval '30 days' THEN now() ELSE usage_reset_at END
      WHERE id = $1`,
    [userId]
  );
}

module.exports = { getUsageStatus, recordGeneration, effectivePlan };
