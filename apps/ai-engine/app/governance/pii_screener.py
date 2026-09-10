import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Optional


@dataclass
class PIIResult:
    text: str
    detected: bool
    types: list[str]


EMAIL_RE = re.compile(r'[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}')
JP_PHONE_RE = re.compile(r'(0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{4}|\+81[-\s]?\d{1,4}[-\s]?\d{1,4}[-\s]?\d{4})')
CREDIT_CARD_RE = re.compile(r'\b(?:\d[ \-]?){13,19}\b')
MY_NUMBER_RE = re.compile(r'\b\d{4}[ \-]?\d{4}[ \-]?\d{4}\b')


def _luhn_check(number: str) -> bool:
    digits = [int(d) for d in number if d.isdigit()]
    total = 0
    for i, d in enumerate(reversed(digits)):
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


# ---------------------------------------------------------------------------
# 資格情報 (CREDENTIAL) 検知 — gateway 側 services/secret-scrubber.ts と同等のパターン
#
# llm/router.py の _screen_user_messages() が全 LLM 呼び出しの手前で screen() を通すので、
# gateway でマスクし損ねた API キーがここで二重に止まる。
# マスク文字列は gateway と同じ `[REDACTED_<KIND>]` 形式に揃えてあるため、
# 既にマスク済みのテキストを再度通しても壊れない（角括弧はどの文字クラスにも入らない）。
#
# 誤検出で普通の日本語文や URL を壊さないため、汎用パターンは
#   - base64: 40 文字以上 かつ 小文字/大文字/数字の 3 クラスすべてを含む
#   - hex:    40 文字以上
#   - key=value: 値は ASCII 8 文字以上（日本語の値は対象外）
# と保守的な閾値を置き、URL のパス片を拾わないよう直前の文字を lookbehind で制限している。
# ---------------------------------------------------------------------------

_NON_SECRET_VALUES = {
    'null', 'undefined', 'true', 'false', 'none', 'nil', 'empty', 'nan',
    'string', 'number', 'boolean', 'object', 'value',
}


def _class_count(value: str) -> int:
    """小文字・大文字・数字のうち何クラス含むか。"""
    count = 0
    if re.search(r'[a-z]', value):
        count += 1
    if re.search(r'[A-Z]', value):
        count += 1
    if re.search(r'[0-9]', value):
        count += 1
    return count


def _fixed(kind: str) -> Callable[[re.Match[str]], Optional[str]]:
    def _replace(_m: re.Match[str]) -> Optional[str]:
        return f'[REDACTED_{kind}]'
    return _replace


def _bearer(m: re.Match[str]) -> Optional[str]:
    token = m.group(3)
    # 「Bearer authentication」のような普通の英文を壊さないための条件
    looks_like_token = len(token) >= 8 and (
        bool(re.search(r'[0-9]', token))
        or bool(re.search(r'[-._~+/=]', token))
        or len(token) >= 20
    )
    if not looks_like_token:
        return None
    return f'{m.group(1)}{m.group(2)}[REDACTED_BEARER]'


def _generic(m: re.Match[str]) -> Optional[str]:
    value = m.group(2)
    if value.lower() in _NON_SECRET_VALUES:
        return None
    if re.match(r'^https?://', value, re.IGNORECASE):
        return None
    return f'{m.group(1)}[REDACTED_GENERIC_SECRET]'


def _base64(m: re.Match[str]) -> Optional[str]:
    if _class_count(m.group(0).rstrip('=')) != 3:
        return None
    return '[REDACTED_BASE64_TOKEN]'


def _basic(m: 're.Match[str]') -> Optional[str]:
    """Authorization: Basic <base64>。「Basic authentication」のような英文は壊さない。"""
    token = m.group(3)
    looks_like_base64 = bool(re.search(r'[0-9+/=]', token)) or (
        bool(re.search(r'[a-z]', token)) and bool(re.search(r'[A-Z]', token))
    )
    if not looks_like_base64:
        return None
    return f'{m.group(1)}{m.group(2)}[REDACTED_BASIC_AUTH]'


def _basic_arg(m: 're.Match[str]') -> Optional[str]:
    return f'{m.group(1)}{m.group(2)}{m.group(3)}{m.group(4)}:[REDACTED_BASIC_AUTH]'


def _url_userinfo(m: 're.Match[str]') -> Optional[str]:
    return f'{m.group(1)}{m.group(2)}:[REDACTED_URL_PASSWORD]@'


# (種別, 正規表現, 置換関数) — 具体的なプロバイダのパターンから順に適用する
CREDENTIAL_RULES: list[tuple[str, re.Pattern[str], Callable[[re.Match[str]], Optional[str]]]] = [
    ('ANTHROPIC_KEY', re.compile(r'\bsk-ant-[A-Za-z0-9_-]{12,}'), _fixed('ANTHROPIC_KEY')),
    ('OPENAI_KEY', re.compile(r'\bsk-[A-Za-z0-9_-]{16,}'), _fixed('OPENAI_KEY')),
    # Stripe / SendGrid / Twilio — いずれも区切り文字の都合で汎用規則に当たらない。
    # gateway の secret-scrubber.ts と規則を揃えること（二段目が同じ盲点を持つと二重防御にならない）
    ('STRIPE_KEY', re.compile(r'\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}'), _fixed('STRIPE_KEY')),
    ('SENDGRID_KEY', re.compile(r'\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}'), _fixed('SENDGRID_KEY')),
    ('TWILIO_SID', re.compile(r'\b(?:AC|SK)[0-9a-fA-F]{32}\b'), _fixed('TWILIO_SID')),
    ('SLACK_TOKEN', re.compile(r'\b(?:xox[abeprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,})'), _fixed('SLACK_TOKEN')),
    ('GITHUB_TOKEN', re.compile(r'\b(?:gh[oprsu]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})'), _fixed('GITHUB_TOKEN')),
    ('AWS_ACCESS_KEY_ID', re.compile(r'\b(?:AKIA|ASIA)[0-9A-Z]{16}\b'), _fixed('AWS_ACCESS_KEY_ID')),
    ('GOOGLE_API_KEY', re.compile(r'\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])'), _fixed('GOOGLE_API_KEY')),
    # LINE 長期チャネルアクセストークン（実物は 170 文字前後の base64）
    ('LINE_CHANNEL_TOKEN', re.compile(r'(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{140,}={0,2}(?![A-Za-z0-9+/=])'), _fixed('LINE_CHANNEL_TOKEN')),
    # Authorization: Bearer xxx — "Bearer " は残してトークンだけ伏せる
    ('BEARER', re.compile(r'\b([Bb]earer)([ \t]+)([A-Za-z0-9\-._~+/]+=*)'), _bearer),
    ('BASIC_AUTH', re.compile(r'\b([Bb]asic)([ \t]+)([A-Za-z0-9+/]{8,}={0,2})'), _basic),
    # curl の -u / --user。利用者名は残してパスワード側だけ伏せる
    ('BASIC_AUTH_ARG', re.compile(r'(--user|-u)([ \t]+)(["\']?)([^\s:"\']{1,120}):([^\s"\']{1,200})'), _basic_arg),
    # https://user:password@host
    ('URL_USERINFO', re.compile(r'(\bhttps?://)([^\s/@:]{1,120}):([^\s/@]{1,200})@', re.IGNORECASE), _url_userinfo),
    # ⚠️ 先頭は \b ではなく「英数字の直後でない」。\b だと SENDGRID_API_KEY の
    #    API_KEY 部分に境界が立たず（_ は語構成文字）、環境変数風の書き方を取り逃す。
    ('GENERIC_SECRET', re.compile(
        r'((?<![A-Za-z0-9])(?:api[-_ ]?key|apikey|access[-_ ]?token|auth[-_ ]?token|refresh[-_ ]?token'
        r'|bearer[-_ ]?token|client[-_ ]?secret|secret[-_ ]?key|private[-_ ]?key'
        r'|token|secret|password|passwd|pwd|credential)\s*["\'`]?\s*[:=]\s*["\'`]?)'
        r'([A-Za-z0-9\-._~+/]{8,}=*)',
        re.IGNORECASE,
    ), _generic),
    ('BASE64_TOKEN', re.compile(r'(?<!base64,)(?<![A-Za-z0-9+/\-_.])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])'), _base64),
    ('HEX_TOKEN', re.compile(r'(?<![A-Za-z0-9\-._/])[0-9a-fA-F]{40,}(?![0-9a-fA-F])'), _fixed('HEX_TOKEN')),
]


def scrub_credentials(text: str) -> tuple[str, list[str]]:
    """資格情報らしき文字列を [REDACTED_<KIND>] に置換する。副作用なし。

    Returns: (マスク後テキスト, 検出した種別のリスト)
    """
    current = text
    kinds: list[str] = []
    for kind, pattern, handler in CREDENTIAL_RULES:
        out: list[str] = []
        last = 0
        hit = False
        for m in pattern.finditer(current):
            replacement = handler(m)
            if replacement is None:  # 誤検出とみなして素通し
                continue
            out.append(current[last:m.start()])
            out.append(replacement)
            last = m.end()
            hit = True
        if hit:
            out.append(current[last:])
            current = ''.join(out)
            if kind not in kinds:
                kinds.append(kind)
    return current, kinds


def screen(text: str) -> PIIResult:
    masked = text
    detected_types: list[str] = []

    # 資格情報を最初に処理する。後段の PHONE / CREDIT_CARD 正規表現は数字列を
    # 単語境界なしで拾うため、後回しにするとトークンの内側だけが先に置換され、
    # 残りの断片が平文で残ってしまう (例: AWS のアクセスキー ID の数字部分だけが先に消える)。
    # 既存 4 種の検知対象 (メール / 電話 / カード / マイナンバー) は
    # どの資格情報パターンにも一致しないので、既存の挙動は変わらない。
    masked, credential_kinds = scrub_credentials(masked)

    if EMAIL_RE.search(masked):
        detected_types.append('EMAIL')
        masked = EMAIL_RE.sub('[PII_EMAIL]', masked)

    if JP_PHONE_RE.search(masked):
        detected_types.append('PHONE')
        masked = JP_PHONE_RE.sub('[PII_PHONE]', masked)

    for match in list(CREDIT_CARD_RE.finditer(masked)):
        digits_only = re.sub(r'[^\d]', '', match.group())
        if len(digits_only) >= 13 and _luhn_check(digits_only):
            if 'CREDIT_CARD' not in detected_types:
                detected_types.append('CREDIT_CARD')
            masked = masked.replace(match.group(), '[PII_CARD]')

    if MY_NUMBER_RE.search(masked):
        detected_types.append('MY_NUMBER')
        masked = MY_NUMBER_RE.sub('[PII_MYNUMBER]', masked)

    if credential_kinds:
        detected_types.append('CREDENTIAL')

    return PIIResult(text=masked, detected=len(detected_types) > 0, types=detected_types)
