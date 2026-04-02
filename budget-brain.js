/**
 * APEX Budget Brain - Single source of truth for how APEX thinks about spending.
 *
 * Mental model: APEX is a contractor with a fixed daily labor budget.
 * Before touching a single tool, the contractor looks at the job list,
 * estimates hours per task, and only commits to work that fits the budget.
 *
 * The budget is not a limit to hit - it is the design constraint that shapes the entire day.
 */

import fs from 'fs';
import path from 'path';

const TRACKER_PATH = path.resolve(process.cwd(), 'spend-tracker.json');
const DAILY_PLAN_PATH = path.resolve(process.cwd(), 'daily-plan.json');
const COST_TABLE_PATH = path.resolve(process.cwd(), 'cost-table.json');

// --- Constants ---
const DAILY_USD_CAP = 2.50;        // Leave $0.50 buffer below $3.00 hard stop
const DAILY_PLAN_BUDGET = 2.00;    // Plan to spend $2.00, keep $0.50 for unplanned work
const HARD_STOP_USD = 3.00;

// Pricing per 1K tokens (USD)
const PRICING = {
  'claude-haiku-4-5-20251001': { input: 0.00025, output: 0.00125 },
  'claude-sonnet-4-6':         { input: 0.003,   output: 0.015 },
};

// Blended token envelope for $2.50/day
const DAILY_ENVELOPE = {
  haiku_weighted_tokens: 800000,    // ~$2.50 worth of blended Haiku tokens
  sonnet_weighted_tokens: 55000,    // ~$2.50 worth of blended Sonnet tokens (use sparingly)
  max_sonnet_calls_per_day: 3,      // Sonnet is a specialist consultant
  usd_cap: DAILY_USD_CAP,
};

// --- Pacing time blocks (UTC) ---
const PACING_BLOCKS = [
  { start: 0,  end: 8,  pct: 0.20, label: 'overnight' },   // $0.50 - maintenance only
  { start: 8,  end: 16, pct: 0.50, label: 'primary' },      // $1.25 - business execution
  { start: 16, end: 24, pct: 0.30, label: 'followup' },     // $0.75 - follow-up & reporting
];

// --- Default task cost lookup table ---
const DEFAULT_COST_TABLE = {
  'research_web':        { input: 800,  output: 300,  model: 'haiku' },
  'write_short_content': { input: 500,  output: 600,  model: 'haiku' },
  'write_long_content':  { input: 1000, output: 1500, model: 'haiku' },
  'business_decision':   { input: 1500, output: 500,  model: 'haiku' },
  'code_generation':     { input: 2000, output: 1000, model: 'haiku' },
  'complex_reasoning':   { input: 3000, output: 1500, model: 'sonnet' },
  'summarize':           { input: 1000, output: 200,  model: 'haiku' },
  'classify_reply':      { input: 300,  output: 100,  model: 'haiku' },
  'daily_planning':      { input: 2000, output: 800,  model: 'haiku' },
};

// --- Helpers ---

function todayUTC() {
  return new Date().toISOString().split('T')[0];
}

function currentUTCHour() {
  return new Date().getUTCHours();
}

function loadCostTable() {
  try {
    if (fs.existsSync(COST_TABLE_PATH)) {
      return JSON.parse(fs.readFileSync(COST_TABLE_PATH, 'utf-8'));
    }
  } catch { /* use default */ }
  return { ...DEFAULT_COST_TABLE };
}

function saveCostTable(table) {
  fs.writeFileSync(COST_TABLE_PATH, JSON.stringify(table, null, 2) + '\n');
}

function loadTracker() {
  try {
    if (fs.existsSync(TRACKER_PATH)) {
      const data = JSON.parse(fs.readFileSync(TRACKER_PATH, 'utf-8'));
      if (data.date === todayUTC()) return data;
    }
  } catch { /* fresh tracker */ }
  return { date: todayUTC(), daily_spend_usd: 0, daily_input_tokens: 0, daily_output_tokens: 0, call_log: [], status: 'active' };
}

function loadDailyPlan() {
  try {
    if (fs.existsSync(DAILY_PLAN_PATH)) {
      const plan = JSON.parse(fs.readFileSync(DAILY_PLAN_PATH, 'utf-8'));
      if (plan.date === todayUTC()) return plan;
    }
  } catch { /* no plan */ }
  return null;
}

function saveDailyPlan(plan) {
  fs.writeFileSync(DAILY_PLAN_PATH, JSON.stringify(plan, null, 2) + '\n');
}

// --- Core Functions ---

/**
 * Get the daily token envelope - how much budget APEX has to work with.
 */
export function getDailyEnvelope() {
  const tracker = loadTracker();
  const usd_remaining = Math.max(0, DAILY_USD_CAP - tracker.daily_spend_usd);

  // Count Sonnet calls today
  const sonnetCalls = tracker.call_log.filter(c => c.model === 'claude-sonnet-4-6').length;
  const sonnet_calls_remaining = Math.max(0, DAILY_ENVELOPE.max_sonnet_calls_per_day - sonnetCalls);

  // Estimate remaining weighted tokens based on remaining USD
  const haiku_tokens_remaining = Math.round(usd_remaining / DAILY_USD_CAP * DAILY_ENVELOPE.haiku_weighted_tokens);

  return {
    haiku_tokens_remaining,
    sonnet_calls_remaining,
    usd_remaining: Math.round(usd_remaining * 1000000) / 1000000,
    usd_cap: DAILY_USD_CAP,
    usd_spent: Math.round(tracker.daily_spend_usd * 1000000) / 1000000,
    hard_stop: HARD_STOP_USD,
  };
}

/**
 * Estimate the cost of a task before it runs.
 */
export function estimateTaskCost(taskType, complexity = 'normal') {
  const table = loadCostTable();
  const entry = table[taskType] || table['classify_reply']; // default to cheapest

  const multiplier = complexity === 'high' ? 1.5 : complexity === 'low' ? 0.7 : 1.0;
  const input = Math.round(entry.input * multiplier);
  const output = Math.round(entry.output * multiplier);

  const modelKey = entry.model === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';
  const pricing = PRICING[modelKey];
  const estimated_usd = (input / 1000) * pricing.input + (output / 1000) * pricing.output;

  return {
    estimated_input_tokens: input,
    estimated_output_tokens: output,
    estimated_usd: Math.round(estimated_usd * 1000000) / 1000000,
    recommended_model: modelKey,
    task_type: taskType,
  };
}

/**
 * Cost an entire daily plan. Trims low-priority tasks to fit under $2.00.
 * Tasks should be [{name, taskType, complexity, priority}] where priority is 1(highest)-10(lowest).
 */
export function costDailyPlan(tasks) {
  const costed = tasks.map(t => ({
    ...t,
    ...estimateTaskCost(t.taskType || 'classify_reply', t.complexity),
  }));

  // Sort by priority (lower number = higher priority)
  costed.sort((a, b) => (a.priority || 5) - (b.priority || 5));

  let totalUsd = 0;
  const planned = [];
  const deferred = [];

  for (const task of costed) {
    if (totalUsd + task.estimated_usd <= DAILY_PLAN_BUDGET) {
      totalUsd += task.estimated_usd;
      planned.push({ ...task, status: 'planned' });
    } else {
      deferred.push({ ...task, status: 'deferred', reason: 'exceeds_daily_budget' });
    }
  }

  const plan = {
    date: todayUTC(),
    budget_usd: DAILY_PLAN_BUDGET,
    estimated_total_usd: Math.round(totalUsd * 1000000) / 1000000,
    buffer_usd: Math.round((DAILY_USD_CAP - totalUsd) * 100) / 100,
    planned,
    deferred,
    created_at: new Date().toISOString(),
  };

  saveDailyPlan(plan);
  return plan;
}

/**
 * Get pacing allowance for the current time block.
 * Returns how much USD is allowed right now, minus what's been spent in this block.
 */
export function getPacingAllowance() {
  const hour = currentUTCHour();
  const block = PACING_BLOCKS.find(b => hour >= b.start && hour < b.end);
  if (!block) return { allowed_usd: 0, block_label: 'unknown', reason: 'no_block' };

  const blockBudget = DAILY_USD_CAP * block.pct;

  // Calculate spend in current block by filtering call_log entries
  const tracker = loadTracker();
  let blockSpend = 0;
  for (const call of tracker.call_log) {
    const callHour = new Date(call.timestamp).getUTCHours();
    if (callHour >= block.start && callHour < block.end) {
      blockSpend += call.cost_usd;
    }
  }

  const remaining = Math.max(0, blockBudget - blockSpend);

  return {
    allowed_usd: Math.round(remaining * 1000000) / 1000000,
    block_budget_usd: Math.round(blockBudget * 100) / 100,
    block_spent_usd: Math.round(blockSpend * 1000000) / 1000000,
    block_label: block.label,
    block_hours: `${block.start}:00-${block.end}:00 UTC`,
    exhausted: remaining <= 0,
  };
}

/**
 * Sonnet firewall - only allow Sonnet when genuinely necessary.
 * Returns true ONLY if:
 * - Task explicitly requires multi-step reasoning Haiku can't do
 * - Task is a one-time architectural decision
 * - Sonnet cost fits remaining budget
 */
export function requiresSonnet(taskType, context = {}) {
  const envelope = getDailyEnvelope();

  // No Sonnet calls remaining
  if (envelope.sonnet_calls_remaining <= 0) {
    return { allowed: false, reason: 'daily_sonnet_limit_reached' };
  }

  // Check if estimated Sonnet cost fits in remaining budget
  const estimate = estimateTaskCost(taskType, context.complexity);
  if (estimate.estimated_usd > envelope.usd_remaining) {
    return { allowed: false, reason: 'insufficient_budget_for_sonnet' };
  }

  // Only these task types can use Sonnet
  const sonnetEligible = new Set(['complex_reasoning']);
  if (!sonnetEligible.has(taskType)) {
    return { allowed: false, reason: 'task_type_not_sonnet_eligible', recommended: 'claude-haiku-4-5-20251001' };
  }

  // Must have explicit justification in context
  if (!context.justification) {
    return { allowed: false, reason: 'no_justification_provided', recommended: 'claude-haiku-4-5-20251001' };
  }

  return {
    allowed: true,
    reason: 'sonnet_justified',
    justification: context.justification,
    estimated_usd: estimate.estimated_usd,
    sonnet_calls_remaining_after: envelope.sonnet_calls_remaining - 1,
  };
}

/**
 * Update the cost lookup table when actual costs diverge >20% from estimates.
 */
export function updateCostEstimate(taskType, actualInput, actualOutput) {
  const table = loadCostTable();
  const entry = table[taskType];
  if (!entry) return;

  const estimatedTotal = entry.input + entry.output;
  const actualTotal = actualInput + actualOutput;
  const divergence = Math.abs(actualTotal - estimatedTotal) / estimatedTotal;

  if (divergence > 0.20) {
    // Blend: 70% new actual, 30% old estimate (smooth adjustment)
    table[taskType] = {
      ...entry,
      input: Math.round(actualInput * 0.7 + entry.input * 0.3),
      output: Math.round(actualOutput * 0.7 + entry.output * 0.3),
    };
    saveCostTable(table);
    return { adjusted: true, old: { input: entry.input, output: entry.output }, new: table[taskType] };
  }

  return { adjusted: false };
}

/**
 * Get a budget health dashboard snapshot for the /budget command.
 */
export function getBudgetDashboard() {
  const tracker = loadTracker();
  const envelope = getDailyEnvelope();
  const pacing = getPacingAllowance();
  const plan = loadDailyPlan();

  // Model breakdown
  const haikuCalls = tracker.call_log.filter(c => c.model === 'claude-haiku-4-5-20251001');
  const sonnetCalls = tracker.call_log.filter(c => c.model === 'claude-sonnet-4-6');
  const haikuSpend = haikuCalls.reduce((s, c) => s + c.cost_usd, 0);
  const sonnetSpend = sonnetCalls.reduce((s, c) => s + c.cost_usd, 0);
  const haikuInputTokens = haikuCalls.reduce((s, c) => s + c.input_tokens, 0);
  const haikuOutputTokens = haikuCalls.reduce((s, c) => s + c.output_tokens, 0);
  const sonnetInputTokens = sonnetCalls.reduce((s, c) => s + c.input_tokens, 0);
  const sonnetOutputTokens = sonnetCalls.reduce((s, c) => s + c.output_tokens, 0);

  // Tasks completed today (from plan)
  const tasksCompleted = plan?.planned?.filter(t => t.status === 'completed')?.length || 0;
  const tasksRemaining = plan?.planned?.filter(t => t.status !== 'completed') || [];
  const remainingEstCost = tasksRemaining.reduce((s, t) => s + (t.estimated_usd || 0), 0);

  // Project end-of-day spend
  const projectedSpend = tracker.daily_spend_usd + remainingEstCost;

  // Yesterday's accuracy (load yesterday's tracker if available)
  let yesterdayAccuracy = 'N/A';
  try {
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yDate = yesterday.toISOString().split('T')[0];
    const archivePath = path.resolve(process.cwd(), `data/spend-archive/${yDate}.json`);
    if (fs.existsSync(archivePath)) {
      const yData = JSON.parse(fs.readFileSync(archivePath, 'utf-8'));
      if (yData.estimated_total_usd && yData.actual_spend_usd) {
        const accuracy = (1 - Math.abs(yData.actual_spend_usd - yData.estimated_total_usd) / yData.estimated_total_usd) * 100;
        yesterdayAccuracy = `${Math.round(accuracy)}%`;
      }
    }
  } catch { /* no archive */ }

  return {
    date: todayUTC(),
    time_utc: new Date().toISOString(),
    budget: {
      usd_spent: Math.round(tracker.daily_spend_usd * 10000) / 10000,
      usd_cap: DAILY_USD_CAP,
      usd_remaining: envelope.usd_remaining,
      hard_stop: HARD_STOP_USD,
    },
    tokens: {
      haiku: { calls: haikuCalls.length, input: haikuInputTokens, output: haikuOutputTokens, spend_usd: Math.round(haikuSpend * 10000) / 10000 },
      sonnet: { calls: sonnetCalls.length, input: sonnetInputTokens, output: sonnetOutputTokens, spend_usd: Math.round(sonnetSpend * 10000) / 10000 },
    },
    pacing,
    tasks_completed: tasksCompleted,
    tasks_remaining: tasksRemaining.map(t => ({ name: t.name, estimated_usd: t.estimated_usd })),
    projected_eod_spend: Math.round(projectedSpend * 10000) / 10000,
    yesterday_accuracy: yesterdayAccuracy,
  };
}

/**
 * Format the budget dashboard as a Telegram message.
 */
export function formatBudgetMessage() {
  const d = getBudgetDashboard();

  const lines = [
    `\u{1f4ca} *APEX Budget Dashboard*`,
    `${d.date} \u2014 ${d.time_utc.split('T')[1].split('.')[0]} UTC`,
    ``,
    `*Spend:* $${d.budget.usd_spent} / $${d.budget.usd_cap} ($${d.budget.usd_remaining} remaining)`,
    `*Hard stop:* $${d.budget.hard_stop}`,
    ``,
    `*Haiku:* ${d.tokens.haiku.calls} calls, ${d.tokens.haiku.input.toLocaleString()} in / ${d.tokens.haiku.output.toLocaleString()} out \u2014 $${d.tokens.haiku.spend_usd}`,
    `*Sonnet:* ${d.tokens.sonnet.calls} calls, ${d.tokens.sonnet.input.toLocaleString()} in / ${d.tokens.sonnet.output.toLocaleString()} out \u2014 $${d.tokens.sonnet.spend_usd}`,
    ``,
    `*Pacing:* ${d.pacing.block_label} block (${d.pacing.block_hours})`,
    `  Block budget: $${d.pacing.block_budget_usd} \u2014 spent: $${d.pacing.block_spent_usd} \u2014 remaining: $${d.pacing.allowed_usd}`,
    ``,
    `*Tasks completed:* ${d.tasks_completed}`,
  ];

  if (d.tasks_remaining.length > 0) {
    lines.push(`*Tasks remaining:* ${d.tasks_remaining.length}`);
    for (const t of d.tasks_remaining.slice(0, 5)) {
      lines.push(`  \u2022 ${t.name} (~$${t.estimated_usd})`);
    }
    if (d.tasks_remaining.length > 5) lines.push(`  ... and ${d.tasks_remaining.length - 5} more`);
  }

  lines.push(``);
  lines.push(`*Projected EOD:* $${d.projected_eod_spend}`);
  lines.push(`*Yesterday accuracy:* ${d.yesterday_accuracy}`);

  return lines.join('\n');
}

export {
  DAILY_USD_CAP,
  DAILY_PLAN_BUDGET,
  HARD_STOP_USD,
  PRICING,
  PACING_BLOCKS,
  loadDailyPlan,
  saveDailyPlan,
  loadTracker as loadTrackerFromBrain,
  loadCostTable,
  saveCostTable,
  DEFAULT_COST_TABLE,
};
