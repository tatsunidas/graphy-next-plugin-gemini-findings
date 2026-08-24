/**
 * GRAPHY-Next プラグイン UI の型定義（プラグイン開発者向け・エディタ補完用）。
 *
 * この .d.ts は「ビルド不要」でエディタ型補完を得るためのもの。`ui.js` の先頭で
 *   /// <reference path="./graphy-plugin.d.ts" />
 *   // @ts-check
 * と書けば、TypeScript を導入しなくても VS Code 等で `host` に補完が効く。
 *
 * 本体の契約は GRAPHY-Next の frontend/src/plugins/pluginTypes.ts。ここはその安定サブセット。
 */

/** プラグインを組み込む先（UI サーフェス）。 */
export type PluginSurface = "viewer2d.menu" | "viewer2d.toolbar" | "mainscreen.menu";

/**
 * 2D ビューアのプラグインから使える、表示中タイルへの操作（安定サブセット）。
 * GRAPHY-Next 本体にはこれ以外の操作もあるが、ここではプラグイン向けに安定なものだけを公開する。
 */
export interface ViewerActions {
  /** 表示を Fit（はみ出しなく収める）。 */
  fit(): void;
  /** 表示状態をリセット。 */
  reset(): void;
  /** 90 度回転。 */
  rotate90(): void;
  /** 左右反転。 */
  flipH(): void;
  /** 上下反転。 */
  flipV(): void;
  /** 白黒反転。 */
  invert(): void;
  /** 元に戻す / やり直し。 */
  undo(): void;
  redo(): void;
  /** ウィンドウレベル（中心・幅）を適用。 */
  setWindowLevel(center: number, width: number): void;
  /** DICOM 既定のウィンドウに戻す。 */
  resetWindow(): void;
}

/**
 * 操作対象タイル 1 枚が「いま何を表示しているか」。`host.getTargets()` の要素。
 *
 * <p>**GRAPHY-Next 0.1.9 以降**。使うプラグインは plugin.json の
 * `engines.graphy` を `">=0.1.9"` にすること（古い本体には導入させない＝正しい挙動）。
 */
export interface ViewerTarget {
  /** タイルの識別子。`getViewState(tileId)` に渡せる。 */
  tileId: string;
  studyUid: string;
  seriesUid: string;
  /** 画面に出ているシリーズ名。 */
  seriesLabel: string;
  /** 表示中スライスの imageId。 */
  imageId: string;
  /** 表示中スライス（Z）の 0 始まり index と、そのスタックの総数。 */
  sliceIndex: number;
  sliceCount: number;
  /** ZCT モデルのチャンネル / 時相（多次元でないシリーズは 0）。 */
  c: number;
  t: number;
  modality: string;
}

/**
 * タイル 1 枚の表示状態。`host.getViewState()` の戻り。
 *
 * <p>W/L は**モダリティ値空間**（CT なら HU）。表示単位は `unit`。**0.1.9 以降**。
 */
export interface ViewerViewState {
  tileId: string;
  windowCenter: number;
  windowWidth: number;
  /** 校正済み画素値の単位（CT は "HU"、無ければ ""）。 */
  unit: string;
  /** 適用中の LUT 名（LUT ダイアログの名前。例 "10_Percent"）。グレースケール（未適用）なら null。 */
  colormap: string | null;
  invert: boolean;
  flipH: boolean;
  flipV: boolean;
  /** 度。 */
  rotation: number;
  /** Fit を 1.0 とした相対倍率。 */
  zoom: number;
  /** 既定（画像が中央）からのオフセット（world mm）。 */
  pan: [number, number];
}

/** `getPixelData` の任意指定。**0.1.9 以降**。 */
export interface PixelDataOptions {
  /**
   * 読み出すスライス（Z）の 0 始まり index。既定は表示中スライス。
   * 範囲外は拒否（null が返る）＝黙って別のスライスにはならない。
   */
  sliceIndex?: number;
}

/**
 * スライス 1 枚の**校正済み画素**。`host.getPixelData()` の戻り。**0.1.9 以降**。
 *
 * <p>値はモダリティ値（CT なら HU、SUV 校正済み PET なら SUV）で、**表示 W/L は掛かっていない**
 * ＝定量処理に使える。カラー（RGB）画像は輝度に落ちて `unit === "raw"`。
 */
export interface PixelData {
  tileId: string;
  imageId: string;
  /** 実際に読み出したスライスの index。 */
  sliceIndex: number;
  /** 行数・列数。`data.length === rows * cols`。 */
  rows: number;
  cols: number;
  /** row-major。`data[y * cols + x]`。 */
  data: Float32Array;
  /** 値の単位（"HU" / "SUVbw" / "" / カラーは "raw"）。 */
  unit: string;
  /** 画素間隔 [列方向(x), 行方向(y), スライス方向(z)] mm。不明な軸は null。 */
  spacing: [number | null, number | null, number | null];
}

/** `showOverlay` に渡す値マップ。**0.1.9 以降**。 */
export interface Overlay {
  /** rows*cols, row-major。`NaN` は透明。 */
  data: Float32Array;
  /** 現在スライスの rows/cols と一致していること（不一致は拒否）。 */
  rows: number;
  cols: number;
  /** 値 → 濃淡の窓。省略時は data の min/max（NaN 以外）で自動。 */
  window?: { center: number; width: number };
  /** 本体の LUT 名（例 "Hot_Iron"）。省略/null はグレースケール。 */
  colormap?: string | null;
  /** 不透明度 0〜1（既定 0.5）。 */
  opacity?: number;
}

/** `saveDerivedSeries` に渡す保存要求。**0.1.9 以降**。 */
export interface DerivedSeriesRequest {
  /** 新シリーズの説明。保存時に本体が `[Plugin] ` 接頭辞を付ける。 */
  seriesDescription: string;
  /**
   * フレーム（1 枚以上）。`sliceIndex` は**元シリーズのどのスライスに対応するか**。
   * 幾何（IPP/IOP/PixelSpacing/厚み）は本体が元シリーズから引き継ぐので、プラグインは書かない。
   */
  frames: Array<{ sliceIndex: number; data: Float32Array }>;
  /** 元スライスと一致していること（不一致は拒否）。 */
  rows: number;
  cols: number;
  /** 値の単位（`RescaleType` に入る。例 "HU"）。 */
  unit?: string;
  /** 派生内容の説明。プラグイン id・版は本体が併記する。 */
  derivationDescription?: string;
}

/** 保存結果。`cancelled` はユーザーが確認ダイアログで拒否した場合。**0.1.9 以降**。 */
export interface DerivedSeriesResult {
  ok: boolean;
  cancelled?: boolean;
  seriesInstanceUid?: string;
  instanceCount?: number;
  error?: string;
}

interface PluginHostBase {
  /** 自分の plugin.json の id。 */
  pluginId: string;
  /** i18n 取得関数（ホスト言語に追従）。 */
  t: (key: string) => string;
  /** ユーザーへの簡易通知。 */
  notify: (message: string) => void;
  /**
   * バックエンド面（Java 実装）を呼ぶ: POST /api/plugins/{id}/run。
   * デスクトップ版（standalone）のみ実行可。Web 版は 501 で reject される。
   */
  runBackend: (payload?: unknown) => Promise<unknown>;
}

/** 2D ビューア系（viewer2d.menu / viewer2d.toolbar）に渡るコンテキスト。 */
export interface Viewer2DPluginHost extends PluginHostBase {
  surface: "viewer2d.menu" | "viewer2d.toolbar";
  /** 表示中タイルへの操作。 */
  actions: ViewerActions;
  /**
   * 操作対象タイル（選択タイル→無ければ全タイル。`actions` の対象と同じ）が
   * いま何を表示しているか。**0.1.9 以降**。
   *
   * <p>**呼ぶたびに現在値を読む**。ダイアログを開いている間にユーザーがスライスを送ることが
   * あるので、活性化時に一度だけ読んだ値を持ち回らないこと。
   */
  getTargets: () => ViewerTarget[];
  /**
   * 対象タイルの表示状態。`tileId` を省略すると対象の先頭タイル。取得不能なら null。
   * **0.1.9 以降**。
   */
  getViewState: (tileId?: string) => ViewerViewState | null;
  /**
   * 対象タイルのスライス 1 枚の**校正済み画素**（HU / SUV。表示 8bit ではない）。
   * `tileId` 省略時は対象の先頭タイル。取得不能・`sliceIndex` が範囲外なら null。**0.1.9 以降**。
   *
   * <p>1 回 1 スライス。シリーズ全体が要るなら `sliceIndex` を変えて回すこと
   * （512×512×500 を Float32 で全部持つと 500MB を超える）。
   *
   * <p>患者の生画素を扱う API なので、使うプラグインは `plugin.json` の `permissions` に
   * `"read-pixels"` を宣言すること（導入時の同意画面に出る）。
   */
  getPixelData: (tileId?: string, opts?: PixelDataOptions) => Promise<PixelData | null>;
  /**
   * 処理結果（値マップ）を**表示中スライスへ重ねて見せる**。`tileId` 省略時は対象の先頭タイル。
   * rows/cols が現在スライスと不一致なら false。**0.1.9 以降**。
   *
   * <p>渡すのは値だけ。色付け（`window` / `colormap` / `opacity`）は本体がする。
   * `NaN` の画素は透明になるので、マスクや部分的なマップをそのまま渡せる。
   * 本体が画像左下に「プラグイン: <名前>」のラベルを出す。
   *
   * <p>オーバーレイは**出したスライスに紐付く**（他スライスでは隠れ、戻ると再表示。
   * シリーズ切替では破棄）。**保存はされない**（派生シリーズ保存は未実装）。
   */
  showOverlay: (tileId: string | undefined, overlay: Overlay) => boolean;
  /** オーバーレイを消す。`tileId` 省略時は対象タイル全部。**0.1.9 以降**。 */
  clearOverlay: (tileId?: string) => void;
  /**
   * 処理結果を**派生シリーズとして保存する**（デスクトップ版はこの PC の保管庫、Web 版は接続中の PACS）。
   * **0.1.9 以降**。
   *
   * <p>**本体が必ず確認ダイアログを出す**（抑止不可）。ユーザーが拒否すると
   * `{ ok: false, cancelled: true }` が返る。プラグインが黙って保存することはできない。
   *
   * <p>画素は 16bit signed ＋ Rescale で保存される（HU のような整数はそのまま、確率マップのような
   * 小さい実数は値域から係数を決めて量子化）。`NaN` は「データ無し」として値域の最小値になる。
   * 保存物には `[Plugin] ` 接頭辞とプラグイン id・版が必ず残る。**元シリーズは変更されない。**
   */
  saveDerivedSeries: (tileId: string | undefined, req: DerivedSeriesRequest) => Promise<DerivedSeriesResult>;
}

/** データベース画面（mainscreen.menu）に渡るコンテキスト。 */
export interface MainScreenPluginHost extends PluginHostBase {
  surface: "mainscreen.menu";
  /** 選択中スタディの UID（未選択なら null）。 */
  selectedStudyUid: string | null;
}

export type PluginHost = Viewer2DPluginHost | MainScreenPluginHost;
