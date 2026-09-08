// LINE webhook 受け口（全テナント共通 1 本、prefix /api/webhooks/line）。
// destination（bot userId）から ChannelConnection を逆引きし、raw body で署名検証してから
// 即 200 → void 非同期で取り込み（processLineEvents）。LINE は応答が遅い/エラーだと再送を
// 繰り返すため、「未登録・DISABLED は 200 で握る」「不正署名のみ 401」を厳守する。
//
// このプラグインは encapsulated なので、ここで登録する content type parser は
// 本ルート配下だけに効き、他ルートの JSON パースには影響しない。

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '../../utils/prisma';
import { openSecret } from '../../services/secret-box';
import { verifyLineSignature } from '../../services/inbox/line-client';
import { processLineEvents } from '../../services/inbox/line-inbox';
import type { LineWebhookBody } from '../../services/inbox/line-types';

interface RawBodyRequest extends FastifyRequest {
  rawBody?: Buffer;
}

export async function lineWebhookRoutes(app: FastifyInstance): Promise<void> {
  // 署名検証は「受信したバイト列そのもの」に対して行う必要があるため raw body を保持する。
  // JSON が壊れている場合は body を {} にして後段で 400 を返す（parser では throw しない）。
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as RawBodyRequest).rawBody = body as Buffer;
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch {
      done(null, {});
    }
  });

  app.post('/', async (request, reply) => {
    const rawBody = (request as RawBodyRequest).rawBody;
    const body = (request.body ?? {}) as Partial<LineWebhookBody>;
    const destination = typeof body.destination === 'string' ? body.destination : '';
    if (!rawBody || !destination) {
      return reply.code(400).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'webhook body が不正です' },
      });
    }

    const connection = await prisma.channelConnection.findUnique({
      where: { provider_channelId: { provider: 'line', channelId: destination } },
    });
    if (!connection || connection.status !== 'ACTIVE') {
      // 未登録 / 無効化済みは 200 で握る（4xx/5xx を返すと LINE が再送ループする）。
      request.log.warn(
        { destination },
        '[line-webhook] 未登録または DISABLED の destination からの webhook を無視',
      );
      return reply.send({ success: true });
    }

    let channelSecret: string;
    try {
      channelSecret = openSecret(connection.channelSecretEnc);
    } catch (e) {
      // 復号失敗 = サーバ側の鍵設定問題。署名検証不能だが 401 で LINE に再送させても直らないため
      // 200 で握ってログだけ残す（secret / token はログに出さない）。
      request.log.error(
        { connectionId: connection.id, err: e instanceof Error ? e.message : String(e) },
        '[line-webhook] channelSecret の復号に失敗（CHANNEL_CREDENTIAL_ENC_KEY を確認）',
      );
      return reply.send({ success: true });
    }

    const signature = request.headers['x-line-signature'];
    if (!verifyLineSignature(rawBody, channelSecret, typeof signature === 'string' ? signature : undefined)) {
      return reply.code(401).send({
        success: false,
        error: { code: 'INVALID_SIGNATURE', message: '署名が不正です' },
      });
    }

    // 即 200 → 取り込みは完全非同期（LINE の応答タイムアウト・再送を防ぐ）
    reply.send({ success: true });
    const events = Array.isArray(body.events) ? body.events : [];
    void processLineEvents(connection, events).catch((e) => {
      request.log.error(
        { connectionId: connection.id, err: e instanceof Error ? e.message : String(e) },
        '[line-webhook] processLineEvents に失敗',
      );
    });
  });
}
