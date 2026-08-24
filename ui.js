/// <reference path="./graphy-plugin.d.ts" />
// @ts-check
/*
 * GRAPHY-Next プラグイン「Gemini 所見推敲」のフロント面。
 *
 * 流れ:
 *   人が粗い所見を書く → スタディのシリーズツリーから画像を複数選ぶ
 *   → バックエンド面（JAR）が Gemini に投げる → 推敲後の所見・直した点・書き足す観点が返る
 *
 * ── なぜ外部 API 呼び出しを ui.js から直接やらないのか ──────────────
 *  配布版 GRAPHY-Next のレンダラには CSP
 *    connect-src 'self' http://localhost:* http://127.0.0.1:*
 *  が効いており、ui.js から外部 API を fetch するとブロックされる。
 *  よって外部 API は **バックエンド面（gemini-findings.jar）から**呼ぶ。
 *
 * ── なぜ画像のレンダリングも JAR 面なのか ────────────────────────
 *  host API には「シリーズの生ピクセルを取る手段」が無く、ui.js が触れるのは
 *  **表示中のキャンバス**だけ。つまり ui.js だけでは「開いていないインスタンス」を
 *  見ることも送ることもできない。
 *  一方 JAR 面は backend の JVM 内で動くので dcm4che が使え、任意のインスタンスを
 *  読んで PNG にできる（op:"render"）。ここがバックエンド面の見せ場。
 *
 * ── 安全上の前提 ─────────────────────────────────────────────
 *  画像とテキストは Google のサーバーへ送信される。実患者データを送ってはならない。
 *  ダイアログは、確認チェックを入れるまで実行できないようにしてある。
 */

/** backend のオリジン。ui.js は /api/plugins/<id>/ui.js として配信されるので自分の URL から求まる。 */
const API_ORIGIN = new URL(import.meta.url).origin;

/** localStorage のキー。プラグイン id を前置して他と衝突させない。 */
const LS_KEY = "graphy-plugin.gemini-findings.apiKey";

/** 書き換えた指示（プロンプト）の保存先。Gems のように自分用の指示を育てられるようにする。 */
const LS_PROMPT = "graphy-plugin.gemini-findings.instruction";

/** 添付できる画像の上限（JAR 側も同じ値で頭打ちにしている）。 */
const MAX_IMAGES = 8;

/** JAR にレンダリングさせるときの長辺（px）。プレビューと送信で同じ画像を使い回す。 */
const RENDER_EDGE = 768;

/** ツリーに出さないモダリティ（画像ではない・このデモでは描けないもの）。 */
const HIDDEN_MODALITIES = new Set(["SR", "PR", "KO", "RTSTRUCT", "RTPLAN", "SEG"]);

/** 練習用の粗いドラフト。わざと口語・省略まじりにしてある。 */
const SAMPLE_DRAFT = `右上葉に結節。2cmくらい。辺縁ぎざぎざ。
胸水なし。リンパ節おおきいのはない。
前回よりすこし大きくなってる気がする。
気管支のよりかたあり。`;

const MODELS = ["gemini-2.5-flash", "gemini-2.5-pro"];

/**
 * プラグインの入口。2D ビューア／DB 画面の Plug-ins メニューから呼ばれる。
 *
 * @param {import('./graphy-plugin').PluginHost} host
 */
export function activate(host) {
  openDialog(host, studyCandidates(host));
}

// ── 対象スタディを決める ──────────────────────────────────────

/**
 * 対象になりうる studyInstanceUID を集める。
 *
 * - mainscreen.menu … ホストが選択中スタディを渡してくれる（公式の host API）。
 * - viewer2d.menu … タイルの外枠 <div> の data-tile-id="<studyUid>|<seriesUid>" から拾う。
 *   これは公式 API ではなく DOM 依存なので、本体の版が上がると変わりうる。
 *
 * @param {import('./graphy-plugin').PluginHost} host
 * @returns {string[]}
 */
function studyCandidates(host) {
  if (host.surface === "mainscreen.menu") {
    return host.selectedStudyUid ? [host.selectedStudyUid] : [];
  }
  const seen = [];
  for (const el of document.querySelectorAll("[data-tile-id]")) {
    const tileId = el.getAttribute("data-tile-id") || "";
    const studyUid = tileId.split("|")[0];
    if (studyUid && !seen.includes(studyUid)) seen.push(studyUid);
  }
  return seen;
}

// ── backend の REST（同一オリジンなので ui.js から直接叩ける） ────────

async function getJson(path) {
  const res = await fetch(API_ORIGIN + path);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  return res.json();
}

/** スタディのシリーズ一覧。 */
function fetchSeries(studyUid) {
  return getJson(`/api/studies/${encodeURIComponent(studyUid)}/series`);
}

/** シリーズのインスタンス一覧（InstanceNumber 昇順で返る）。 */
function fetchInstances(studyUid, seriesUid) {
  return getJson(
    `/api/studies/${encodeURIComponent(studyUid)}/series/${encodeURIComponent(seriesUid)}/instances`,
  );
}

// ── ダイアログ ───────────────────────────────────────────────

function openDialog(host, studyUids) {
  /** レンダリング結果のキャッシュ。key = sopUid。 */
  const rendered = new Map();
  /** 選択中インスタンス。key = sopUid、値はラベル等。Map なので選んだ順が保たれる。 */
  const selected = new Map();

  let studyUid = studyUids[0] || null;

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
    width: "min(980px, 96vw)",
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
  panel.appendChild(
    hint(
      "flash は思考（thinking）を切って呼び出します（速く・安く・出力が途中で切れにくい）。" +
        "pro は思考を無効化できない仕様のため、そのぶん出力トークンを厚めに取ります。",
    ),
  );

  // ── 3. 指示（プロンプト）— Gems のように書き換えられる
  //
  // 既定の文面は JAR 側の DEFAULT_INSTRUCTION が正本で、ここは op:"defaults" で取得して
  // 初期値にするだけ。UI 側に同じ文面をコピーすると必ず食い違うので、そうしない。
  const promptDetails = document.createElement("details");
  Object.assign(promptDetails.style, { marginTop: "14px" });
  const promptSummary = document.createElement("summary");
  Object.assign(promptSummary.style, { cursor: "pointer", fontWeight: "700", marginBottom: "6px" });
  promptSummary.textContent = "3. 指示（プロンプト）— 書き換えられます";
  promptDetails.appendChild(promptSummary);
  panel.appendChild(promptDetails);

  const promptArea = document.createElement("textarea");
  styleInput(promptArea);
  Object.assign(promptArea.style, {
    width: "100%",
    minHeight: "180px",
    resize: "vertical",
    maxWidth: "none",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: "12px",
    lineHeight: "1.6",
  });
  promptArea.value = localStorage.getItem(LS_PROMPT) || "";
  promptArea.placeholder = "既定の指示を読み込み中…";
  promptDetails.appendChild(promptArea);

  const promptBar = row();
  Object.assign(promptBar.style, { marginTop: "6px" });
  const resetPromptBtn = button("既定に戻す", "#39415a");
  const promptState = el("span", { color: "#93a1b8", fontSize: "11.5px" });
  promptBar.appendChild(resetPromptBtn);
  promptBar.appendChild(promptState);
  promptDetails.appendChild(promptBar);
  promptDetails.appendChild(
    hint(
      "この指示がドラフトと画像の前に置かれます。書き換えるとこの端末に保存され、次回もそれが使われます。" +
        "⚠ 既定の指示には「画像から新たな所見を診断しない」という制約が入っています。" +
        "外すかどうかは書き換えた人の責任です。",
    ),
  );

  /** 既定の指示は JAR から取得する（op:"defaults"）。 */
  let defaultInstruction = "";
  (async () => {
    try {
      const res = /** @type {any} */ (await host.runBackend({ op: "defaults" }));
      defaultInstruction = (res && res.instruction) || "";
      if (!promptArea.value) promptArea.value = defaultInstruction;
      promptArea.placeholder = "";
      updatePromptState();
    } catch (e) {
      promptArea.placeholder = explainBackendError(e);
    }
  })();

  function updatePromptState() {
    const custom = defaultInstruction !== "" && promptArea.value.trim() !== defaultInstruction.trim();
    promptState.textContent = custom
      ? "カスタム（この端末に保存済み・次に開いてもこの内容です）"
      : "既定のまま";
    // ボタンは常に見せる（機能があると分かるように）。既定のままなら押せないだけにする。
    resetPromptBtn.disabled = !custom;
    resetPromptBtn.style.opacity = custom ? "1" : "0.45";
    resetPromptBtn.style.cursor = custom ? "pointer" : "not-allowed";
    promptSummary.textContent = "3. 指示（プロンプト）— 書き換えられます" + (custom ? "  ※カスタム" : "");
  }

  promptArea.oninput = () => {
    if (promptArea.value.trim() === defaultInstruction.trim()) localStorage.removeItem(LS_PROMPT);
    else localStorage.setItem(LS_PROMPT, promptArea.value);
    updatePromptState();
  };
  resetPromptBtn.onclick = () => {
    promptArea.value = defaultInstruction;
    localStorage.removeItem(LS_PROMPT);
    updatePromptState();
  };
  updatePromptState();

  // ── 4. ドラフト
  panel.appendChild(sectionTitle("4. 所見のドラフト（自分で書く）"));
  const draft = document.createElement("textarea");
  styleInput(draft);
  Object.assign(draft.style, { width: "100%", minHeight: "110px", resize: "vertical", maxWidth: "none" });
  draft.value = SAMPLE_DRAFT;
  panel.appendChild(draft);
  panel.appendChild(
    hint("まず自分の言葉で書くのが練習の主眼です。粗くて構いません（サンプルもわざと粗く書いてあります）。"),
  );

  // ── 5. 画像（シリーズツリー＋プレビュー）
  panel.appendChild(sectionTitle("5. 添付する画像（インスタンス単位で複数選択）"));
  panel.appendChild(
    hint(
      "例: CT なら造影前と造影後の同じレベル、MRI なら同じレベルの T2 と T1。" +
        `選んだ順に「画像1, 画像2 …」として渡されます（最大 ${MAX_IMAGES} 枚）。`,
    ),
  );

  // 複数のスタディが開いているときだけ選択させる。
  if (studyUids.length > 1) {
    const studyRow = row();
    studyRow.appendChild(labelled("対象スタディ"));
    const studySel = document.createElement("select");
    styleInput(studySel);
    for (const uid of studyUids) {
      const o = document.createElement("option");
      o.value = uid;
      o.textContent = shortUid(uid);
      studySel.appendChild(o);
    }
    studySel.onchange = () => {
      studyUid = studySel.value;
      selected.clear();
      refreshSelection();
      buildTree();
    };
    studyRow.appendChild(studySel);
    Object.assign(studyRow.style, { marginBottom: "8px" });
    panel.appendChild(studyRow);
  }

  const browser = el("div", { display: "flex", gap: "12px", alignItems: "stretch", marginTop: "6px" });
  panel.appendChild(browser);

  const treeBox = el("div", {
    flex: "1 1 380px",
    minWidth: "0",
    maxHeight: "300px",
    overflow: "auto",
    background: "#0f1626",
    border: "1px solid #2a3550",
    borderRadius: "8px",
    padding: "6px",
  });
  browser.appendChild(treeBox);

  const previewBox = el("div", {
    flex: "0 0 300px",
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    alignItems: "center",
    justifyContent: "center",
    background: "#0f1626",
    border: "1px solid #2a3550",
    borderRadius: "8px",
    padding: "8px",
    minHeight: "200px",
  });
  browser.appendChild(previewBox);

  const previewImg = document.createElement("img");
  Object.assign(previewImg.style, {
    maxWidth: "100%",
    maxHeight: "240px",
    borderRadius: "4px",
    display: "none",
    background: "#000",
  });
  const previewCaption = el("div", { color: "#93a1b8", fontSize: "11.5px", textAlign: "center" });
  previewCaption.textContent = "インスタンスを選ぶとここに表示されます";
  previewBox.appendChild(previewImg);
  previewBox.appendChild(previewCaption);

  const selectionInfo = el("div", { marginTop: "8px", color: "#93a1b8", fontSize: "12px" });
  panel.appendChild(selectionInfo);

  const thumbs = el("div", { display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "6px" });
  panel.appendChild(thumbs);

  // ── 6. 確認
  panel.appendChild(sectionTitle("6. 確認"));
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

  const truncWarn = el("div", {
    marginTop: "8px",
    display: "none",
    background: "rgba(234,179,8,0.12)",
    border: "1px solid rgba(234,179,8,0.5)",
    borderRadius: "8px",
    padding: "8px 10px",
    fontSize: "12px",
    lineHeight: "1.6",
  });
  panel.appendChild(truncWarn);

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

  // ── ツリー ────────────────────────────────────────────────

  /** シリーズ一覧を読んでツリーを組み直す。 */
  async function buildTree() {
    treeBox.textContent = "";
    if (!studyUid) {
      const msg = el("div", { color: "#93a1b8", fontSize: "12px", padding: "8px", lineHeight: "1.7" });
      msg.textContent =
        host.surface === "mainscreen.menu"
          ? "スタディが選択されていません。一覧でスタディを選んでから実行してください。（画像なしでも推敲はできます）"
          : "2D ビューアにシリーズが開かれていません。（画像なしでも推敲はできます）";
      treeBox.appendChild(msg);
      return;
    }

    const loading = el("div", { color: "#93a1b8", fontSize: "12px", padding: "8px" });
    loading.textContent = "シリーズを読み込み中…";
    treeBox.appendChild(loading);

    let list;
    try {
      list = await fetchSeries(studyUid);
    } catch (e) {
      loading.textContent = "シリーズ一覧を取得できませんでした: " + e;
      return;
    }
    treeBox.textContent = "";

    const shown = list.filter((s) => !HIDDEN_MODALITIES.has(String(s.modality || "").toUpperCase()));
    if (shown.length === 0) {
      const msg = el("div", { color: "#93a1b8", fontSize: "12px", padding: "8px" });
      msg.textContent = "表示できるシリーズがありません。";
      treeBox.appendChild(msg);
      return;
    }
    if (shown.length < list.length) {
      treeBox.appendChild(
        hint(`画像ではないシリーズ（${[...HIDDEN_MODALITIES].join(", ")}）は隠しています。`),
      );
    }

    for (const s of shown) treeBox.appendChild(seriesNode(s));
  }

  /** シリーズ 1 行（クリックで展開してインスタンスを並べる）。 */
  function seriesNode(series) {
    const wrap = el("div", { marginBottom: "2px" });

    const head = el("div", {
      display: "flex",
      gap: "6px",
      alignItems: "center",
      cursor: "pointer",
      padding: "5px 6px",
      borderRadius: "5px",
      userSelect: "none",
    });
    const caret = el("span", { color: "#93a1b8", width: "10px", flex: "0 0 10px" });
    caret.textContent = "▸";
    const label = el("span", { fontWeight: "600" });
    label.textContent = seriesLabel(series);
    const count = el("span", { color: "#93a1b8", fontSize: "11.5px", marginLeft: "auto" });
    count.textContent = `${series.numberOfInstances ?? "?"} 枚`;
    head.appendChild(caret);
    head.appendChild(label);
    head.appendChild(count);
    head.onmouseenter = () => (head.style.background = "#1b2438");
    head.onmouseleave = () => (head.style.background = "transparent");
    wrap.appendChild(head);

    const body = el("div", { display: "none", paddingLeft: "16px" });
    wrap.appendChild(body);

    let loaded = false;
    head.onclick = async () => {
      const open = body.style.display !== "none";
      body.style.display = open ? "none" : "block";
      caret.textContent = open ? "▸" : "▾";
      if (open || loaded) return;
      loaded = true;
      body.textContent = "";
      const loading = el("div", { color: "#93a1b8", fontSize: "12px", padding: "4px 6px" });
      loading.textContent = "読み込み中…";
      body.appendChild(loading);
      try {
        const instances = await fetchInstances(studyUid, series.seriesInstanceUid);
        body.textContent = "";
        for (const inst of instances) body.appendChild(instanceNode(series, inst));
      } catch (e) {
        loading.textContent = "インスタンス一覧を取得できませんでした: " + e;
        loaded = false;
      }
    };

    return wrap;
  }

  /** インスタンス 1 行（チェックで選択・クリックでプレビュー）。 */
  function instanceNode(series, inst) {
    const sop = inst.sopInstanceUid;
    const label = `${seriesLabel(series)} #${inst.instanceNumber ?? "?"}`;

    const line = el("div", {
      display: "flex",
      gap: "6px",
      alignItems: "center",
      padding: "3px 6px",
      borderRadius: "5px",
      cursor: "pointer",
    });
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = selected.has(sop);
    box.onclick = (e) => e.stopPropagation(); // 行クリック（プレビュー）と分ける
    box.onchange = () => {
      if (box.checked) {
        if (selected.size >= MAX_IMAGES) {
          box.checked = false;
          host.notify(`添付できるのは ${MAX_IMAGES} 枚までです。`);
          return;
        }
        selected.set(sop, { studyUid, seriesUid: series.seriesInstanceUid, sopUid: sop, label });
      } else {
        selected.delete(sop);
      }
      refreshSelection();
    };
    const text = el("span", { fontSize: "12px" });
    text.textContent = `#${inst.instanceNumber ?? "?"}`;
    line.appendChild(box);
    line.appendChild(text);
    line.onmouseenter = () => (line.style.background = "#1b2438");
    line.onmouseleave = () => (line.style.background = "transparent");
    line.onclick = () => showPreview(series, inst, label);

    return line;
  }

  // ── プレビュー / レンダリング ───────────────────────────────

  /**
   * インスタンスを JAR 面でレンダリングして PNG を得る（結果はキャッシュ）。
   * ここが「ui.js にはできず、バックエンド面にはできる」ことの実演。
   */
  async function renderInstance(seriesUid, sopUid) {
    const cached = rendered.get(sopUid);
    if (cached) return cached;
    const res = /** @type {any} */ (
      await host.runBackend({
        op: "render",
        apiOrigin: API_ORIGIN,
        studyUid,
        seriesUid,
        sopUid,
        maxEdge: RENDER_EDGE,
      })
    );
    if (!res || !res.ok) throw new Error((res && res.error) || "レンダリングに失敗しました");
    const shot = {
      base64: res.base64,
      mimeType: res.mimeType || "image/png",
      dataUrl: `data:${res.mimeType || "image/png"};base64,${res.base64}`,
      width: res.width,
      height: res.height,
    };
    rendered.set(sopUid, shot);
    return shot;
  }

  async function showPreview(series, inst, label) {
    previewCaption.textContent = label + " を読み込み中…";
    previewImg.style.display = "none";
    try {
      const shot = await renderInstance(series.seriesInstanceUid, inst.sopInstanceUid);
      previewImg.src = shot.dataUrl;
      previewImg.style.display = "block";
      previewCaption.textContent = `${label}（${shot.width}×${shot.height}）`;
    } catch (e) {
      previewCaption.textContent = explainBackendError(e);
    }
  }

  /** 選択枚数の表示とサムネイル列を更新する。 */
  function refreshSelection() {
    selectionInfo.textContent =
      selected.size === 0
        ? `選択中: 0 枚（画像なしでも推敲できます・最大 ${MAX_IMAGES} 枚）`
        : `選択中: ${selected.size} 枚 / 最大 ${MAX_IMAGES} 枚`;
    thumbs.textContent = "";
    let i = 1;
    for (const item of selected.values()) {
      const cell = el("div", { display: "flex", flexDirection: "column", gap: "2px", alignItems: "center" });
      const img = document.createElement("img");
      Object.assign(img.style, {
        width: "64px",
        height: "64px",
        objectFit: "cover",
        border: "1px solid #2a3550",
        borderRadius: "4px",
        background: "#000",
      });
      const shot = rendered.get(item.sopUid);
      if (shot) img.src = shot.dataUrl;
      const cap = el("div", { color: "#93a1b8", fontSize: "10.5px" });
      cap.textContent = "画像" + i++;
      cell.appendChild(img);
      cell.appendChild(cap);
      cell.title = item.label;
      thumbs.appendChild(cell);
    }
  }

  // ── 実行本体 ─────────────────────────────────────────────

  runBtn.onclick = async () => {
    const apiKey = keyInput.value.trim();
    if (!apiKey) {
      status.textContent = "API キーを入力してください。";
      return;
    }
    if (remember.box.checked) localStorage.setItem(LS_KEY, apiKey);
    else localStorage.removeItem(LS_KEY);

    runBtn.disabled = true;
    runBtn.style.opacity = "0.5";
    result.style.display = "none";
    copyBtn.style.display = "none";
    truncWarn.style.display = "none";

    try {
      // 選択済みで未レンダリングのものをここで揃える（プレビュー済みならキャッシュが効く）。
      const images = [];
      let n = 0;
      for (const item of selected.values()) {
        n++;
        status.textContent = `画像を準備しています… (${n}/${selected.size})`;
        const shot = await renderInstance(item.seriesUid, item.sopUid);
        images.push({ base64: shot.base64, mimeType: shot.mimeType, label: item.label });
      }
      refreshSelection();

      status.textContent = "Gemini に問い合わせています…（数十秒かかることがあります）";
      const res = /** @type {any} */ (
        await host.runBackend({
          op: "refine",
          apiKey,
          model: modelSel.value,
          // 空なら JAR 側の既定が使われる（str(args,"instruction", DEFAULT_INSTRUCTION)）。
          instruction: promptArea.value.trim(),
          findings: draft.value,
          images,
        })
      );

      if (res && res.ok) {
        result.textContent = String(res.text || "");
        result.style.display = "block";
        copyBtn.style.display = "inline-block";
        const u = res.usage;
        status.textContent =
          `完了（${res.model}${res.finishReason ? " / " + res.finishReason : ""}` +
          ` / 画像 ${res.images ?? images.length} 枚` +
          (u ? ` / トークン ${u.totalTokens}（思考 ${u.thoughtsTokens ?? 0}）` : "") +
          "）。内容は必ずご自身で確認してください。";
        if (res.truncated) {
          truncWarn.textContent =
            "⚠ 出力が上限に達して途中で終わっています（finishReason=MAX_TOKENS）。" +
            "ドラフトを短くするか、画像を減らして再実行してください。";
          truncWarn.style.display = "block";
        }
      } else {
        status.textContent = "エラー: " + ((res && res.error) || "不明なエラー");
      }
    } catch (e) {
      status.textContent = explainBackendError(e);
    } finally {
      runBtn.disabled = !consent.box.checked;
      runBtn.style.opacity = consent.box.checked ? "1" : "0.5";
    }
  };

  document.body.appendChild(overlay);
  keyInput.focus();
  refreshSelection();
  buildTree();
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

// ── 表示ヘルパ ─────────────────────────────────────────────

function seriesLabel(series) {
  const parts = [series.modality, series.seriesDescription].filter(Boolean);
  return parts.length > 0 ? parts.join(" / ") : shortUid(series.seriesInstanceUid);
}

function shortUid(uid) {
  if (!uid) return "(unknown)";
  return uid.length <= 18 ? uid : "…" + uid.slice(-16);
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

function labelled(text) {
  const s = el("span", { color: "#93a1b8" });
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
