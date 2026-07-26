# 発表スライドの生成

`build-deck.js` が `docs/presentation-2026-07-31.md` の構成・原稿をそのまま
PowerPoint に起こす。読み上げ原稿は各スライドの**発表者ノート**に入るので、
PowerPoint の発表者ビューでそのまま読める。

```bash
npm install pptxgenjs          # 初回のみ
node docs/presentation/build-deck.js
# → FLOW-presentation-2026-07-31.pptx
```

文言を直したいときは `build-deck.js` を編集して再実行する。
スライド本文と `addNotes()` の原稿は必ず両方直すこと（片方だけ直すとズレる）。

## 設計メモ
- canvas は `LAYOUT_WIDE`（13.33 × 7.5 inch）。`BODY_TOP` / `BODY_BOT` で本文の上下端を統一している
- 図の横線は「両端の縦線ちょうど」で止める（はみ出すと雑に見える）
- 箇条書きの中に `\n` を入れないこと。別項目として弾点が付いてしまう
- フォントは Meiryo。日本語が化ける環境では PowerPoint 側で置換する
