/// <reference path="./graphy-plugin.d.ts" />
// @ts-check
/*
 * GRAPHY-Next プラグイン「Gemini 所見推敲」のフロント面。
 *
 * 流れ:
 *   人が粗い所見を書く → 表示中の画像を添付 → バックエンド面（JAR）が Gemini に投げる
 *   → 推敲後の所見・直した点・書き足す観点が返る
 *
 * ── なぜ外部 API 呼び出しを ui.js から直接やらないのか ──────────────
 *  配布版 GRAPHY-Next のレンダラには CSP
 *    connect-src 'self' http://localhost:* http://127.0.0.1:*
 *  が効いており、ui.js から外部 API を fetch するとブロックされる。
 *  よって外部 API は **バックエンド面（gemini-findings.jar）から**呼ぶ。
 *  ui.js の役目は「入力を集めて host.runBackend() に渡し、結果を表示する」こと。
 *
 * ── 安全上の前提 ─────────────────────────────────────────────
 *  画像とテキストは Google のサーバーへ送信される。実患者データを送ってはならない。
 *  ダイアログは、確認チェックを入れるまで実行できないようにしてある。
 */

/** localStorage のキー。プラグイン id を前置して他と衝突させない。 */
const LS_KEY = "graphy-plugin.gemini-findings.apiKey";

/** 添付画像の最大辺（px）。大きすぎるとリクエストが重くなるので縮小する。 */
const MAX_IMAGE_EDGE = 1024;

/** 練習用の粗いドラフト。わざと口語・省略まじりにしてある。 */
const SAMPLE_DRAFT = `右上葉に結節。2cmくらい。辺縁ぎざぎざ。
胸水なし。リンパ節おおきいのはない。
前回よりすこし大きくなってる気がする。
気管支のよりかたあり。`;

const MODELS = ["gemini-2.5-flash", "gemini-2.5-pro"];

/**
 * プラグインの入口。2D ビューアの Plug-ins メニューから呼ばれる。
 *
 * @param {import('./graphy-plugin').PluginHost} host
 */
export function activate(host) {
  if (host.surface === "mainscreen.menu") {
    host.notify("このプラグインは 2D ビューアの Plug-ins メニューから実行してください。");
    return;
  }
  openDialog(host);
}

// ── 表示中の画像を取り出す ────────────────────────────────────

/**
 * 2D ビューアのタイルを列挙する。
 *
 * GRAPHY-Next は各タイルの外枠 <div> に data-tile-id="<studyUid>|<seriesUid>" を持たせている。
 * これは公式の host API ではなく DOM 依存なので、本体の版が上がると変わりうる。
 *
 * @returns {{tileId: string, seriesUid: string, canvas: HTMLCanvasElement, label: string}[]}
 */
function findOpenTiles() {
  const out = [];
  for (const el of document.querySelectorAll("[data-tile-id]")) {
    const tileId = el.getAttribute("data-tile-id") || "";
    const canvas = el.querySelector("canvas");
    if (!tileId || !(canvas instanceof HTMLCanvasElement)) continue;
    if (canvas.width === 0 || canvas.height === 0) continue;
    const seriesUid = tileId.split("|")[1] || "";
    const label = seriesUid.length <= 18 ? seriesUid : "…" + seriesUid.slice(-16);
    out.push({ tileId, seriesUid, canvas, label });
  }
  return out;
}

/**
 * キャンバスを PNG の base64（データ URL の接頭辞なし）にする。長辺を縮小する。
 *
 * Cornerstone3D のビューポート キャンバスは 2D の場合も WebGL の場合もあるため、
 * いったんオフスクリーンの 2D キャンバスへ drawImage してから toDataURL する。
 *
 * @returns {{base64: string, dataUrl: string, width: number, height: number} | null}
 */
function captureCanvas(src) {
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));

  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const ctx = off.getContext("2d");
  if (!ctx) return null;
  // 黒背景を敷いてから描く（透明部分が白飛びしないように）。
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(src, 0, 0, w, h);

  const dataUrl = off.toDataURL("image/png");
  const comma = dataUrl.indexOf(",");
  return { base64: dataUrl.slice(comma + 1), dataUrl, width: w, height: h };
}

// ── ダイアログ ───────────────────────────────────────────────

function openDialog(host) {
  const tiles = findOpenTiles();

  const overlay = el("div", {
    position: "fixed",
    inset: "0",
    zIndex: "99999",
    background: "rgba(0,0,0,0.65)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    font: "13px system-ui, sans-serif",
    color: "#e8ecf5",
  });

  const panel = el("div", {
    background: "#161d2e",
    border: "1px solid #2a3550",
    borderRadius: "10px",
    padding: "16px 18px",
    width: "min(880px, 94vw)",
    maxHeight: "92vh",
    overflow: "auto",
    boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
  });
  overlay.appendChild(panel);

  const title = el("div", { fontSize: "15px", fontWeight: "700", marginBottom: "4px" });
  title.textContent = "Gemini 所見推敲（教育用の文章演習）";
  panel.appendChild(title);

  const sub = el("div", { color: "#93a1b8", fontSize: "12px", marginBottom: "12px", lineHeight: "1.6" });
  sub.textContent =
    "自分で書いた粗い所見を Gemini に推敲させます。診断支援ではありません。入力した文章と画像は Google のサーバーへ送信されます。";
  panel.appendChild(sub);

  // ── 警告帯
  const warn = el("div", {
    background: "rgba(244,63,94,0.12)",
    border: "1px solid rgba(244,63,94,0.5)",
    borderRadius: "8px",
    padding: "10px 12px",
    marginBottom: "14px",
    lineHeight: "1.7",
    fontSize: "12px",
  });
  warn.innerHTML =
    "<b>実患者データを送信しないでください。</b><br>" +
    "匿名化済みデータ・ファントム・公開データセットのみを対象にしてください。" +
    "施設の規程や倫理審査の要否は各自でご確認ください。";
  panel.appendChild(warn);

  // ── 1. API キー
  panel.appendChild(sectionTitle("1. Gemini API キー"));
  const keyRow = row();
  const keyInput = input("password", "AIza… （Google AI Studio で取得）");
  keyInput.value = localStorage.getItem(LS_KEY) || "";
  keyRow.appendChild(keyInput);
  const remember = checkbox("この端末に保存する", keyInput.value !== "");
  keyRow.appendChild(remember.wrap);
  panel.appendChild(keyRow);
  panel.appendChild(
    hint(
      "キーは呼び出しのたびにバックエンド面へ渡され、そこでは保存されません。" +
        "「保存する」を選ぶとブラウザの localStorage に平文で残ります。共有端末では選ばないでください。",
    ),
  );

  // ── 2. モデル
  panel.appendChild(sectionTitle("2. モデル"));
  const modelSel = document.createElement("select");
  styleInput(modelSel);
  for (const m of MODELS) {
    const o = document.createElement("option");
    o.value = m;
    o.textContent = m;
    modelSel.appendChild(o);
  }
  panel.appendChild(modelSel);

  // ── 3. ドラフト
  panel.appendChild(sectionTitle("3. 所見のドラフト（自分で書く）"));
  const draft = document.createElement("textarea");
  styleInput(draft);
  Object.assign(draft.style, { width: "100%", minHeight: "120px", resize: "vertical", maxWidth: "none" });
  draft.value = SAMPLE_DRAFT;
  panel.appendChild(draft);
  panel.appendChild(
    hint("まず自分の言葉で書くのが練習の主眼です。粗くて構いません（サンプルもわざと粗く書いてあります）。"),
  );

  // ── 4. 画像
  panel.appendChild(sectionTitle("4. 添付する画像"));
  const imgRow = row();
  const attach = checkbox("表示中の画像を添付する", tiles.length > 0);
  imgRow.appendChild(attach.wrap);

  const tileSel = document.createElement("select");
  styleInput(tileSel);
  tiles.forEach((t, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = t.label;
    tileSel.appendChild(o);
  });
  if (tiles.length === 0) {
    attach.box.checked = false;
    attach.box.disabled = true;
    const o = document.createElement("option");
    o.textContent = "（2D ビューアに画像がありません）";
    tileSel.appendChild(o);
    tileSel.disabled = true;
  }
  imgRow.appendChild(tileSel);
  panel.appendChild(imgRow);

  const preview = document.createElement("img");
  Object.assign(preview.style, {
    marginTop: "8px",
    maxWidth: "220px",
    border: "1px solid #2a3550",
    borderRadius: "6px",
    display: "none",
  });
  panel.appendChild(preview);

  const refreshPreview = () => {
    if (!attach.box.checked || tiles.length === 0) {
      preview.style.display = "none";
      return;
    }
    const shot = captureCanvas(tiles[Number(tileSel.value)].canvas);
    preview.src = shot ? shot.dataUrl : "";
    preview.style.display = shot ? "block" : "none";
  };
  attach.box.onchange = refreshPreview;
  tileSel.onchange = refreshPreview;
  refreshPreview();

  // ── 5. 確認
  panel.appendChild(sectionTitle("5. 確認"));
  const consent = checkbox(
    "送信する画像とテキストは実患者データではなく、外部送信してよいことを確認しました",
    false,
  );
  panel.appendChild(consent.wrap);

  // ── 実行
  const bar = row();
  Object.assign(bar.style, { marginTop: "16px" });
  const runBtn = button("推敲する", "#0b5cad");
  const closeBtn = button("閉じる", "#39415a");
  runBtn.disabled = true;
  runBtn.style.opacity = "0.5";
  bar.appendChild(runBtn);
  bar.appendChild(closeBtn);
  panel.appendChild(bar);

  consent.box.onchange = () => {
    runBtn.disabled = !consent.box.checked;
    runBtn.style.opacity = consent.box.checked ? "1" : "0.5";
    runBtn.style.cursor = consent.box.checked ? "pointer" : "not-allowed";
  };

  const status = el("div", { marginTop: "10px", color: "#93a1b8", fontSize: "12px", minHeight: "1.4em" });
  panel.appendChild(status);

  const result = el("div", {
    marginTop: "10px",
    whiteSpace: "pre-wrap",
    background: "#0f1626",
    border: "1px solid #2a3550",
    borderRadius: "8px",
    padding: "12px 14px",
    lineHeight: "1.8",
    display: "none",
    maxHeight: "40vh",
    overflow: "auto",
  });
  panel.appendChild(result);

  const copyBtn = button("結果をコピー", "#39415a");
  Object.assign(copyBtn.style, { marginTop: "8px", display: "none" });
  panel.appendChild(copyBtn);
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(result.textContent || "").then(
      () => host.notify("コピーしました。"),
      () => host.notify("コピーできませんでした。"),
    );
  };

  // ── 閉じる
  const close = () => {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  closeBtn.onclick = close;
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };
  document.addEventListener("keydown", onKey);

  // ── 実行本体
  runBtn.onclick = async () => {
    const apiKey = keyInput.value.trim();
    if (!apiKey) {
      status.textContent = "API キーを入力してください。";
      return;
    }
    if (remember.box.checked) localStorage.setItem(LS_KEY, apiKey);
    else localStorage.removeItem(LS_KEY);

    /** @type {Record<string, unknown>} */
    const payload = {
      apiKey,
      model: modelSel.value,
      findings: draft.value,
    };
    if (attach.box.checked && tiles.length > 0) {
      const shot = captureCanvas(tiles[Number(tileSel.value)].canvas);
      if (shot) {
        payload.imageBase64 = shot.base64;
        payload.mimeType = "image/png";
      }
    }

    runBtn.disabled = true;
    runBtn.style.opacity = "0.5";
    status.textContent = "Gemini に問い合わせています…（数十秒かかることがあります）";
    result.style.display = "none";
    copyBtn.style.display = "none";

    try {
      // ここがバックエンド面の呼び出し: POST /api/plugins/gemini-findings/run
      const res = /** @type {any} */ (await host.runBackend(payload));
      if (res && res.ok) {
        result.textContent = String(res.text || "");
        result.style.display = "block";
        copyBtn.style.display = "inline-block";
        const u = res.usage;
        status.textContent =
          `完了（${res.model}${res.finishReason ? " / " + res.finishReason : ""}` +
          (u ? ` / トークン ${u.totalTokens}` : "") +
          "）。内容は必ずご自身で確認してください。";
      } else {
        status.textContent = "エラー: " + ((res && res.error) || "不明なエラー");
      }
    } catch (e) {
      status.textContent = explainBackendError(e);
    } finally {
      runBtn.disabled = false;
      runBtn.style.opacity = "1";
    }
  };

  document.body.appendChild(overlay);
  keyInput.focus();
}

/**
 * runBackend の reject を読み解く。
 * よくあるのは Web 版の 501（バックエンド面はデスクトップ版のみ実行可）。
 */
function explainBackendError(e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (/501|not implemented|unsupported/i.test(msg)) {
    return (
      "バックエンド面を実行できません（501）。" +
      "JAR を伴うプラグインはデスクトップ版（standalone）でのみ動作します。"
    );
  }
  if (/404/.test(msg)) {
    return "バックエンド面が見つかりません（404）。plugin.json の entrypoint と、フォルダ直下の JAR を確認してください。";
  }
  if (/500/.test(msg)) {
    return "バックエンド面が例外で落ちました（500）。アプリのログを確認してください。JAR を入れ替えた直後ならアプリの再起動が必要です。";
  }
  return "呼び出しに失敗しました: " + msg;
}

// ── DOM ヘルパ ─────────────────────────────────────────────

function el(tag, style) {
  const e = document.createElement(tag);
  Object.assign(e.style, style);
  return e;
}

function row() {
  return el("div", { display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" });
}

function sectionTitle(text) {
  const s = el("div", { fontWeight: "700", marginTop: "14px", marginBottom: "6px" });
  s.textContent = text;
  return s;
}

function hint(text) {
  const s = el("div", { color: "#93a1b8", fontSize: "11.5px", marginTop: "5px", lineHeight: "1.6" });
  s.textContent = text;
  return s;
}

function styleInput(e) {
  Object.assign(e.style, {
    background: "#0f1626",
    color: "#e8ecf5",
    border: "1px solid #2a3550",
    borderRadius: "6px",
    padding: "6px 9px",
    font: "inherit",
    maxWidth: "420px",
  });
}

function input(type, placeholder) {
  const e = document.createElement("input");
  e.type = type;
  e.placeholder = placeholder;
  e.autocomplete = "off";
  styleInput(e);
  e.style.flex = "1 1 280px";
  return e;
}

function checkbox(labelText, checked) {
  const wrap = el("label", { display: "inline-flex", gap: "6px", alignItems: "center", cursor: "pointer" });
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = checked;
  const span = document.createElement("span");
  span.textContent = labelText;
  wrap.appendChild(box);
  wrap.appendChild(span);
  return { wrap, box };
}

function button(text, bg) {
  const b = document.createElement("button");
  b.textContent = text;
  Object.assign(b.style, {
    background: bg,
    color: "#fff",
    border: "0",
    borderRadius: "6px",
    padding: "7px 16px",
    cursor: "pointer",
    font: "inherit",
    fontWeight: "600",
  });
  return b;
}
