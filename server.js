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

// Initialize Supabase Client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('ERROR: Missing SUPABASE_URL or SUPABASE_KEY environment variables.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false
  }
});

console.log('[Supabase] Initialized client targeting:', supabaseUrl);

// Helper to ensure company is registered
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
  
  // Use Supabase upsert
  const { error } = await supabase
    .from('companies')
    .upsert({ code, name: companyName }, { onConflict: 'code' });
    
  if (error) {
    console.error('[Supabase] ensureCompany error:', error.message);
    throw error;
  }
  return companyName;
}

// Sessions store
const activeSessions = {};

// Clean up old sessions every hour
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

// API: Initialize a session and get captcha
app.get('/api/session', async (req, res) => {
  try {
    const baseUrl = 'https://insprod.tii.org.tw';
    const mainUrl = `${baseUrl}/Query.aspx`;
    
    console.log(`[Session] Fetching ${mainUrl} to start session...`);
    const mainRes = await fetch(mainUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    // Extract cookies robustly
    let cookieArr = [];
    if (typeof mainRes.headers.getSetCookie === 'function') {
      cookieArr = mainRes.headers.getSetCookie(); // Correctly get all set-cookie headers
    } else {
      const single = mainRes.headers.get('set-cookie');
      if (single) cookieArr = [single];
    }
    const cookieStr = cookieArr.map(c => c.split(';')[0].trim()).join('; ');
    console.log(`[Session] Captured cookies: ${cookieStr}`);
    
    const sessionId = crypto.randomUUID();
    activeSessions[sessionId] = {
      cookies: cookieStr,
      timestamp: Date.now()
    };
    
    // Fetch captcha
    const captchaUrl = `${baseUrl}/bmp.ashx`;
    console.log(`[Session] Fetching captcha for session ${sessionId}...`);
    const captchaRes = await fetch(captchaUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cookie': cookieStr
      }
    });
    
    const buffer = await captchaRes.arrayBuffer();
    const base64Image = Buffer.from(buffer).toString('base64');
    
    res.json({
      success: true,
      sessionId,
      captcha: `data:image/jpeg;base64,${base64Image}`
    });
  } catch (err) {
    console.error('Error starting session:', err);
    res.status(500).json({ success: false, error: 'Failed to initialize session with TII.' });
  }
});

// API: Perform search
app.post('/api/search', async (req, res) => {
  const { sessionId, keyword, categoryId, captcha, forceRefresh } = req.body;
  
  if (!keyword) {
    return res.status(400).json({ success: false, error: 'Missing keyword.' });
  }
  
  const force = forceRefresh === true || forceRefresh === 'true';
  const cat = categoryId || '2'; // Default to life insurance
  
  if (!force) {
    // Check Supabase database cache
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
      console.log(`[Search] Cache HIT for keyword: "${keyword}" category: "${cat}". Found ${rows.length} policies.`);
      // Transform keys to frontend camelCase
      const results = rows.map(r => ({
        productId: r.product_id,
        name: r.name,
        startDate: r.start_date,
        endDate: r.end_date,
        categoryId: r.category_id
      }));
      return res.json({
        success: true,
        fromCache: true,
        results
      });
    }
    
    // No cache hit, check if captcha parameters exist
    if (!captcha || !sessionId) {
      console.log(`[Search] Cache MISS for "${keyword}". Requiring captcha.`);
      return res.json({ success: false, needCaptcha: true });
    }
    
    // Captcha provided, query TII
    await queryTII(sessionId, keyword, cat, captcha, res);
  } else {
    // Force refresh requires captcha
    if (!captcha || !sessionId) {
      return res.json({ success: false, needCaptcha: true, error: '強制重新整理需要輸入驗證碼' });
    }
    await queryTII(sessionId, keyword, cat, captcha, res);
  }
});

// Helper function to query TII and cache results
async function queryTII(sessionId, keyword, categoryId, captcha, res) {
  const session = activeSessions[sessionId];
  if (!session) {
    return res.status(400).json({ success: false, error: 'Session expired. Please refresh the page.' });
  }
  
  try {
    const baseUrl = 'https://insprod.tii.org.tw';
    const postUrl = `${baseUrl}/ResultQueryAll.aspx`;
    
    console.log(`[Search] Querying TII: keyword="${keyword}" category="${categoryId}"...`);
    
        // Encode keyword to Big5 percent-encoding
    const keywordBuf = iconv.encode(keyword, 'big5');
    let big5PercentEncoded = '';
    for (let i = 0; i < keywordBuf.length; i++) {
      big5PercentEncoded += '%' + keywordBuf[i].toString(16).toUpperCase().padStart(2, '0');
    }
    
    const bodyStr = `postB=Y&isqry=Y&isquery=Y&categoryId=${categoryId || ''}&CompanyID=000&f_CategoryId1=&qry_beginDate_SD1=&qry_beginDate_SD2=&qry_endDate_ED1=&qry_endDate_ED2=&fQueryAll=${big5PercentEncoded}&bmpC=${captcha}`;
    
    const postRes = await fetch(postUrl, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': session.cookies,
        'Referer': `${baseUrl}/Query.aspx`
      },
      body: bodyStr
    });
    
    const postBuffer = await postRes.arrayBuffer();
    const html = iconv.decode(Buffer.from(postBuffer), 'big5');
    
    // Check for errors in the HTML using highly robust alert-based detection
    if (html.includes('alert(') && (html.includes('驗證碼') || html.includes('錯誤') || html.includes('失效'))) {
      return res.json({ success: false, errorType: 'captcha', error: '驗證碼錯誤或已失效，請點擊驗證碼重新整理輸入' });
    }
    
    const $ = cheerio.load(html);
    const results = [];
    const dbPromises = [];
    
    // Find all links referencing DetailList.aspx
    $('a[href*="DetailList.aspx"]').each((i, a) => {
      const link = $(a).attr('href');
      const nameText = $(a).text().trim();
      if (!nameText || nameText === '') return;
      
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
          results.push({
            productId,
            name: nameText,
            startDate,
            endDate,
            categoryId
          });
          
          // Store in database asynchronously
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
    
    // Wait for all DB insertions to finish before returning
    await Promise.all(dbPromises);
    
    console.log(`[Search] Successfully query and cached ${results.length} policies from TII.`);
    res.json({
      success: true,
      results
    });
  } catch (err) {
    console.error('TII Search error:', err);
    res.status(500).json({ success: false, error: 'Search failed.' });
  }
}

// API: Download all documents for a policy, caching them in Supabase Storage and DB
app.post('/api/download', async (req, res) => {
  const { sessionId, productId, productName } = req.body;
  
  if (!productId) {
    return res.status(400).json({ success: false, error: 'Missing parameters.' });
  }
  
  try {
    // 1. Check if files already exist in Supabase DB cache
    const { data: dbFiles, error: checkErr } = await supabase
      .from('policy_files')
      .select('file_id, filename, doc_type, size_bytes')
      .eq('product_id', productId);
      
    if (checkErr) {
      console.error('[Supabase] Check cached files error:', checkErr.message);
    }
    
    if (dbFiles && dbFiles.length > 0) {
      console.log(`[Download] Cache HIT for product: "${productName}" (${productId}). Found ${dbFiles.length} files.`);
      
      const filesList = dbFiles.map(f => ({
        fileId: f.file_id,
        filename: f.filename,
        docType: f.doc_type,
        sizeBytes: f.size_bytes
      }));
      
      return res.json({
        success: true,
        fromCache: true,
        productName,
        productId,
        files: filesList
      });
    }
    
    // 2. Cache MISS, must scrape TII, requires session
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
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cookie': session.cookies
      }
    });
    
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
        if (prevTr.length > 0) {
          docType = prevTr.text().trim().replace(/\s+/g, ' ');
        }
        
        downloadLinks.push({
          href: href.trim(),
          filename: text,
          docType
        });
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
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Cookie': session.cookies,
          'Referer': detailUrl
        }
      });
      
      if (fileRes.status === 200) {
        const contentType = fileRes.headers.get('content-type') || '';
        if (contentType.includes('text/html')) {
          console.log(`[Download] Warning: File ${link.filename} returned HTML. Skipping.`);
          continue;
        }
        
        const buffer = await fileRes.arrayBuffer();
        const nodeBuffer = Buffer.from(buffer);
        
        // A. Upload to Supabase Storage
        const storagePath = `policies/${productId}/${link.filename}`;
        const { error: uploadErr } = await supabase.storage
          .from('policy-attachments')
          .upload(storagePath, nodeBuffer, {
            contentType: 'application/pdf',
            upsert: true
          });
          
        if (uploadErr) {
          console.error('[Supabase Storage] Upload error:', uploadErr.message);
          continue;
        }
        
        // B. Insert metadata into policy_files table
        const fileId = crypto.randomUUID();
        const { error: dbErr } = await supabase
          .from('policy_files')
          .insert({
            file_id: fileId,
            product_id: productId,
            filename: link.filename,
            doc_type: link.docType,
            storage_path: storagePath,
            size_bytes: buffer.byteLength,
            downloaded_at: Date.now()
          });
          
        if (dbErr) {
          console.error('[Supabase DB] File insert error:', dbErr.message);
          continue;
        }
        
        downloadedFiles.push({
          fileId,
          filename: link.filename,
          docType: link.docType,
          sizeBytes: buffer.byteLength
        });
      } else {
        console.log(`[Download] Failed to download ${link.filename}. Status: ${fileRes.status}`);
      }
    }
    
    res.json({
      success: true,
      productName,
      productId,
      files: downloadedFiles
    });
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ success: false, error: 'Failed to download policy files.' });
  }
});

// API: Get archive directory (grouped by company)
app.get('/api/archive', (req, res) => {
  db.all(
    `SELECT DISTINCT c.code, c.name FROM companies c
     INNER JOIN policies p ON p.companyCode = c.code`,
    [],
    (err, companies) => {
      if (err) {
        console.error('[Database] Fetch companies error:', err.message);
        return res.status(500).json({ success: false, error: 'Failed to fetch archived companies.' });
      }
      
      db.all(
        `SELECT p.productId, p.name, p.startDate, p.endDate, p.categoryId, p.companyCode,
                COUNT(f.fileId) as filesCount
         FROM policies p
         LEFT JOIN policy_files f ON f.productId = p.productId
         GROUP BY p.productId`,
        [],
        (err, policies) => {
          if (err) {
            console.error('[Database] Fetch policies error:', err.message);
            return res.status(500).json({ success: false, error: 'Failed to fetch archived policies.' });
          }
          
          res.json({
            success: true,
            companies,
            policies
          });
        }
      );
        }
  );
});

// API: Get archive directory (grouped by company)
app.get('/api/archive', async (req, res) => {
  try {
    // 1. Fetch all companies
    const { data: companies, error: compErr } = await supabase
      .from('companies')
      .select('code, name');
      
    if (compErr) throw compErr;
    
    // 2. Fetch all policies with related policy_files count
    const { data: policiesData, error: polErr } = await supabase
      .from('policies')
      .select(`
        product_id,
        name,
        start_date,
        end_date,
        category_id,
        company_code,
        policy_files (count)
      `);
      
    if (polErr) throw polErr;
    
    // Transform keys to frontend camelCase
    const policies = policiesData.map(p => ({
      productId: p.product_id,
      name: p.name,
      startDate: p.start_date,
      endDate: p.end_date,
      categoryId: p.category_id,
      companyCode: p.company_code,
      filesCount: p.policy_files?.[0]?.count || 0
    }));
    
    // Filter active companies (companies with at least one policy in DB)
    const activeCompanyCodes = new Set(policies.map(p => p.companyCode));
    const filteredCompanies = companies.filter(c => activeCompanyCodes.has(c.code));
    
    res.json({
      success: true,
      companies: filteredCompanies,
      policies
    });
  } catch (err) {
    console.error('[Supabase] Fetch archive error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch archived data.' });
  }
});

// API: Get files list for a policy
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
  
  const files = rows.map(r => ({
    fileId: r.file_id,
    filename: r.filename,
    docType: r.doc_type,
    sizeBytes: r.size_bytes
  }));
  
  res.json({
    success: true,
    files: files || []
  });
});

// API: Serve binary PDF file from Supabase Storage
app.get('/api/file/:fileId', async (req, res) => {
  const { fileId } = req.params;
  
  try {
    // 1. Fetch metadata from DB
    const { data: fileMeta, error: dbErr } = await supabase
      .from('policy_files')
      .select('filename, doc_type, storage_path, size_bytes')
      .eq('file_id', fileId)
      .single();
      
    if (dbErr || !fileMeta) {
      console.error('[Supabase] Fetch file meta error:', dbErr?.message);
      return res.status(404).send('File not found in database.');
    }
    
    // 2. Download buffer from Supabase Storage
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
    if (ext === '.pdf') {
      contentType = 'application/pdf';
    } else if (ext === '.doc' || ext === '.docx') {
      contentType = 'application/msword';
    }
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileMeta.filename)}"`);
    res.setHeader('Content-Length', fileMeta.size_bytes);
    res.send(buffer);
  } catch (err) {
    console.error('File stream error:', err);
    res.status(500).send('Server error downloading file.');
  }
});

// Helper to retrieve policy text, downloading and parsing if needed
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
      // Download from Supabase Storage
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
          
        // Cache text back to DB
        await supabase
          .from('policy_files')
          .update({ extracted_text: text })
          .eq('file_id', file.file_id);
          
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

// API: Analyze policy using simple keyword context search or Gemini claims comparison
app.post('/api/policy/:productId/analyze', async (req, res) => {
  const { productId } = req.params;
  const { keyword, analysisType } = req.body;
  
  if (!keyword) {
    return res.status(400).json({ success: false, error: 'Missing keyword.' });
  }
  
  const type = analysisType || 'content'; // 'content' or 'claim'
  
  try {
    console.log(`[Analyze] Analyzing product ${productId} for keyword "${keyword}" (type: ${type})...`);
    const citationText = await getPolicyFullText(productId);
    
    // 3. Perform analysis
    if (type === 'content') {
      // Simple keyword search: return contextual snippets grouped with file references and page numbers
      const snippets = [];
      
      // Query file metadata for references
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
                fileId: file.file_id,
                filename: file.filename,
                pageNum,
                context: `...${match[1].trim()} **${match[2]}** ${match[3].trim()}...`
              });
              if (match.index === regex.lastIndex) {
                regex.lastIndex++;
              }
            }
          });
        }
      }
      
      return res.json({
        success: true,
        analysisType: 'content',
        keyword,
        matchCount: snippets.length,
        results: snippets
      });
      
    } else {
      // Claim Analysis (using Gemini API)
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
        return res.json({
          success: true,
          analysisType: 'claim',
          keyword,
          fallback: true,
          markdown: fallbackMarkdown
        });
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

# 關於「${keyword}」的理賠分析報告

> [!IMPORTANT]
> **理賠結論**
> [請明確給出是否理賠的結論，例如：**理賠可能性極高** / **可能理賠但有限制條件** / **不在理賠範圍內**]

## 一、 臨床常見治療與手術項目
[請先簡單說明與「${keyword}」相關的常見臨床治療、檢查或手術項目有哪些（例如：超音波水晶體乳化術、人工水晶體置換等）。]

## 二、 保單條款對照與理賠條款
[請查閱條款內文，指出與此項治療/手術相關的保單條款。例如：
- 是否屬於「住院手術」或「門診手術」理賠項目？
- 實支實付醫療險的「雜費」或「手術費」限額條款。
- 是否有明確定義的手術列表比例？請引用條款中提及的具體文字。]

## 三、 除外責任與限額條款
[檢查保單條款中是否有與此治療相關的除外責任（例如：美容、非治療性手術、等待期限制、既往症排除、非健保身分給付折算比例等）或特別限制條件。]

## 四、 最終理賠分析結論與建議
[結合上述分析，以條列式方式給出使用者明確的理賠依據與申請建議（如：需要診斷書如何記載開刀名稱、收據收費項目開立建議等）。]

請確保你的回答邏輯嚴密，並且完全基於我們提供的保單條款進行比對與推論（若條款內沒有定義，請直接說明條款未提及該項目），請勿憑空捏造條款。`;
      
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`;
      
      let apiResponse;
      let fetchErr = null;
      try {
        apiResponse = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [{ text: prompt }]
            }]
          })
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
        return res.json({
          success: true,
          analysisType: 'claim',
          keyword,
          fallback: true,
          markdown: fallbackMarkdown
        });
      }
      
      return res.json({
        success: true,
        analysisType: 'claim',
        keyword,
        fallback: false,
        markdown: generatedText
      });
    }
  } catch (err) {
    console.error('[Analyze] error:', err);
    res.status(500).json({ success: false, error: '分析失敗：' + err.message });
  }
});

// API: Estimate claim based on diagnosis certificate and receipt images + policy terms
app.post('/api/policy/:productId/estimate', async (req, res) => {
  const { productId } = req.params;
  const { certImage, receiptImage } = req.body; // certImage = { data, mimeType }, receiptImage = { data, mimeType }
  
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
    
    // 3. Construct Gemini Multimodal Request
    console.log(`[Estimate] Constructing multimodal prompt for Gemini...`);
    
    const prompt = `
你是一位極其專業且經驗豐富的保險理賠理算師 (Claims Adjuster/Auditor)。
使用者目前提供了一張「診斷證明書」照片及/或「醫療費用收據」照片，並希望對照以下「保單條款文字」進行理賠金額的精確理算與試算。

以下是保單條款內文：
---
${truncatedText}
---

請對照片中的診斷書及收據進行細緻的分析、OCR 識別與比對。
請特別注意：理賠試算必須呈現出「表格化」的清晰對照，同時附帶詳細的文字理算說明。

請完全依據以下 Markdown 格式與架構輸出繁體中文 (zh-TW) 的理賠估算報告：

# 智慧理賠理算與試算報告

## [保單/商品名稱，例如：國泰人壽新全意住院醫療健康保險附約] 理賠估算報告

> [!IMPORTANT]
> **預估總理賠金額**
> ## NT$ [請在比對計算後，給出合理的預估總金額。例如：112,095] 元
> *此金額為基於您上傳的診斷書與收據條款估算，實際給付金額以保險公司最終審核為準。*

### 📊 理賠試算總表

| 方案 / 保障項目 | 計算公式與明細 | 預估理賠金額 | 核賠說明 |
| :--- | :--- | :--- | :--- |
| **方案一：實支實付型** | | | |
| 1. 住院經常費用保險金 | 每日 NT$ [單價] x [天數] 天 (限額 NT$ [上限] 元) | NT$ [核付小計] 元 | 實報實銷，小於限額全額理賠 / 超出限額以限額給付 |
| 2. 住院醫療費用金 (雜費) | 健保自付額 + 處置費 + 材料費 + 證明書費 | NT$ [核付小計] 元 | 實際花費總計 NT$ [花費] 元 (限額 NT$ [上限] 元) |
| **方案一總計** | **住院經常費用 + 醫療雜費** | **NT$ [方案一總額] 元** | **實支實付型核賠總金額** |
| **方案二：日額給付型** | | | |
| 住院日額給付金 | 每日固定日額 NT$ [日額] x [天數] 天 | NT$ [方案二總額] 元 | 按實際住院天數給付固定日額 |
| **💡 最終理賠結論** | **擇優給付 (方案一 vs 方案二)** | **NT$ [最高者金額] 元** | **依條款擇優給付 [方案一/方案二]** |

---

### 🔍 關鍵條款與核賠規則確認
1. **同一次住院判定**：[依據條款規定（例如：第4條：出院與再入院日期間隔未超過 14 日，其各項給付合計額及限額均視為同一次住院辦理），判定上傳的多張收據或診斷書是否屬於同一次住院，額度是否需合併/共用。]
2. **給付選擇判定**：[依據條款規定（例如：被保險人可選擇「實支實付型」或「日額給付型」申請保險金），說明保險公司在實務上會採取擇優給付的原則。]

---

### 📋 詳細理算說明明細

#### 1. 方案一：實支實付型詳細試算
* **A. 每日住院經常費用保險金（限額：每日 [金額] 元）**：
  * **理賠範圍**：[說明條款理賠範圍，如是否包含超等病房費差額、膳食費、護理費等，並註明條款中是否有特殊約定（例如膳食費是否給付）。]
  * **天數計算**：住院起訖期間（例如 5/18 至 7/10，共計 54 天）。總限額為：54 天 x [每日額度] 元 = [總額] 元。
  * **實際花費明細**：[條列式列出各收據對應之超等病房差額、膳食費、護理費等明細並計算總和。]
  * **核賠結果**：[說明實際花費是否小於總限額，給出核付金額。]
* **B. 每次住院醫療費用保險金 / 雜費（限額：[金額] 元）**：
  * **理賠範圍**：[說明條款理賠範圍，包括證明書費、自負額、醫師指示用藥、材料費、特材等。]
  * **實際花費明細**：[條列式列出各收據對應之自費項目明細與總和。例如：
    - 醫院A收據：急性自負額 XX 元 + 證明書 XX 元 = XX 元。
    - 醫院B收據：部分負擔 XX 元 + 特材 XX 元 = XX 元。
    - 合併總額：XX 元。]
  * **核賠結果**：[說明實際花費是否超出限額，給出核付金額。]

#### 2. 方案二：日額給付型詳細試算
* **理賠標準**：按實際住院日數乘以「住院日額」給付。本計劃之住院日額為每日 [日額] 元。
* **日額給付總計**：[天數] 天 × [日額] 元 = **[總計]** 元。

---

### 💡 最終理賠總額預估結論與建議
* **核賠結論**：[詳細比較方案一與方案二的試算金額，說明依據條款「擇優給付」原則，以金額較高者（如：方案一的 112,095 元）作為預估理賠總額。]
* **理賠申請建議**：[給予理賠申請建議，例如：診斷書上應如何記載開刀名稱、收據收費項目開立建議、是否需要正本等。]

請確保你的理算回答邏輯嚴密，並且完全基於我們提供的保單條款與收據/診斷書圖片內容進行比對與精確試算，不得捏造事實或概括帶過。若有圖片模糊無法看清的文字，請在報告中指出並說明。
`;

    const parts = [{ text: prompt }];

    if (certImage && certImage.data) {
      parts.push({
        inlineData: {
          mimeType: certImage.mimeType || 'image/jpeg',
          data: certImage.data
        }
      });
    }

    if (receiptImage && receiptImage.data) {
      parts.push({
        inlineData: {
          mimeType: receiptImage.mimeType || 'image/jpeg',
          data: receiptImage.data
        }
      });
    }

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`;
    
    console.log(`[Estimate] Calling Gemini 2.0 Flash Multimodal API...`);
    const apiResponse = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }]
      })
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
    res.json({
      success: true,
      markdown: generatedText
    });
    
  } catch (err) {
    console.error('[Estimate] Logic error:', err);
    res.status(500).json({ success: false, error: '理算分析失敗：' + err.message });
  }
});


app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`  TII Policy Crawler Server running on port ${PORT}`);
  console.log(`  Open http://localhost:${PORT} in your browser`);
  console.log(`==================================================`);
});
