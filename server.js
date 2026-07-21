process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const crypto = require('crypto');
const { PDFParse } = require('pdf-parse');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3005;
const DEBUG_DIR = path.join(__dirname, 'debug');
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('ERROR: Missing SUPABASE_URL or SUPABASE_KEY environment variables.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false }
});

console.log('[Supabase] Initialized client targeting:', supabaseUrl);

// ---------------------------------------------------------------------------
// CookieJar — correctly captures EVERY Set-Cookie header (not just the first),
// and does not blow up on cookies whose `expires=` value contains a comma.
// This was the most likely root cause of the "can't find products" bug:
// the old code did `set-cookie`.split(',') which both truncates multi-cookie
// responses and corrupts any cookie containing an expires date.
// ---------------------------------------------------------------------------
class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  update(response) {
    let rawCookies = [];

    if (typeof response.headers.getSetCookie === 'function') {
      // Node 18.14+ / undici: returns every Set-Cookie header correctly split.
      rawCookies = response.headers.getSetCookie();
    } else {
      // Fallback for older runtimes: split only on commas that precede a new
      // "name=value" pair, not commas inside an Expires= date.
      const single = response.headers.get('set-cookie');
      if (single) {
        rawCookies = single.split(/,(?=\s*[^;=]+=[^;]*)/);
      }
    }

    for (const raw of rawCookies) {
      const pair = raw.split(';')[0];
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (name) this.cookies.set(name, value);
    }

    return rawCookies.length;
  }

  toString() {
    return Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  get size() {
    return this.cookies.size;
  }
}

const COMMON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

// Sessions store: sessionId -> { jar: CookieJar, timestamp, lastHtml, lastUrl }
const activeSessions = {};

setInterval(() => {
  const now = Date.now();
  Object.keys(activeSessions).forEach(sid => {
    if (now - activeSessions[sid].timestamp > 3600 * 1000) {
      delete activeSessions[sid];
    }
  });
}, 1800 * 1000);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Helper: ensure company is registered
// ---------------------------------------------------------------------------
async function ensureCompany(code, productName) {
  let companyName = null;

  const prefixes = [
    '國泰人壽', '國泰產物', '國泰世紀產物',
    '富邦人壽', '富邦產物',
    '臺灣產物', '台灣人壽',
    '兆豐產物',
    '新光人壽', '新光產物',
    '南山人壽', '南山產物',
    '中華郵政',
    '中國人壽', '凱基人壽',
    '三商美邦人壽', '三商美邦',
    '第一產物', '華南產物', '泰安產物', '明台產物', '旺旺友聯', '和泰產物',
    '安達人壽', '安達產物', '法國巴黎人壽', '安聯人壽', '保誠人壽', '友邦人壽'
  ];

  for (const prefix of prefixes) {
    if (productName.includes(prefix)) {
      companyName = prefix;
      break;
    }
  }

  if (!companyName) {
    const match = productName.match(/^([^\s（(0-9]+保險)/) || productName.match(/^([^\s（(0-9]+人壽)/) || productName.match(/^([^\s（(0-9]+產險)/);
    companyName = match ? match[1] : `${code}-保險公司`;
  }

  const { error } = await supabase
    .from('companies')
    .upsert({ code, name: companyName }, { onConflict: 'code' });

  if (error) {
    console.log('[Supabase] ensureCompany error:', error.message);
    throw error;
  }
  return companyName;
}

// ---------------------------------------------------------------------------
// API: Initialize a session and get captcha
// ---------------------------------------------------------------------------
app.get('/api/session', async (req, res) => {
  try {
    const baseUrl = 'https://insprod.tii.org.tw';
    const mainUrl = `${baseUrl}/Query.aspx`;

    console.log(`[Session] Fetching ${mainUrl} to start session...`);
    const jar = new CookieJar();

    const mainRes = await fetch(mainUrl, { headers: { ...COMMON_HEADERS } });
    const n1 = jar.update(mainRes);
    console.log(`[Session] Captured ${n1} cookie(s) from Query.aspx. Jar size=${jar.size}`);

    if (jar.size === 0) {
      // If TII didn't hand us a session cookie at all, every subsequent
      // request will look "logged out" and searches will silently fail.
      console.warn('[Session] WARNING: no cookies received from Query.aspx. TII may be blocking this server, or its cookie format changed.');
    }

    const captchaUrl = `${baseUrl}/bmp.ashx`;
    console.log(`[Session] Fetching captcha...`);
    const captchaRes = await fetch(captchaUrl, {
      headers: { ...COMMON_HEADERS, Cookie: jar.toString() }
    });
    const n2 = jar.update(captchaRes);
    console.log(`[Session] Captured ${n2} additional cookie(s) from bmp.ashx. Jar size=${jar.size}`);

    const buffer = await captchaRes.arrayBuffer();
    const base64Image = Buffer.from(buffer).toString('base64');

    const sessionId = crypto.randomUUID();
    activeSessions[sessionId] = {
      jar,
      timestamp: Date.now(),
      lastHtml: null,
      lastUrl: null
    };

    res.json({
      success: true,
      sessionId,
      captcha: `data:image/jpeg;base64,${base64Image}`,
      cookieCount: jar.size // exposed so the frontend/console can flag a suspicious 0
    });
  } catch (err) {
    console.error('Error starting session:', err);
    res.status(500).json({ success: false, error: 'Failed to initialize session with TII.' });
  }
});

// ---------------------------------------------------------------------------
// API: Perform search
// ---------------------------------------------------------------------------
app.post('/api/search', async (req, res) => {
  const { sessionId, keyword, categoryId, captcha, forceRefresh } = req.body;

  if (!keyword) {
    return res.status(400).json({ success: false, error: 'Missing keyword.' });
  }

  // IMPORTANT: previously this silently defaulted to '2' (人壽保險) whenever
  // categoryId was falsy — including an intentional "全部" (all) selection
  // sent as '' or 0. That made an "all categories" search on the frontend
  // silently become a life-insurance-only search on the backend, which looks
  // exactly like "can't find the product" for anything non-life.
  if (categoryId === undefined || categoryId === null) {
    return res.status(400).json({
      success: false,
      error: 'Missing categoryId. Send an explicit category (use "" only if you really mean "all categories" and the TII form supports it).'
    });
  }
  const cat = categoryId;
  console.log(`[Search] keyword="${keyword}" categoryId="${cat}" forceRefresh=${!!forceRefresh}`);

  const force = forceRefresh === true || forceRefresh === 'true';

  if (!force) {
    const { data: rows, error } = await supabase
      .from('policies')
      .select('product_id, name, start_date, end_date, category_id')
      .or(`name.ilike.%${keyword}%,company_code.eq.${keyword}`)
      .eq('category_id', cat);

    if (error) {
      console.error('[Supabase] Search cache error:', error.message);
      return res.status(500).json({ success: false, error: 'Database search error.' });
    }

    if (rows && rows.length > 0) {
      console.log(`[Search] Cache HIT for "${keyword}" (category ${cat}). Found ${rows.length} policies.`);
      const results = rows.map(r => ({
        productId: r.product_id,
        name: r.name,
        startDate: r.start_date,
        endDate: r.end_date,
        categoryId: r.category_id
      }));
      return res.json({ success: true, fromCache: true, results });
    }

    console.log(`[Search] Cache MISS for "${keyword}" (category ${cat}).`);
    if (!captcha || !sessionId) {
      return res.json({ success: false, needCaptcha: true });
    }
    await queryTII(sessionId, keyword, cat, captcha, res);
  } else {
    if (!captcha || !sessionId) {
      return res.json({ success: false, needCaptcha: true, error: '強制重新整理需要輸入驗證碼' });
    }
    await queryTII(sessionId, keyword, cat, captcha, res);
  }
});

// ---------------------------------------------------------------------------
// Helper function to query TII and cache results
// ---------------------------------------------------------------------------
async function queryTII(sessionId, keyword, categoryId, captcha, res) {
  const session = activeSessions[sessionId];
  if (!session) {
    return res.status(400).json({ success: false, error: 'Session expired. Please refresh the page.' });
  }

  try {
    const baseUrl = 'https://insprod.tii.org.tw';
    const postUrl = `${baseUrl}/ResultQueryAll.aspx`;

    console.log(`[Search] Querying TII: keyword="${keyword}" category="${categoryId}" cookieJarSize=${session.jar.size}`);
    if (session.jar.size === 0) {
      console.warn('[Search] WARNING: cookie jar is empty for this session — TII will almost certainly reject/ignore this request.');
    }

    const keywordBuf = iconv.encode(keyword, 'big5');
    let big5PercentEncoded = '';
    for (let i = 0; i < keywordBuf.length; i++) {
      big5PercentEncoded += '%' + keywordBuf[i].toString(16).toUpperCase().padStart(2, '0');
    }

    const bodyStr = `postB=Y&isqry=Y&isquery=Y&categoryId=${categoryId || ''}&CompanyID=000&f_CategoryId1=&qry_beginDate_SD1=&qry_beginDate_SD2=&qry_endDate_ED1=&qry_endDate_ED2=&fQueryAll=${big5PercentEncoded}&bmpC=${captcha}`;

    const postRes = await fetch(postUrl, {
      method: 'POST',
      headers: {
        ...COMMON_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: session.jar.toString(),
        Referer: `${baseUrl}/Query.aspx`
      },
      body: bodyStr
    });

    // TII may rotate/add cookies on this response too — capture them so any
    // follow-up request (e.g. download) in this session still works.
    const nNew = session.jar.update(postRes);
    if (nNew > 0) console.log(`[Search] TII issued ${nNew} new cookie(s) on ResultQueryAll.aspx response.`);

    const postBuffer = await postRes.arrayBuffer();
    const html = iconv.decode(Buffer.from(postBuffer), 'big5');

    // Save the raw response for debugging, always — cheap and invaluable
    // when something silently comes back empty.
    session.lastHtml = html;
    session.lastUrl = postUrl;
    session.timestamp = Date.now();
    try {
      fs.writeFileSync(path.join(DEBUG_DIR, `${sessionId}.html`), html, 'utf8');
    } catch (writeErr) {
      console.warn('[Search] Could not write debug HTML file:', writeErr.message);
    }
    console.log(`[Search] TII responded with ${html.length} chars. First 300 chars:\n${html.slice(0, 300).replace(/\s+/g, ' ')}`);

    // 1. Captcha-specific error
    if (html.includes('alert(') && (html.includes('驗證碼') || html.includes('錯誤') || html.includes('失效'))) {
      return res.json({ success: false, errorType: 'captcha', error: '驗證碼錯誤或已失效，請點擊驗證碼重新整理輸入' });
    }

    const $ = cheerio.load(html);
    const results = [];
    const dbPromises = [];

    $('a[href*="DetailList.aspx"]').each((i, a) => {
      const link = $(a).attr('href');
      const nameText = $(a).text().trim();
      if (!nameText) return;

      const tr = $(a).closest('tr');
      const tds = tr.find('td');

      if (tds.length >= 6) {
        const startDate = tds.eq(3).text().trim().replace(/\s+/g, ' ');
        const endDate = tds.eq(5).text().trim().replace(/\s+/g, ' ');

        let productId = '';
        if (link) {
          const urlObj = new URL(link, baseUrl);
          productId = urlObj.searchParams.get('productId');
        }

        if (productId) {
          results.push({ productId, name: nameText, startDate, endDate, categoryId });

          const companyCode = productId.substring(0, 3);
          const p = ensureCompany(companyCode, nameText)
            .then(async () => {
              const { error } = await supabase
                .from('policies')
                .upsert({
                  product_id: productId,
                  name: nameText,
                  company_code: companyCode,
                  start_date: startDate,
                  end_date: endDate,
                  category_id: categoryId,
                  last_updated: Date.now()
                }, { onConflict: 'product_id' });
              if (error) console.error('[Supabase] Policy insert error:', error.message);
            })
            .catch(err => console.error('[Supabase] Company registration error:', err.message));

          dbPromises.push(p);
        }
      }
    });

    await Promise.all(dbPromises);

    // 2. Genuinely zero results — distinguish "TII says nothing matches" from
    // "we failed to parse a page that actually had results". If TII has a
    // recognizable "no data" phrase, trust it. Otherwise, if we found zero
    // links AND no recognizable phrase, something about the page format (or
    // our session) is wrong — surface that instead of pretending it's a
    // normal empty result.
    if (results.length === 0) {
      const noDataMarkers = ['查無', '無符合', '無相關資料', '沒有符合', '查詢無資料'];
      const hasNoDataMarker = noDataMarkers.some(m => html.includes(m));
      const hasResultTable = html.includes('DetailList.aspx');

      if (hasNoDataMarker) {
        console.log('[Search] TII confirmed zero matches (found explicit no-data marker).');
      } else if (!hasResultTable) {
        console.error('[Search] Zero results AND no "DetailList.aspx" links anywhere in the response, and no no-data marker either. This usually means the session/cookie was rejected, or TII changed its page structure. Raw HTML saved to debug/' + sessionId + '.html');
        return res.json({
          success: false,
          error: '查詢結果無法解析，可能是連線階段失效或 TII 網站格式異動，請重新整理驗證碼再試一次；若持續發生請檢查 debug/ 目錄下的回應內容。',
          diagnosticHint: 'no_results_and_no_marker'
        });
      }
    }

    console.log(`[Search] Successfully queried and cached ${results.length} policies from TII.`);
    res.json({ success: true, results });
  } catch (err) {
    console.error('TII Search error:', err);
    res.status(500).json({ success: false, error: 'Search failed.' });
  }
}

// ---------------------------------------------------------------------------
// API: Debug — inspect the last raw TII response for a session
// ---------------------------------------------------------------------------
app.get('/api/debug/session/:sessionId', (req, res) => {
  const session = activeSessions[req.params.sessionId];
  if (!session) return res.status(404).json({ success: false, error: 'Unknown or expired session.' });
  res.json({
    success: true,
    cookieJar: session.jar.toString(),
    cookieCount: session.jar.size,
    lastUrl: session.lastUrl,
    lastHtmlLength: session.lastHtml ? session.lastHtml.length : 0,
    lastHtmlPreview: session.lastHtml ? session.lastHtml.slice(0, 2000) : null
  });
});

// ---------------------------------------------------------------------------
// API: Download all documents for a policy
// ---------------------------------------------------------------------------
app.post('/api/download', async (req, res) => {
  const { sessionId, productId, productName } = req.body;

  if (!productId) {
    return res.status(400).json({ success: false, error: 'Missing parameters.' });
  }

  try {
    const { data: dbFiles, error: checkErr } = await supabase
      .from('policy_files')
      .select('file_id, filename, doc_type, size_bytes')
      .eq('product_id', productId);

    if (checkErr) console.error('[Supabase] Check cached files error:', checkErr.message);

    if (dbFiles && dbFiles.length > 0) {
      console.log(`[Download] Cache HIT for product: "${productName}" (${productId}). Found ${dbFiles.length} files.`);
      const filesList = dbFiles.map(f => ({
        fileId: f.file_id, filename: f.filename, docType: f.doc_type, sizeBytes: f.size_bytes
      }));
      return res.json({ success: true, fromCache: true, productName, productId, files: filesList });
    }

    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'Cache miss. Active session required to query TII.' });
    }

    const session = activeSessions[sessionId];
    if (!session) {
      return res.status(400).json({ success: false, error: 'Session expired. Please refresh the page.' });
    }

    const baseUrl = 'https://insprod.tii.org.tw';
    const detailUrl = `${baseUrl}/DetailList.aspx?productId=${productId}`;

    console.log(`[Download] Cache MISS. Fetching detail page: ${detailUrl}...`);
    const detailRes = await fetch(detailUrl, {
      headers: { ...COMMON_HEADERS, Cookie: session.jar.toString() }
    });
    session.jar.update(detailRes);

    const detailBuffer = await detailRes.arrayBuffer();
    const detailHtml = iconv.decode(Buffer.from(detailBuffer), 'big5');
    if (detailHtml.includes('驗證碼錯誤') || detailHtml.includes('請重新輸入') || detailHtml.includes('失效')) {
      return res.status(400).json({ success: false, error: 'Session invalid at TII. Please refresh captcha and search again.' });
    }

    const $ = cheerio.load(detailHtml);
    const downloadLinks = [];

    $('a').each((i, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().trim();
      if (href && href.includes('Open2.ashx')) {
        let docType = '未知文件';
        const td = $(el).closest('td');
        const prevTr = td.closest('tr').prev('tr');
        if (prevTr.length > 0) docType = prevTr.text().trim().replace(/\s+/g, ' ');
        downloadLinks.push({ href: href.trim(), filename: text, docType });
      }
    });

    if (downloadLinks.length === 0) {
      return res.json({ success: false, error: 'No download files found for this product.' });
    }

    console.log(`[Download] Found ${downloadLinks.length} files to download from TII.`);
    const downloadedFiles = [];

    for (const link of downloadLinks) {
      const fileUrl = `${baseUrl}/${link.href}`;
      console.log(`[Download] Downloading: ${link.filename} from ${fileUrl}...`);

      const fileRes = await fetch(fileUrl, {
        headers: { ...COMMON_HEADERS, Cookie: session.jar.toString(), Referer: detailUrl }
      });

      if (fileRes.status === 200) {
        const contentType = fileRes.headers.get('content-type') || '';
        if (contentType.includes('text/html')) {
          console.log(`[Download] Warning: File ${link.filename} returned HTML. Skipping.`);
          continue;
        }

        const buffer = await fileRes.arrayBuffer();
        const nodeBuffer = Buffer.from(buffer);

        const storagePath = `policies/${productId}/${link.filename}`;
        const { error: uploadErr } = await supabase.storage
          .from('policy-attachments')
          .upload(storagePath, nodeBuffer, { contentType: 'application/pdf', upsert: true });

        if (uploadErr) {
          console.error('[Supabase Storage] Upload error:', uploadErr.message);
          continue;
        }

        const fileId = crypto.randomUUID();
        const { error: dbErr } = await supabase
          .from('policy_files')
          .insert({
            file_id: fileId, product_id: productId, filename: link.filename,
            doc_type: link.docType, storage_path: storagePath,
            size_bytes: buffer.byteLength, downloaded_at: Date.now()
          });

        if (dbErr) {
          console.error('[Supabase DB] File insert error:', dbErr.message);
          continue;
        }

        downloadedFiles.push({ fileId, filename: link.filename, docType: link.docType, sizeBytes: buffer.byteLength });
      } else {
        console.log(`[Download] Failed to download ${link.filename}. Status: ${fileRes.status}`);
      }
    }

    res.json({ success: true, productName, productId, files: downloadedFiles });
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ success: false, error: 'Failed to download policy files.' });
  }
});

// ---------------------------------------------------------------------------
// API: Get archive directory (grouped by company)
// ---------------------------------------------------------------------------
app.get('/api/archive', async (req, res) => {
  try {
    const { data: companies, error: compErr } = await supabase.from('companies').select('code, name');
    if (compErr) throw compErr;

    const { data: policiesData, error: polErr } = await supabase
      .from('policies')
      .select(`
        product_id, name, start_date, end_date, category_id, company_code,
        policy_files (count)
      `);
    if (polErr) throw polErr;

    const policies = policiesData.map(p => ({
      productId: p.product_id, name: p.name, startDate: p.start_date, endDate: p.end_date,
      categoryId: p.category_id, companyCode: p.company_code,
      filesCount: p.policy_files?.[0]?.count || 0
    }));

    const activeCompanyCodes = new Set(policies.map(p => p.companyCode));
    const filteredCompanies = companies.filter(c => activeCompanyCodes.has(c.code));

    res.json({ success: true, companies: filteredCompanies, policies });
  } catch (err) {
    console.error('[Supabase] Fetch archive error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch archived data.' });
  }
});

// ---------------------------------------------------------------------------
// API: Get files list for a policy
// ---------------------------------------------------------------------------
app.get('/api/policy/:productId/files', async (req, res) => {
  const { productId } = req.params;
  const { data: rows, error } = await supabase
    .from('policy_files')
    .select('file_id, filename, doc_type, size_bytes')
    .eq('product_id', productId);

  if (error) {
    console.error('[Supabase] Fetch policy files error:', error.message);
    return res.status(500).json({ success: false, error: 'Database error.' });
  }

  const files = rows.map(r => ({ fileId: r.file_id, filename: r.filename, docType: r.doc_type, sizeBytes: r.size_bytes }));
  res.json({ success: true, files: files || [] });
});

// ---------------------------------------------------------------------------
// API: Serve binary PDF file from Supabase Storage
// ---------------------------------------------------------------------------
app.get('/api/file/:fileId', async (req, res) => {
  const { fileId } = req.params;

  try {
    const { data: fileMeta, error: dbErr } = await supabase
      .from('policy_files')
      .select('filename, doc_type, storage_path, size_bytes')
      .eq('file_id', fileId)
      .single();

    if (dbErr || !fileMeta) {
      console.error('[Supabase] Fetch file meta error:', dbErr?.message);
      return res.status(404).send('File not found in database.');
    }

    const { data: fileData, error: dlErr } = await supabase.storage
      .from('policy-attachments')
      .download(fileMeta.storage_path);

    if (dlErr || !fileData) {
      console.error('[Supabase Storage] Download error:', dlErr?.message);
      return res.status(404).send('File not found in storage.');
    }

    const buffer = Buffer.from(await fileData.arrayBuffer());

    let contentType = 'application/octet-stream';
    const ext = path.extname(fileMeta.filename).toLowerCase();
    if (ext === '.pdf') contentType = 'application/pdf';
    else if (ext === '.doc' || ext === '.docx') contentType = 'application/msword';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileMeta.filename)}"`);
    res.setHeader('Content-Length', fileMeta.size_bytes);
    res.send(buffer);
  } catch (err) {
    console.error('File stream error:', err);
    res.status(500).send('Server error downloading file.');
  }
});

// ---------------------------------------------------------------------------
// Helper to retrieve policy text, downloading and parsing if needed
// ---------------------------------------------------------------------------
async function getPolicyFullText(productId) {
  const { data: files, error } = await supabase
    .from('policy_files')
    .select('file_id, filename, storage_path, extracted_text')
    .eq('product_id', productId);

  if (error || !files || files.length === 0) {
    throw new Error('此保單目前尚未下載備查條款檔案，請先執行「下載備查」或「開始自動檢索」並同步條款。');
  }

  const parsedFiles = [];

  for (const file of files) {
    if (file.extracted_text) {
      parsedFiles.push({ filename: file.filename, text: file.extracted_text });
    } else {
      console.log(`[Parse] Fetching PDF from storage for text extraction: ${file.filename}`);
      const { data: fileData, error: dlErr } = await supabase.storage
        .from('policy-attachments')
        .download(file.storage_path);

      if (dlErr || !fileData) {
        console.error(`[Parse] Failed to download ${file.filename}:`, dlErr?.message);
        continue;
      }

      try {
        const arrayBuffer = await fileData.arrayBuffer();
        const nodeBuffer = Buffer.from(arrayBuffer);

        const parser = new PDFParse({ data: nodeBuffer });
        const pdfData = await parser.getText();
        const text = (pdfData.pages && pdfData.pages.length > 0)
          ? pdfData.pages.map(p => p.text).join('\f')
          : (pdfData.text || '');

        await supabase.from('policy_files').update({ extracted_text: text }).eq('file_id', file.file_id);
        parsedFiles.push({ filename: file.filename, text });
      } catch (parseErr) {
        console.error(`[Parse] Error parsing PDF ${file.filename}:`, parseErr);
      }
    }
  }

  const validFiles = parsedFiles.filter(f => f.text && f.text.trim().length > 0);
  if (validFiles.length === 0) {
    throw new Error('未能從保單文件中擷取出任何有效文字，無法進行條款對照。');
  }

  return validFiles.map(f => `[檔案名稱: ${f.filename}]\n${f.text}`).join('\n\n');
}

// ---------------------------------------------------------------------------
// API: Analyze policy (content keyword search or Gemini claims comparison)
// ---------------------------------------------------------------------------
app.post('/api/policy/:productId/analyze', async (req, res) => {
  const { productId } = req.params;
  const { keyword, analysisType } = req.body;

  if (!keyword) return res.status(400).json({ success: false, error: 'Missing keyword.' });

  const type = analysisType || 'content';

  try {
    console.log(`[Analyze] Analyzing product ${productId} for keyword "${keyword}" (type: ${type})...`);
    const citationText = await getPolicyFullText(productId);

    if (type === 'content') {
      const snippets = [];
      const { data: dbFiles } = await supabase
        .from('policy_files')
        .select('file_id, filename, extracted_text')
        .eq('product_id', productId);

      if (dbFiles) {
        for (const file of dbFiles) {
          if (!file.extracted_text) continue;
          const pages = file.extracted_text.split('\f');

          pages.forEach((pageText, pageIdx) => {
            if (!pageText.trim()) return;
            const pageNum = pageIdx + 1;
            const cleanText = pageText.replace(/\s+/g, ' ');
            const regex = new RegExp(`([^.!?\n\r]{0,60})(${keyword})([^.!?\n\r]{0,60})`, 'gi');
            let match;
            while ((match = regex.exec(cleanText)) !== null && snippets.length < 50) {
              snippets.push({
                fileId: file.file_id, filename: file.filename, pageNum,
                context: `...${match[1].trim()} **${match[2]}** ${match[3].trim()}...`
              });
              if (match.index === regex.lastIndex) regex.lastIndex++;
            }
          });
        }
      }

      return res.json({ success: true, analysisType: 'content', keyword, matchCount: snippets.length, results: snippets });
    } else {
      const geminiKey = process.env.GEMINI_API_KEY;

      if (!geminiKey) {
        console.log('[Analyze] GEMINI_API_KEY not found. Falling back to local keyword matching.');
        const cleanText = citationText.replace(/\s+/g, ' ');
        const regex = new RegExp(`([^.!?\n\r]{0,100})(${keyword})([^.!?\n\r]{0,100})`, 'gi');
        const snippets = [];
        let match;
        while ((match = regex.exec(cleanText)) !== null && snippets.length < 15) {
          snippets.push(`...${match[1].trim()} **${match[2]}** ${match[3].trim()}...`);
          if (match.index === regex.lastIndex) regex.lastIndex++;
        }

        const fallbackMarkdown = `
> [!WARNING]
> **智慧 AI 引擎離線中**
> 系統未設定 \`GEMINI_API_KEY\` 環境變數，因此無法為您進行智慧手術理賠比對。目前為您進行本地關鍵字條款檢索。

### 本地關鍵字條款檢索結果 (關鍵字: ${keyword})
${snippets.length > 0 ? snippets.map(s => `* ${s}`).join('\n') : '在保單條款中未找到直接提及該關鍵字的條款段落。'}

### 理賠建議
請手動確認上述條款內容，或請系統管理員於雲端環境（例如 Render 的 Environment Variables）中設定 \`GEMINI_API_KEY\` 以啟用全自動的臨床手術理賠比對分析。
`;
        return res.json({ success: true, analysisType: 'claim', keyword, fallback: true, markdown: fallbackMarkdown });
      }

      console.log(`[Analyze] Calling Gemini API for keyword: "${keyword}"...`);

      const maxLength = 60000;
      let truncatedText = citationText;
      if (citationText.length > maxLength) {
        truncatedText = citationText.substring(0, maxLength) + '\n\n[...保單內容過長，已截斷後半段...]';
      }

      const prompt = `
你是一位極其專業且經驗豐富的保險理賠分析法務顧問。
使用者目前查詢的理賠關鍵字（疾病、手術或治療項目）為：「${keyword}」。

我們已從使用者的 PDF 保單條款中擷取出以下條款內文：
---
${truncatedText}
---

請依據上述提供的保單條款內容，進行細緻的比對與推理，並以下列 Markdown 格式輸出繁體中文 (zh-TW) 的理賠分析報告：

# 關於「${keyword}」的理賠報告

> [!IMPORTANT]
> **理賠結論**
> [請明確給出是否理賠的結論，例如：**理賠可能性極高** / **可能理賠但有限制條件** / **不在理賠範圍內**]

## 一、 臨床常見治療與手術項目
[請先簡單說明與「${keyword}」相關的常見臨床治療、檢查或手術項目有哪些（例如：超音波水晶體乳化術、人工水晶體置換等）。]

## 二、 保單條款對照與理賠條款
[請查閱條款內文，指出與此項治療/手術相關的保單條款。]

## 三、 除外責任與限額條款
[檢查保單條款中是否有與此治療相關的除外責任或特別限制條件。]

## 四、 最終理賠分析結論與建議
[結合上述分析，以條列式方式給出使用者明確的理賠依據與申請建議。]

請確保你的回答邏輯嚴密，並且完全基於我們提供的保單條款進行比對與推論（若條款內沒有定義，請直接說明條款未提及該項目），請勿憑空捏造條款。`;

      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`;

      let apiResponse;
      let fetchErr = null;
      try {
        apiResponse = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
      } catch (e) {
        console.error('[Analyze] Gemini API fetch exception:', e);
        fetchErr = e;
      }

      let fallbackNeeded = false;
      let warningMsg = '';
      let generatedText = '';

      if (fetchErr) {
        fallbackNeeded = true;
        warningMsg = `智慧 AI 引擎連線異常 (${fetchErr.message})，已自動降級為本地關鍵字條款檢索。`;
      } else if (!apiResponse.ok) {
        const errBody = await apiResponse.text();
        console.error('[Analyze] Gemini API error response:', errBody);
        fallbackNeeded = true;
        if (apiResponse.status === 429) {
          warningMsg = '您的 Google Gemini API 金鑰今日免費額度已用完，或暫時超出頻率限制 (Rate Limit 429)，已自動降級為本地關鍵字條款檢索。';
        } else if (apiResponse.status === 503) {
          warningMsg = 'Google Gemini AI 伺服器目前流量過載 (Service Unavailable 503)，請稍後再試，已自動暫時降級為本地關鍵字條款檢索。';
        } else {
          warningMsg = `智慧 AI 引擎回應錯誤 (狀態碼: ${apiResponse.status})，已自動降級為本地關鍵字條款檢索。`;
        }
      } else {
        try {
          const responseData = await apiResponse.json();
          generatedText = responseData.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!generatedText) {
            fallbackNeeded = true;
            warningMsg = '智慧 AI 引擎未回傳有效文字內容，已自動降級為本地關鍵字條款檢索。';
          }
        } catch (jsonErr) {
          console.error('[Analyze] Failed to parse JSON response:', jsonErr);
          fallbackNeeded = true;
          warningMsg = '解析智慧 AI 引擎的回應時出錯，已自動降級為本地關鍵字條款檢索。';
        }
      }

      if (fallbackNeeded) {
        const cleanText = citationText.replace(/\s+/g, ' ');
        const regex = new RegExp(`([^.!?\n\r]{0,100})(${keyword})([^.!?\n\r]{0,100})`, 'gi');
        const snippets = [];
        let match;
        while ((match = regex.exec(cleanText)) !== null && snippets.length < 15) {
          snippets.push(`...${match[1].trim()} **${match[2]}** ${match[3].trim()}...`);
          if (match.index === regex.lastIndex) regex.lastIndex++;
        }

        const fallbackMarkdown = `
> [!WARNING]
> **${warningMsg}**

### 本地關鍵字條款檢索結果 (關鍵字: ${keyword})
${snippets.length > 0 ? snippets.map(s => `* ${s}`).join('\n') : '在保單條款中未找到直接提及該關鍵字的條款段落。'}

### 理賠建議
請手動確認上述條款內容，或稍後再試以使用 AI 智慧理賠比對分析功能。
`;
        return res.json({ success: true, analysisType: 'claim', keyword, fallback: true, markdown: fallbackMarkdown });
      }

      return res.json({ success: true, analysisType: 'claim', keyword, fallback: false, markdown: generatedText });
    }
  } catch (err) {
    console.error('[Analyze] error:', err);
    res.status(500).json({ success: false, error: '分析失敗：' + err.message });
  }
});

// ---------------------------------------------------------------------------
// API: Estimate claim based on diagnosis certificate and receipt images
// ---------------------------------------------------------------------------
app.post('/api/policy/:productId/estimate', async (req, res) => {
  const { productId } = req.params;
  const { certImage, receiptImage } = req.body;

  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    return res.status(400).json({
      success: false,
      error: '系統未偵測到 GEMINI_API_KEY 環境變數。此智慧理算功能需要 Gemini API 金鑰進行圖片 OCR 與多模態推理，請在 local_env.bat 中設定並重新啟動服務。'
    });
  }

  if (!certImage && !receiptImage) {
    return res.status(400).json({ success: false, error: '請至少上傳診斷證明書或醫療費用收據其中一張圖片。' });
  }

  try {
    console.log(`[Estimate] Extracting/Checking text for product ${productId}...`);
    const citationText = await getPolicyFullText(productId);

    const maxLength = 60000;
    let truncatedText = citationText;
    if (citationText.length > maxLength) {
      truncatedText = citationText.substring(0, maxLength) + '\n\n[...保單內容過長，已截斷後半段...]';
    }

    console.log(`[Estimate] Constructing multimodal prompt for Gemini...`);

    const prompt = `
你是一位極其專業且經驗豐富的保險理賠理算師 (Claims Adjuster/Auditor)。
使用者目前提供了一張「診斷證明書」照片及/或「醫療費用收據」照片，並希望對照以下「保單條款文字」進行理賠金額的精確理算與試算。

以下是保單條款內文：
---
${truncatedText}
---

請對照片中的診斷書及收據進行細緻的分析、OCR 識別與比對，並輸出繁體中文 (zh-TW) 的理賠估算報告，需包含表格化的理算對照與詳細說明，並在最後給出擇優給付結論與申請建議。若圖片模糊無法看清，請在報告中指出。`;

    const parts = [{ text: prompt }];

    if (certImage && certImage.data) {
      parts.push({ inlineData: { mimeType: certImage.mimeType || 'image/jpeg', data: certImage.data } });
    }
    if (receiptImage && receiptImage.data) {
      parts.push({ inlineData: { mimeType: receiptImage.mimeType || 'image/jpeg', data: receiptImage.data } });
    }

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`;

    console.log(`[Estimate] Calling Gemini 2.0 Flash Multimodal API...`);
    const apiResponse = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }] })
    });

    if (!apiResponse.ok) {
      const errBody = await apiResponse.text();
      console.error('[Estimate] Gemini API error response:', errBody);
      let errorMsg = `智慧 AI 引擎回應錯誤 (狀態碼: ${apiResponse.status})`;
      if (apiResponse.status === 429) {
        errorMsg = '您的 Google Gemini API 金鑰今日免費額度已用完，或暫時超出頻率限制 (Rate Limit 429)，請稍後再試。';
      } else if (apiResponse.status === 503) {
        errorMsg = 'Google Gemini AI 伺服器目前流量過載 (Service Unavailable 503)，請稍後再試。';
      }
      return res.status(apiResponse.status).json({ success: false, error: errorMsg });
    }

    const responseData = await apiResponse.json();
    const generatedText = responseData.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!generatedText) {
      return res.status(500).json({ success: false, error: '智慧 AI 引擎未回傳有效理算報告文字內容。' });
    }

    console.log(`[Estimate] Claim estimation completed successfully.`);
    res.json({ success: true, markdown: generatedText });
  } catch (err) {
    console.error('[Estimate] Logic error:', err);
    res.status(500).json({ success: false, error: '理算分析失敗：' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`  TII Policy Crawler Server running on port ${PORT}`);
  console.log(`  Open http://localhost:${PORT} in your browser`);
  console.log(`  Debug HTML dumps saved to: ${DEBUG_DIR}`);
  console.log(`==================================================`);
});
