#!/usr/bin/env node
// 出所: ~/.claude/skills/org-ontology/scripts/drift.mjs (org-ontology スキル)
// スキル側を直したら cp で同期する。CI から使えるようにリポジトリにも置いている。
// 語彙定義と実データの突き合わせ。依存なし。Node 18+。
// 使い方: node drift.mjs <ontology.json> <observed.json> [--out DIR]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const [ontPath, obsPath] = args.filter((a) => !a.startsWith('--'))
const outIdx = args.indexOf('--out')
const outDir = outIdx >= 0 ? args[outIdx + 1] : './ontology-out'
if (!ontPath || !obsPath) {
  console.error('usage: node drift.mjs <ontology.json> <observed.json> [--out DIR]')
  process.exit(2)
}

const ont = JSON.parse(readFileSync(ontPath, 'utf8'))
const observed = JSON.parse(readFileSync(obsPath, 'utf8'))
const norm = (s) => String(s).trim().toLowerCase()
const NULL_TOKEN = '(null)'

// field -> scheme
const fieldScheme = new Map()
for (const [name, s] of Object.entries(ont.schemes)) {
  for (const f of s.boundTo) fieldScheme.set(f, name)
}

// 語彙索引。id / prefLabel / altLabel のどれで書かれていても同じ概念に解決する
const index = {}
for (const [name, s] of Object.entries(ont.schemes)) {
  const m = new Map()
  for (const c of s.concepts) {
    // 先勝ち。id > prefLabel > altLabel の順に登録し、大小違いの別表記が id を上書きしないようにする
    const put = (t, via) => { const k = norm(t); if (k && !m.has(k)) m.set(k, { c, via }) }
    put(c.id, 'id')
    put(c.prefLabel, 'prefLabel')
    for (const a of c.altLabel ?? []) put(a, 'altLabel')
  }
  index[name] = m
}

const violations = []
const add = (severity, code, where, detail) => violations.push({ severity, code, where, detail })

// field -> { conceptId|__unknown:value -> count }
const usage = new Map()
const nulls = new Map()
const totals = new Map()
const unknownByScheme = new Map()

for (const row of observed) {
  const { field, value } = row
  const n = Number(row.n ?? 0)
  const schemeName = fieldScheme.get(field)
  totals.set(field, (totals.get(field) ?? 0) + n)
  if (!schemeName) {
    add('info', 'UNBOUND_FIELD', field, '語彙に紐づいていない列。boundTo に足すか、対象外と決める')
    continue
  }
  if (value === NULL_TOKEN || value === null) {
    nulls.set(field, (nulls.get(field) ?? 0) + n)
    continue
  }
  const hit = index[schemeName].get(norm(value))
  const key = hit ? hit.c.id : `__unknown:${value}`
  if (!usage.has(field)) usage.set(field, new Map())
  const u = usage.get(field)
  u.set(key, (u.get(key) ?? 0) + n)

  if (!hit) {
    if (!unknownByScheme.has(schemeName)) unknownByScheme.set(schemeName, new Set())
    unknownByScheme.get(schemeName).add(value)
    add('error', 'UNKNOWN_TERM', field, `"${value}" (${n}件) は ${schemeName} の語彙にない`)
  } else if (hit.via !== 'id') {
    add('info', 'VARIANT_USED', field, `"${value}" (${n}件) は ${hit.c.id} の別表記として解決した`)
  }
}

// 使われていない語彙。観測数が少ないうちは判定しない
// （データがまだ無いだけの環境で DEAD_TERM を出すと、警告が信用されなくなる）
const DEFAULT_MIN_SAMPLES = 20
for (const [name, s] of Object.entries(ont.schemes)) {
  const min = s.minSamples ?? ont.minSamples ?? DEFAULT_MIN_SAMPLES
  const sample = s.boundTo.reduce((a, f) => a + (totals.get(f) ?? 0), 0)
  if (sample < min) {
    add('info', 'SMALL_SAMPLE', name, `観測 ${sample} 件（閾値 ${min}）。DEAD_TERM の判定を省略した`)
    continue
  }
  for (const c of s.concepts) {
    if (c.status !== 'active') continue
    let total = 0
    for (const f of s.boundTo) total += usage.get(f)?.get(c.id) ?? 0
    if (total === 0) {
      add('warn', 'DEAD_TERM', `${name}.${c.id}`,
        `語彙では active だが実データに0件${c.note ? `（${c.note}）` : ''}`)
    }
  }
}

// カバレッジ（ある列には出るが、対応する列には出ない）
for (const [name, s] of Object.entries(ont.schemes)) {
  for (const rule of s.coverage ?? []) {
    const from = usage.get(rule.from) ?? new Map()
    const by = usage.get(rule.by) ?? new Map()
    const missing = [...from.keys()].filter((k) => !k.startsWith('__unknown:') && !(by.get(k) > 0))
    if (missing.length) {
      add(rule.severity ?? 'warn', 'COVERAGE_GAP', `${rule.from} → ${rule.by}`,
        `${missing.join(', ')} が ${rule.by} 側に存在しない${rule.note ? `。${rule.note}` : ''}`)
    }
  }
}

// null が多すぎる列
for (const [name, s] of Object.entries(ont.schemes)) {
  if (!s.nullable) continue
  for (const f of s.boundTo) {
    const total = totals.get(f) ?? 0
    const nullN = nulls.get(f) ?? 0
    const ratio = total ? nullN / total : 0
    if (ratio > (s.sparseThreshold ?? 0.5)) {
      add('warn', 'SPARSE_FIELD', f,
        `${nullN}/${total} (${Math.round(ratio * 100)}%) が null。概念として機能していない`)
    }
  }
}

// 集計データでは検査できないもの（黙って通さず、明示する）
for (const [name, s] of Object.entries(ont.schemes)) {
  if (s.transitions) {
    add('info', 'NEEDS_ROW_DATA', name,
      '状態遷移の検査には行単位のログが必要。TaskLog を読む観測を足すこと')
  }
}

// ---- 出力 ----
mkdirSync(outDir, { recursive: true })
const rank = { error: 0, warn: 1, info: 2 }
violations.sort((a, b) => rank[a.severity] - rank[b.severity] || a.code.localeCompare(b.code))
const counts = violations.reduce((m, v) => ((m[v.severity] = (m[v.severity] ?? 0) + 1), m), {})

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const md = [
  `# 語彙のズレ (${ont.id} v${ont.version})`, '',
  `観測: ${observed.length} 行 / error ${counts.error ?? 0}, warn ${counts.warn ?? 0}, info ${counts.info ?? 0}`, '',
  '| 重大度 | コード | 対象 | 内容 |', '|---|---|---|---|',
  ...violations.map((v) => `| ${v.severity} | ${v.code} | \`${v.where}\` | ${v.detail} |`),
].join('\n')
writeFileSync(join(outDir, 'violations.md'), md + '\n')

const nodes = [], edges = []
for (const [name, s] of Object.entries(ont.schemes)) {
  nodes.push({ id: `scheme:${name}`, type: 'scheme', label: s.label ?? name })
  for (const c of s.concepts) {
    let total = 0
    for (const f of s.boundTo) total += usage.get(f)?.get(c.id) ?? 0
    nodes.push({ id: `concept:${name}:${c.id}`, type: 'concept', scheme: name, label: c.prefLabel, code: c.id, status: c.status, count: total })
    edges.push({ from: `scheme:${name}`, to: `concept:${name}:${c.id}`, type: 'hasConcept' })
  }
  for (const v of unknownByScheme.get(name) ?? []) {
    nodes.push({ id: `concept:${name}:__unknown:${v}`, type: 'unknown', scheme: name, label: v, code: v, status: 'unknown', count: 0 })
  }
  for (const f of s.boundTo) {
    nodes.push({ id: `field:${f}`, type: 'field', scheme: name, label: f, count: totals.get(f) ?? 0 })
    for (const [key, n] of usage.get(f) ?? []) {
      edges.push({ from: `field:${f}`, to: `concept:${name}:${key.startsWith('__unknown:') ? key : key}`, type: 'observed', count: n })
    }
  }
}
writeFileSync(join(outDir, 'graph.json'), JSON.stringify({ ontology: ont.id, version: ont.version, generatedAt: new Date().toISOString(), nodes, edges, violations }, null, 2))

// スキームごとのブロック表示。力学グラフより読める
const ROW = 34, PAD = 20, LW = 210, RW = 260, GAP = 150
let blocks = ''
for (const [name, s] of Object.entries(ont.schemes)) {
  const left = s.boundTo
  const right = [...s.concepts.map((c) => ({ code: c.id, label: c.prefLabel, status: c.status })),
    ...[...(unknownByScheme.get(name) ?? [])].map((v) => ({ code: v, label: v, status: 'unknown' }))]
  const h = Math.max(left.length, right.length) * ROW + PAD * 2
  const ly = (i) => PAD + i * ROW + ROW / 2, ry = (i) => PAD + i * ROW + ROW / 2
  let svg = ''
  left.forEach((f, i) => {
    const u = usage.get(f) ?? new Map()
    right.forEach((r, j) => {
      const n = u.get(r.status === 'unknown' ? `__unknown:${r.code}` : r.code) ?? 0
      if (!n) return
      const x1 = PAD + LW, x2 = PAD + LW + GAP, w = Math.min(6, 1 + Math.log10(n + 1) * 3)
      svg += `<path d="M${x1} ${ly(i)} C${x1 + GAP / 2} ${ly(i)}, ${x2 - GAP / 2} ${ry(j)}, ${x2} ${ry(j)}" fill="none" stroke="${r.status === 'unknown' ? '#d33' : '#6b8'}" stroke-width="${w.toFixed(1)}" opacity=".7"/>`
      svg += `<text x="${x1 + GAP / 2}" y="${(ly(i) + ry(j)) / 2 - 4}" font-size="10" fill="#888" text-anchor="middle">${n}</text>`
    })
  })
  left.forEach((f, i) => {
    svg += `<rect x="${PAD}" y="${ly(i) - 12}" width="${LW}" height="24" rx="4" fill="#eef2f7" stroke="#c3cedb"/>`
    svg += `<text x="${PAD + 8}" y="${ly(i) + 4}" font-size="12" fill="#33414f">${esc(f)}</text>`
  })
  right.forEach((r, j) => {
    const x = PAD + LW + GAP
    const fill = r.status === 'unknown' ? '#fde8e8' : r.status === 'active' ? '#eaf6ee' : '#f3f3f3'
    const stroke = r.status === 'unknown' ? '#d33' : r.status === 'active' ? '#8fc7a3' : '#ccc'
    svg += `<rect x="${x}" y="${ry(j) - 12}" width="${RW}" height="24" rx="4" fill="${fill}" stroke="${stroke}"/>`
    svg += `<text x="${x + 8}" y="${ry(j) + 4}" font-size="12" fill="#2b3a46">${esc(r.label)} <tspan fill="#98a4b0">${esc(r.code)}${r.status !== 'active' ? ` / ${r.status}` : ''}</tspan></text>`
  })
  blocks += `<section><h2>${esc(s.label ?? name)} <small>${esc(name)}</small></h2><svg viewBox="0 0 ${PAD * 2 + LW + GAP + RW} ${h}" width="100%">${svg}</svg></section>`
}
const html = `<!doctype html><meta charset="utf-8"><title>org-ontology drift</title>
<style>body{font:14px -apple-system,system-ui,sans-serif;margin:24px;color:#22303c;max-width:900px}
h1{font-size:20px}h2{font-size:15px;margin:24px 0 4px}h2 small{color:#98a4b0;font-weight:400}
section{border:1px solid #e3e8ee;border-radius:8px;padding:8px 12px;margin-bottom:8px}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid #eee;padding:6px 8px;text-align:left;vertical-align:top}
.error{color:#c00;font-weight:600}.warn{color:#b70}.info{color:#789}code{background:#f4f6f8;padding:1px 4px;border-radius:3px}</style>
<h1>語彙のズレ <small style="color:#98a4b0">${esc(ont.id)} v${esc(ont.version)}</small></h1>
<p>error ${counts.error ?? 0} / warn ${counts.warn ?? 0} / info ${counts.info ?? 0}　線の太さは件数、赤は語彙にない値。</p>
${blocks}
<h2>検出一覧</h2><table><tr><th>重大度</th><th>コード</th><th>対象</th><th>内容</th></tr>
${violations.map((v) => `<tr><td class="${v.severity}">${v.severity}</td><td><code>${v.code}</code></td><td><code>${esc(v.where)}</code></td><td>${esc(v.detail)}</td></tr>`).join('')}
</table>`
writeFileSync(join(outDir, 'graph.html'), html)

console.log(`error ${counts.error ?? 0} / warn ${counts.warn ?? 0} / info ${counts.info ?? 0}`)
for (const v of violations) console.log(`  [${v.severity}] ${v.code} ${v.where}: ${v.detail}`)
console.log(`\n-> ${join(outDir, 'violations.md')}, graph.json, graph.html`)
process.exit((counts.error ?? 0) > 0 ? 1 : 0)
