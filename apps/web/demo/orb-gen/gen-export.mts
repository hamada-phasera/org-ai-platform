import { createWebExport } from "./src/code-export";
import { createPresetOrbStateConfiguration } from "./src/orb-states";

// 参考画像 = particleRibbon プリセット（暗い球＋虹彩の殻＋光るリボン）。
// プリセット本来の色・殻・リボン設定をそのまま使い、構図だけ合わせる:
//  - radius 0.94: 球がキャンバスをほぼ満たす（「遠すぎる」対策）
//  - canvasColor: ページの明るいグレーと同色（楕円バーとの継ぎ目消し）
// 状態は idle=静か / thinking=活発 のまま。トグルが dark で thinking に
// 追随するので、ダーク時はリボンが少し燃える。
const cfg = createPresetOrbStateConfiguration("particleRibbon");
cfg.shared.radius = 0.94;
cfg.shared.canvasColor = "#e7e8ea";
cfg.activationDuration = 0.65;
process.stdout.write(createWebExport(cfg, "idle"));
