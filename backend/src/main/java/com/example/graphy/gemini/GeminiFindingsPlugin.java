package com.example.graphy.gemini;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.vis.graphynext.plugin.spi.GraphyPlugin;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * GRAPHY-Next プラグイン「Gemini 所見推敲」のバックエンド面。
 *
 * <p>UI（ui.js）から {@code host.runBackend(payload)}（＝{@code POST /api/plugins/{id}/run}）で
 * 呼ばれ、Google の Gemini API に「人が書いた粗い所見ドラフト」＋「表示中の画像」を渡して、
 * 読影レポートとして通用する日本語へ推敲させる。戻り値は JSON 化されて UI に返る。
 *
 * <h2>なぜ Java 側で呼ぶのか</h2>
 * 配布版 GRAPHY-Next のレンダラには CSP
 * {@code connect-src 'self' http://localhost:* http://127.0.0.1:*} が効いており、
 * {@code ui.js} から外部 API を fetch するとブロックされる。外部 API を叩く処理は
 * バックエンド面（この JAR）に置くのが唯一の方法。
 *
 * <h2>依存について</h2>
 * <ul>
 *   <li>{@code graphy-plugin-api}（SPI）… ランタイムは GRAPHY-Next が供給するので {@code provided}。</li>
 *   <li>Jackson … プラグイン JAR は<b>親クラスローダ付き</b>でロードされるため、backend の依存が
 *       実行時に見える。よって {@code provided} で参照でき、JAR に同梱しなくてよい。
 *       ただし<b>本体の版が上がると壊れうる</b>ことは織り込むこと。</li>
 * </ul>
 *
 * <h2>API キーの扱い</h2>
 * キーは呼び出しごとに UI から渡され、<b>このクラスはどこにも保存しない</b>（ログにも出さない）。
 * 保存しているのはブラウザの localStorage（UI 側）だけで、平文である。個人のデスクトップ利用を
 * 前提とした割り切りであり、共有端末では「保存しない」を選ぶこと。
 *
 * <h2>これは診断ではない</h2>
 * プロンプトは「ドラフトに書かれている内容の言語化・整理」に限定しており、画像から新しい所見を
 * 診断させない。教育・執筆練習のためのサンプルである。
 */
public class GeminiFindingsPlugin implements GraphyPlugin {

    /** Gemini の REST エンドポイント（モデル名は呼び出し時に差し込む）。 */
    private static final String ENDPOINT =
            "https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent";

    private static final String DEFAULT_MODEL = "gemini-2.5-flash";

    /** 画像を添付するので少し長めに待つ。 */
    private static final Duration TIMEOUT = Duration.ofSeconds(90);

    /**
     * 推敲の指示。画像から新しい所見を「診断」させないことを最優先の制約にしている。
     * 出力を 3 部構成にしているのは、推敲結果だけでなく「なぜ直したか」を学べるようにするため。
     */
    private static final String INSTRUCTION = """
            あなたは放射線診断レポートの日本語校閲者です。
            以下は、練習のために書かれた粗い所見のドラフトです。添付画像とドラフトを踏まえ、
            読影レポートとして通用する日本語に推敲してください。

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
        String apiKey = str(args, "apiKey", null);
        String findings = str(args, "findings", null);
        String model = str(args, "model", DEFAULT_MODEL);
        String imageBase64 = str(args, "imageBase64", null);
        String mimeType = str(args, "mimeType", "image/png");

        if (isBlank(apiKey)) return fail("API キーが指定されていません。");
        if (isBlank(findings)) return fail("所見のドラフトが空です。");

        String body = buildRequest(findings, imageBase64, mimeType);

        HttpRequest req = HttpRequest.newBuilder(URI.create(ENDPOINT.formatted(model)))
                .timeout(TIMEOUT)
                .header("Content-Type", "application/json; charset=utf-8")
                // キーはクエリ文字列ではなくヘッダで渡す（URL はログ・プロキシに残りやすいため）。
                .header("x-goog-api-key", apiKey)
                .POST(HttpRequest.BodyPublishers.ofString(body, java.nio.charset.StandardCharsets.UTF_8))
                .build();

        HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
        return parseResponse(res.statusCode(), res.body(), model);
    }

    // ── リクエスト組み立て ────────────────────────────────────────

    /**
     * Gemini の generateContent 用の JSON を組み立てる。
     *
     * <pre>
     * {
     *   "contents": [{ "role": "user", "parts": [
     *       { "text": "..." },
     *       { "inline_data": { "mime_type": "image/png", "data": "&lt;base64&gt;" } }
     *   ]}],
     *   "generationConfig": { "temperature": 0.3, "maxOutputTokens": 2048 }
     * }
     * </pre>
     *
     * 画像が無ければ text パートだけになる（画像なしでも推敲は成立する）。
     */
    private String buildRequest(String findings, String imageBase64, String mimeType) throws Exception {
        ObjectNode root = mapper.createObjectNode();

        ArrayNode parts = mapper.createArrayNode();
        parts.addObject().put("text", INSTRUCTION + "\n\n--- ドラフト ---\n" + findings);

        if (!isBlank(imageBase64)) {
            ObjectNode inline = parts.addObject().putObject("inline_data");
            inline.put("mime_type", mimeType);
            inline.put("data", imageBase64);
        }

        ObjectNode content = mapper.createObjectNode();
        content.put("role", "user");
        content.set("parts", parts);
        root.putArray("contents").add(content);

        ObjectNode cfg = root.putObject("generationConfig");
        cfg.put("temperature", 0.3);          // 推敲なので発散させない
        cfg.put("maxOutputTokens", 2048);

        return mapper.writeValueAsString(root);
    }

    // ── レスポンス解釈 ──────────────────────────────────────────

    /**
     * 応答を UI が使いやすい形へ畳む。
     *
     * <p>成功: {@code {ok:true, text, model, finishReason, usage}}<br>
     * 失敗: {@code {ok:false, error, status}} — UI 側はこれをそのまま表示すればよい。
     * 例外を投げると 500 になって原因が伝わらないので、想定内の失敗は必ず値で返す。
     */
    private Object parseResponse(int status, String body, String model) throws Exception {
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
                case 429 -> "（レート制限。しばらく待って再実行してください）";
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

        if (text.isEmpty()) {
            // safety でブロックされた場合など。理由を返さないと利用者が途方に暮れる。
            String reason = candidate.path("finishReason").asText("");
            String blocked = json.path("promptFeedback").path("blockReason").asText("");
            String why = !blocked.isEmpty() ? "promptFeedback.blockReason=" + blocked
                    : !reason.isEmpty() ? "finishReason=" + reason : "理由不明";
            return fail("本文が返りませんでした（" + why + "）。", status);
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("text", text);
        out.put("model", model);
        out.put("finishReason", candidate.path("finishReason").asText(""));
        JsonNode usage = json.path("usageMetadata");
        if (!usage.isMissingNode()) {
            Map<String, Object> u = new LinkedHashMap<>();
            u.put("promptTokens", usage.path("promptTokenCount").asInt(0));
            u.put("outputTokens", usage.path("candidatesTokenCount").asInt(0));
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

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }
}
