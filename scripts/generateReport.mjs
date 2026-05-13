import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const API_BASE = process.env.ZHIPU_API_BASE || "https://open.bigmodel.cn/api/coding/paas/v4";
const MAX_TOKENS = parseInt(process.env.ZHIPU_MAX_TOKENS || "50000", 10);
const TIMEOUT_MS = parseInt(process.env.ZHIPU_TIMEOUT_MS || "480000", 10);
const MODELS = ["GLM-5-Turbo", "glm-4.7", "glm-4.7-flash"];

const SYSTEM_PROMPT = `你是人格心理學與精神醫學領域的資深研究員，專精自戀型人格疾患（Narcissistic Personality Disorder, NPD）研究。

你的任務是：
1. 從提供的醫學與心理學文獻中，篩選出最具臨床意義與研究價值的 NPD / 自戀相關論文
2. 對每篇論文進行繁體中文摘要、分類、PICO 分析
3. 評估其臨床實用性（高/中/低）
4. 生成適合醫療專業人員與心理健康工作者閱讀的日報

輸出格式要求：
- 語言：繁體中文（台灣用語）
- 專業但易懂
- 每篇論文需包含：中文標題、一句話總結、PICO分析、臨床實用性、分類標籤
- 最後提供今日精選 TOP 3（最重要/最影響臨床實踐的論文）
- 回傳格式必須是純 JSON，不要用 markdown code block 包裹`;

const NPD_TAGS = [
  "自戀型人格疾患", "病態自戀", "誇大自戀", "脆弱自戀", "隱性自戀",
  "暗黑三角", "暗黑四角", "同理心缺損", "自我膨脹", "羞恥感",
  "心理治療", "移情焦點治療", "心智化治療", "基模治療",
  "神經科學", "fMRI", "預設模式網路", "自我參照",
  "依附關係", "童年創傷", "發展起源",
  "親密伴侶暴力", "強制控制", "心理虐待",
  "社群媒體", "自拍文化", "網路自我呈現",
  "職場自戀", "CEO 自戀", "破壞性領導",
  "評估量表", "NPI", "PNI", "NARQ",
  "鑑別診断", "邊緣型人格", "反社會人格", "戲劇型人格",
  "流行病學", "盛行率", "共病",
];

function getDateStr() {
  return process.env.TARGET_DATE || new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function loadPapers() {
  const path = resolve(ROOT, "papers.json");
  return JSON.parse(readFileSync(path, "utf-8"));
}

function loadSummarizedPmids() {
  const path = resolve(ROOT, "docs", "summarized_pmids.json");
  if (!existsSync(path)) return new Set();
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    return new Set(Array.isArray(data.pmids) ? data.pmids : []);
  } catch {
    return new Set();
  }
}

function saveSummarizedPmids(existing, newPmids) {
  const all = [...new Set([...existing, ...newPmids])].slice(-2000);
  const path = resolve(ROOT, "docs", "summarized_pmids.json");
  mkdirSync(resolve(ROOT, "docs"), { recursive: true });
  writeFileSync(path, JSON.stringify({ updated: getDateStr(), count: all.length, pmids: all }, null, 2));
}

function cleanJsonResponse(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.includes("\n") ? cleaned.split("\n").slice(1).join("\n") : cleaned.slice(3);
    cleaned = cleaned.replace(/```+$/g, "").trim();
  }
  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    cleaned = cleaned.slice(jsonStart, jsonEnd + 1);
  }
  return cleaned;
}

function safeJsonParse(text) {
  const cleaned = cleanJsonResponse(text);
  try {
    return JSON.parse(cleaned);
  } catch (e1) {
    console.error(`[WARN] JSON parse attempt 1 failed: ${e1.message}`);
    try {
      const fixed = cleaned
        .replace(/,\s*([}\]])/g, "$1")
        .replace(/\\(?!["\\/bfnrtu])/g, "\\\\")
        .replace(/[\x00-\x1f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
      return JSON.parse(fixed);
    } catch (e2) {
      console.error(`[WARN] JSON parse attempt 2 failed: ${e2.message}`);
      try {
        const aggressiveFixed = cleaned
          .replace(/\\n/g, " ")
          .replace(/\\r/g, "")
          .replace(/\\t/g, " ")
          .replace(/'/g, '"')
          .replace(/,\s*([}\]])/g, "$1");
        return JSON.parse(aggressiveFixed);
      } catch (e3) {
        console.error(`[ERROR] All JSON parse attempts failed: ${e3.message}`);
        console.error(`[DEBUG] First 500 chars: ${cleaned.slice(0, 500)}`);
        return null;
      }
    }
  }
}

async function callZhipuAPI(apiKey, papersData) {
  const dateStr = papersData.date || getDateStr();
  const paperCount = papersData.count || 0;
  const papersText = JSON.stringify(papersData.papers || [], null, 2);

  const prompt = `以下是 ${dateStr} 從 PubMed 抓取的最新自戀型人格疾患（NPD）與自戀相關文獻（共 ${paperCount} 篇）。

請進行以下分析，並以 JSON 格式回傳（不要用 markdown code block）：

{
  "date": "${dateStr}",
  "market_summary": "1-2句話總結今天文獻的整體趨勢與亮點，聚焦於 NPD 與自戀研究",
  "top_picks": [
    {
      "rank": 1,
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話總結（繁體中文，點出核心發現與臨床意義）",
      "pico": {
        "population": "研究對象",
        "intervention": "介入措施或研究變項",
        "comparison": "對照組或比較基準",
        "outcome": "主要結果"
      },
      "clinical_utility": "高/中/低",
      "utility_reason": "為什麼實用的一句話說明",
      "tags": ["標籤1", "標籤2"],
      "url": "原文連結",
      "emoji": "相關emoji"
    }
  ],
  "all_papers": [
    {
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話總結",
      "clinical_utility": "高/中/低",
      "tags": ["標籤1"],
      "url": "連結",
      "emoji": "emoji"
    }
  ],
  "keywords": ["關鍵字1", "關鍵字2"],
  "topic_distribution": {
    "自戀型人格疾患": 3,
    "誇大自戀": 2
  }
}

原始文獻資料：
${papersText}

請篩選出最重要的 TOP 5-8 篇論文放入 top_picks（按重要性排序），其餘放入 all_papers。
每篇 paper 的 tags 請從以下選擇：${NPD_TAGS.join("、")}。
記住：回傳純 JSON，不要用 \`\`\`json\`\`\` 包裹。`;

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  for (const model of MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        console.error(`[INFO] Trying ${model} (attempt ${attempt + 1})...`);
        const resp = await fetch(`${API_BASE}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: prompt },
            ],
            temperature: 0.3,
            top_p: 0.9,
            max_tokens: MAX_TOKENS,
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        if (resp.status === 429) {
          const wait = 60000 * (attempt + 1);
          console.error(`[WARN] Rate limited, waiting ${wait / 1000}s...`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }

        if (!resp.ok) {
          const errText = await resp.text().catch(() => "");
          console.error(`[ERROR] HTTP ${resp.status}: ${errText.slice(0, 200)}`);
          if (resp.status >= 500) continue;
          break;
        }

        const data = await resp.json();
        const text = data?.choices?.[0]?.message?.content || "";
        if (!text) {
          console.error(`[WARN] Empty response from ${model}`);
          continue;
        }

        const result = safeJsonParse(text);
        if (!result) {
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 5000));
            continue;
          }
          break;
        }

        console.error(`[INFO] Analysis complete: ${result.top_picks?.length || 0} top picks, ${(result.all_papers || []).length} total`);
        return result;
      } catch (err) {
        console.error(`[ERROR] ${model} attempt ${attempt + 1} failed: ${err.message}`);
        if (attempt < 2) await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  console.error("[ERROR] All models and attempts failed");
  return null;
}

function generateHtml(analysis) {
  const dateStr = analysis.date || getDateStr();
  const parts = dateStr.split("-");
  const dateDisplay = parts.length === 3 ? `${parts[0]}年${parseInt(parts[1])}月${parseInt(parts[2])}日` : dateStr;
  const summary = analysis.market_summary || "";
  const topPicks = analysis.top_picks || [];
  const allPapers = analysis.all_papers || [];
  const keywords = analysis.keywords || [];
  const topicDist = analysis.topic_distribution || {};

  const topPicksHtml = topPicks.map((p) => {
    const utilityClass = p.clinical_utility === "高" ? "utility-high" : p.clinical_utility === "中" ? "utility-mid" : "utility-low";
    const tags = (p.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
    return `<div class="news-card featured">
  <div class="card-header">
    <span class="rank-badge">#${p.rank || ""}</span>
    <span class="emoji-icon">${p.emoji || "📄"}</span>
    <span class="journal-source">${esc(p.journal || "")}</span>
  </div>
  <h3>${esc(p.title_zh || p.title_en || "")}</h3>
  <p class="title-en">${esc(p.title_en || "")}</p>
  <p>${esc(p.summary || "")}</p>
  ${p.pico ? `<div class="pico-grid">
    <div class="pico-item"><span class="pico-label">P</span><span class="pico-text">${esc(p.pico.population || "")}</span></div>
    <div class="pico-item"><span class="pico-label">I</span><span class="pico-text">${esc(p.pico.intervention || "")}</span></div>
    <div class="pico-item"><span class="pico-label">C</span><span class="pico-text">${esc(p.pico.comparison || "")}</span></div>
    <div class="pico-item"><span class="pico-label">O</span><span class="pico-text">${esc(p.pico.outcome || "")}</span></div>
  </div>` : ""}
  <div class="card-footer">
    ${tags}
    <span class="${utilityClass}">臨床實用性：${esc(p.clinical_utility || "中")}</span>
    ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">PubMed →</a>` : ""}
  </div>
  ${p.utility_reason ? `<p class="utility-reason">💡 ${esc(p.utility_reason)}</p>` : ""}
</div>`;
  }).join("\n");

  const allPapersHtml = allPapers.map((p) => {
    const utilityClass = p.clinical_utility === "高" ? "utility-high" : p.clinical_utility === "中" ? "utility-mid" : "utility-low";
    const tags = (p.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
    return `<div class="news-card">
  <div class="card-header-row">
    <span class="emoji-sm">${p.emoji || "📄"}</span>
    <span class="journal-source">${esc(p.journal || "")}</span>
    <span class="${utilityClass} utility-sm">${esc(p.clinical_utility || "中")}</span>
  </div>
  <h3>${esc(p.title_zh || p.title_en || "")}</h3>
  <p>${esc(p.summary || "")}</p>
  <div class="card-footer">
    ${tags}
    ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">PubMed →</a>` : ""}
  </div>
</div>`;
  }).join("\n");

  const keywordsHtml = keywords.map((k) => `<span class="keyword">${esc(k)}</span>`).join("\n");

  const topicEntries = Object.entries(topicDist).sort((a, b) => b[1] - a[1]);
  const maxTopic = Math.max(...topicEntries.map(([, v]) => v), 1);
  const topicHtml = topicEntries.map(([name, count]) => {
    const pct = Math.round((count / maxTopic) * 100);
    return `<div class="topic-row">
  <span class="topic-name">${esc(name)}</span>
  <div class="topic-bar-bg"><div class="topic-bar" style="width:${pct}%"></div></div>
  <span class="topic-count">${count}</span>
</div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>NPD 文獻日報 · ${dateDisplay}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
:root{--bg:#f6f1e8;--surface:#fffaf2;--line:#d8c5ab;--text:#2b2118;--muted:#766453;--accent:#8c4f2b;--accent-soft:#ead2bf;--card-bg:color-mix(in srgb,var(--surface) 92%,white)}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:radial-gradient(circle at top,#fff6ea 0,var(--bg) 55%,#ead8c6 100%);color:var(--text);font-family:"Noto Sans TC","PingFang TC","Helvetica Neue",Arial,sans-serif;min-height:100vh;overflow-x:hidden}
.container{position:relative;z-index:1;max-width:880px;margin:0 auto;padding:60px 32px 80px}
header{display:flex;align-items:center;gap:16px;margin-bottom:52px;animation:fadeDown .6s ease both}
.logo{width:48px;height:48px;border-radius:14px;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;box-shadow:0 4px 20px rgba(140,79,43,.25)}
.header-text h1{font-size:22px;font-weight:700;color:var(--text);letter-spacing:-.3px}
.header-meta{display:flex;gap:8px;margin-top:6px;flex-wrap:wrap;align-items:center}
.badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;letter-spacing:.3px}
.badge-date{background:var(--accent-soft);border:1px solid var(--line);color:var(--accent)}
.badge-count{background:rgba(140,79,43,.06);border:1px solid var(--line);color:var(--muted)}
.badge-source{background:transparent;color:var(--muted);font-size:11px;padding:0 4px}
.summary-card{background:var(--card-bg);border:1px solid var(--line);border-radius:24px;padding:28px 32px;margin-bottom:32px;box-shadow:0 20px 60px rgba(61,36,15,.06);animation:fadeUp .5s ease .1s both}
.summary-card h2{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.6px;color:var(--accent);margin-bottom:16px}
.summary-text{font-size:15px;line-height:1.8;color:var(--text)}
.section{margin-bottom:36px;animation:fadeUp .5s ease both}
.section-title{display:flex;align-items:center;gap:10px;font-size:17px;font-weight:700;color:var(--text);margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--line)}
.section-icon{width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;background:var(--accent-soft)}
.news-card{background:var(--card-bg);border:1px solid var(--line);border-radius:24px;padding:22px 26px;margin-bottom:12px;box-shadow:0 8px 30px rgba(61,36,15,.04);transition:background .2s,border-color .2s,transform .2s}
.news-card:hover{transform:translateY(-2px);box-shadow:0 12px 40px rgba(61,36,15,.08)}
.news-card.featured{border-left:3px solid var(--accent)}
.news-card.featured:hover{border-color:var(--accent)}
.card-header{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.rank-badge{background:var(--accent);color:#fff7f0;font-weight:700;font-size:12px;padding:2px 8px;border-radius:6px}
.emoji-icon{font-size:18px}
.card-header-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.emoji-sm{font-size:14px}
.news-card h3{font-size:15px;font-weight:600;color:var(--text);margin-bottom:8px;line-height:1.5}
.title-en{font-size:12px;color:var(--muted);margin-bottom:8px;font-style:italic;opacity:.7}
.journal-source{font-size:12px;color:var(--accent);margin-bottom:8px;opacity:.8}
.news-card p{font-size:13.5px;line-height:1.75;color:var(--muted)}
.card-footer{margin-top:12px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.tag{padding:2px 9px;background:var(--accent-soft);border-radius:999px;font-size:11px;color:var(--accent)}
.news-card a{font-size:12px;color:var(--accent);text-decoration:none;opacity:.7;margin-left:auto}
.news-card a:hover{opacity:1}
.utility-high{color:#5a7a3a;font-size:11px;font-weight:600;padding:2px 8px;background:rgba(90,122,58,.1);border-radius:4px}
.utility-mid{color:#9f7a2e;font-size:11px;font-weight:600;padding:2px 8px;background:rgba(159,122,46,.1);border-radius:4px}
.utility-low{color:var(--muted);font-size:11px;font-weight:600;padding:2px 8px;background:rgba(118,100,83,.08);border-radius:4px}
.utility-sm{font-size:10px}
.utility-reason{margin-top:10px;font-size:12.5px;color:var(--accent);opacity:.85;font-style:italic}
.pico-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px;padding:12px;background:rgba(255,253,249,.8);border-radius:14px;border:1px solid var(--line)}
.pico-item{display:flex;gap:8px;align-items:baseline}
.pico-label{font-size:10px;font-weight:700;color:#fff7f0;background:var(--accent);padding:2px 6px;border-radius:4px;flex-shrink:0}
.pico-text{font-size:12px;color:var(--muted);line-height:1.4}
.keywords-section{margin-bottom:36px}
.keywords{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.keyword{padding:5px 14px;background:var(--accent-soft);border:1px solid var(--line);border-radius:20px;font-size:12px;color:var(--accent);cursor:default;transition:background .2s}
.keyword:hover{background:rgba(140,79,43,.18)}
.topic-section{margin-bottom:36px}
.topic-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.topic-name{font-size:13px;color:var(--muted);width:120px;flex-shrink:0;text-align:right}
.topic-bar-bg{flex:1;height:8px;background:var(--line);border-radius:4px;overflow:hidden}
.topic-bar{height:100%;background:linear-gradient(90deg,var(--accent),#c47a4a);border-radius:4px;transition:width .6s ease}
.topic-count{font-size:12px;color:var(--accent);width:24px}
.clinic-banner{margin-top:48px;animation:fadeUp .5s ease .4s both}
.clinic-links{display:flex;flex-direction:column;gap:10px}
.clinic-link{display:flex;align-items:center;gap:14px;padding:18px 24px;background:var(--card-bg);border:1px solid var(--line);border-radius:24px;text-decoration:none;color:var(--text);transition:all .2s;box-shadow:0 8px 30px rgba(61,36,15,.04)}
.clinic-link:hover{border-color:var(--accent);transform:translateY(-2px);box-shadow:0 12px 40px rgba(61,36,15,.08)}
.clinic-icon{font-size:28px;flex-shrink:0}
.clinic-info{flex:1}
.clinic-name{font-size:15px;font-weight:700;color:var(--text)}
.clinic-desc{font-size:12px;color:var(--muted);margin-top:2px}
.clinic-arrow{font-size:18px;color:var(--accent);font-weight:700}
footer{margin-top:32px;padding-top:22px;border-top:1px solid var(--line);font-size:11.5px;color:var(--muted);display:flex;justify-content:space-between;animation:fadeUp .5s ease .5s both}
footer a{color:var(--muted);text-decoration:none}
footer a:hover{color:var(--accent)}
@keyframes fadeDown{from{opacity:0;transform:translateY(-16px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
@media(max-width:600px){.container{padding:36px 18px 60px}.summary-card,.news-card{padding:20px 18px}.pico-grid{grid-template-columns:1fr}footer{flex-direction:column;gap:6px;text-align:center}.topic-name{width:80px;font-size:11px}.clinic-links{gap:8px}}
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo">🪞</div>
    <div class="header-text">
      <h1>NPD 文獻日報</h1>
      <div class="header-meta">
        <span class="badge badge-date">${dateDisplay}</span>
        <span class="badge badge-count">📊 ${topPicks.length + allPapers.length} 篇文獻</span>
        <span class="badge badge-source">PubMed · Zhipu AI</span>
      </div>
    </div>
  </header>

  <div class="summary-card">
    <h2>📋 今日總覽</h2>
    <p class="summary-text">${esc(summary)}</p>
  </div>

  ${topPicks.length > 0 ? `<div class="section" style="animation-delay:.2s">
    <div class="section-title"><span class="section-icon">🏆</span>今日精選 TOP ${topPicks.length}</div>
    ${topPicksHtml}
  </div>` : ""}

  ${allPapers.length > 0 ? `<div class="section" style="animation-delay:.3s">
    <div class="section-title"><span class="section-icon">📚</span>其他文獻</div>
    ${allPapersHtml}
  </div>` : ""}

  ${topicEntries.length > 0 ? `<div class="topic-section section" style="animation-delay:.35s">
    <div class="section-title"><span class="section-icon">📊</span>主題分布</div>
    ${topicHtml}
  </div>` : ""}

  ${keywords.length > 0 ? `<div class="keywords-section section" style="animation-delay:.4s">
    <div class="section-title"><span class="section-icon">🏷️</span>關鍵字</div>
    <div class="keywords">${keywordsHtml}</div>
  </div>` : ""}

  <div class="clinic-banner">
    <div class="section-title"><span class="section-icon">🏥</span>相關資源</div>
    <div class="clinic-links">
      <a class="clinic-link" href="https://www.leepsyclinic.com/" target="_blank" rel="noopener">
        <span class="clinic-icon">🏥</span>
        <div class="clinic-info">
          <div class="clinic-name">李政洋身心診所</div>
          <div class="clinic-desc">專業身心科門診 · 台北</div>
        </div>
        <span class="clinic-arrow">→</span>
      </a>
      <a class="clinic-link" href="https://blog.leepsyclinic.com/" target="_blank" rel="noopener">
        <span class="clinic-icon">📬</span>
        <div class="clinic-info">
          <div class="clinic-name">訂閱電子報</div>
          <div class="clinic-desc">接收最新心理健康資訊</div>
        </div>
        <span class="clinic-arrow">→</span>
      </a>
      <a class="clinic-link" href="https://buymeacoffee.com/CYlee" target="_blank" rel="noopener">
        <span class="clinic-icon">☕</span>
        <div class="clinic-info">
          <div class="clinic-name">Buy Me a Coffee</div>
          <div class="clinic-desc">支持我們持續產出優質內容</div>
        </div>
        <span class="clinic-arrow">→</span>
      </a>
    </div>
  </div>

  <footer>
    <span>Powered by PubMed + Zhipu AI · <a href="https://github.com/u8901006/narcissitic-personality-disorder">GitHub</a></span>
    <span>NPD Research Daily Report</span>
  </footer>
</div>
</body>
</html>`;
}

function esc(s) {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function main() {
  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) {
    console.error("[ERROR] ZHIPU_API_KEY not set");
    process.exit(1);
  }

  const dateStr = getDateStr();
  const papersData = loadPapers();
  const summarized = loadSummarizedPmids();

  let analysis;
  if (!papersData.papers || papersData.papers.length === 0) {
    console.error("[WARN] No papers found, generating empty report");
    analysis = {
      date: dateStr,
      market_summary: "今日 PubMed 暫無新的自戀型人格疾患相關文獻更新。請明天再查看。",
      top_picks: [],
      all_papers: [],
      keywords: [],
      topic_distribution: {},
    };
  } else {
    analysis = await callZhipuAPI(apiKey, papersData);
    if (!analysis) {
      console.error("[ERROR] Analysis failed");
      process.exit(1);
    }
  }

  const html = generateHtml(analysis);
  const outputPath = resolve(ROOT, "docs", `npd-${dateStr}.html`);
  mkdirSync(resolve(ROOT, "docs"), { recursive: true });
  writeFileSync(outputPath, html, "utf-8");
  console.error(`[INFO] Report saved to ${outputPath}`);

  const newPmids = papersData.papers.map((p) => p.pmid).filter(Boolean);
  saveSummarizedPmids(summarized, newPmids);
  console.error(`[INFO] Updated summarized_pmids.json (+${newPmids.length} PMIDs)`);
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
