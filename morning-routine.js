/**
 * APEX Morning Routine - Budget planning session that runs before any business tasks.
 *
 * Sequence:
 * 1. Load yesterday's actual spend, compare to estimates, adjust cost table if divergent
 * 2. Load today's task backlog
 * 3. Run budget-brain costing on every task
 * 4. Produce costed daily plan (trimmed to $2.00)
 * 5. Send Telegram summary with the plan
 * 6. Only after this completes does APEX begin executing tasks
 */

import fs from 'fs';
import path from 'path';
import https from 'https';

import {
  costDailyPlan,
  estimateTaskCost,
  getDailyEnvelope,
  loadCostTable,
  saveCostTable,
  DEFAULT_COST_TABLE,
  DAILY_PLAN_BUDGET,
  DAILY_USD_CAP,
  loadDailyPlan,
} from './budget-brain.js';

const TRACKER_PATH = path.resolve(process.cwd(), 'spend-tracker.json');
const ARCHIVE_DIR = path.resolve(process.cwd(), 'data/spend-archive');
const TELEGRAM_CHAT_ID = '8111645127';

function todayUTC() {
  return new Date().toISOString().split('T')[0];
}

function yesterdayUTC() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().split('T')[0];
}

/**
 * Archive yesterday's spend tracker for historical comparison.
 */
function archiveYesterdaySpend() {
  try {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    const archivePath = path.join(ARCHIVE_DIR, `${yesterdayUTC()}.json`);

    // If we have yesterday's daily-plan, merge actual spend into archive
    if (fs.existsSync(TRACKER_PATH)) {
      const tracker = JSON.parse(fs.readFileSync(TRACKER_PATH, 'utf-8'));
      if (tracker.date === yesterdayUTC()) {
        const planPath = path.resolve(process.cwd(), 'daily-plan.json');
        let estimatedTotal = 0;
        if (fs.existsSync(planPath)) {
          try {
            const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
            if (plan.date === yesterdayUTC()) {
              estimatedTotal = plan.estimated_total_usd || 0;
            }
          } catch { /* no plan */ }
        }

        const archive = {
          date: tracker.date,
          actual_spend_usd: tracker.daily_spend_usd,
          estimated_total_usd: estimatedTotal,
          total_calls: tracker.call_log.length,
          input_tokens: tracker.daily_input_tokens,
          output_tokens: tracker.daily_output_tokens,
        };
        fs.writeFileSync(archivePath, JSON.stringify(archive, null, 2) + '\n');
        return archive;
      }
    }
  } catch { /* best effort */ }
  return null;
}

/**
 * Step 1: Compare yesterday's actual spend to estimates. Adjust cost table if >20% off.
 */
function reconcileYesterday() {
  const archive = archiveYesterdaySpend();
  if (!archive || !archive.estimated_total_usd) {
    return { reconciled: false, reason: 'no_yesterday_data' };
  }

  const divergence = Math.abs(archive.actual_spend_usd - archive.estimated_total_usd) / archive.estimated_total_usd;

  if (divergence > 0.20) {
    // Apply a global scaling factor to the cost table
    const scaleFactor = archive.actual_spend_usd / archive.estimated_total_usd;
    const table = loadCostTable();
    for (const key of Object.keys(table)) {
      table[key].input = Math.round(table[key].input * scaleFactor);
      table[key].output = Math.round(table[key].output * scaleFactor);
    }
    saveCostTable(table);
    return {
      reconciled: true,
      divergence_pct: Math.round(divergence * 100),
      scale_factor: Math.round(scaleFactor * 100) / 100,
      actual: archive.actual_spend_usd,
      estimated: archive.estimated_total_usd,
    };
  }

  return {
    reconciled: false,
    divergence_pct: Math.round(divergence * 100),
    actual: archive.actual_spend_usd,
    estimated: archive.estimated_total_usd,
  };
}

/**
 * Step 2-4: Load task backlog, cost it, produce plan.
 * Tasks come from the NanoClaw database via getDueTasks or a snapshot file.
 */
function buildDailyPlan(taskBacklog = []) {
  // If no explicit backlog provided, try to load from tasks snapshot
  if (taskBacklog.length === 0) {
    try {
      // Check common task snapshot locations
      const snapshotPaths = [
        path.resolve(process.cwd(), 'data/tasks-snapshot.json'),
        path.resolve(process.cwd(), 'groups/main/tasks.json'),
      ];
      for (const sp of snapshotPaths) {
        if (fs.existsSync(sp)) {
          const tasks = JSON.parse(fs.readFileSync(sp, 'utf-8'));
          if (Array.isArray(tasks) && tasks.length > 0) {
            taskBacklog = tasks
              .filter(t => t.status === 'active')
              .map(t => ({
                name: t.prompt?.slice(0, 60) || `task-${t.id}`,
                taskType: classifyTaskType(t.prompt || ''),
                complexity: 'normal',
                priority: 5,
              }));
            break;
          }
        }
      }
    } catch { /* proceed with empty backlog */ }
  }

  // Always include the morning planning task itself
  const planningTask = {
    name: 'morning_planning',
    taskType: 'daily_planning',
    complexity: 'normal',
    priority: 1,
  };

  const allTasks = [planningTask, ...taskBacklog];
  return costDailyPlan(allTasks);
}

/**
 * Heuristic: classify a task prompt into a task type for cost estimation.
 */
function classifyTaskType(prompt) {
  const lower = prompt.toLowerCase();
  if (lower.includes('research') || lower.includes('search') || lower.includes('find')) return 'research_web';
  if (lower.includes('code') || lower.includes('implement') || lower.includes('fix') || lower.includes('build')) return 'code_generation';
  if (lower.includes('write') || lower.includes('draft') || lower.includes('compose')) {
    return lower.length > 200 ? 'write_long_content' : 'write_short_content';
  }
  if (lower.includes('decide') || lower.includes('strategy') || lower.includes('plan')) return 'business_decision';
  if (lower.includes('summarize') || lower.includes('summary')) return 'summarize';
  if (lower.includes('analyze') || lower.includes('reason') || lower.includes('complex')) return 'complex_reasoning';
  if (lower.includes('reply') || lower.includes('respond') || lower.includes('answer')) return 'classify_reply';
  return 'classify_reply'; // default to cheapest
}

/**
 * Step 5: Format and send the daily plan via Telegram.
 */
async function sendDailyPlanTelegram(plan, reconciliation) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  const lines = [
    `\u{1f4cb} *APEX Daily Budget Plan* \u2014 ${plan.date}`,
    ``,
    `*Budget:* $${DAILY_PLAN_BUDGET} planning / $${DAILY_USD_CAP} cap`,
    `*Estimated spend:* $${plan.estimated_total_usd}`,
    `*Buffer:* $${plan.buffer_usd}`,
  ];

  if (reconciliation.reconciled) {
    lines.push(``);
    lines.push(`\u{1f504} *Yesterday adjustment:* estimates were ${reconciliation.divergence_pct}% off`);
    lines.push(`  Actual: $${reconciliation.actual?.toFixed(4)} vs Est: $${reconciliation.estimated?.toFixed(4)}`);
    lines.push(`  Cost table scaled by ${reconciliation.scale_factor}x`);
  } else if (reconciliation.actual !== undefined) {
    lines.push(``);
    lines.push(`\u2705 *Yesterday accuracy:* ${100 - (reconciliation.divergence_pct || 0)}% (within tolerance)`);
  }

  lines.push(``);
  lines.push(`*Planned tasks (${plan.planned.length}):*`);
  for (const t of plan.planned) {
    const model = t.recommended_model?.includes('sonnet') ? '\u{1f534}Sonnet' : '\u{1f535}Haiku';
    lines.push(`  ${t.priority || '-'}. ${t.name} \u2014 ~$${t.estimated_usd} (${model})`);
  }

  if (plan.deferred.length > 0) {
    lines.push(``);
    lines.push(`*Deferred tasks (${plan.deferred.length}):*`);
    for (const t of plan.deferred) {
      lines.push(`  \u23f8 ${t.name} \u2014 ~$${t.estimated_usd} (${t.reason})`);
    }
  }

  const message = lines.join('\n');

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: 'Markdown',
  });

  return new Promise((resolve) => {
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

/**
 * Main morning routine entry point.
 * Call this at 00:01 UTC before any tasks run.
 */
export async function runMorningRoutine(taskBacklog = []) {
  // Step 1: Reconcile yesterday
  const reconciliation = reconcileYesterday();

  // Step 2-4: Build costed daily plan
  const plan = buildDailyPlan(taskBacklog);

  // Step 5: Send Telegram summary
  await sendDailyPlanTelegram(plan, reconciliation);

  // Step 6: Plan is logged to daily-plan.json (done in costDailyPlan)
  return { plan, reconciliation };
}

export { classifyTaskType, reconcileYesterday, buildDailyPlan, archiveYesterdaySpend };
