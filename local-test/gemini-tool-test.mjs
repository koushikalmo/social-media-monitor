// validates Gemini API can emit a structured tool call for our plugin's
// youtube_post_status_report tool. read-only: makes one Gemini call, prints
// the decoded result. does NOT scrape YouTube and does NOT post to Telegram.
//
// usage (env loaded by run.sh/run.bat, or set manually):
//   GEMINI_API_KEY=AIza... node local-test/gemini-tool-test.mjs

import fs from "node:fs";
import path from "node:path";

const ENV_FILE = path.join(process.cwd(), "local-test", ".env");
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey || apiKey.startsWith("AIza-replace")) {
  console.error("GEMINI_API_KEY not set. fill it in local-test/.env first.");
  process.exit(1);
}

const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";
const URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

const requestBody = {
  contents: [
    {
      role: "user",
      parts: [
        {
          text: `Run the periodic 3-hour YouTube status check for channel ${process.env.YT_CHANNEL ?? "@eagle3dstreaming"}. Call the youtube_post_status_report tool with maxVideos=5. Do not respond with text — call the tool.`,
        },
      ],
    },
  ],
  tools: [
    {
      functionDeclarations: [
        {
          name: "youtube_post_status_report",
          description:
            "Scrape a YouTube channel, diff against the last run, format a Telegram-ready status message, post it. Call exactly once per cron run.",
          parameters: {
            type: "OBJECT",
            properties: {
              channel: { type: "STRING", description: "Channel ID UCxxxxxx or @handle" },
              maxVideos: { type: "INTEGER", description: "How many recent videos to track" },
            },
            required: ["channel"],
          },
        },
      ],
    },
  ],
  toolConfig: {
    functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["youtube_post_status_report"] },
  },
};

console.log(`[gemini-test] model=${MODEL}`);
console.log(`[gemini-test] POST ${URL.replace(apiKey, "***")}`);
const t0 = Date.now();
const res = await fetch(URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(requestBody),
});
const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

if (!res.ok) {
  const errText = await res.text().catch(() => "");
  console.error(`[gemini-test] FAILED ${res.status}: ${errText.slice(0, 500)}`);
  process.exit(1);
}

const json = await res.json();
const parts = json.candidates?.[0]?.content?.parts ?? [];
const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
const text = parts.filter((p) => p.text).map((p) => p.text).join("");

console.log(`[gemini-test] response in ${elapsed}s`);
if (calls.length > 0) {
  for (const c of calls) {
    console.log(`[gemini-test] ✓ structured tool call: ${c.name}(${JSON.stringify(c.args)})`);
  }
  console.log("[gemini-test] Gemini can drive this plugin's agent path correctly.");
} else if (text) {
  console.log(`[gemini-test] ✗ no tool call — model emitted text instead:`);
  console.log(`  "${text.slice(0, 300)}"`);
  console.log("[gemini-test] would NOT work as a cron driver. troubleshoot the prompt or model.");
  process.exit(2);
} else {
  console.log("[gemini-test] ✗ empty response. unexpected.");
  console.log(JSON.stringify(json, null, 2).slice(0, 1000));
  process.exit(3);
}
