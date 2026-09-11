// Stripe webhook の受け口。prefix /api/webhooks/stripe
//
// 署名を raw body で検証 → 処理済みなら 200 → 処理 → **成功してから**処理済みの印を書く。
// 失敗は 500 を返して Stripe に再送させる（Stripe は数日間、間隔を空けて再送する）。
//
// このプラグインは encapsulated なので、ここで登録する content type parser は
// 本ルート配下だけに効き、他ルートの JSON パースには影響しない。

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '../utils/prisma';
import { billingConfigFromEnv, verifyStripeSignature } from '../services/billing/billing-core';
import { StripeClient } from '../services/billing/stripe-client';
import { handleStripeEvent, type StripeEvent } from '../services/billing/webhook-handler';

interface RawBodyRequest extends FastifyRequest {
  rawBody?: Buffer;
}

export async function stripeWebhookRoutes(app: FastifyInstance): Promise<void> {
  // 署名は「受信したバイト列そのもの」に対して計算されているので、パース前の本文を保持する
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as RawBodyRequest).rawBody = body as Buffer;
    done(null, {});
  });

  app.post('/', async (request, reply) => {
    const config = billingConfigFromEnv();
    if (!config?.webhookSecret) {
      request.log.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET が未設定のため受け付けません');
      return reply.code(503).send({ success: false, error: { code: 'BILLING_NOT_CONFIGURED', message: 'webhook is not configured' } });
    }

    const raw = (request as RawBodyRequest).rawBody;
    const header = request.headers['stripe-signature'];
    if (!raw || !verifyStripeSignature(raw, typeof header === 'string' ? header : undefined, config.webhookSecret)) {
      return reply.code(400).send({ success: false, error: { code: 'INVALID_SIGNATURE', message: '署名が不正です' } });
    }

    let event: StripeEvent;
    try {
      event = JSON.parse(raw.toString('utf8')) as StripeEvent;
    } catch {
      return reply.code(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: 'webhook body が不正です' } });
    }
    if (!event?.id || !event.type || !event.data?.object) {
      return reply.code(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: 'webhook body が不正です' } });
    }

    const seen = await prisma.billingEvent.findUnique({ where: { id: event.id }, select: { id: true } });
    if (seen) return reply.send({ received: true, duplicate: true });

    let orgId: string | null;
    try {
      orgId = await handleStripeEvent(event, config, new StripeClient(config.secretKey));
    } catch (e) {
      request.log.error(
        { eventId: event.id, type: event.type, err: e instanceof Error ? e.message : String(e) },
        '[stripe-webhook] 処理に失敗（Stripe が再送する）',
      );
      return reply.code(500).send({ success: false, error: { code: 'WEBHOOK_FAILED', message: 'processing failed' } });
    }

    // 同じイベントが同時に届いたら片方が一意制約で落ちるだけ。処理は「取り直して写す」なので二重でも結果は同じ
    await prisma.billingEvent
      .create({ data: { id: event.id, type: event.type, orgId } })
      .catch((e: { code?: string }) => {
        if (e?.code !== 'P2002') throw e;
      });
    return reply.send({ received: true });
  });
}
