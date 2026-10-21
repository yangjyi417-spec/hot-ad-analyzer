/*
 * 热点广告分析技能网站 · 后端
 * 纯 Node 18 实现（无需 npm install）。
 * 职责：
 *   1) 服务端代理抓取 B 站 / 微博 实时热点（规避浏览器 CORS，且 key 不外露）
 *   2) /api/analyze：配置了大模型 key 走 GLM 12 维拆解；否则用本地规则引擎兜底
 *   3) 计算"借势指数"（时效 > 风险 > 契合 加权）并组装完整报告
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');

// ---------- 读取配置 ----------
function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    return cfg;
  } catch (e) {
    return { model: {}, port: 5178 };
  }
}

// ---------- 数据归档 / 分析缓存 ----------
const DATA_DIR = path.join(ROOT, 'data');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
const SHOTS_DIR = path.join(DATA_DIR, 'shots');
const ANALYSES_FILE = path.join(DATA_DIR, 'analyses.json');

function ensureDirs() { try { fs.mkdirSync(ARCHIVE_DIR, { recursive: true }); fs.mkdirSync(SHOTS_DIR, { recursive: true }); } catch (e) {} }
function todayStr() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; } }
function writeJson(file, obj) { try { ensureDirs(); fs.writeFileSync(file, JSON.stringify(obj)); return true; } catch (e) { return false; } }

// 把抓到的热点合并进"当天"归档（按 id upsert，不覆盖已保存的 analysis）
function mergeArchive(items) {
  if (!items || !items.length) return;
  const date = todayStr();
  const file = path.join(ARCHIVE_DIR, date + '.json');
  const doc = readJson(file, { date, updatedAt: nowISO(), items: [] }) || { date, updatedAt: nowISO(), items: [] };
  if (!Array.isArray(doc.items)) doc.items = [];
  const map = {};
  doc.items.forEach(x => { if (x && x.id) map[x.id] = x; });
  items.forEach(x => {
    if (!x || !x.id) return;
    const prev = map[x.id] || {};
    const merged = Object.assign({}, prev, x);
    // 保留旧的已存分析（抓取项不含 analysis 字段时不删除）
    if (!x.analysis && prev.analysis) merged.analysis = prev.analysis;
    merged.category = merged.sourceName || merged.category || '其它';
    map[x.id] = merged;
  });
  doc.items = Object.keys(map).map(k => map[k]);
  doc.updatedAt = nowISO();
  writeJson(file, doc);
}

function loadAnalyses() { return readJson(ANALYSES_FILE, {}) || {}; }
function cacheKey(ctx) { return (ctx.source || 'src') + '|' + (ctx.title || ''); }
function findCached(ctx) { const a = loadAnalyses(); const e = a[cacheKey(ctx)]; return e && e.report ? e.report : null; }
function saveAnalysis(ctx, report) {
  const a = loadAnalyses();
  a[cacheKey(ctx)] = { key: cacheKey(ctx), item: { title: ctx.title, source: ctx.source, sourceName: ctx.sourceName, url: ctx.url, date: ctx.date, rank: ctx.rank, heatText: ctx.heatText }, report, savedAt: nowISO(), date: todayStr() };
  writeJson(ANALYSES_FILE, a);
  // 同步附到当天归档条目
  const file = path.join(ARCHIVE_DIR, todayStr() + '.json');
  const doc = readJson(file, null);
  if (doc && Array.isArray(doc.items)) {
    const it = doc.items.find(i => i.id === ctx.id) || doc.items.find(i => i.title === ctx.title && i.source === ctx.source);
    if (it) { it.analysis = report; it.analyzedAt = nowISO(); writeJson(file, doc); }
  }
}

// ---------- 12 维框架（含权重与定义）----------
const DIMS = [
  { key: 'source',    name: '传播信源',   group: '传播', question: '谁在推动这个话题？官方/KOL/素人？可信度与推手性质如何？', weight: 1 },
  { key: 'spread',    name: '扩散机制',   group: '传播', question: '靠什么裂变？梗、情绪、反转还是站队？',                 weight: 7 },
  { key: 'lifecycle', name: '生命周期',   group: '传播', question: '处于萌芽/上升/峰值/衰退哪个阶段？剩余窗口多久？',       weight: 7 },
  { key: 'audience',  name: '受众画像',   group: '受众', question: '讨论它的是哪群人？与目标客群重合度如何？',               weight: 7 },
  { key: 'insight',   name: '核心洞察',   group: '受众', question: '表象之下戳中了什么真实需求或社会心理？',                 weight: 11 },
  { key: 'emotion',   name: '情绪触点',   group: '受众', question: '靠哪种情绪驱动互动？情绪是正向/中性/高危？',             weight: 6 },
  { key: 'fit',       name: '品牌契合度', group: '创意', question: '热点与品牌调性能否自然衔接？硬蹭还是天然契合？',         weight: 13 },
  { key: 'creative',  name: '创意切入角度', group: '创意', question: '从哪个角度进最巧妙、不尴尬？',                          weight: 7 },
  { key: 'content',   name: '内容形式',   group: '创意', question: '该做成短视频/海报/H5/互动梗图？落地难度？',              weight: 3 },
  { key: 'media',     name: '媒介适配',   group: '媒介', question: '该投在哪个平台、用什么原生玩法？',                       weight: 6 },
  { key: 'timing',    name: '时效窗口',   group: '媒介', question: '还有多少响应时间？该小时级快反还是精致慢做？',           weight: 18 },
  { key: 'risk',      name: '风险合规',   group: '媒介', question: '有没有翻车点？政策/价值观/竞品冲突风险？',               weight: 14 }
];

// ---------- 抓取各平台真实热点 ----------
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const nowISO = () => new Date().toISOString();

async function fetchBilibili() {
  const url = 'https://api.bilibili.com/x/web-interface/popular?ps=30';
  const j = await getJson(url, { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/' });
  const list = (j.data && j.data.list) || [];
  return list.map((v, i) => ({
    id: 'bi-' + v.bvid,
    title: v.title,
    url: 'https://www.bilibili.com/video/' + v.bvid,
    source: 'bilibili',
    sourceName: 'B站热门',
    rank: i + 1,
    date: ymdHM(v.pubdate),
    heat: (v.stat && v.stat.view) || 0,
    heatText: fmt((v.stat && v.stat.view) || 0) + ' 播放',
    extra: v.owner ? ('UP主：' + v.owner.name) : ''
  }));
}

async function fetchWeibo() {
  const url = 'https://weibo.com/ajax/side/hotSearch';
  const j = await getJson(url, { 'User-Agent': UA, 'Referer': 'https://weibo.com/' });
  const list = (j.data && j.data.realtime) || [];
  return list
    .filter(x => !x.is_ad)
    .map((x, i) => ({
      id: 'wb-' + (x.word || i),
      title: x.word,
      url: 'https://s.weibo.com/weibo?q=' + encodeURIComponent('#' + x.word + '#'),
      source: 'weibo',
      sourceName: '微博热搜',
      rank: i + 1,
      date: ymdHM(Math.floor(Date.now() / 1000)),
      heat: x.num || 0,
      heatText: fmt(x.num || 0),
      extra: x.label_desc ? ('标签：' + x.label_desc) : ''
    }));
}

async function fetchJuheHot(cfg) {
  const j = (cfg && cfg.juhe) || {};
  const key = j.hotKey || j.key;
  if (!key) throw new Error('未配置 juhe Key');
  const base = j.url || 'https://apis.juhe.cn/fapigx/networkhot/query';
  const r = await getJson(base + '?key=' + encodeURIComponent(key), { 'User-Agent': UA });
  if (!r.result || !r.result.list) throw new Error('juhe: ' + (r.reason || '返回异常'));
  return r.result.list.map((x, i) => ({
    id: 'jh-' + i + '-' + (x.title || ''),
    title: x.title,
    url: 'https://www.baidu.com/s?wd=' + encodeURIComponent(x.title || ''),
    source: 'juhe',
    sourceName: '全网热搜',
    rank: i + 1,
    date: ymdHM(Math.floor(Date.now() / 1000)),
    heat: x.hotnum || 0,
    heatText: fmt(x.hotnum || 0),
    extra: (x.digest && x.digest !== '...') ? x.digest : ''
  }));
}

// juhe 新闻列表（头条聚合）：result.data[]，字段 title/date/category/author_name/url
async function fetchJuheNews(cfg) {
  const j = (cfg && cfg.juhe) || {};
  const key = j.newsKey || j.key;
  if (!key) throw new Error('未配置新闻列表 Key');
  const base = j.newsUrl || 'https://v.juhe.cn/toutiao/index';
  const r = await getJson(base + '?type=top&key=' + encodeURIComponent(key), { 'User-Agent': UA });
  const data = r.result && r.result.data;
  if (!data) throw new Error('新闻列表: ' + (r.reason || '返回异常'));
  return data.map((x, i) => ({
    id: 'jn-' + (x.uniquekey || i) + '-' + (x.title || ''),
    title: x.title,
    url: x.url || ('https://www.baidu.com/s?wd=' + encodeURIComponent(x.title || '')),
    source: 'juhe_news',
    sourceName: '新闻榜单',
    rank: i + 1,
    date: (x.date || '').slice(0, 16),
    heat: 0,
    heatText: x.category || '',
    extra: x.author_name ? ('来源：' + x.author_name) : ''
  }));
}

// juhe AI新闻简报：result.list[]，字段 title/summary/publish_date/author_name/url
async function fetchJuheBrief(cfg) {
  const j = (cfg && cfg.juhe) || {};
  const key = j.briefKey || j.key;
  if (!key) throw new Error('未配置AI简报 Key');
  const base = j.briefUrl || 'https://apis.juhe.cn/fapigw/aibrief/list';
  const r = await getJson(base + '?key=' + encodeURIComponent(key), { 'User-Agent': UA });
  const list = r.result && r.result.list;
  if (!list) throw new Error('AI简报: ' + (r.reason || '返回异常'));
  return list.map((x, i) => ({
    id: 'jb-' + (x.id || i) + '-' + (x.title || ''),
    title: x.title,
    url: x.url || ('https://www.baidu.com/s?wd=' + encodeURIComponent(x.title || '')),
    source: 'juhe_brief',
    sourceName: 'AI简报',
    rank: i + 1,
    date: (x.publish_date || '').slice(0, 16),
    heat: 0,
    heatText: x.type || '',
    extra: (x.summary || '')
  }));
}

async function getJson(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch (e) { throw new Error('接口返回非 JSON：' + text.slice(0, 80)); }
}

function fmt(n) {
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
  return String(n);
}

// unix 秒 → "YYYY-MM-DD HH:mm"（东八区）
function ymdHM(sec) {
  if (!sec) return '';
  const d = new Date((Number(sec) || 0) * 1000 + 8 * 3600 * 1000);
  if (isNaN(d.getTime())) return '';
  const p = x => String(x).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate())
    + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

// ---------- 借势指数（加权，时效>风险>契合）----------
function computeIndex(dims) {
  let total = 0;
  for (const d of DIMS) {
    const sc = clamp(dims[d.key] && dims[d.key].score != null ? dims[d.key].score : 0, 0, 5);
    total += d.weight * (sc / 5);
  }
  return Math.round(total);
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, Number(v) || 0)); }

// ---------- 结论与风险灯 ----------
function conclude(index, riskScore, timingScore) {
  const riskLight = riskScore <= 1.5 ? 'red' : riskScore <= 3 ? 'yellow' : 'green';
  let label;
  if (riskLight === 'red' || index < 40) label = '不建议借势';
  else if (index < 60) label = '谨慎尝试';
  else if (timingScore >= 4) label = '建议快反';
  else label = '可做精致物料';
  return { label, riskLight };
}

// ---------- 本地规则引擎（未接大模型时兜底，让全流程可视化）----------
const SENSITIVE = ['去世','死亡','事故','灾害','地震','洪水','暴力','性侵','犯罪','判决','塌房','争议','维权','罢工','疫情','自杀','虐待','泄露'];
function localAnalyze(ctx) {
  const t = ctx.title || '';
  const hitRisk = SENSITIVE.some(w => t.includes(w));
  const riskScore = hitRisk ? 1 : 3.5;
  const dims = {};
  const mk = (key, score, analysis, tag) => {
    const def = DIMS.find(d => d.key === key);
    dims[key] = { ...def, score, analysis, tag: tag || '' };
  };
  mk('source', 2.5, '本地引擎无法判定信源构成，接入大模型后将识别官方/媒体/KOL/素人占比与可信度。', '待激活');
  mk('spread', 3, '扩散机制需结合评论区语义分析，本地引擎给出中性基线。', '');
  mk('lifecycle', 3, '当前采集为静态快照，无法判断生命周期阶段；大模型版将结合增速推断。', '');
  mk('audience', 2.5, `来源平台【${ctx.sourceName || '未知'}】暗示了大致受众圈层，精细画像需 AI。`, '');
  mk('insight', 2.5, '核心洞察依赖对热点背景的理解，请接入大模型获取真正的一句话洞察。', '');
  mk('emotion', hitRisk ? 1.5 : 3, '情绪基调判定需语义分析。', hitRisk ? '偏敏感' : '');
  mk('fit', 2.5, '品牌契合度取决于你要代入的具体品牌，可在输入中补充品牌信息后由 AI 判断。', '');
  mk('creative', 2.5, '创意角度为 AI 强项，本地引擎仅占位。', '');
  mk('content', 3, `基于来源平台，默认建议形式为${ctx.source === 'bilibili' ? '中短视频 / 二创梗' : '话题海报 + 短图文'}`, '');
  mk('media', 3, `${ctx.sourceName || '热点来源平台'}为天然主战场。`, '');
  mk('timing', 3.5, '热搜/热门榜意味着窗口正开，但精确剩余时长需实时增速。', '黄');
  mk('risk', riskScore, hitRisk ? '标题含潜在敏感词，务必人工复核后再决定是否借势。' : '本地引擎未做深度语义风险扫描，接入大模型后将给出敏感点、政策与价值观风险评估。', hitRisk ? '建议人工复核' : '');
  const index = computeIndex(dims);
  const c = conclude(index, riskScore, dims.timing.score);
  return {
    mode: 'local',
    index, conclusion: c.label, riskLight: c.riskLight,
    conclusionText: '本地规则引擎仅提供流程占位与中性基线；在 config.json 填入免费 GLM Key 后，本报告的 12 维将由大模型给出真正有依据的拆解。',
    dims,
    creatives: [ { title: '（示例）情绪共鸣向', desc: '接入大模型后，此处会给出 2-3 个可直接写入 brief 的具体创意 concept。' } ],
    contentForm: dims.content.analysis, mainPlatform: ctx.sourceName || '热点来源平台',
    timing: { window: '窗口正开（需实时增速精修）', label: dims.timing.tag, color: 'yellow' },
    risk: { level: hitRisk ? '谨慎/高危' : '安全基线', points: hitRisk ? ['标题命中敏感词，请人工复核'] : ['本地引擎未做深度风险扫描'] }
  };
}

// ---------- 网页截图 + 视觉读图（先说明内容，再分析）----------
function findBrowser() {
  const cfg = loadConfig();
  const cands = [
    cfg.browser,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return null;
}
function shotName(ctx) {
  const hash = crypto.createHash('md5').update((ctx.source || 'src') + '|' + (ctx.title || '')).digest('hex').slice(0, 16);
  return hash + '.png';
}
// 无头浏览器截图：viewport 抓取首屏（1200x1600），带超时保护
function captureShot(url, outFile, timeoutMs) {
  return new Promise((resolve, reject) => {
    const browser = findBrowser();
    if (!browser) return reject(new Error('本机未找到 Chrome/Edge，无法截图'));
    ensureDirs();
    const profile = path.join(DATA_DIR, '.browser-profile');
    const args = ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + profile,
      '--timeout=9000',
      '--window-size=1200,1600', '--virtual-time-budget=9000',
      '--screenshot=' + outFile, url];
    let p;
    try { p = spawn(browser, args); } catch (e) { return reject(e); }
    let err = '';
    p.stderr.on('data', d => { err += d; });
    const to = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, timeoutMs || 20000);
    let settled = false;
    p.on('close', () => {
      if (settled) return; settled = true; clearTimeout(to);
      if (fs.existsSync(outFile) && fs.statSync(outFile).size > 4000) resolve(outFile);
      else reject(new Error('截图失败：' + (err || '未生成图片').replace(/\s+/g, ' ').slice(0, 90)));
    });
    p.on('error', e => { if (settled) return; settled = true; clearTimeout(to); reject(e); });
  });
}

// 用视觉大模型「读」截图，客观说明这条热点到底在讲什么
function visionOverview(imgPath, ctx, cfg) {
  const v = cfg.vision || {};
  const b64 = fs.readFileSync(imgPath).toString('base64');
  const prompt = `这是一条标题为「${ctx.title}」的热点/新闻，在【${ctx.sourceName || '网页'}】上的真实截图。` +
    `请只依据截图中真实可见的文字与画面，客观说明这条热点到底在讲什么，不要编造截图以外的信息。` +
    `输出 JSON（字符串内严禁英文双引号，需要引用请用中文「」，换行用逗号），字段如下：` +
    `{"overview":"两三句话，具体讲清这条热点的事件/人物/数据/进展","facts":["截图可见的关键事实点1","关键事实点2","关键事实点3"],"visible":"截图里出现的主要标题或文字","caution":"是否含敏感/负面/争议/风险内容，简短说明或留空"}`;
  const body = {
    model: v.model || 'glm-4v-flash',
    messages: [{ role: 'user', content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } }
    ] }],
    temperature: 0.2
  };
  return fetch(v.baseUrl || 'https://open.bigmodel.cn/api/paas/v4/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (v.apiKey || (cfg.model && cfg.model.apiKey)) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000)
  }).then(async res => {
    const raw = await res.text();
    if (!res.ok) throw new Error('视觉模型 HTTP ' + res.status + '：' + raw.slice(0, 120));
    const j = JSON.parse(raw);
    let c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!c) throw new Error('视觉模型返回为空');
    c = c.replace(/```json|```/g, '').trim();
    const s = c.indexOf('{'), e = c.lastIndexOf('}');
    if (s >= 0 && e > s) c = c.slice(s, e + 1);
    try { return JSON.parse(c); }
    catch (err) { return { overview: c.slice(0, 300), facts: [], visible: '', caution: '' }; }
  });
}

// ---------- 大模型分析（GLM / OpenAI 兼容）----------
const SYS = '你是资深广告传播分析师，严格遵循给定的"热点广告 12 维分析框架"输出结论。每个维度都要展开写成一段有分量的分析（两三句、80-140字），把这个维度的判断、判断所依据的具体理由、以及对借势的启示讲透，内容要针对这条热点本身、具体不空泛，像专业分析师写的正文。禁止只写一句话结论，也不要使用【依据】【推理】【判断】这类标签或分点前缀。score 仅用于内部雷达图定形（0-5），文字才是重点。所有字符串值内部严禁出现英文双引号（需要引用请用中文「」），换行请用顿号或逗号替代，确保输出能被 JSON.parse 直接解析。只输出 JSON，不要多余文字。';
function buildPrompt(ctx) {
  return `请对以下热点做广告借势 12 维拆解。

【热点标题】${ctx.title}
【来源平台】${ctx.sourceName || '未知'}（${ctx.source || ''}）
【热度指标】${ctx.heatText || ''}
【补充信息/品牌】${ctx.brand || '（用户未提供，按通用快消/内容品牌视角判断契合度）'}
【背景上下文】${ctx.context || '（无额外上下文，请基于热点本身常识判断）'}

【12 维定义】（key 必须与下列一致）
${DIMS.map(d => `- ${d.key}｜${d.name}｜需回答：${d.question}`).join('\n')}

严格输出如下 JSON（字段名一致；score 为 0-5；risk 与 timing 的 score 含义：越高越安全/越可行动）：
{
  "dims": {
    ${DIMS.map(d => `"${d.key}": {"score": 0-5, "analysis": "针对这条热点展开写80-140字、两三句的连贯分析：这个维度怎么看、依据是什么、对借势有何启示。要具体、有信息量，不要一句话带过，不要分点或【依据】等标签", "tag": "简短标签或留空"}`).join(',\n    ')}
  },
  "creatives": [ {"title":"创意概念名","desc":"一句话怎么做"} ],
  "contentForm": "建议内容形式",
  "mainPlatform": "建议主投平台与原生玩法",
  "timing": {"window":"建议响应速度：如 6小时快反 / 3日内 / 观望"},
  "risk": {"level":"安全|谨慎|高危","points":["风险点1","风险点2"]}
}`;
}

// 容错解析：标准 JSON → 去尾逗号重试 → 正则按维度兜底
function parseModelJson(s) {
  try { return JSON.parse(s); } catch (e) {}
  try { return JSON.parse(s.replace(/,\s*([}\]])/g, '$1')); } catch (e) {}
  const out = { dims: {} };
  for (const d of DIMS) {
    const re = new RegExp('"' + d.key + '"\\s*:\\s*\\{[\\s\\S]*?"score"\\s*:\\s*([0-9.]+)[\\s\\S]*?"analysis"\\s*:\\s*"([\\s\\S]*?)"\\s*,\\s*"tag"\\s*:\\s*"([\\s\\S]*?)"');
    const m = s.match(re);
    if (m) out.dims[d.key] = { score: parseFloat(m[1]), analysis: m[2], tag: m[3] };
  }
  const cf = s.match(/"contentForm"\s*:\s*"([\s\S]*?)"/); if (cf) out.contentForm = cf[1];
  const mp = s.match(/"mainPlatform"\s*:\s*"([\s\S]*?)"/); if (mp) out.mainPlatform = mp[1];
  const tw = s.match(/"window"\s*:\s*"([\s\S]*?)"/); if (tw) out.timing = { window: tw[1] };
  const rl = s.match(/"level"\s*:\s*"([\s\S]*?)"/); if (rl) out.risk = { level: rl[1] };
  if (Object.keys(out.dims).length < 6) throw new Error('模型返回 JSON 无法解析');
  return out;
}

async function llmAnalyze(ctx, cfg) {
  const m = cfg.model || {};
  const body = {
    model: m.model || 'glm-4-flash',
    messages: [ { role: 'system', content: SYS }, { role: 'user', content: buildPrompt(ctx) } ],
    temperature: 0.4
  };
  const res = await fetch(m.baseUrl || 'https://open.bigmodel.cn/api/paas/v4/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + m.apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  });
  const raw = await res.text();
  if (!res.ok) throw new Error('LLM HTTP ' + res.status + '：' + raw.slice(0, 160));
  const j = JSON.parse(raw);
  let content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!content) throw new Error('LLM 返回内容为空');
  content = content.replace(/```json|```/g, '').trim();
  const start = content.indexOf('{'); const end = content.lastIndexOf('}');
  const parsed = parseModelJson(content.slice(start, end + 1));
  // 规范化：补全缺失维度、算指数
  const dims = {};
  for (const d of DIMS) {
    const g = (parsed.dims && parsed.dims[d.key]) || {};
    dims[d.key] = { ...d, score: clamp(g.score, 0, 5), analysis: g.analysis || '（模型未给出）', tag: g.tag || '' };
  }
  const riskScore = dims.risk.score;
  const timingScore = dims.timing.score;
  const index = computeIndex(dims);
  const c = conclude(index, riskScore, timingScore);
  const riskLvl = (parsed.risk && parsed.risk.level) || (riskScore <= 1.5 ? '高危' : riskScore <= 3 ? '谨慎' : '安全');
  return {
    mode: 'llm', model: m.model || 'glm-4-flash',
    index, conclusion: c.label, riskLight: c.riskLight,
    conclusionText: buildConclusionText(c.label, dims),
    dims,
    creatives: parsed.creatives || [],
    contentForm: parsed.contentForm || dims.content.analysis,
    mainPlatform: parsed.mainPlatform || dims.media.analysis,
    timing: { window: (parsed.timing && parsed.timing.window) || '—', label: dims.timing.tag, color: timingScore >= 4 ? 'green' : timingScore >= 2.5 ? 'yellow' : 'gray' },
    risk: { level: riskLvl, points: (parsed.risk && parsed.risk.points) || [dims.risk.analysis] }
  };
}
function buildConclusionText(label, dims) {
  const parts = [];
  if (dims.insight && dims.insight.analysis) parts.push('洞察：' + short(dims.insight.analysis, 40));
  if (dims.fit) parts.push('契合度 ' + dims.fit.score + '/5');
  if (dims.risk) parts.push('风险 ' + dims.risk.score + '/5');
  return label + '。' + parts.join('；') + '。';
}
function short(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }

// ---------- HTTP 服务 ----------
function sendJson(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
}
function serveStatic(res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(PUB, path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/hot') {
      const src = url.searchParams.get('source') || 'all';
      const out = {};
      const cfg = loadConfig();
      const jobs = [];
      if (src === 'bilibili' || src === 'all') jobs.push(fetchBilibili().then(l => out.bilibili = l).catch(e => out.bilibiliError = e.message));
      if (src === 'weibo' || src === 'all') jobs.push(fetchWeibo().then(l => out.weibo = l).catch(e => out.weiboError = e.message));
      if (src === 'juhe' || src === 'all') jobs.push(fetchJuheHot(cfg).then(l => out.juhe = l).catch(e => out.juheError = e.message));
      if (src === 'juhe_news' || src === 'all') jobs.push(fetchJuheNews(cfg).then(l => out.juheNews = l).catch(e => out.juheNewsError = e.message));
      if (src === 'juhe_brief' || src === 'all') jobs.push(fetchJuheBrief(cfg).then(l => out.juheBrief = l).catch(e => out.juheBriefError = e.message));
      await Promise.all(jobs);
      const allItems = [].concat(out.juhe || [], out.juheNews || [], out.juheBrief || [], out.weibo || [], out.bilibili || []);
      mergeArchive(allItems);
      out.collectedAt = nowISO();
      return sendJson(res, 200, out);
    }
    if (url.pathname === '/api/analyze' && req.method === 'POST') {
      const body = await readBody(req);
      const ctx = JSON.parse(body || '{}');
      const cfg = loadConfig();
      const hasKey = cfg.model && cfg.model.apiKey && cfg.model.apiKey.trim();
      const wantShot = ctx.shot !== 'off' && ctx.url && /^https?:\/\//i.test(ctx.url) && hasKey && !!findBrowser();
      if (!ctx.force) {
        const hit = findCached(ctx);
        // 命中缓存：除非「本该有截图却缺图、且此前并未截图失败过」，否则直接返回
        if (hit && (!wantShot || hit.shot || hit.shotError)) return sendJson(res, 200, Object.assign({ cached: true }, hit));
      }
      let shotRel = null, overview = null, shotError = null;
      if (wantShot) {
        const fname = shotName(ctx);
        const fpath = path.join(SHOTS_DIR, fname);
        try {
          await captureShot(ctx.url, fpath, 20000);
          shotRel = '/shots/' + fname;
          try { overview = await visionOverview(fpath, ctx, cfg); }
          catch (e) { shotError = '读图失败：' + e.message; }
        } catch (e) { shotError = e.message; }
        if (overview && overview.overview) {
          ctx.context = (ctx.context ? ctx.context + '\n' : '') +
            '【截图读到的真实内容（分析请以此为准，不要只凭标题臆测）】' + overview.overview +
            ((overview.facts && overview.facts.length) ? ' 关键事实：' + overview.facts.join('；') : '') +
            (overview.visible ? ' 截图可见文字：' + overview.visible : '');
        }
      }
      let rep;
      if (hasKey) {
        try { rep = await llmAnalyze(ctx, cfg); }
        catch (e) { rep = localAnalyze(ctx); rep.llmError = e.message; }
      } else {
        rep = localAnalyze(ctx);
      }
      rep.shot = shotRel;
      rep.overview = overview || null;
      if (shotError) rep.shotError = shotError;
      if (rep.mode === 'llm' && !rep.llmError) saveAnalysis(ctx, rep);
      return sendJson(res, 200, rep);
    }
    if (url.pathname === '/api/shot' && req.method === 'POST') {
      const body = await readBody(req);
      const ctx = JSON.parse(body || '{}');
      const cfg = loadConfig();
      if (!ctx.url) return sendJson(res, 400, { error: '缺少 url' });
      if (!findBrowser()) return sendJson(res, 500, { error: '本机未找到 Chrome/Edge' });
      const fname = shotName(Object.assign({ source: 'shot', title: ctx.url }, ctx));
      const fpath = path.join(SHOTS_DIR, fname);
      try { await captureShot(ctx.url, fpath, 20000); return sendJson(res, 200, { shot: '/shots/' + fname }); }
      catch (e) { return sendJson(res, 500, { error: e.message }); }
    }
    if (url.pathname === '/api/archive/dates') {
      ensureDirs();
      let files = [];
      try { files = fs.readdirSync(ARCHIVE_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)); } catch (e) {}
      const dates = files.map(f => f.replace('.json', '')).sort().reverse().map(d => {
        const doc = readJson(path.join(ARCHIVE_DIR, d + '.json'), { items: [] });
        const analyzed = (doc.items || []).filter(i => i.analysis).length;
        return { date: d, count: (doc.items || []).length, analyzed };
      });
      return sendJson(res, 200, { dates, today: todayStr() });
    }
    if (url.pathname === '/api/archive') {
      const date = url.searchParams.get('date') || todayStr();
      const category = url.searchParams.get('category') || 'all';
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const doc = readJson(path.join(ARCHIVE_DIR, date + '.json'), { date, items: [] });
      let items = (doc && doc.items) || [];
      if (category && category !== 'all') items = items.filter(i => (i.category || i.sourceName) === category || i.source === category);
      if (q) items = items.filter(i => ((i.title || '') + ' ' + (i.extra || '') + ' ' + (i.category || '')).toLowerCase().includes(q));
      const cats = Array.from(new Set(((doc && doc.items) || []).map(i => i.category || i.sourceName).filter(Boolean)));
      return sendJson(res, 200, { date, total: ((doc && doc.items) || []).length, count: items.length, categories: cats, items });
    }
    if (url.pathname === '/api/config') {
      const cfg = loadConfig();
      return sendJson(res, 200, { llmOn: !!(cfg.model && cfg.model.apiKey && cfg.model.apiKey.trim()), model: cfg.model ? cfg.model.model : null });
    }
    if (url.pathname.startsWith('/shots/')) {
      const safe = path.basename(url.pathname);
      const f = path.join(SHOTS_DIR, safe);
      return fs.readFile(f, (err, data) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
        res.end(data);
      });
    }
    return serveStatic(res, url.pathname);
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => resolve(d));
  });
}

const PORT = (loadConfig().port) || 5178;
server.listen(PORT, () => {
  console.log('\n  热点广告分析技能网站 已启动');
  console.log('  在浏览器打开 →  http://localhost:' + PORT + '\n');
  const cfg = loadConfig();
  console.log('  分析模式：' + (cfg.model && cfg.model.apiKey ? '大模型（' + (cfg.model.model || 'glm-4-flash') + '）' : '本地规则引擎（在 config.json 填入免费 GLM Key 可升级为 AI 拆解）'));
  console.log('  数据源：全网热搜 / 新闻榜单 / AI简报 / 微博热搜 / B站热门（服务端实时抓取）');
  console.log('  每日归档：抓取内容自动存入 data/archive/<日期>.json，分析结果缓存于 data/analyses.json\n');
});
