package com.example.graphy.gemini;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.vis.graphynext.plugin.spi.GraphyPlugin;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.io.DicomInputStream;

import javax.imageio.ImageIO;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.awt.image.DataBufferByte;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * GRAPHY-Next プラグイン「Gemini 所見推敲」のバックエンド面。
 *
 * <p>UI（ui.js）から {@code host.runBackend(payload)}（＝{@code POST /api/plugins/{id}/run}）で
 * 呼ばれる。{@code op} で 2 つの仕事を持つ:
 *
 * <ul>
 *   <li>{@code op:"render"} … 指定インスタンスを<b>サーバ側でレンダリング</b>して PNG(base64) を返す。
 *       シリーズツリーのプレビューと、Gemini へ添付する画像の両方に使う。</li>
 *   <li>{@code op:"refine"}（既定）… 所見ドラフト＋<b>複数枚</b>の画像を Gemini に渡して推敲させる。</li>
 *   <li>{@code op:"defaults"} … 既定の指示（プロンプト）を返す。UI はこれを編集用テキストエリアの
 *       初期値にする。既定文面の実体を<b>ここ 1 か所</b>に保ち、UI と二重管理しないための口。</li>
 * </ul>
 *
 * <h2>なぜ Java 側で呼ぶのか</h2>
 * 配布版 GRAPHY-Next のレンダラには CSP
 * {@code connect-src 'self' http://localhost:* http://127.0.0.1:*} が効いており、
 * {@code ui.js} から外部 API を fetch するとブロックされる。外部 API を叩く処理は
 * バックエンド面（この JAR）に置くのが唯一の方法。
 *
 * <h2>なぜレンダリングも Java 側なのか</h2>
 * ui.js は「表示中のキャンバス」しか画素を得られない（host API に生画素を取る手段が無い）。
 * 一方この JAR は backend の JVM 内で<b>親クラスローダ付き</b>にロードされるため、backend の依存
 * である <b>dcm4che</b> がそのまま使える。よって「開いていないインスタンス」も読める。
 * これが ui.js には無いバックエンド面の強みで、このデモの主題そのものである。
 *
 * <h2>依存について</h2>
 * <ul>
 *   <li>{@code graphy-plugin-api}（SPI）… ランタイムは GRAPHY-Next が供給するので {@code provided}。</li>
 *   <li>Jackson / dcm4che … 同じく backend の依存が実行時に見えるので {@code provided} で参照する。
 *       ただし<b>本体の版が上がると壊れうる</b>ことは織り込むこと。</li>
 * </ul>
 *
 * <h2>API キーの扱い</h2>
 * キーは呼び出しごとに UI から渡され、<b>このクラスはどこにも保存しない</b>（ログにも出さない）。
 *
 * <h2>これは診断ではない</h2>
 * 既定のプロンプトは「ドラフトに書かれている内容の言語化・整理」に限定しており、画像から新しい
 * 所見を診断させない。教育・執筆練習のためのサンプルである。
 *
 * <p>⚠ プロンプトは UI から書き換えられる（{@code args.instruction}）。書き換えた場合、
 * 「診断させない」という制約を維持するかどうかは<b>書き換えた人の責任</b>になる。
 */
public class GeminiFindingsPlugin implements GraphyPlugin {

    /** Gemini の REST エンドポイント（モデル名は呼び出し時に差し込む）。 */
    private static final String ENDPOINT =
            "https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent";

    private static final String DEFAULT_MODEL = "gemini-2.5-flash";

    /** 画像を添付するので少し長めに待つ。 */
    private static final Duration TIMEOUT = Duration.ofSeconds(120);

    /**
     * 出力トークンの上限。
     *
     * <p>⚠ Gemini 2.5 系は<b>思考（thinking）モデル</b>で、思考トークンもこの上限に含まれる。
     * 以前の 2048 では思考で枠を使い切り、本文が {@code finishReason=MAX_TOKENS} で途中で切れていた。
     * 余裕を持たせたうえで、flash では思考自体を切る（{@link #applyThinking}）。
     */
    private static final int DEFAULT_MAX_OUTPUT_TOKENS = 8192;

    /** 添付画像の上限枚数（無料枠のトークン消費とレイテンシを抑えるため）。 */
    private static final int MAX_IMAGES = 8;

    /**
     * 推敲の指示（既定）。画像から新しい所見を「診断」させないことを最優先の制約にしている。
     * 出力を 3 部構成にしているのは、推敲結果だけでなく「なぜ直したか」を学べるようにするため。
     *
     * <p>UI からユーザーが書き換えた指示（{@code args.instruction}）が来たらそちらを使う。
     * ここは<b>既定値であり、UI の初期値の供給元</b>でもある（{@code op:"defaults"}）。
     */
    private static final String DEFAULT_INSTRUCTION = """
            あなたは放射線診断レポートの日本語校閲者です。
            以下は、練習のために書かれた粗い所見のドラフトです。添付画像とドラフトを踏まえ、
            読影レポートとして通用する日本語に推敲してください。

            添付画像は複数枚ある場合があります。各画像の直前にその画像の説明（シリーズ名・
            インスタンス番号など）を置いてあります。ドラフトが特定の相・シーケンスに言及して
            いる場合は、対応する画像がどれかを踏まえて表現を整えてください。

            制約:
            - 画像から新たな所見を「診断」しないでください。ドラフトに書かれている内容の
              言語化・整理・用語の適正化に徹してください。
            - ドラフトに無い病変・計測値・断定的な診断名を追加しないでください。
            - 断定できない箇所は「〜が疑われる」「〜の可能性がある」と表現してください。
            - 所見（Findings）と印象（Impression）を分けてください。

            出力は次の 3 部構成にしてください:
            1. 推敲後の所見
            2. 直した点（箇条書き。なぜ直したかを一言添える）
            3. 書き足すとよい観点（箇条書き。質問の形で）

            これは教育目的の文章演習であり、診断ではありません。
            """;

    private final ObjectMapper mapper = new ObjectMapper();

    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(15))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    @Override
    public Object run(Map<String, Object> args) throws Exception {
        String op = str(args, "op", "refine");
        return switch (op) {
            case "render" -> render(args);
            case "refine" -> refine(args);
            case "defaults" -> Map.of("ok", true, "instruction", DEFAULT_INSTRUCTION);
            default -> fail("未知の op: " + op);
        };
    }

    // ── op:"render" — インスタンスを PNG にする ───────────────────────

    /**
     * 1 インスタンスを読んで PNG(base64) にする。
     *
     * <p>入力: {@code apiOrigin, studyUid, seriesUid, sopUid, maxEdge?}<br>
     * 出力: {@code {ok:true, base64, mimeType, width, height, window:{center,width}}}
     *
     * <p>本体の REST（{@code /api/studies/../instances/{sop}/file}）から Part-10 を取ってくるので、
     * standalone（ローカル保管庫）でも web（PACS へ WADO-RS）でも同じコードで動く。
     */
    private Object render(Map<String, Object> args) {
        String apiOrigin = str(args, "apiOrigin", null);
        String studyUid = str(args, "studyUid", null);
        String seriesUid = str(args, "seriesUid", null);
        String sopUid = str(args, "sopUid", null);
        int maxEdge = clamp(intOf(args, "maxEdge", 768), 64, 2048);

        if (isBlank(apiOrigin) || isBlank(studyUid) || isBlank(seriesUid) || isBlank(sopUid)) {
            return fail("render には apiOrigin / studyUid / seriesUid / sopUid が必要です。");
        }
        // apiOrigin は UI から渡ってくる＝外部入力。任意のホストを取りに行かせない（SSRF 対策）。
        if (!isLoopbackOrigin(apiOrigin)) {
            return fail("apiOrigin はローカルホストのみ許可しています: " + apiOrigin);
        }

        try {
            byte[] dicom = fetchInstance(apiOrigin, studyUid, seriesUid, sopUid);
            if (dicom == null) return fail("インスタンスを取得できませんでした（" + shortUid(sopUid) + "）。");

            Attributes ds;
            try (DicomInputStream in = new DicomInputStream(new ByteArrayInputStream(dicom))) {
                in.setIncludeBulkData(DicomInputStream.IncludeBulkData.YES);
                ds = in.readDataset();
            }
            return toPngResult(ds, maxEdge);
        } catch (Exception e) {
            return fail("レンダリングに失敗しました: " + e);
        }
    }

    /** 本体の REST からインスタンス（Part-10）を取得する。 */
    private byte[] fetchInstance(String apiOrigin, String studyUid, String seriesUid, String sopUid)
            throws Exception {
        String url = apiOrigin
                + "/api/studies/" + enc(studyUid)
                + "/series/" + enc(seriesUid)
                + "/instances/" + enc(sopUid) + "/file";
        HttpRequest req = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(30))
                .GET()
                .build();
        HttpResponse<byte[]> res = http.send(req, HttpResponse.BodyHandlers.ofByteArray());
        if (res.statusCode() != 200) return null;
        byte[] body = res.body();
        return (body == null || body.length == 0) ? null : body;
    }

    /**
     * データセット → 縮小済み PNG(base64)。
     *
     * <p>非圧縮（ネイティブ）画素のみを対象にする。圧縮転送構文は dcm4che のコーデック
     * （opencv 版）が要るため、このデモの範囲外としてエラーを返す。本体側の
     * {@code RadiomicsMapEngine} も同じ割り切りをしている。
     */
    private Object toPngResult(Attributes ds, int maxEdge) throws Exception {
        int rows = ds.getInt(Tag.Rows, 0);
        int cols = ds.getInt(Tag.Columns, 0);
        if (rows <= 0 || cols <= 0) return fail("Rows/Columns がありません。");

        int spp = ds.getInt(Tag.SamplesPerPixel, 1);
        if (spp != 1) return fail("カラー画像（SamplesPerPixel=" + spp + "）はこのデモでは未対応です。");

        byte[] px = ds.getBytes(Tag.PixelData);
        if (px == null) {
            return fail("画素が取り出せませんでした（圧縮転送構文の可能性があります）。"
                    + "このデモは非圧縮（Implicit/Explicit VR Little Endian）のみ対応です。");
        }

        int ba = ds.getInt(Tag.BitsAllocated, 16);
        int bs = ds.getInt(Tag.BitsStored, ba);
        int pr = ds.getInt(Tag.PixelRepresentation, 0);
        double slope = ds.getDouble(Tag.RescaleSlope, 1.0);
        double intercept = ds.getDouble(Tag.RescaleIntercept, 0.0);

        int n = rows * cols;
        float[] v = new float[n];
        if (ba == 16) {
            if (px.length < n * 2) return fail("PixelData が短すぎます。");
            int mask = (bs >= 16) ? 0xFFFF : ((1 << bs) - 1);
            int signBit = 1 << (bs - 1);
            int span = 1 << bs;
            for (int i = 0; i < n; i++) {
                int raw = ((px[2 * i] & 0xFF) | ((px[2 * i + 1] & 0xFF) << 8)) & mask;
                if (pr == 1 && (raw & signBit) != 0) raw -= span; // 符号付き 2 の補数（BitsStored 準拠）
                v[i] = (float) (raw * slope + intercept);
            }
        } else if (ba == 8) {
            if (px.length < n) return fail("PixelData が短すぎます。");
            for (int i = 0; i < n; i++) v[i] = (float) ((px[i] & 0xFF) * slope + intercept);
        } else {
            return fail("BitsAllocated=" + ba + " は未対応です。");
        }

        // VOI（ウィンドウ）。タグが無ければ実データの min/max にフォールバックする。
        double[] wc = ds.getDoubles(Tag.WindowCenter);
        double[] ww = ds.getDoubles(Tag.WindowWidth);
        double center;
        double width;
        if (wc != null && wc.length > 0 && ww != null && ww.length > 0 && ww[0] > 0) {
            center = wc[0];
            width = ww[0];
        } else {
            float min = Float.MAX_VALUE;
            float max = -Float.MAX_VALUE;
            for (float f : v) {
                if (f < min) min = f;
                if (f > max) max = f;
            }
            if (max <= min) max = min + 1;
            center = (min + max) / 2.0;
            width = max - min;
        }

        boolean invert = "MONOCHROME1".equalsIgnoreCase(ds.getString(Tag.PhotometricInterpretation, ""));
        BufferedImage src = new BufferedImage(cols, rows, BufferedImage.TYPE_BYTE_GRAY);
        byte[] out = ((DataBufferByte) src.getRaster().getDataBuffer()).getData();
        double lo = center - width / 2.0;
        for (int i = 0; i < n; i++) {
            int g = (int) Math.round((v[i] - lo) / width * 255.0);
            g = clamp(g, 0, 255);
            out[i] = (byte) (invert ? 255 - g : g);
        }

        BufferedImage img = scaleTo(src, maxEdge);
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        ImageIO.write(img, "png", baos);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("ok", true);
        result.put("base64", Base64.getEncoder().encodeToString(baos.toByteArray()));
        result.put("mimeType", "image/png");
        result.put("width", img.getWidth());
        result.put("height", img.getHeight());
        result.put("window", Map.of("center", center, "width", width));
        return result;
    }

    /** 長辺が maxEdge を超えていれば縮小する（拡大はしない）。 */
    private static BufferedImage scaleTo(BufferedImage src, int maxEdge) {
        int w = src.getWidth();
        int h = src.getHeight();
        double scale = Math.min(1.0, (double) maxEdge / Math.max(w, h));
        if (scale >= 1.0) return src;
        int nw = Math.max(1, (int) Math.round(w * scale));
        int nh = Math.max(1, (int) Math.round(h * scale));
        BufferedImage dst = new BufferedImage(nw, nh, BufferedImage.TYPE_BYTE_GRAY);
        Graphics2D g = dst.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        g.drawImage(src, 0, 0, nw, nh, null);
        g.dispose();
        return dst;
    }

    // ── op:"refine" — Gemini に投げる ────────────────────────────────

    private Object refine(Map<String, Object> args) throws Exception {
        String apiKey = str(args, "apiKey", null);
        String findings = str(args, "findings", null);
        String model = str(args, "model", DEFAULT_MODEL);
        int maxOutputTokens = clamp(intOf(args, "maxOutputTokens", DEFAULT_MAX_OUTPUT_TOKENS), 256, 65536);
        // ユーザーが書き換えた指示があればそれを使う（Gems のような使い勝手にするため）。
        String instruction = str(args, "instruction", DEFAULT_INSTRUCTION);

        if (isBlank(apiKey)) return fail("API キーが指定されていません。");
        if (isBlank(findings)) return fail("所見のドラフトが空です。");

        List<Img> images = imagesOf(args);
        String body = buildRequest(instruction, findings, images, model, maxOutputTokens);

        HttpRequest req = HttpRequest.newBuilder(URI.create(ENDPOINT.formatted(model)))
                .timeout(TIMEOUT)
                .header("Content-Type", "application/json; charset=utf-8")
                // キーはクエリ文字列ではなくヘッダで渡す（URL はログ・プロキシに残りやすいため）。
                .header("x-goog-api-key", apiKey)
                .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                .build();

        HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
        return parseResponse(res.statusCode(), res.body(), model, images.size());
    }

    /** 添付画像 1 枚（base64 と、どの画像かを説明するラベル）。 */
    private record Img(String base64, String mimeType, String label) {}

    /**
     * 引数から添付画像を取り出す。
     * 新形式 {@code images:[{base64,mimeType,label}]} を基本とし、旧形式
     * {@code imageBase64 + mimeType}（単一画像）も受け付ける（互換のため）。
     */
    private List<Img> imagesOf(Map<String, Object> args) {
        List<Img> out = new ArrayList<>();
        Object raw = args == null ? null : args.get("images");
        if (raw instanceof List<?> list) {
            for (Object o : list) {
                if (!(o instanceof Map<?, ?> m)) continue;
                String b64 = asString(m.get("base64"));
                if (isBlank(b64)) continue;
                String mime = asString(m.get("mimeType"));
                String label = asString(m.get("label"));
                out.add(new Img(b64, isBlank(mime) ? "image/png" : mime,
                        isBlank(label) ? "画像" : label));
                if (out.size() >= MAX_IMAGES) break;
            }
        }
        if (out.isEmpty()) {
            String legacy = str(args, "imageBase64", null);
            if (!isBlank(legacy)) {
                out.add(new Img(legacy, str(args, "mimeType", "image/png"), "表示中の画像"));
            }
        }
        return out;
    }

    /**
     * Gemini の generateContent 用の JSON を組み立てる。
     *
     * <pre>
     * {
     *   "contents": [{ "role": "user", "parts": [
     *       { "text": "..." },
     *       { "text": "画像1: CT / PRE LIVER  #23" },
     *       { "inline_data": { "mime_type": "image/png", "data": "&lt;base64&gt;" } },
     *       ...
     *   ]}],
     *   "generationConfig": { "temperature": 0.3, "maxOutputTokens": 8192,
     *                         "thinkingConfig": { "thinkingBudget": 0 } }
     * }
     * </pre>
     *
     * 画像の直前にラベルの text パートを置くのがコツ。こうしないと複数枚を渡したときに
     * 「どれが造影前でどれが造影後か」がモデルに伝わらない。
     */
    private String buildRequest(String instruction, String findings, List<Img> images, String model,
            int maxOutputTokens) throws Exception {
        ObjectNode root = mapper.createObjectNode();

        ArrayNode parts = mapper.createArrayNode();
        parts.addObject().put("text", instruction + "\n\n--- ドラフト ---\n" + findings);

        int i = 1;
        for (Img img : images) {
            parts.addObject().put("text", "画像" + i++ + ": " + img.label());
            ObjectNode inline = parts.addObject().putObject("inline_data");
            inline.put("mime_type", img.mimeType());
            inline.put("data", img.base64());
        }

        ObjectNode content = mapper.createObjectNode();
        content.put("role", "user");
        content.set("parts", parts);
        root.putArray("contents").add(content);

        ObjectNode cfg = root.putObject("generationConfig");
        cfg.put("temperature", 0.3);          // 推敲なので発散させない
        cfg.put("maxOutputTokens", maxOutputTokens);
        applyThinking(cfg, model);

        return mapper.writeValueAsString(root);
    }

    /**
     * 思考（thinking）の設定。
     *
     * <p>Gemini 2.5 系は思考モデルで、<b>思考トークンも maxOutputTokens に含まれる</b>。
     * 既定のままだと思考で枠を使い切り、本文が {@code finishReason=MAX_TOKENS} で途中で切れる。
     * 推敲は「書かれている内容を整えるだけ」で深い推論が要らないので、思考を切ってしまうのが
     * 早くて安く、出力も切れなくなる（無料枠のトークン節約にもなる）。
     *
     * <p>⚠ {@code thinkingBudget:0} を受け付けるのは flash 系だけ。pro 系は思考を無効化できず
     * 400 になるため、pro のときは何も指定せず動的思考のままにする（そのぶん枠を厚めに取る）。
     */
    private static void applyThinking(ObjectNode generationConfig, String model) {
        String m = model == null ? "" : model.toLowerCase(Locale.ROOT);
        if (m.contains("flash")) {
            generationConfig.putObject("thinkingConfig").put("thinkingBudget", 0);
        }
    }

    // ── レスポンス解釈 ──────────────────────────────────────────

    /**
     * 応答を UI が使いやすい形へ畳む。
     *
     * <p>成功: {@code {ok:true, text, model, finishReason, truncated, images, usage}}<br>
     * 失敗: {@code {ok:false, error, status}} — UI 側はこれをそのまま表示すればよい。
     * 例外を投げると 500 になって原因が伝わらないので、想定内の失敗は必ず値で返す。
     */
    private Object parseResponse(int status, String body, String model, int imageCount) throws Exception {
        JsonNode json;
        try {
            json = mapper.readTree(body);
        } catch (Exception e) {
            return fail("応答を JSON として解釈できませんでした（HTTP " + status + "）。", status);
        }

        if (status != 200) {
            JsonNode err = json.path("error");
            String msg = err.path("message").asText("");
            if (msg.isEmpty()) msg = "HTTP " + status;
            // よくある詰まりどころは、そのまま出しても分からないので補足する。
            String hint = switch (status) {
                case 400 -> "（モデル名・リクエスト形式・画像サイズを確認してください）";
                case 401, 403 -> "（API キーが無効、または Generative Language API が有効化されていません）";
                case 404 -> "（モデル名が存在しないか、そのキーで使えません）";
                case 429 -> "（レート制限。無料枠は分あたり・日あたりの上限が低めです。しばらく待って再実行してください）";
                default -> "";
            };
            return fail(msg + hint, status);
        }

        JsonNode candidate = json.path("candidates").path(0);
        StringBuilder sb = new StringBuilder();
        for (JsonNode p : candidate.path("content").path("parts")) {
            String t = p.path("text").asText("");
            if (!t.isEmpty()) sb.append(t);
        }
        String text = sb.toString();
        String reason = candidate.path("finishReason").asText("");
        JsonNode usage = json.path("usageMetadata");
        int thoughts = usage.path("thoughtsTokenCount").asInt(0);

        if (text.isEmpty()) {
            // safety でブロックされた場合や、思考だけで枠を使い切った場合など。
            String blocked = json.path("promptFeedback").path("blockReason").asText("");
            if ("MAX_TOKENS".equals(reason)) {
                return fail("出力トークンの上限に達し、本文が 1 文字も返りませんでした"
                        + (thoughts > 0 ? "（思考に " + thoughts + " トークン使われています）" : "")
                        + "。モデルを flash にするか、上限を上げて再実行してください。", status);
            }
            String why = !blocked.isEmpty() ? "promptFeedback.blockReason=" + blocked
                    : !reason.isEmpty() ? "finishReason=" + reason : "理由不明";
            return fail("本文が返りませんでした（" + why + "）。", status);
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("text", text);
        out.put("model", model);
        out.put("finishReason", reason);
        // 途中で切れたことを UI が明示できるようにする（黙って切れているのが一番まずい）。
        out.put("truncated", "MAX_TOKENS".equals(reason));
        out.put("images", imageCount);
        if (!usage.isMissingNode()) {
            Map<String, Object> u = new LinkedHashMap<>();
            u.put("promptTokens", usage.path("promptTokenCount").asInt(0));
            u.put("outputTokens", usage.path("candidatesTokenCount").asInt(0));
            u.put("thoughtsTokens", thoughts);
            u.put("totalTokens", usage.path("totalTokenCount").asInt(0));
            out.put("usage", u);
        }
        return out;
    }

    // ── 小物 ────────────────────────────────────────────────────

    private static Map<String, Object> fail(String message) {
        return fail(message, 0);
    }

    private static Map<String, Object> fail(String message, int status) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", false);
        out.put("error", message);
        out.put("status", status);
        return out;
    }

    /** args は JSON 由来なので値の型は保証されない。文字列以外は既定値に落とす。 */
    private static String str(Map<String, Object> args, String key, String fallback) {
        if (args == null) return fallback;
        Object v = args.get(key);
        if (v instanceof String s && !s.isBlank()) return s;
        return fallback;
    }

    private static int intOf(Map<String, Object> args, String key, int fallback) {
        if (args == null) return fallback;
        Object v = args.get(key);
        if (v instanceof Number n) return n.intValue();
        if (v instanceof String s) {
            try {
                return Integer.parseInt(s.trim());
            } catch (NumberFormatException ignored) {
                return fallback;
            }
        }
        return fallback;
    }

    private static String asString(Object v) {
        return v instanceof String s ? s : null;
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }

    private static int clamp(int v, int lo, int hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    private static String enc(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }

    private static String shortUid(String uid) {
        if (uid == null) return "(unknown)";
        return uid.length() <= 18 ? uid : "…" + uid.substring(uid.length() - 16);
    }

    /** {@code http://localhost:8080} 等のループバックだけを許可する。 */
    private static boolean isLoopbackOrigin(String origin) {
        try {
            URI u = URI.create(origin);
            String host = u.getHost();
            if (host == null) return false;
            String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
            if (!scheme.equals("http") && !scheme.equals("https")) return false;
            return host.equals("localhost") || host.equals("127.0.0.1") || host.equals("[::1]");
        } catch (Exception e) {
            return false;
        }
    }
}
