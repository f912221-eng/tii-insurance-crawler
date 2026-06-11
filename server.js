process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const express = require('express');
const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const crypto = require('crypto');
const { PDFParse } = require('pdf-parse');

const app = express();
const PORT = process.env.PORT || 3005;

// Database Initialization
const dbPath = process.env.DATABASE_FILE || path.join(__dirname, 'tii_cache.db');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  // 1. Companies Table
  db.run(`
    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE,
      name TEXT
    )
  `);

  // 2. Policies Table
  db.run(`
    CREATE TABLE IF NOT EXISTS policies (
      productId TEXT PRIMARY KEY,
      name TEXT,
      companyCode TEXT,
      startDate TEXT,
      endDate TEXT,
      categoryId TEXT,
      lastUpdated INTEGER
    )
  `);

  // 3. Policy Files Table
  db.run(`
    CREATE TABLE IF NOT EXISTS policy_files (
      fileId TEXT PRIMARY KEY,
      productId TEXT,
      filename TEXT,
      docType TEXT,
      fileData BLOB,
      sizeBytes INTEGER,
      downloadedAt INTEGER,
      FOREIGN KEY(productId) REFERENCES policies(productId)
    )
  `);

  // Migration: Add extractedText column if not exists
  db.all("PRAGMA table_info(policy_files)", (err, columns) => {
    if (err) {
      console.error('[Database] Migration check failed:', err.message);
      return;
    }
    const hasCol = columns && columns.some(c => c.name === 'extractedText');
    if (!hasCol) {
      db.run("ALTER TABLE policy_files ADD COLUMN extractedText TEXT", (err) => {
        if (err) {
          console.error('[Database] ALTER TABLE migration failed:', err.message);
        } else {
          console.log('[Database] Migration successful: added extractedText column to policy_files.');
        }
      });
    }
  });
  
  console.log('[Database] SQLite Database tables initialized at:', dbPath);
});

// Helper to ensure company is registered
function ensureCompany(code, productName) {
  return new Promise((resolve, reject) => {
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
    
    db.run(
      `INSERT INTO companies (code, name) VALUES (?, ?) 
       ON CONFLICT(code) DO UPDATE SET name=excluded.name WHERE name LIKE '%-保險公司'`,
      [code, companyName],
      function(err) {
        if (err) return reject(err);
        resolve(companyName);
      }
    );
  });
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

// Ensure downloads directory exists
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

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
    
    // Extract cookies
    const cookieHeader = mainRes.headers.get('set-cookie');
    let cookieStr = '';
    if (cookieHeader) {
      cookieStr = cookieHeader.split(',').map(c => c.split(';')[0].trim()).join('; ');
    }
    
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
    // Check local database cache
    db.all(
      `SELECT productId, name, startDate, endDate, categoryId FROM policies 
       WHERE (name LIKE ? OR companyCode = ?) AND categoryId = ?`,
      [`%${keyword}%`, keyword, cat],
      async (err, rows) => {
        if (err) {
          console.error('[Database] Search cache error:', err.message);
          return res.status(500).json({ success: false, error: 'Database search error.' });
        }
        
        if (rows && rows.length > 0) {
          console.log(`[Search] Cache HIT for keyword: "${keyword}" category: "${cat}". Found ${rows.length} policies.`);
          return res.json({
            success: true,
            fromCache: true,
            results: rows
          });
        }
        
        // No cache hit, check if captcha parameters exist
        if (!captcha || !sessionId) {
          console.log(`[Search] Cache MISS for "${keyword}". Requiring captcha.`);
          return res.json({ success: false, needCaptcha: true });
        }
        
        // Captcha provided, query TII
        await queryTII(sessionId, keyword, cat, captcha, res);
      }
    );
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
    
    const formData = new URLSearchParams();
    formData.append('postB', 'Y');
    formData.append('isqry', 'Y');
    formData.append('isquery', 'Y');
    formData.append('categoryId', categoryId || '');
    formData.append('CompanyID', '000');
    formData.append('f_CategoryId1', '');
    formData.append('qry_beginDate_SD1', '');
    formData.append('qry_beginDate_SD2', '');
    formData.append('qry_endDate_ED1', '');
    formData.append('qry_endDate_ED2', '');
    formData.append('fQueryAll', keyword);
    formData.append('bmpC', captcha);
    
    const postRes = await fetch(postUrl, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': session.cookies,
        'Referer': `${baseUrl}/Query.aspx`
      },
      body: formData.toString()
    });
    
    const html = await postRes.text();
    
    // Check for errors in the HTML
    if (html.includes('識別碼不正確') || html.includes('驗證碼錯誤') || html.includes('識別碼錯誤') || html.includes('請輸入圖形驗證碼')) {
      return res.json({ success: false, errorType: 'captcha', error: '驗證碼錯誤或失效，請重新輸入！' });
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
            .then(() => {
              return new Promise((resolve) => {
                db.run(
                  `INSERT OR REPLACE INTO policies (productId, name, companyCode, startDate, endDate, categoryId, lastUpdated)
                   VALUES (?, ?, ?, ?, ?, ?, ?)`,
                  [productId, nameText, companyCode, startDate, endDate, categoryId, Date.now()],
                  (err) => {
                    if (err) console.error('[Database] Policy insert error:', err.message);
                    resolve();
                  }
                );
              });
            })
            .catch(err => console.error('[Database] Company registration error:', err.message));
            
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

// API: Download all documents for a policy, caching them in SQLite BLOBs
app.post('/api/download', async (req, res) => {
  const { sessionId, productId, productName } = req.body;
  
  if (!productId) {
    return res.status(400).json({ success: false, error: 'Missing parameters.' });
  }
  
  // 1. Check if files already exist in local database cache
  db.all(
    `SELECT fileId, filename, docType, sizeBytes FROM policy_files WHERE productId = ?`,
    [productId],
    async (err, dbFiles) => {
      if (err) {
        console.error('[Database] Check cached files error:', err.message);
      }
      
      if (dbFiles && dbFiles.length > 0) {
        console.log(`[Download] Cache HIT for product: "${productName}" (${productId}). Found ${dbFiles.length} files.`);
        
        const safeFolderName = (productName || productId).replace(/[\\/:*?"<>|]/g, '_');
        const policyDir = path.join(downloadsDir, safeFolderName);
        if (!fs.existsSync(policyDir)) {
          fs.mkdirSync(policyDir, { recursive: true });
        }
        
        const filesList = [];
        for (const file of dbFiles) {
          const savePath = path.join(policyDir, file.filename);
          if (!fs.existsSync(savePath)) {
            await new Promise((resolve) => {
              db.get(
                `SELECT fileData FROM policy_files WHERE fileId = ?`,
                [file.fileId],
                (err, row) => {
                  if (!err && row && row.fileData) {
                    fs.writeFileSync(savePath, row.fileData);
                  }
                  resolve();
                }
              );
            });
          }
          
          filesList.push({
            fileId: file.fileId,
            filename: file.filename,
            docType: file.docType,
            sizeBytes: file.sizeBytes,
            localPath: savePath
          });
        }
        
        return res.json({
          success: true,
          fromCache: true,
          productName,
          productId,
          policyFolder: policyDir,
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
      
      try {
        const baseUrl = 'https://insprod.tii.org.tw';
        const detailUrl = `${baseUrl}/DetailList.aspx?productId=${productId}`;
        
        console.log(`[Download] Cache MISS. Fetching detail page: ${detailUrl}...`);
        const detailRes = await fetch(detailUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Cookie': session.cookies
          }
        });
        
        const detailHtml = await detailRes.text();
        if (detailHtml.includes('識別碼錯誤') || detailHtml.includes('請重新輸入識別碼')) {
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
        const dbPromises = [];
        
        const safeFolderName = (productName || productId).replace(/[\\/:*?"<>|]/g, '_');
        const policyDir = path.join(downloadsDir, safeFolderName);
        if (!fs.existsSync(policyDir)) {
          fs.mkdirSync(policyDir, { recursive: true });
        }
        
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
            
            const savePath = path.join(policyDir, link.filename);
            fs.writeFileSync(savePath, nodeBuffer);
            
            const fileId = crypto.randomUUID();
            downloadedFiles.push({
              fileId,
              filename: link.filename,
              docType: link.docType,
              sizeBytes: buffer.byteLength,
              localPath: savePath
            });
            
            const p = new Promise((resolve) => {
              db.run(
                `INSERT OR REPLACE INTO policy_files (fileId, productId, filename, docType, fileData, sizeBytes, downloadedAt)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [fileId, productId, link.filename, link.docType, nodeBuffer, buffer.byteLength, Date.now()],
                (err) => {
                  if (err) console.error('[Database] Failed to save file BLOB:', err.message);
                  resolve();
                }
              );
            });
            dbPromises.push(p);
          } else {
            console.log(`[Download] Failed to download ${link.filename}. Status: ${fileRes.status}`);
          }
        }
        
        await Promise.all(dbPromises);
        
        res.json({
          success: true,
          productName,
          productId,
          policyFolder: policyDir,
          files: downloadedFiles
        });
      } catch (err) {
        console.error('Download error:', err);
        res.status(500).json({ success: false, error: 'Failed to download policy files.' });
      }
    }
  );
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

// API: Get files list for a policy
app.get('/api/policy/:productId/files', (req, res) => {
  const { productId } = req.params;
  db.all(
    `SELECT fileId, filename, docType, sizeBytes FROM policy_files WHERE productId = ?`,
    [productId],
    (err, rows) => {
      if (err) {
        console.error('[Database] Fetch policy files error:', err.message);
        return res.status(500).json({ success: false, error: 'Database error.' });
      }
      res.json({
        success: true,
        files: rows || []
      });
    }
  );
});

// API: Serve binary PDF file from SQLite BLOB
app.get('/api/file/:fileId', (req, res) => {
  const { fileId } = req.params;
  db.get(
    `SELECT filename, docType, fileData, sizeBytes FROM policy_files WHERE fileId = ?`,
    [fileId],
    (err, row) => {
      if (err) {
        console.error('[Database] Fetch file error:', err.message);
        return res.status(500).send('Database error.');
      }
      if (!row) {
        return res.status(404).send('File not found in database.');
      }
      
      let contentType = 'application/octet-stream';
      const ext = path.extname(row.filename).toLowerCase();
      if (ext === '.pdf') {
        contentType = 'application/pdf';
      } else if (ext === '.doc' || ext === '.docx') {
        contentType = 'application/msword';
      }
      
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.filename)}"`);
      res.setHeader('Content-Length', row.sizeBytes);
      res.send(row.fileData);
    }
  );
});

// API: Analyze policy using simple keyword context search or Gemini claims comparison
app.post('/api/policy/:productId/analyze', async (req, res) => {
  const { productId } = req.params;
  const { keyword, analysisType } = req.body;
  
  if (!keyword) {
    return res.status(400).json({ success: false, error: 'Missing keyword.' });
  }
  
  const type = analysisType || 'content'; // 'content' or 'claim'
  
  // 1. Get all policy files from DB
  db.all(
    `SELECT fileId, filename, fileData, extractedText FROM policy_files WHERE productId = ?`,
    [productId],
    async (err, files) => {
      if (err) {
        console.error('[Analyze] DB fetch files error:', err.message);
        return res.status(500).json({ success: false, error: 'Database error.' });
      }
      
      if (!files || files.length === 0) {
        return res.status(404).json({ success: false, error: '此保單目前尚未下載備查條款檔案，請先執行「下載備查」或「開始自動檢索」並同步條款。' });
      }
      
      try {
        console.log(`[Analyze] Analyzing product ${productId} for keyword "${keyword}" (type: ${type})...`);
        
        // 2. Extract text for files that don't have it cached
        let fullText = '';
        const promises = files.map(file => {
          return new Promise(async (resolve, reject) => {
            if (file.extractedText) {
              resolve(file.extractedText);
            } else {
              // Parse PDF buffer using pdf-parse
              try {
                if (!file.filename.toLowerCase().endsWith('.pdf')) {
                  resolve('');
                  return;
                }
                console.log(`[Analyze] Parsing PDF text for ${file.filename} (${file.fileData.length} bytes)...`);
                const parser = new PDFParse({ data: file.fileData });
                const pdfData = await parser.getText();
                const text = pdfData.text || '';
                
                // Cache the extracted text in DB
                db.run(
                  `UPDATE policy_files SET extractedText = ? WHERE fileId = ?`,
                  [text, file.fileId],
                  (dbErr) => {
                    if (dbErr) console.error('[Analyze] Failed to cache extracted text:', dbErr.message);
                  }
                );
                
                resolve(text);
              } catch (parseErr) {
                console.error(`[Analyze] Error parsing PDF ${file.filename}:`, parseErr);
                resolve('');
              }
            }
          });
        });
        
        const texts = await Promise.all(promises);
        fullText = texts.join('\n\n');
        
        if (!fullText.trim()) {
          return res.status(400).json({ success: false, error: '未能從保單文件中擷取出任何有效文字（可能檔案格式不支援或非 PDF 檔）。' });
        }
        
        // 3. Perform analysis
        if (type === 'content') {
          // Simple keyword search: return contextual snippets and page counts
          const cleanText = fullText.replace(/\s+/g, ' ');
          const regex = new RegExp(`([^.!?\n\r]{0,60})(${keyword})([^.!?\n\r]{0,60})`, 'gi');
          const snippets = [];
          let match;
          
          while ((match = regex.exec(cleanText)) !== null && snippets.length < 50) {
            snippets.push({
              context: `...${match[1].trim()} **${match[2]}** ${match[3].trim()}...`
            });
            if (match.index === regex.lastIndex) {
              regex.lastIndex++;
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
            const cleanText = fullText.replace(/\s+/g, ' ');
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
          let truncatedText = fullText;
          if (fullText.length > maxLength) {
            truncatedText = fullText.substring(0, maxLength) + '\n\n[...保單內容過長，已截斷後半段...]';
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
          
          const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`;
          
          const apiResponse = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{
                parts: [{ text: prompt }]
              }]
            })
          });
          
          if (!apiResponse.ok) {
            const errBody = await apiResponse.text();
            console.error('[Analyze] Gemini API error response:', errBody);
            throw new Error(`Gemini API returned status ${apiResponse.status}`);
          }
          
          const responseData = await apiResponse.json();
          const generatedText = responseData.candidates?.[0]?.content?.parts?.[0]?.text;
          
          if (!generatedText) {
            throw new Error('Gemini API returned empty text candidate.');
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
        console.error('[Analyze] Logic error:', err);
        res.status(500).json({ success: false, error: '分析失敗：' + err.message });
      }
    }
  );
});

app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`  TII Policy Crawler Server running on port ${PORT}`);
  console.log(`  Open http://localhost:${PORT} in your browser`);
  console.log(`==================================================`);
});
