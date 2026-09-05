const pool = require('./db-pool');
const { getPlan } = require('./plans');

const MS_PER_MONTH = 30 * 24 * 60 * 60 * 1000;

// Atomically checks whether userId may generate one more document right now
// and, if so, consumes it. Uses SELECT ... FOR UPDATE so two concurrent
// requests from the same user can't both slip through on the last unit of
// quota. Returns { allowed, remaining, plan, limit }.
async function checkAndConsumeQuota(userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT plan, plan_expires_at, monthly_usage_count, usage_reset_at FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );
    const user = rows[0];
    if (!user) {
      await client.query('ROLLBACK');
      return { allowed: false, remaining: 0, plan: 'free', limit: 0 };
    }

    // A paid plan that expired without a renewal webhook updating it yet
    // (e.g. the provider's renewal charge failed) reverts to free rules.
    let effectivePlan = user.plan;
    if (effectivePlan !== 'free' && user.plan_expires_at && new Date(user.plan_expires_at) < new Date()) {
      effectivePlan = 'free';
    }

    let usageCount = user.monthly_usage_count;
    let resetAt = new Date(user.usage_reset_at);
    const now = new Date();
    if (now - resetAt > MS_PER_MONTH) {
      usageCount = 0;
      resetAt = now;
    }

    const limit = getPlan(effectivePlan).monthlyDocs;
    const allowed = usageCount < limit;

    if (allowed) {
      usageCount += 1;
    }

    await client.query(
      'UPDATE users SET monthly_usage_count = $1, usage_reset_at = $2 WHERE id = $3',
      [usageCount, resetAt, userId]
    );

    await client.query('COMMIT');

    return {
      allowed,
      remaining: limit === Infinity ? Infinity : Math.max(0, limit - usageCount),
      plan: effectivePlan,
      limit
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Read-only status for the Settings UI — does not consume quota or mutate state.
async function getUsageStatus(userId) {
  const { rows } = await pool.query(
    'SELECT plan, plan_expires_at, monthly_usage_count, usage_reset_at FROM users WHERE id = $1',
    [userId]
  );
  const user = rows[0];
  if (!user) return null;

  let effectivePlan = user.plan;
  if (effectivePlan !== 'free' && user.plan_expires_at && new Date(user.plan_expires_at) < new Date()) {
    effectivePlan = 'free';
  }

  const resetAt = new Date(user.usage_reset_at);
  const usageCount = (new Date() - resetAt > MS_PER_MONTH) ? 0 : user.monthly_usage_count;
  const limit = getPlan(effectivePlan).monthlyDocs;

  return {
    plan: effectivePlan,
    planExpiresAt: user.plan_expires_at,
    usageCount,
    limit,
    remaining: limit === Infinity ? Infinity : Math.max(0, limit - usageCount)
  };
}

module.exports = { checkAndConsumeQuota, getUsageStatus };
