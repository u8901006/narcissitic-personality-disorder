import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const PUBMED_SEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const PUBMED_FETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";

const SEARCH_QUERIES = [
  '(("Narcissistic Personality Disorder"[Mesh] OR "narcissistic personality disorder"[tiab] OR "pathological narcissism"[tiab] OR "malignant narcissism"[tiab] OR "narcissistic pathology"[tiab] OR (NPD[tiab] AND narciss*[tiab])))',
  '(("Personality Disorders"[Mesh] OR "personality disorder*"[tiab] OR "cluster B"[tiab]) AND narciss*[tiab])',
  '(narcissis*[tiab] AND ("grandiose narcissism"[tiab] OR "vulnerable narcissism"[tiab] OR "covert narcissism"[tiab] OR "communal narcissism"[tiab] OR "collective narcissism"[tiab] OR "narcissistic admiration"[tiab] OR "narcissistic rivalry"[tiab]))',
  '("Dark Triad"[tiab] OR "Dark Tetrad"[tiab] OR "narcissistic abuse"[tiab])',
  '(narcissis*[tiab] AND ("Narcissistic Personality Inventory"[tiab] OR NPI[tiab] OR "Pathological Narcissism Inventory"[tiab] OR PNI[tiab] OR NARQ[tiab] OR FFNI[tiab] OR HSNS[tiab] OR PID-5[tiab]))',
  '(("narcissistic personality disorder"[tiab] OR "pathological narcissism"[tiab]) AND (psychotherap*[tiab] OR "schema therapy"[tiab] OR "transference-focused psychotherapy"[tiab] OR mentalization[tiab] OR "therapeutic alliance"[tiab] OR countertransference[tiab]))',
  '(narcissis*[tiab] AND (empathy[tiab] OR mentaliz*[tiab] OR "theory of mind"[tiab] OR fMRI[tiab] OR EEG[tiab] OR "default mode network"[tiab] OR "medial prefrontal cortex"[tiab] OR "self-referential"[tiab]))',
  '(narcissis*[tiab] AND (parent*[tiab] OR attachment[tiab] OR "childhood maltreatment"[tiab] OR "adverse childhood experiences"[tiab] OR adolescent*[tiab] OR longitudinal[tiab] OR "self-esteem"[tiab] OR shame[tiab]))',
  '(narcissis*[tiab] AND ("intimate partner violence"[tiab] OR "coercive control"[tiab] OR "psychological abuse"[tiab] OR "emotional abuse"[tiab] OR aggression[tiab] OR stalking[tiab] OR "relationship satisfaction"[tiab]))',
  '(narcissis*[tiab] AND ("social media"[tiab] OR Instagram[tiab] OR TikTok[tiab] OR Facebook[tiab] OR selfie[tiab] OR influencer*[tiab] OR "online self-presentation"[tiab]))',
  '("narcissistic leadership"[tiab] OR "CEO narcissism"[tiab] OR "leader narcissism"[tiab] OR (narcissis*[tiab] AND (hubris[tiab] OR overconfidence[tiab] OR "destructive leadership"[tiab] OR "counterproductive work behavior"[tiab])))',
];

function getDateStr() {
  const target = process.env.TARGET_DATE;
  if (target) return target;
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
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

function buildDateFilter(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const lookback = d.toISOString().slice(0, 10).replace(/-/g, "/");
  return `"${lookback}"[Date - Publication] : "3000"[Date - Publication]`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function searchPapers(query, retmax = 60) {
  const url = new URL(PUBMED_SEARCH);
  url.searchParams.set("db", "pubmed");
  url.searchParams.set("term", query);
  url.searchParams.set("retmax", String(retmax));
  url.searchParams.set("sort", "date");
  url.searchParams.set("retmode", "json");

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url.toString(), {
        headers: { "User-Agent": "NPDDailyReportBot/1.0" },
        signal: AbortSignal.timeout(30000),
      });
      if (resp.status === 429) {
        const wait = 5000 * (attempt + 1);
        console.error(`[WARN] Rate limited, waiting ${wait / 1000}s...`);
        await sleep(wait);
        continue;
      }
      if (!resp.ok) throw new Error(`PubMed search ${resp.status}`);
      const data = await resp.json();
      return data?.esearchresult?.idlist || [];
    } catch (err) {
      console.error(`[ERROR] PubMed search failed: ${err.message}`);
      if (attempt < 2) await sleep(3000);
    }
  }
  return [];
}

async function fetchDetails(pmids) {
  if (!pmids.length) return [];
  const url = new URL(PUBMED_FETCH);
  url.searchParams.set("db", "pubmed");
  url.searchParams.set("id", pmids.join(","));
  url.searchParams.set("retmode", "xml");

  try {
    const resp = await fetch(url.toString(), {
      headers: { "User-Agent": "NPDDailyReportBot/1.0" },
      signal: AbortSignal.timeout(60000),
    });
    if (!resp.ok) throw new Error(`PubMed fetch ${resp.status}`);
    const xml = await resp.text();
    return parseXml(xml);
  } catch (err) {
    console.error(`[ERROR] PubMed fetch failed: ${err.message}`);
    return [];
  }
}

function parseXml(xml) {
  const papers = [];
  const articleRe = /<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g;
  let match;
  while ((match = articleRe.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, "ArticleTitle");
    const journal = extractTag(block, "<Title>", "</Title>") || extractTag(block, "<MedlineTA>", "</MedlineTA>");

    const abstractParts = [];
    const absRe = /<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g;
    let absMatch;
    while ((absMatch = absRe.exec(block)) !== null) {
      const labelMatch = absMatch[0].match(/Label="([^"]*)"/);
      const label = labelMatch ? labelMatch[1] : "";
      const text = absMatch[1].replace(/<[^>]+>/g, "").trim();
      if (text) {
        abstractParts.push(label ? `${label}: ${text}` : text);
      }
    }
    const abstract = abstractParts.join(" ").slice(0, 2000);

    const year = extractTag(block, "<Year>", "</Year>");
    const month = extractTag(block, "<Month>", "</Month>");
    const day = extractTag(block, "<Day>", "</Day>");
    const dateParts = [year, month, day].filter(Boolean);
    const dateStr = dateParts.join(" ");

    const pmid = extractTag(block, "<PMID", "</PMID>").replace(/^[^>]*>/, "");
    const url = pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : "";

    const keywords = [];
    const kwRe = /<Keyword>([\s\S]*?)<\/Keyword>/g;
    let kwMatch;
    while ((kwMatch = kwRe.exec(block)) !== null) {
      const kw = kwMatch[1].trim();
      if (kw) keywords.push(kw);
    }

    if (title) {
      papers.push({ pmid, title, journal, date: dateStr, abstract, url, keywords });
    }
  }
  return papers;
}

function extractTag(block, openTag, closeTag) {
  if (!closeTag) {
    const re = new RegExp(`<${openTag}[^>]*>([\\s\\S]*?)</${openTag}>`, "i");
    const m = block.match(re);
    return m ? m[1].replace(/<[^>]+>/g, "").trim() : "";
  }
  const start = block.indexOf(openTag);
  if (start === -1) return "";
  const contentStart = start + openTag.length;
  const end = block.indexOf(closeTag, contentStart);
  if (end === -1) return "";
  return block.slice(contentStart, end).replace(/<[^>]+>/g, "").trim();
}

async function main() {
  const dateStr = getDateStr();
  const days = parseInt(process.env.LOOKBACK_DAYS || "7", 10);
  const maxPapers = parseInt(process.env.MAX_PAPERS || "50", 10);
  const dateFilter = buildDateFilter(days);
  const summarized = loadSummarizedPmids();

  console.error(`[INFO] Date: ${dateStr}, Lookback: ${days} days, Max: ${maxPapers}`);
  console.error(`[INFO] Already summarized: ${summarized.size} PMIDs`);

  const allPmids = new Set();
  for (let i = 0; i < SEARCH_QUERIES.length; i++) {
    const fullQuery = `(${SEARCH_QUERIES[i]}) AND ${dateFilter}`;
    const pmids = await searchPapers(fullQuery, 60);
    for (const id of pmids) allPmids.add(id);
    if (i < SEARCH_QUERIES.length - 1) await sleep(1500);
  }

  console.error(`[INFO] Unique PMIDs found: ${allPmids.size}`);

  let pmidList = [...allPmids].slice(0, maxPapers + summarized.size);
  let papers = await fetchDetails(pmidList);

  papers = papers.filter((p) => !summarized.has(p.pmid));
  papers = papers.slice(0, maxPapers);

  console.error(`[INFO] After dedup: ${papers.length} new papers`);

  const output = {
    date: dateStr,
    count: papers.length,
    papers,
  };

  writeFileSync(resolve(ROOT, "papers.json"), JSON.stringify(output, null, 2));
  console.error(`[INFO] Saved papers.json with ${papers.length} papers`);
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  const dateStr = getDateStr();
  writeFileSync(
    resolve(ROOT, "papers.json"),
    JSON.stringify({ date: dateStr, count: 0, papers: [] }, null, 2)
  );
  process.exit(0);
});
