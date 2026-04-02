/**
 * APEX Cost Enforcement — Reverse Proxy
 *
 * HTTP proxy that intercepts all Anthropic API calls from containers.
 * Chain: Container SDK → Cost Proxy (10255) → OneCLI (10254) → Anthropic API
 *
 * Enforces:
 * - $3.00/day hard budget cap
 * - Model allowlist (Haiku default, Sonnet for complex tasks only)
 * - Max token caps (1024 Haiku, 2048 Sonnet, never above 2048)
 * - Spend tracking and Telegram alerts
 */
import http from 'http';
import { createRequire } from 'module';

import { logger } from './logger.js';
import { checkBudget, recordCall, sendTelegramAlert } from './spend-tracker.js';

// Budget Brain: pacing enforcement
const require = createRequire(import.meta.url);
const budgetBrainPath = require.resolve('../budget-brain.js');
const { getPacingAllowance, requiresSonnet } = await import(budgetBrainPath);

// Prompt Compressor: automatic prompt size reduction
const compressorPath = require.resolve('../prompt-compressor.js');
const { compressMessages } = await import(compressorPath);

// KB Gate: check knowledge base before API calls
const kbGatePath = require.resolve('../kb-gate.js');
const { kbCheck } = await import(kbGatePath);

// Dedup Cache: avoid repeating similar API calls
const dedupCachePath = require.resolve('../dedup-cache.js');
const { cacheCheck, cacheStore } = await import(dedupCachePath);

// Research Compressor: compress research results in responses
const researchCompressorPath = require.resolve('../research-compressor.js');
const { compressResearch } = await import(researchCompressorPath);

export const COST_PROXY_PORT = 10255;

const ALLOWED_MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'];
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const TOKEN_CAPS: Record<string, number> = {
  'claude-haiku-4-5-20251001': 1024,
  'claude-sonnet-4-6': 2048,
};
const ABSOLUTE_MAX_TOKENS = 2048;
const DEFAULT_MAX_TOKENS = 512;

// OneCLI gateway URL — requests are forwarded here after enforcement
const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = 10254;

let alertCooldown = 0; // Prevent Telegram alert spam

function enforceRequestBody(
  body: Buffer,
): { enforced: string; model: string; maxTokens: number } | null {
  try {
    const parsed = JSON.parse(body.toString());

    // Enforce model allowlist
    if (!parsed.model || !ALLOWED_MODELS.includes(parsed.model)) {
      logger.info(
        { requested: parsed.model, enforced: DEFAULT_MODEL },
        'APEX: Model not in allowlist, defaulting to Haiku',
      );
      parsed.model = DEFAULT_MODEL;
    }

    // Enforce max_tokens caps
    const modelCap = TOKEN_CAPS[parsed.model] || ABSOLUTE_MAX_TOKENS;
    if (!parsed.max_tokens) {
      parsed.max_tokens = DEFAULT_MAX_TOKENS;
    }
    parsed.max_tokens = Math.min(
      parsed.max_tokens,
      modelCap,
      ABSOLUTE_MAX_TOKENS,
    );

    const enforced = JSON.stringify(parsed);
    return { enforced, model: parsed.model, maxTokens: parsed.max_tokens };
  } catch {
    // If body can't be parsed, pass through (non-messages endpoint)
    return null;
  }
}

export function startCostProxy(): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const isMessagesEndpoint = req.url?.includes('/v1/messages');

      // Collect request body
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', async () => {
        const requestBody = Buffer.concat(chunks);

        // Budget check — only gate messages API calls (not models list, etc.)
        if (isMessagesEndpoint && req.method === 'POST') {
          const budget = checkBudget();

          if (!budget.allowed) {
            const msg = `APEX HARD STOP: Daily limit reached ($${budget.daily_spend.toFixed(2)}/$3.00). No further API calls today.`;
            logger.error(msg);

            const now = Date.now();
            if (now - alertCooldown > 60000) {
              alertCooldown = now;
              sendTelegramAlert(msg).catch(() => {});
            }

            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                type: 'error',
                error: {
                  type: 'rate_limit_error',
                  message: `APEX_BUDGET_EXCEEDED: ${msg}`,
                },
              }),
            );
            return;
          }

          if (budget.warning) {
            const now = Date.now();
            if (now - alertCooldown > 300000) {
              alertCooldown = now;
              sendTelegramAlert(
                `⚠️ APEX WARNING: $${budget.daily_spend.toFixed(2)} spent today. Approaching $3.00 limit.`,
              ).catch(() => {});
            }
          }

          // APEX Pacing: check if current time block has allowance
          const pacing = getPacingAllowance();
          if (pacing.exhausted) {
            const msg = `APEX PACING: ${pacing.block_label} block (${pacing.block_hours}) exhausted. Task queued for next block.`;
            logger.warn(msg);
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                type: 'error',
                error: {
                  type: 'rate_limit_error',
                  message: `APEX_PACING_EXHAUSTED: ${msg}`,
                },
              }),
            );
            return;
          }
        }

        // APEX KB Gate & Dedup Cache: pre-flight checks before API calls
        if (isMessagesEndpoint && req.method === 'POST') {
          try {
            const parsed = JSON.parse(requestBody.toString());
            // Extract user prompt from the last user message
            const lastUserMsg = [...(parsed.messages || [])].reverse().find(
              (m: any) => m.role === 'user',
            );
            const promptText =
              typeof lastUserMsg?.content === 'string'
                ? lastUserMsg.content
                : Array.isArray(lastUserMsg?.content)
                  ? lastUserMsg.content
                      .filter((b: any) => b.type === 'text')
                      .map((b: any) => b.text)
                      .join(' ')
                  : '';

            if (promptText) {
              // 1. KB Gate: check local knowledge base first
              const kbResult = await kbCheck(promptText);
              if (kbResult.found) {
                logger.info(
                  { source: kbResult.source },
                  'APEX KB HIT: Answered from knowledge base, 0 tokens spent',
                );
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    id: `kb-hit-${Date.now()}`,
                    type: 'message',
                    role: 'assistant',
                    content: [
                      {
                        type: 'text',
                        text: `[KB: ${kbResult.source}]\n\n${kbResult.content}`,
                      },
                    ],
                    model: DEFAULT_MODEL,
                    stop_reason: 'end_turn',
                    usage: { input_tokens: 0, output_tokens: 0 },
                  }),
                );
                return;
              }

              // 2. Dedup Cache: check for recent similar calls
              const cacheResult = cacheCheck(promptText, parsed.model);
              if (cacheResult.hit) {
                logger.info(
                  {
                    fingerprint: cacheResult.fingerprint,
                    age: cacheResult.age_minutes,
                  },
                  'APEX CACHE HIT: 0 tokens spent',
                );
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    id: `cache-hit-${Date.now()}`,
                    type: 'message',
                    role: 'assistant',
                    content: [
                      { type: 'text', text: cacheResult.result },
                    ],
                    model: parsed.model || DEFAULT_MODEL,
                    stop_reason: 'end_turn',
                    usage: { input_tokens: 0, output_tokens: 0 },
                  }),
                );
                return;
              }
            }
          } catch {
            // Non-parseable body or KB/cache error — proceed to API
          }
        }

        // Enforce model and token caps on messages requests
        let forwardBody = requestBody.toString();
        let trackedModel = DEFAULT_MODEL;
        if (isMessagesEndpoint && req.method === 'POST') {
          const enforced = enforceRequestBody(requestBody);
          if (enforced) {
            forwardBody = enforced.enforced;
            trackedModel = enforced.model;

            // APEX Sonnet Firewall: block Sonnet unless justified
            if (trackedModel === 'claude-sonnet-4-6') {
              const sonnetCheck = requiresSonnet('complex_reasoning', {});
              if (!sonnetCheck.allowed) {
                logger.info(
                  { reason: sonnetCheck.reason },
                  'APEX: Sonnet blocked by firewall, downgrading to Haiku',
                );
                const parsed = JSON.parse(forwardBody);
                parsed.model = DEFAULT_MODEL;
                const modelCap =
                  TOKEN_CAPS[DEFAULT_MODEL] || ABSOLUTE_MAX_TOKENS;
                parsed.max_tokens = Math.min(
                  parsed.max_tokens,
                  modelCap,
                  ABSOLUTE_MAX_TOKENS,
                );
                forwardBody = JSON.stringify(parsed);
                trackedModel = DEFAULT_MODEL;
              }
            }

            // APEX Prompt Compressor: reduce prompt size before sending
            try {
              const parsed = JSON.parse(forwardBody);
              if (parsed.messages && Array.isArray(parsed.messages)) {
                const { messages: compressed, stats } = compressMessages(
                  parsed.messages,
                );
                if (stats.totalReduction > 0) {
                  parsed.messages = compressed;
                  forwardBody = JSON.stringify(parsed);
                  logger.debug(
                    {
                      reduction: `${stats.totalReduction}%`,
                      original: stats.totalOriginal,
                      compressed: stats.totalCompressed,
                    },
                    'APEX: Prompt compressed',
                  );
                }
              }
            } catch {
              // Non-parseable body, skip compression
            }
          }
        }

        // Forward to upstream (OneCLI gateway)
        const proxyReq = http.request(
          {
            hostname: UPSTREAM_HOST,
            port: UPSTREAM_PORT,
            path: req.url,
            method: req.method,
            headers: {
              ...req.headers,
              host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}`,
              'content-length': String(forwardBody.length),
            },
          },
          (proxyRes) => {
            // Collect upstream response
            const resChunks: Buffer[] = [];
            proxyRes.on('data', (chunk: Buffer) => resChunks.push(chunk));
            proxyRes.on('end', () => {
              const responseBody = Buffer.concat(resChunks);

              // Track usage from response (messages endpoint only)
              if (isMessagesEndpoint && req.method === 'POST') {
                try {
                  const parsed = JSON.parse(responseBody.toString());
                  if (parsed.usage) {
                    recordCall(
                      parsed.model || trackedModel,
                      parsed.usage.input_tokens || 0,
                      parsed.usage.output_tokens || 0,
                      'container-agent',
                    );
                    logger.debug(
                      {
                        model: parsed.model,
                        input: parsed.usage.input_tokens,
                        output: parsed.usage.output_tokens,
                      },
                      'APEX: Recorded API call',
                    );

                    // Store result in dedup cache for future calls
                    const responseText =
                      Array.isArray(parsed.content)
                        ? parsed.content
                            .filter((b: any) => b.type === 'text')
                            .map((b: any) => b.text)
                            .join('\n')
                        : '';
                    if (responseText) {
                      try {
                        const reqParsed = JSON.parse(requestBody.toString());
                        const lastMsg = [...(reqParsed.messages || [])]
                          .reverse()
                          .find((m: any) => m.role === 'user');
                        const promptForCache =
                          typeof lastMsg?.content === 'string'
                            ? lastMsg.content
                            : '';
                        if (promptForCache) {
                          cacheStore(
                            promptForCache,
                            responseText,
                            parsed.model || trackedModel,
                          );
                        }
                      } catch {
                        // Skip cache store on error
                      }

                      // Run research compressor on response if it looks like research
                      const lowerResp = responseText.toLowerCase();
                      if (
                        lowerResp.includes('http') ||
                        lowerResp.includes('source:') ||
                        lowerResp.includes('according to') ||
                        lowerResp.includes('research')
                      ) {
                        compressResearch(responseText, '', '').catch(() => {});
                      }
                    }
                  }
                } catch {
                  // Non-JSON response, skip tracking
                }
              }

              // Forward response headers and body
              const headers = { ...proxyRes.headers };
              // Fix content-length since we're buffering
              headers['content-length'] = String(responseBody.length);
              delete headers['transfer-encoding'];

              res.writeHead(proxyRes.statusCode || 200, headers);
              res.end(responseBody);
            });
          },
        );

        proxyReq.on('error', (err) => {
          logger.error({ err, url: req.url }, 'APEX: Upstream proxy error');
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              type: 'error',
              error: {
                type: 'api_error',
                message: `APEX proxy upstream error: ${err.message}`,
              },
            }),
          );
        });

        proxyReq.write(forwardBody);
        proxyReq.end();
      });
    });

    server.on('error', (err) => {
      logger.error({ err }, 'APEX: Cost proxy server error');
      reject(err);
    });

    server.listen(COST_PROXY_PORT, '127.0.0.1', () => {
      logger.info(
        { port: COST_PROXY_PORT },
        'APEX: Cost enforcement proxy started',
      );
      resolve(server);
    });
  });
}
