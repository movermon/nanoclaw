/**
 * APEX Cost Enforcement — Spend Tracker
 *
 * Tracks daily API spend, enforces a $3.00/day hard cap.
 * All costs are stored in spend-tracker.json at the project root.
 */
import fs from 'fs';
import path from 'path';
import https from 'https';

import { logger } from './logger.js';

const TRACKER_PATH = path.resolve(process.cwd(), 'spend-tracker.json');
const DAILY_HARD_CAP_USD = 3.0;
const DAILY_WARNING_USD = 2.0;
const RESTRICTED_MODE_USD = 2.5;

// Pricing per 1K tokens (USD)
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 0.00025, output: 0.00125 },
  'claude-sonnet-4-6': { input: 0.003, output: 0.015 },
};

// Default to Haiku pricing for unknown models (safe conservative estimate)
const DEFAULT_PRICING = { input: 0.003, output: 0.015 };

export interface CallLogEntry {
  timestamp: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  caller: string;
}

export interface TrackerData {
  date: string;
  daily_spend_usd: number;
  daily_input_tokens: number;
  daily_output_tokens: number;
  call_log: CallLogEntry[];
  status: 'active' | 'restricted';
}

function todayUTC(): string {
  return new Date().toISOString().split('T')[0];
}

export function loadTracker(): TrackerData {
  const today = todayUTC();

  try {
    if (fs.existsSync(TRACKER_PATH)) {
      const raw = fs.readFileSync(TRACKER_PATH, 'utf-8');
      const data: TrackerData = JSON.parse(raw);

      // Reset if date has changed (midnight UTC rollover)
      if (data.date !== today) {
        logger.info(
          { oldDate: data.date, newDate: today },
          'APEX: Daily spend tracker reset (new day)',
        );
        const fresh: TrackerData = {
          date: today,
          daily_spend_usd: 0,
          daily_input_tokens: 0,
          daily_output_tokens: 0,
          call_log: [],
          status: 'active',
        };
        saveTracker(fresh);
        return fresh;
      }

      return data;
    }
  } catch (err) {
    logger.error({ err }, 'APEX: Failed to load spend tracker, resetting');
  }

  const fresh: TrackerData = {
    date: today,
    daily_spend_usd: 0,
    daily_input_tokens: 0,
    daily_output_tokens: 0,
    call_log: [],
    status: 'active',
  };
  saveTracker(fresh);
  return fresh;
}

function saveTracker(data: TrackerData): void {
  try {
    fs.writeFileSync(TRACKER_PATH, JSON.stringify(data, null, 2) + '\n');
  } catch (err) {
    logger.error({ err }, 'APEX: Failed to save spend tracker');
  }
}

export function recordCall(
  model: string,
  inputTokens: number,
  outputTokens: number,
  caller: string = 'unknown',
): TrackerData {
  const tracker = loadTracker();
  const pricing = PRICING[model] || DEFAULT_PRICING;

  const cost =
    (inputTokens / 1000) * pricing.input +
    (outputTokens / 1000) * pricing.output;

  tracker.daily_spend_usd += cost;
  tracker.daily_input_tokens += inputTokens;
  tracker.daily_output_tokens += outputTokens;

  tracker.call_log.push({
    timestamp: new Date().toISOString(),
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: Math.round(cost * 1000000) / 1000000,
    caller,
  });

  // Set restricted mode if approaching limit
  if (tracker.daily_spend_usd >= RESTRICTED_MODE_USD) {
    tracker.status = 'restricted';
  }

  saveTracker(tracker);
  return tracker;
}

export interface BudgetCheck {
  allowed: boolean;
  warning: boolean;
  reason: string;
  daily_spend: number;
  status: string;
}

export function checkBudget(): BudgetCheck {
  const tracker = loadTracker();

  if (tracker.daily_spend_usd >= DAILY_HARD_CAP_USD) {
    return {
      allowed: false,
      warning: true,
      reason: `Daily spend limit reached: $${tracker.daily_spend_usd.toFixed(2)}/$${DAILY_HARD_CAP_USD.toFixed(2)}`,
      daily_spend: tracker.daily_spend_usd,
      status: tracker.status,
    };
  }

  if (tracker.daily_spend_usd >= DAILY_WARNING_USD) {
    return {
      allowed: true,
      warning: true,
      reason: `Approaching daily limit: $${tracker.daily_spend_usd.toFixed(2)}/$${DAILY_HARD_CAP_USD.toFixed(2)}`,
      daily_spend: tracker.daily_spend_usd,
      status: tracker.status,
    };
  }

  return {
    allowed: true,
    warning: false,
    reason: 'OK',
    daily_spend: tracker.daily_spend_usd,
    status: tracker.status,
  };
}

export function isRestrictedMode(): boolean {
  const tracker = loadTracker();
  return tracker.status === 'restricted' || tracker.daily_spend_usd >= RESTRICTED_MODE_USD;
}

export function getSpendSummary(): string {
  const tracker = loadTracker();
  const calls = tracker.call_log.length;
  const callerBreakdown = tracker.call_log.reduce(
    (acc, c) => {
      acc[c.caller] = (acc[c.caller] || 0) + c.cost_usd;
      return acc;
    },
    {} as Record<string, number>,
  );

  const breakdown = Object.entries(callerBreakdown)
    .map(([caller, cost]) => `  ${caller}: $${cost.toFixed(4)}`)
    .join('\n');

  return [
    `📊 APEX Daily Spend Report — ${tracker.date}`,
    `Total: $${tracker.daily_spend_usd.toFixed(4)} / $${DAILY_HARD_CAP_USD.toFixed(2)}`,
    `Input tokens: ${tracker.daily_input_tokens.toLocaleString()}`,
    `Output tokens: ${tracker.daily_output_tokens.toLocaleString()}`,
    `API calls: ${calls}`,
    breakdown ? `\nBreakdown by caller:\n${breakdown}` : '',
    `\nStatus: ${tracker.status}`,
  ].join('\n');
}

// Telegram alert integration
const TELEGRAM_CHAT_ID = '8111645127';

export async function sendTelegramAlert(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.warn('APEX: Cannot send Telegram alert — TELEGRAM_BOT_TOKEN not set');
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: 'Markdown',
  });

  return new Promise<void>((resolve) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            logger.warn(
              { statusCode: res.statusCode, body: data },
              'APEX: Telegram alert failed',
            );
          }
          resolve();
        });
      },
    );
    req.on('error', (err) => {
      logger.error({ err }, 'APEX: Telegram alert error');
      resolve();
    });
    req.write(body);
    req.end();
  });
}
