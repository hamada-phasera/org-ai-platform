#!/usr/bin/env bash
# =============================================================================
# org-ai-platform: 部署別 Claude Code エージェント用 worktree セットアップ
#
# 使い方:
#   cd ~/AIProject/org-ai-platform   # リポジトリのルートで実行
#   bash setup-worktrees.sh
#
# 再実行しても安全（既存の worktree / ブランチはスキップします）
# =============================================================================
set -euo pipefail

# ---- 設定（部署を増やす場合はここに追加） ----------------------------------
# 形式: "worktreeディレクトリ名:ブランチ名"
DEPARTMENTS=(
  "org-ai-sales:feat/sales-dept"
  "org-ai-analytics:feat/analytics-dept"
  "org-ai-sns:feat/sns-dept"
)
BASE_BRANCH="main"
# -----------------------------------------------------------------------------

# リポジトリルートの確認
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "❌ ここは git リポジトリではありません。org-ai-platform のルートで実行してください。"
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
PARENT_DIR="$(dirname "$REPO_ROOT")"
cd "$REPO_ROOT"

echo "📦 リポジトリ: $REPO_ROOT"
echo "📂 worktree の作成先: $PARENT_DIR/"
echo ""

# 未コミットの変更があると worktree 間で混乱のもとになるので警告のみ（中断はしない）
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "⚠️  未コミットの変更があります。worktree 作成前にコミットしておくことを推奨します。"
  echo ""
fi

for entry in "${DEPARTMENTS[@]}"; do
  DIR_NAME="${entry%%:*}"
  BRANCH="${entry##*:}"
  TARGET="$PARENT_DIR/$DIR_NAME"

  echo "── $DIR_NAME ($BRANCH) ──────────────────────────"

  # ブランチが無ければ main から作成
  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    echo "   ブランチ $BRANCH は既に存在 → スキップ"
  else
    git branch "$BRANCH" "$BASE_BRANCH"
    echo "   ✅ ブランチ $BRANCH を $BASE_BRANCH から作成"
  fi

  # worktree が無ければ作成
  if [ -d "$TARGET" ]; then
    echo "   worktree $TARGET は既に存在 → スキップ"
  else
    git worktree add "$TARGET" "$BRANCH"
    echo "   ✅ worktree を作成: $TARGET"
  fi
  echo ""
done

echo "═══════════════════════════════════════════════════"
echo "🎉 セットアップ完了。現在の worktree 一覧:"
echo ""
git worktree list
echo ""
echo "次のステップ:"
echo "  1. dept-claude-md/ 内の各 CLAUDE.md を、対応する所有ディレクトリ直下に配置してコミット"
echo "     例: apps/sales/CLAUDE.md, apps/analytics/CLAUDE.md, apps/sns/CLAUDE.md"
echo "  2. docs/tasks.md を配置してコミット（全 worktree から見えるように main に入れる）"
echo "  3. Cursor / Claude Code で各 worktree ディレクトリを開く:"
for entry in "${DEPARTMENTS[@]}"; do
  echo "     - $PARENT_DIR/${entry%%:*}"
done
echo "  4. 各セッションの最初のプロンプト:"
echo "     「CLAUDE.md と自分の部署の CLAUDE.md を読み、docs/tasks.md の担当タスクを進めて」"
echo ""
echo "統合フェーズ: main の worktree（${REPO_ROOT}）で 4 つ目のセッションを起動し、"
echo "CLAUDE.integration.md のプロンプトを与えてください。"
