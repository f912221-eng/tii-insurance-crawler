// Global State
let sessionId = null;
let activeDownloads = {};
let activeTab = 'search';
let archiveData = { companies: [], policies: [] };

// DOM Elements
const searchForm = document.getElementById('searchForm');
const keywordInput = document.getElementById('keywordInput');
const categorySelect = document.getElementById('categorySelect');
const captchaInput = document.getElementById('captchaInput');
const captchaImg = document.getElementById('captchaImg');
const refreshCaptchaBtn = document.getElementById('refreshCaptchaBtn');
const searchBtn = document.getElementById('searchBtn');

const resultsSection = document.getElementById('resultsSection');
const resultSummary = document.getElementById('resultSummary');
const resultsBody = document.getElementById('resultsBody');

const toast = document.getElementById('toast');
const toastIcon = document.getElementById('toastIcon');
const toastMessage = document.getElementById('toastMessage');

// Tab DOM Elements
const searchTabBtn = document.getElementById('searchTabBtn');
const archiveTabBtn = document.getElementById('archiveTabBtn');
const searchTabContent = document.getElementById('searchTabContent');
const archiveTabContent = document.getElementById('archiveTabContent');
const forceRefreshCheckbox = document.getElementById('forceRefreshCheckbox');
const captchaGroup = document.getElementById('captchaGroup');
const archiveSearchInput = document.getElementById('archiveSearchInput');
const archiveContainer = document.getElementById('archiveContainer');

// Modal Elements
const downloadModal = document.getElementById('downloadModal');
const modalPolicyName = document.getElementById('modalPolicyName');
const modalPolicyId = document.getElementById('modalPolicyId');
const modalProgressBar = document.getElementById('modalProgressBar');
const downloadSteps = document.getElementById('downloadSteps');
const downloadFilesList = document.getElementById('downloadFilesList');
const filesUl = document.getElementById('filesUl');
const closeModalBtns = document.querySelectorAll('.close-modal, .close-modal-btn');

// DOM Elements for Analysis Modal
const analysisModal = document.getElementById('analysisModal');
const analysisPolicyName = document.getElementById('analysisPolicyName');
const analysisPolicyId = document.getElementById('analysisPolicyId');
const analysisForm = document.getElementById('analysisForm');
const analysisKeywordInput = document.getElementById('analysisKeywordInput');
const analysisTypeSelect = document.getElementById('analysisTypeSelect');
const submitAnalysisBtn = document.getElementById('submitAnalysisBtn');
const analysisResultsSection = document.getElementById('analysisResultsSection');
const analysisLoading = document.getElementById('analysisLoading');
const analysisTextResults = document.getElementById('analysisTextResults');
const snippetsCount = document.getElementById('snippetsCount');
const snippetsUl = document.getElementById('snippetsUl');
const analysisAiResults = document.getElementById('analysisAiResults');
const closeAnalysisModal = document.getElementById('closeAnalysisModal');
const closeAnalysisModalBtn = document.getElementById('closeAnalysisModalBtn');

// Page Init
document.addEventListener('DOMContentLoaded', () => {
    // Bind Tab Switching Events
    searchTabBtn.addEventListener('click', () => switchTab('search'));
    archiveTabBtn.addEventListener('click', () => switchTab('archive'));
    
    // Bind Captcha Events
    refreshCaptchaBtn.addEventListener('click', initSession);
    captchaImg.addEventListener('click', initSession);
    
    // Force Refresh Toggle Event
    forceRefreshCheckbox.addEventListener('change', () => {
        if (forceRefreshCheckbox.checked) {
            captchaGroup.classList.remove('hidden');
            captchaInput.required = true;
            if (!sessionId) {
                initSession();
            }
            showToast('強制重新整理模式：已啟用驗證碼輸入', 'info');
        } else {
            if (captchaInput.placeholder.includes('請輸入')) {
                // do nothing (stay visible if cache miss is pending)
            } else {
                captchaGroup.classList.add('hidden');
                captchaInput.required = false;
            }
        }
    });

    // Bind Search Forms
    searchForm.addEventListener('submit', handleSearch);
    archiveSearchInput.addEventListener('input', debounce(renderArchive, 300));
    
    // Bind Modal Closures
    closeModalBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            downloadModal.style.display = 'none';
        });
    });

    downloadModal.addEventListener('click', (e) => {
        if (e.target === downloadModal) {
            downloadModal.style.display = 'none';
        }
    });

    // Bind Analysis Closures
    closeAnalysisModal.addEventListener('click', () => {
        analysisModal.style.display = 'none';
    });
    closeAnalysisModalBtn.addEventListener('click', () => {
        analysisModal.style.display = 'none';
    });
    analysisModal.addEventListener('click', (e) => {
        if (e.target === analysisModal) {
            analysisModal.style.display = 'none';
        }
    });
    analysisForm.addEventListener('submit', handleAnalysis);
});

// Toast Helper
function showToast(message, type = 'info') {
    toastMessage.textContent = message;
    toast.className = `toast show ${type}`;
    
    if (type === 'success') {
        toastIcon.className = 'fa-solid fa-circle-check';
    } else if (type === 'error') {
        toastIcon.className = 'fa-solid fa-circle-exclamation';
    } else {
        toastIcon.className = 'fa-solid fa-circle-info';
    }
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 4500);
}

// Debounce helper for archive filters
function debounce(func, delay) {
    let timer;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => func.apply(this, args), delay);
    };
}

// Session Initializer (fetch session & captcha)
async function initSession() {
    try {
        captchaImg.style.opacity = '0.5';
        const res = await fetch('/api/session');
        const data = await res.json();
        
        if (data.success) {
            sessionId = data.sessionId;
            captchaImg.src = data.captcha;
            captchaImg.style.opacity = '1';
            captchaInput.value = '';
            captchaInput.placeholder = '請輸入 4 位數字';
            console.log('Session initialized:', sessionId);
        } else {
            showToast('無法取得圖形驗證碼，請重新整理驗證碼', 'error');
        }
    } catch (err) {
        console.error(err);
        showToast('無法連接驗證碼伺服器，請重試', 'error');
    }
}

// Tab Switching logic
function switchTab(tab) {
    activeTab = tab;
    if (tab === 'search') {
        searchTabBtn.classList.add('active');
        archiveTabBtn.classList.remove('active');
        searchTabContent.classList.remove('hidden');
        archiveTabContent.classList.add('hidden');
    } else {
        searchTabBtn.classList.remove('active');
        archiveTabBtn.classList.add('active');
        searchTabContent.classList.add('hidden');
        archiveTabContent.classList.remove('hidden');
        loadArchive();
    }
}

// Search Form Handler
async function handleSearch(e) {
    e.preventDefault();
    
    const keyword = keywordInput.value.trim();
    const categoryId = categorySelect.value;
    const captcha = captchaInput.value.trim();
    const forceRefresh = forceRefreshCheckbox.checked;
    
    if (!keyword) {
        showToast('請輸入關鍵字', 'error');
        return;
    }
    
    const isCaptchaRequired = forceRefresh || !captchaGroup.classList.contains('hidden');
    if (isCaptchaRequired) {
        if (!sessionId) {
            showToast('正在初始化驗證連線，請稍後...', 'info');
            await initSession();
            return;
        }
        if (captcha.length !== 4) {
            showToast('驗證碼長度應為 4 位數字', 'error');
            captchaInput.focus();
            return;
        }
    }
    
    searchBtn.classList.add('loading');
    
    try {
        const res = await fetch('/api/search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ sessionId, keyword, categoryId, captcha, forceRefresh })
        });
        
        const data = await res.json();
        
        if (data.success) {
            const hitText = data.fromCache ? '（從快取資料庫秒讀）' : '';
            showToast(`搜尋成功！${hitText}`, 'success');
            displayResults(data.results);
            
            if (data.fromCache && !forceRefresh) {
                captchaGroup.classList.add('hidden');
                captchaInput.value = '';
                captchaInput.required = false;
            }
        } else if (data.needCaptcha) {
            captchaGroup.classList.remove('hidden');
            captchaInput.required = true;
            showToast('此商品無快取紀錄，請輸入驗證碼進行即時爬取。', 'info');
            if (!sessionId) {
                await initSession();
            }
            captchaInput.focus();
        } else {
            showToast(data.error || '搜尋失敗', 'error');
            if (data.errorType === 'captcha') {
                await initSession();
                captchaInput.focus();
            }
        }
    } catch (err) {
        console.error(err);
        showToast('網路連線失敗，請稍後重試', 'error');
    } finally {
        searchBtn.classList.remove('loading');
    }
}

// Display Results Table
function displayResults(policies) {
    resultsBody.innerHTML = '';
    
    if (policies.length === 0) {
        resultSummary.textContent = '無符合關鍵字的保單資料';
        resultsSection.classList.remove('hidden');
        return;
    }
    
    resultSummary.textContent = `共找到 ${policies.length} 筆符合的保險商品條款`;
    resultsSection.classList.remove('hidden');
    
    policies.forEach((policy, idx) => {
        const tr = document.createElement('tr');
        tr.style.animation = `slideUp 0.4s ease forwards ${idx * 0.05}s`;
        tr.style.opacity = '0';
        
        const isSelling = !policy.endDate || policy.endDate.trim() === '' || policy.endDate.includes('&nbsp;');
        const statusBadge = isSelling 
            ? `<span class="badge badge-selling">銷售中</span>` 
            : `<span class="badge badge-discontinued">停售 (${policy.endDate})</span>`;
            
        const hasBeenDownloaded = activeDownloads[policy.productId];
        
        const actionButton = hasBeenDownloaded
            ? `<div style="display: flex; gap: 0.5rem; justify-content: center;">
                <button class="btn-table completed" disabled><i class="fa-solid fa-check"></i> 已備查</button>
                <button class="btn-table" style="background: rgba(0, 242, 254, 0.15); color: var(--accent-cyan); border-color: rgba(0, 242, 254, 0.3);" onclick="openAnalysisModal('${policy.productId}', '${policy.name.replace(/'/g, "\\'")}')"><i class="fa-solid fa-brain"></i> 比對分析</button>
               </div>`
            : `<button class="btn-table" onclick="downloadPolicy('${policy.productId}', '${policy.name.replace(/'/g, "\\'")}')"><i class="fa-solid fa-cloud-arrow-down"></i> 下載備查</button>`;

        tr.innerHTML = `
            <td><strong>${policy.name}</strong></td>
            <td class="text-center">${policy.startDate || '-'}</td>
            <td class="text-center">${statusBadge}</td>
            <td class="text-center"><code>${policy.productId}</code></td>
            <td class="text-center">${actionButton}</td>
        `;
        
        resultsBody.appendChild(tr);
    });
}

// Helper to append a log line to modal
function addModalStep(text, type = 'info') {
    const item = document.createElement('div');
    item.className = `step-item ${type}`;
    
    let icon = '<i class="fa-solid fa-info-circle"></i>';
    if (type === 'success') {
        icon = '<i class="fa-solid fa-circle-check"></i>';
    } else if (type === 'error') {
        icon = '<i class="fa-solid fa-circle-xmark"></i>';
    } else if (type === 'active') {
        icon = '<i class="fa-solid fa-circle-notch fa-spin"></i>';
    }
    
    item.innerHTML = `${icon} <span>${text}</span>`;
    downloadSteps.appendChild(item);
    downloadSteps.scrollTop = downloadSteps.scrollHeight;
    return item;
}

// Trigger Policy Download (checks cache first, downloads from TII if miss)
async function downloadPolicy(productId, productName) {
    downloadModal.style.display = 'flex';
    modalPolicyName.textContent = productName;
    modalPolicyId.textContent = productId;
    modalProgressBar.style.width = '0%';
    downloadSteps.innerHTML = '';
    downloadFilesList.classList.add('hidden');
    filesUl.innerHTML = '';
    
    const s1 = addModalStep('正在向快取資料庫請求備查文件...', 'active');
    
    try {
        await new Promise(r => setTimeout(r, 450));
        s1.className = 'step-item success';
        s1.querySelector('i').className = 'fa-solid fa-circle-check';
        
        modalProgressBar.style.width = '20%';
        const s2 = addModalStep('正在請求解析保單附件頁面...', 'active');
        
        const res = await fetch('/api/download', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ sessionId, productId, productName })
        });
        
        const data = await res.json();
        
        if (data.success) {
            s2.className = 'step-item success';
            s2.querySelector('i').className = 'fa-solid fa-circle-check';
            modalProgressBar.style.width = '60%';
            
            const source = data.fromCache ? '快取資料庫' : '保發中心即時爬取';
            addModalStep(`同步完成！來源：${source}，共計 ${data.files.length} 個附件檔案。`, 'success');
            
            modalProgressBar.style.width = '100%';
            addModalStep('保單文件已成功儲存並建立備查快取！', 'success');
            showToast('條款檔案同步成功！', 'success');
            
            data.files.forEach(file => {
                const li = document.createElement('li');
                const sizeKb = (file.sizeBytes / 1024).toFixed(1);
                const viewBtn = file.fileId 
                    ? `<button class="btn-table btn-file-action view-btn" style="padding: 0.2rem 0.5rem; font-size: 0.75rem; margin-left: auto;" onclick="viewFile('${file.fileId}')"><i class="fa-solid fa-eye"></i> 瀏覽</button>`
                    : '';
                
                li.innerHTML = `
                    <i class="fa-solid fa-file-pdf"></i>
                    <div style="flex: 1;">
                        <strong>${file.filename}</strong> <span style="color: var(--text-secondary); font-size: 0.75rem;">(${file.docType} - ${sizeKb} KB)</span>
                    </div>
                    ${viewBtn}
                `;
                filesUl.appendChild(li);
            });
            downloadFilesList.classList.remove('hidden');
            
            activeDownloads[productId] = true;
            
            // Re-render row action in search list dynamic DOM
            const trs = resultsBody.querySelectorAll('tr');
            trs.forEach(tr => {
                const codeCell = tr.querySelectorAll('td')[3];
                if (codeCell && codeCell.textContent.includes(productId)) {
                    const actionCell = tr.querySelectorAll('td')[4];
                    actionCell.innerHTML = `
                        <div style="display: flex; gap: 0.5rem; justify-content: center;">
                            <button class="btn-table completed" disabled><i class="fa-solid fa-check"></i> 已備查</button>
                            <button class="btn-table" style="background: rgba(0, 242, 254, 0.15); color: var(--accent-cyan); border-color: rgba(0, 242, 254, 0.3);" onclick="openAnalysisModal('${productId}', '${productName.replace(/'/g, "\\'")}')"><i class="fa-solid fa-brain"></i> 比對分析</button>
                        </div>
                    `;
                }
            });
            
        } else {
            s2.className = 'step-item error';
            s2.querySelector('i').className = 'fa-solid fa-circle-xmark';
            addModalStep(`同步失敗: ${data.error || '無法分析條款連結'}`, 'error');
            showToast(data.error || '同步下載失敗', 'error');
            
            if (data.error && data.error.includes('Cache miss')) {
                downloadModal.style.display = 'none';
                captchaGroup.classList.remove('hidden');
                captchaInput.required = true;
                if (!sessionId) {
                    await initSession();
                }
                captchaInput.focus();
                showToast('本保單無本地備查，請先輸入圖形驗證碼進行即時爬取！', 'warning');
            }
        }
    } catch (err) {
        console.error(err);
        s1.className = 'step-item error';
        s1.querySelector('i').className = 'fa-solid fa-circle-xmark';
        addModalStep('網絡異常，連線中斷。', 'error');
        showToast('無法與伺服器取得聯繫', 'error');
    }
}

// Load Archive
async function loadArchive() {
    archiveContainer.innerHTML = `
        <div class="loading-state">
            <i class="fa-solid fa-circle-notch fa-spin"></i>
            <span>正在載入歷史備查資料...</span>
        </div>
    `;
    
    try {
        const res = await fetch('/api/archive');
        const data = await res.json();
        
        if (data.success) {
            archiveData.companies = data.companies;
            archiveData.policies = data.policies;
            renderArchive();
        } else {
            archiveContainer.innerHTML = `
                <div class="empty-state">
                    <i class="fa-solid fa-circle-exclamation"></i>
                    <p>載入失敗: ${data.error || '資料庫讀取異常'}</p>
                </div>
            `;
        }
    } catch (err) {
        console.error(err);
        archiveContainer.innerHTML = `
            <div class="empty-state">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <p>無法連線至本地資料庫，請檢查伺服器狀態</p>
            </div>
        `;
    }
}

// Render Archive (Accordion folder list)
function renderArchive() {
    const filterText = archiveSearchInput.value.toLowerCase().trim();
    
    const filteredCompanies = archiveData.companies.filter(company => {
        const companyMatch = company.name.toLowerCase().includes(filterText) || company.code.includes(filterText);
        const companyPolicies = archiveData.policies.filter(p => p.companyCode === company.code);
        const policyMatch = companyPolicies.some(p => p.name.toLowerCase().includes(filterText) || p.productId.toLowerCase().includes(filterText));
        return companyMatch || policyMatch;
    });
    
    archiveContainer.innerHTML = '';
    
    if (filteredCompanies.length === 0) {
        archiveContainer.innerHTML = `
            <div class="empty-state">
                <i class="fa-solid fa-folder-open"></i>
                <p>備查資料庫中尚無符合此關鍵字的保單資料</p>
            </div>
        `;
        return;
    }
    
    filteredCompanies.forEach(company => {
        const companyPolicies = archiveData.policies.filter(p => p.companyCode === company.code);
        const displayPolicies = companyPolicies.filter(p => 
            filterText === '' || 
            company.name.toLowerCase().includes(filterText) || 
            p.name.toLowerCase().includes(filterText) ||
            p.productId.toLowerCase().includes(filterText)
        );
        
        if (displayPolicies.length === 0) return;
        
        const groupDiv = document.createElement('div');
        groupDiv.className = 'company-group';
        
        const header = document.createElement('div');
        header.className = 'company-header';
        header.innerHTML = `
            <div class="company-title">
                <i class="fa-solid fa-building-columns"></i>
                <span>${company.name}</span>
            </div>
            <div class="company-meta">
                <span class="policy-count-badge">${displayPolicies.length} 筆已備查</span>
                <i class="fa-solid fa-chevron-down arrow-icon"></i>
            </div>
        `;
        
        const policiesContainer = document.createElement('div');
        policiesContainer.className = 'company-policies';
        
        displayPolicies.forEach(policy => {
            const policyDiv = document.createElement('div');
            policyDiv.className = 'policy-item-wrapper';
            
            const isSelling = !policy.endDate || policy.endDate.trim() === '' || policy.endDate.includes('&nbsp;');
            const statusBadge = isSelling 
                ? `<span class="badge badge-selling" style="margin-right: 0;">銷售中</span>` 
                : `<span class="badge badge-discontinued" style="margin-right: 0;">停售</span>`;
                
            const filesCountText = policy.filesCount > 0 
                ? `<span style="color: var(--accent-emerald);"><i class="fa-solid fa-file-shield"></i> 已快取 ${policy.filesCount} 份檔案</span>` 
                : `<span style="color: var(--text-secondary);"><i class="fa-solid fa-triangle-exclamation"></i> 尚未下載附件</span>`;
            
            const analyzeBtn = policy.filesCount > 0
                ? `<button class="btn btn-secondary btn-file-action analyze-btn-trigger" style="font-size: 0.75rem; padding: 0.25rem 0.6rem; background: rgba(0, 242, 254, 0.1); border-color: rgba(0, 242, 254, 0.2); color: var(--accent-cyan); display: flex; align-items: center; gap: 0.25rem;" onclick="event.stopPropagation(); openAnalysisModal('${policy.productId}', '${policy.name.replace(/'/g, "\\'")}')"><i class="fa-solid fa-brain"></i> 比對分析</button>`
                : '';
                
            policyDiv.innerHTML = `
                <div class="policy-item-header">
                    <div class="policy-name-column">
                        <strong>${policy.name}</strong>
                        <div class="policy-meta-sub">
                            <span>編號: <code>${policy.productId}</code></span>
                            <span>分類: ${policy.categoryId === '2' ? '壽險險種' : '產險險種'}</span>
                            <span>${filesCountText}</span>
                        </div>
                    </div>
                    <div class="policy-action-column" style="gap: 0.75rem; display: flex; align-items: center;">
                        ${analyzeBtn}
                        ${statusBadge}
                        <i class="fa-solid fa-chevron-right arrow-icon" style="font-size: 0.8rem;"></i>
                    </div>
                </div>
                <div class="policy-files-container" id="files-${policy.productId}">
                    <div class="loading-state" style="padding: 1rem;">
                        <i class="fa-solid fa-circle-notch fa-spin" style="font-size: 1.2rem;"></i>
                        <span>載入備查檔案中...</span>
                    </div>
                </div>
            `;
            
            // Bind inner accordion toggle
            const itemHeader = policyDiv.querySelector('.policy-item-header');
            itemHeader.addEventListener('click', (e) => {
                e.stopPropagation();
                const container = policyDiv.querySelector('.policy-files-container');
                const isExpanded = policyDiv.classList.contains('expanded');
                
                if (isExpanded) {
                    policyDiv.classList.remove('expanded');
                } else {
                    policyDiv.classList.add('expanded');
                    loadPolicyFiles(policy.productId, container);
                }
            });
            
            policiesContainer.appendChild(policyDiv);
        });
        
        header.addEventListener('click', () => {
            groupDiv.classList.toggle('expanded');
        });
        
        groupDiv.appendChild(header);
        groupDiv.appendChild(policiesContainer);
        archiveContainer.appendChild(groupDiv);
    });
}

// Dynamic lazy-loading policy files from SQLite BLOB
async function loadPolicyFiles(productId, container) {
    try {
        const res = await fetch(`/api/policy/${productId}/files`);
        const data = await res.json();
        
        if (data.success && data.files.length > 0) {
            container.innerHTML = `
                <div class="files-list-header">備查條款與附件清單：</div>
                <ul class="archive-files-list">
                    ${data.files.map(file => {
                        const sizeKb = (file.sizeBytes / 1024).toFixed(1);
                        return `
                            <li class="archive-file-item">
                                <div class="file-info">
                                    <i class="fa-solid fa-file-pdf"></i>
                                    <span class="file-name-span">${file.filename}</span>
                                    <span class="file-type-span">${file.docType}</span>
                                    <span class="file-size-span">(${sizeKb} KB)</span>
                                </div>
                                <div class="file-actions">
                                    <button class="btn-file-action view-btn" onclick="viewFile('${file.fileId}')">
                                        <i class="fa-solid fa-eye"></i> 線上瀏覽
                                    </button>
                                    <button class="btn-file-action" onclick="downloadFile('${file.fileId}', '${file.filename.replace(/'/g, "\\'")}')">
                                        <i class="fa-solid fa-download"></i> 下載
                                    </button>
                                </div>
                            </li>
                        `;
                    }).join('')}
                </ul>
            `;
        } else {
            container.innerHTML = `
                <div style="padding: 1rem; color: var(--text-secondary); text-align: center; font-size: 0.85rem;">
                    <p style="margin-bottom: 0.5rem;"><i class="fa-solid fa-circle-exclamation"></i> 尚未同步爬取條款文件</p>
                    <button class="btn btn-secondary" style="padding: 0.4rem 0.8rem; font-size: 0.75rem;" onclick="downloadPolicyFromArchive('${productId}')">
                        <i class="fa-solid fa-cloud-arrow-down"></i> 立即爬取下載
                    </button>
                </div>
            `;
        }
    } catch (err) {
        console.error(err);
        container.innerHTML = `
            <div style="color: var(--accent-red); padding: 0.5rem; font-size: 0.85rem;">
                <i class="fa-solid fa-triangle-exclamation"></i> 載入檔案失敗，請檢查本地連線。
            </div>
        `;
    }
}

// Serve PDF files from sqlite blob
function viewFile(fileId) {
    window.open(`/api/file/${fileId}`, '_blank');
}

function downloadFile(fileId, filename) {
    const link = document.createElement('a');
    link.href = `/api/file/${fileId}`;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Download policy documents using search route from archive view
async function downloadPolicyFromArchive(productId) {
    const policy = archiveData.policies.find(p => p.productId === productId);
    if (!policy) return;
    
    switchTab('search');
    keywordInput.value = productId;
    categorySelect.value = policy.categoryId || '2';
    
    captchaGroup.classList.remove('hidden');
    captchaInput.required = true;
    if (!sessionId) {
        await initSession();
    }
    showToast('請輸入圖形驗證碼，爬取該保單的條款檔案。', 'info');
    captchaInput.focus();
}

// --- Analysis Modal Logic ---

// Open analysis modal and reset UI
function openAnalysisModal(productId, productName) {
    analysisModal.style.display = 'flex';
    analysisPolicyName.textContent = productName;
    analysisPolicyId.textContent = productId;
    
    // Reset inputs & results
    analysisKeywordInput.value = '';
    analysisResultsSection.classList.add('hidden');
    analysisLoading.classList.add('hidden');
    analysisTextResults.classList.add('hidden');
    analysisAiResults.classList.add('hidden');
    submitAnalysisBtn.disabled = false;
    submitAnalysisBtn.classList.remove('loading');
}

// Submit analysis request
async function handleAnalysis(e) {
    e.preventDefault();
    
    const productId = analysisPolicyId.textContent;
    const keyword = analysisKeywordInput.value.trim();
    const analysisType = analysisTypeSelect.value;
    
    if (!keyword || !productId) {
        showToast('請輸入分析關鍵字', 'error');
        return;
    }
    
    // UI state loading
    submitAnalysisBtn.disabled = true;
    submitAnalysisBtn.classList.add('loading');
    
    analysisResultsSection.classList.remove('hidden');
    analysisLoading.classList.remove('hidden');
    analysisTextResults.classList.add('hidden');
    analysisAiResults.classList.add('hidden');
    snippetsUl.innerHTML = '';
    
    try {
        const res = await fetch(`/api/policy/${productId}/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keyword, analysisType })
        });
        
        const data = await res.json();
        analysisLoading.classList.add('hidden');
        
        if (data.success) {
            showToast('比對分析完成！', 'success');
            
            if (data.analysisType === 'content') {
                // Render Simple Substring Search Results
                snippetsCount.textContent = data.matchCount;
                if (data.matchCount > 0) {
                    data.results.forEach(snippet => {
                        const li = document.createElement('li');
                        li.className = 'snippet-item';
                        li.style.display = 'flex';
                        li.style.flexDirection = 'column';
                        li.style.gap = '0.5rem';
                        li.style.padding = '0.85rem 1.15rem';
                        li.style.background = 'rgba(255, 255, 255, 0.03)';
                        li.style.borderLeft = '3px solid var(--accent-cyan)';
                        li.style.borderRadius = '6px';
                        li.style.marginBottom = '0.5rem';
                        
                        const textDiv = document.createElement('div');
                        textDiv.style.color = '#e0e0e0';
                        textDiv.style.fontSize = '0.9rem';
                        textDiv.style.lineHeight = '1.4';
                        textDiv.innerHTML = snippet.context.replace(/\*\*(.*?)\*\*/g, '<strong style="color: var(--accent-cyan); font-weight: 600;">$1</strong>');
                        
                        const linkDiv = document.createElement('div');
                        linkDiv.style.display = 'flex';
                        linkDiv.style.alignItems = 'center';
                        linkDiv.style.gap = '0.25rem';
                        linkDiv.style.fontSize = '0.75rem';
                        linkDiv.innerHTML = `
                            <span style="color: var(--text-secondary);"><i class="fa-solid fa-file-pdf"></i> 來源檔案：</span>
                            <a href="/api/file/${snippet.fileId}#search=${encodeURIComponent(keyword)}" target="_blank" style="color: var(--accent-cyan); text-decoration: none; font-weight: 500; display: inline-flex; align-items: center; gap: 0.25rem;">
                                ${snippet.filename} <i class="fa-solid fa-arrow-up-right-from-square" style="font-size: 0.65rem;"></i>
                            </a>
                        `;
                        
                        li.appendChild(textDiv);
                        li.appendChild(linkDiv);
                        snippetsUl.appendChild(li);
                    });
                } else {
                    snippetsUl.innerHTML = `<li style="padding: 1.5rem; text-align: center; color: var(--text-secondary);">條款全文中未找到與「${keyword}」相關的段落。</li>`;
                }
                analysisTextResults.classList.remove('hidden');
            } else {
                // Render AI Claims Report (Markdown parsed to HTML)
                const markdownHtml = parseMarkdown(data.markdown);
                analysisAiResults.innerHTML = markdownHtml;
                analysisAiResults.classList.remove('hidden');
            }
        } else {
            showToast(data.error || '比對失敗', 'error');
            analysisResultsSection.classList.add('hidden');
        }
    } catch (err) {
        console.error(err);
        showToast('與伺服器連線中斷，請稍後重試', 'error');
        analysisResultsSection.classList.add('hidden');
    } finally {
        submitAnalysisBtn.disabled = false;
        submitAnalysisBtn.classList.remove('loading');
    }
}

// Simple yet robust regex-based Markdown-to-HTML parser for LLM outputs
function parseMarkdown(text) {
    if (!text) return '';
    
    // 1. Escaping basic HTML to prevent injection
    let html = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
        
    // 2. Bold text (**text**)
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    
    // 3. Headings (# h1, ## h2, ### h3)
    html = html.replace(/^### (.*?)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.*?)$/gm, '<h2>$2</h2>'); // Wait, double match regex
    // Correct headers parsing
    html = html.replace(/^### (.*?)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.*?)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.*?)$/gm, '<h1>$1</h1>');
    
    // 4. Unordered Lists (* item, - item)
    html = html.replace(/^\* (.*?)$/gm, '<li>$1</li>');
    html = html.replace(/^- (.*?)$/gm, '<li>$1</li>');
    
    // Wrap adjacent li elements into <ul> blocks
    html = html.replace(/(?:<li>.*?<\/li>\s*)+/g, (match) => {
        return `<ul style="list-style-type: disc; margin-bottom: 1rem; padding-left: 1.5rem;">${match}</ul>`;
    });
    
    // 5. Code tags (`code`)
    html = html.replace(/`(.*?)`/g, '<code>$1</code>');
    
    // 6. Blockquote Callout Alerts (e.g. &gt; [!IMPORTANT] ...)
    // Match alerts blockquotes
    html = html.replace(/^&gt;\s*\[\!(IMPORTANT|NOTE|WARNING|TIP|CAUTION)\]\s*\n([\s\S]*?)(?=\n\n|\n&gt;|\n\s*\n|$)/gim, (m, type, content) => {
        const cls = `alert-${type.toLowerCase()}`;
        const cleanContent = content.replace(/^&gt;\s*/gm, '').trim();
        return `<blockquote class="${cls}">${cleanContent}</blockquote>`;
    });
    
    // Match standard Blockquotes (like &gt; text)
    html = html.replace(/^&gt;\s*(.*?)$/gm, '<blockquote>$1</blockquote>');
    
    // 7. Line breaks
    html = html.replace(/\n/g, '<br>');
    
    // 8. Cleaning duplicate tags or blank lines in lists and blockquotes
    html = html.replace(/<br><\/blockquote>/g, '</blockquote>');
    html = html.replace(/<br><\/ul>/g, '</ul>');
    html = html.replace(/<br><h3>/g, '<h3>');
    html = html.replace(/<br><h2>/g, '<h2>');
    html = html.replace(/<br><h1>/g, '<h1>');
    
    return html;
}
