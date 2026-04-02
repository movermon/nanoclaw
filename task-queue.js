/**
 * APEX Task Queue - Budget-aware task queue with ROI sorting.
 *
 * Rules:
 * - No task enters execution without an estimated cost attached
 * - Queue sorted by (value / estimated_cost) - highest ROI first
 * - Before dequeuing, check budget-brain pacing allowance
 * - After completion, compare actual vs estimated - adjust if >20% off
 * - If actual > estimated by >50%, send Telegram alert
 */

import https from 'https';

import {
  estimateTaskCost,
  getPacingAllowance,
  getDailyEnvelope,
  updateCostEstimate,
} from './budget-brain.js';

const TELEGRAM_CHAT_ID = '8111645127';

/**
 * A budget-aware task that wraps any task with cost metadata.
 */
class BudgetTask {
  constructor(id, name, taskType, complexity, priority, executeFn) {
    this.id = id;
    this.name = name;
    this.taskType = taskType;
    this.complexity = complexity || 'normal';
    this.priority = priority || 5;
    this.executeFn = executeFn;

    // Attach cost estimate
    const estimate = estimateTaskCost(taskType, complexity);
    this.estimated_input_tokens = estimate.estimated_input_tokens;
    this.estimated_output_tokens = estimate.estimated_output_tokens;
    this.estimated_usd = estimate.estimated_usd;
    this.recommended_model = estimate.recommended_model;

    // ROI score: higher priority (lower number) = higher value, divided by cost
    this.roi_score = (11 - this.priority) / Math.max(this.estimated_usd, 0.000001);

    this.status = 'queued'; // queued | executing | completed | deferred
    this.actual_usd = null;
    this.queued_at = new Date().toISOString();
  }
}

/**
 * The budget-aware task queue.
 */
class BudgetTaskQueue {
  constructor() {
    this.queue = [];
    this.completed = [];
    this.processing = false;
  }

  /**
   * Enqueue a task. Rejects if no cost estimate can be attached.
   */
  enqueue(id, name, taskType, complexity, priority, executeFn) {
    const task = new BudgetTask(id, name, taskType, complexity, priority, executeFn);

    // Check if this task fits in the daily budget at all
    const envelope = getDailyEnvelope();
    if (task.estimated_usd > envelope.usd_remaining) {
      task.status = 'deferred';
      task.defer_reason = 'exceeds_remaining_daily_budget';
      this.completed.push(task);
      return { enqueued: false, reason: task.defer_reason, task };
    }

    this.queue.push(task);
    // Re-sort by ROI score (highest first)
    this.queue.sort((a, b) => b.roi_score - a.roi_score);

    return { enqueued: true, position: this.queue.indexOf(task) + 1, task };
  }

  /**
   * Attempt to dequeue and execute the next task.
   * Respects pacing allowance - if exhausted, returns null (task waits).
   */
  async dequeue() {
    if (this.queue.length === 0) return null;

    const pacing = getPacingAllowance();

    // If current time block is exhausted, tasks wait
    if (pacing.exhausted) {
      return {
        executed: false,
        reason: 'pacing_block_exhausted',
        block: pacing.block_label,
        next_block: pacing.block_hours,
      };
    }

    const task = this.queue[0];

    // Check if this task fits in the current pacing block
    if (task.estimated_usd > pacing.allowed_usd) {
      return {
        executed: false,
        reason: 'insufficient_pacing_allowance',
        task_cost: task.estimated_usd,
        block_remaining: pacing.allowed_usd,
      };
    }

    // Dequeue and execute
    this.queue.shift();
    task.status = 'executing';
    task.started_at = new Date().toISOString();

    try {
      const result = await task.executeFn();
      task.status = 'completed';
      task.completed_at = new Date().toISOString();
      task.result = result;

      // Record actual cost if available (from spend tracker delta)
      await this._reconcileTaskCost(task);

      this.completed.push(task);
      return { executed: true, task };
    } catch (err) {
      task.status = 'completed';
      task.completed_at = new Date().toISOString();
      task.error = err.message || String(err);
      this.completed.push(task);
      return { executed: true, task, error: task.error };
    }
  }

  /**
   * Compare actual vs estimated cost after task completion.
   * Alert if >50% overrun. Adjust cost table if >20% off.
   */
  async _reconcileTaskCost(task) {
    // In practice, actual cost is tracked by spend-tracker.ts at the API call level.
    // We estimate actual cost from the time window of task execution by checking tracker delta.
    // This is a best-effort heuristic since multiple calls may happen during a task.
    try {
      const fs = await import('fs');
      const path = await import('path');
      const trackerPath = path.default.resolve(process.cwd(), 'spend-tracker.json');
      if (!fs.default.existsSync(trackerPath)) return;

      const tracker = JSON.parse(fs.default.readFileSync(trackerPath, 'utf-8'));
      const taskCalls = tracker.call_log.filter(c =>
        c.timestamp >= task.started_at && c.timestamp <= task.completed_at
      );

      if (taskCalls.length === 0) return;

      const actualInput = taskCalls.reduce((s, c) => s + c.input_tokens, 0);
      const actualOutput = taskCalls.reduce((s, c) => s + c.output_tokens, 0);
      const actualUsd = taskCalls.reduce((s, c) => s + c.cost_usd, 0);
      task.actual_usd = actualUsd;

      // Update cost table if >20% divergent
      updateCostEstimate(task.taskType, actualInput, actualOutput);

      // Alert if >50% overrun
      if (actualUsd > task.estimated_usd * 1.5 && task.estimated_usd > 0) {
        const overrun = Math.round((actualUsd / task.estimated_usd - 1) * 100);
        await this._sendTelegramAlert(
          `\u26a0\ufe0f *APEX Cost Overrun*\nTask: ${task.name}\nEstimated: $${task.estimated_usd}\nActual: $${actualUsd.toFixed(6)}\nOverrun: ${overrun}%`
        );
      }
    } catch { /* best effort */ }
  }

  async _sendTelegramAlert(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return;

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
   * Get queue status for dashboard.
   */
  getStatus() {
    return {
      queued: this.queue.length,
      completed_today: this.completed.length,
      tasks_queued: this.queue.map(t => ({
        name: t.name,
        estimated_usd: t.estimated_usd,
        roi_score: Math.round(t.roi_score),
        model: t.recommended_model,
      })),
      tasks_completed: this.completed
        .filter(t => t.status === 'completed')
        .map(t => ({
          name: t.name,
          estimated_usd: t.estimated_usd,
          actual_usd: t.actual_usd,
        })),
    };
  }

  /**
   * Get total estimated cost of remaining queued tasks.
   */
  getRemainingEstimatedCost() {
    return this.queue.reduce((s, t) => s + t.estimated_usd, 0);
  }

  /**
   * Clear the queue (used at daily reset).
   */
  reset() {
    this.queue = [];
    this.completed = [];
  }
}

// Singleton instance
const budgetQueue = new BudgetTaskQueue();

export { BudgetTaskQueue, BudgetTask, budgetQueue };
export default budgetQueue;
