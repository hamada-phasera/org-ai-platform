#!/usr/bin/env python3
"""demo/liquid-orb.html の実行時JS(第1 module script)を React 用 ES module に抽出する。

出力: src/components/theme-toggle/orb-runtime.gen.js
シェーダー・レンダリングループは無改変。変えるのは DOM 結合の外皮だけ:
  - #orb / #status のグローバル参照 → 引数 canvas / onError コールバック
  - window.liquidOrb 公開 → 戻り値のハンドル
  - 初期状態を initialState 引数に（ダークで開いてもクロスフェード無しで暗い球）
"""
import pathlib, re, sys

root = pathlib.Path(__file__).resolve().parents[2]  # apps/web
src = (root / "demo" / "liquid-orb.html").read_text()
out_path = root / "src" / "components" / "theme-toggle" / "orb-runtime.gen.js"

m = re.search(r'<script type="module">\n(.*?)\n  </script>', src, re.S)
assert m, "runtime script not found"
body = m.group(1)
assert "shaderSource" in body, "wrong script captured"

def swap(old, new, what):
    global body
    assert old in body, f"pattern missing: {what}"
    body = body.replace(old, new, 1)

swap('    const canvas = document.querySelector("#orb");\n', "", "canvas ref")
swap('    const status = document.querySelector("#status");\n', "", "status ref")
swap('    let state = "idle";', "    let state = initialState;", "initial state")
swap(
    "      status.hidden = false;\n"
    "      status.textContent = error instanceof Error ? error.message : String(error);\n"
    "      console.error(error);",
    "      console.error(error);\n"
    "      try { onError?.(error); } catch { /* noop */ }",
    "stopWithError status writes",
)
swap(
    '    Object.defineProperty(window, "liquidOrb", {\n'
    "      value: Object.freeze({\n"
    "        getState: () => state,\n"
    "        setState,\n"
    "      }),\n"
    "    });\n\n",
    "",
    "window.liquidOrb export",
)
swap(
    '    window.addEventListener("pagehide", () => {\n'
    "      stopped = true;\n"
    "      cancelAnimationFrame(animationFrame);\n"
    "      ribbonTarget?.destroy();\n"
    "      device?.destroy();\n"
    '    }, { once: true });\n'
    "    start().catch((error) => {\n"
    "      stopWithError(error);\n"
    "    });",
    "    function destroy() {\n"
    "      if (stopped) return;\n"
    "      stopped = true;\n"
    "      cancelAnimationFrame(animationFrame);\n"
    "      ribbonTarget?.destroy();\n"
    "      ribbonTarget = null;\n"
    "      device?.destroy();\n"
    "      device = null;\n"
    "    }\n"
    '    window.addEventListener("pagehide", destroy, { once: true });\n'
    "    start().catch((error) => {\n"
    "      stopWithError(error);\n"
    "    });\n"
    "    return Object.freeze({ getState: () => state, setState, destroy });",
    "run + handle",
)

wrapped = (
    "/* 自動生成 — 編集しない。demo/orb-gen/make-react-runtime.py が\n"
    " * demo/liquid-orb.html の実行時JSから抽出する。再生成:\n"
    " *   python3 demo/orb-gen/make-react-runtime.py\n"
    " * シェーダー/レンダリングは無改変。外皮(DOM結合)だけ引数化している。 */\n"
    "// eslint-disable-next-line max-lines-per-function -- 生成コード\n"
    'export function mountLiquidOrb(canvas, { initialState = "idle", onError } = {}) {\n'
    + body
    + "\n}\n"
)
out_path.write_text(wrapped)
print(f"wrote {out_path} ({len(wrapped)} bytes)")
