import { api } from '../../services/api';
import { humanizeTaskManagerError } from '../../utils/humanizeLlmError';

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface LlmChatResponse {
  success: boolean;
  data?: { content: string; model?: string };
  error?: { code: string; message: string };
}

/**
 * すべての LLM 呼び出しは API Gateway (/api/llm/chat) → ai-engine 経由で行う。
 * ブラウザから直接 LLM プロバイダを叩くことは禁止（API キー漏洩防止 + PII screening 一貫性）。
 */
async function completeLlm(messages: Message[], jsonMode: boolean): Promise<string> {
  try {
    const { data } = await api.post<LlmChatResponse>('/llm/chat', { messages, jsonMode });
    if (data.success && data.data && typeof data.data.content === 'string') {
      return data.data.content;
    }
    throw new Error(data.error?.message ?? 'LLM gateway returned empty response');
  } catch (e) {
    // eslint-disable-next-line preserve-caught-error -- 利用者向けの文言に変換して投げ直す（lib が ES2020 で ErrorOptions 未対応）
    throw new Error(humanizeTaskManagerError(e));
  }
}

/**
 * コードフェンスを除去しつつ、文字列の先頭から最初の JSON オブジェクト/配列を抽出する。
 * モデルが説明文や前置きを付けた場合でも正しく JSON 部分だけを取り出せる。
 */
function extractJson(raw: string): string {
  let s = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  const objIdx = s.indexOf('{');
  const arrIdx = s.indexOf('[');
  if (objIdx === -1 && arrIdx === -1) return s;

  const startIdx =
    objIdx === -1 ? arrIdx : arrIdx === -1 ? objIdx : Math.min(objIdx, arrIdx);
  s = s.slice(startIdx);

  const openChar = s[0] as '{' | '[';
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let escaped = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\' && inStr) { escaped = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === openChar) depth++;
    else if (c === closeChar && --depth === 0) return s.slice(0, i + 1);
  }

  return s;
}

/**
 * JSON 文字列値の中に含まれるリテラル制御文字（改行・タブ等）をエスケープする。
 * モデルが \n ではなく実際の改行を出力した場合の修復用。
 */
function repairJson(s: string): string {
  let out = '';
  let inStr = false;
  let escaped = false;
  for (const c of s) {
    if (escaped) { out += c; escaped = false; continue; }
    if (c === '\\' && inStr) { out += c; escaped = true; continue; }
    if (c === '"') { inStr = !inStr; out += c; continue; }
    if (inStr) {
      if (c === '\n') { out += '\\n'; continue; }
      if (c === '\r') { out += '\\r'; continue; }
      if (c === '\t') { out += '\\t'; continue; }
    }
    out += c;
  }
  return out;
}

export async function callClaude(
  systemPrompt: string,
  userMessage: string,
  messages: Message[] = []
): Promise<string> {
  const built: Message[] = [
    { role: 'system', content: systemPrompt },
    ...messages,
    { role: 'user', content: userMessage },
  ];
  return await completeLlm(built, false);
}

export async function callClaudeJSON<T>(
  systemPrompt: string,
  userMessage: string,
  messages: Message[] = []
): Promise<T> {
  const built: Message[] = [
    { role: 'system', content: systemPrompt },
    ...messages,
    { role: 'user', content: userMessage },
  ];
  const raw = await completeLlm(built, true);

  // Stage 1: そのままパース（json_object モードなら通常これで成功）
  try {
    return JSON.parse(raw) as T;
  } catch {
    // intentionally empty
  }

  // Stage 2: JSON 抽出 + 修復してパース
  try {
    return JSON.parse(repairJson(extractJson(raw))) as T;
  } catch {
    // intentionally empty
  }

  // Stage 3: AI に純粋な JSON を再出力させる
  const fixed = await callClaude(
    systemPrompt,
    `前の出力をJSONとしてパースしようとしましたが失敗しました。純粋なJSONのみで再度出力してください。コードフェンス・説明文は不要です。\n\n前の出力:\n${raw}`,
    messages
  );
  return JSON.parse(repairJson(extractJson(fixed))) as T;
}
