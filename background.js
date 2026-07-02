// Manages sidebar states and AI requests for the extension.
let sidebarStates = new Map();
let locatorModeStates = new Map();
let tabOrigins = new Map();

async function setIconForTab(tabId, active) {
    try {
        await chrome.action.setBadgeText({ tabId: tabId, text: active ? "ON" : "" });
        await chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: active ? "#27ae60" : "#e74c3c" });
    } catch (e) {}
}

const BLOCKED_PROTOCOLS = ['chrome://', 'chrome-extension://', 'about:', 'edge://', 'opera://', 'vivaldi://', 'brave://', 'view-source:', 'devtools://', 'file://'];
const ALLOWED_PROTOCOLS = ['http://', 'https://', 'ftp://', 'data:'];

function isUrlAllowed(url) {
    if (!url) return false;
    try {
        const lower = String(url).toLowerCase();
        for (const p of BLOCKED_PROTOCOLS) if (lower.startsWith(p)) return false;
        if (ALLOWED_PROTOCOLS.some(p => lower.startsWith(p))) return true;
        return false;
    } catch (e) { return false; }
}

function safeTabsSendMessage(tabId, msg) {
    try { chrome.tabs.sendMessage(tabId, msg, () => { try { void chrome.runtime.lastError; } catch (e) {} }); } catch (e) {}
}

function saveSidebarStates() {
    try {
        const obj = {};
        for (const [k, v] of sidebarStates) { if (v) obj[k] = v; }
        chrome.storage.local.set({ sidebarStates: obj }, () => { try { void chrome.runtime.lastError; } catch (e) {} });
    } catch (e) {}
}

async function loadSidebarStates() {
    try {
        const res = await chrome.storage.local.get("sidebarStates");
        if (res && res.sidebarStates) {
            for (const [k, v] of Object.entries(res.sidebarStates)) sidebarStates.set(Number(k), v);
        }
    } catch (e) {}
}

chrome.action.onClicked.addListener(async (tab) => {
    if (!tab || !tab.id || !isUrlAllowed(tab.url || '')) return;
    try {
        const url = new URL(tab.url);
        tabOrigins.set(tab.id, url.origin);
    } catch (e) {}
    const wasOpen = sidebarStates.get(tab.id) || false;
    if (wasOpen) {
        safeTabsSendMessage(tab.id, { type: 'CLOSE_SIDEBAR' });
        sidebarStates.set(tab.id, false);
        locatorModeStates.set(tab.id, false);
        try { await setIconForTab(tab.id, false); } catch (e) {}
        try { await chrome.storage.local.set({ isSidebarExplicitlyClosed: true }, () => { try { void chrome.runtime.lastError; } catch (e) {} }); } catch (e) {}
        saveSidebarStates();
    } else {
        try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }); } catch (err) {}
        safeTabsSendMessage(tab.id, { type: 'OPEN_SIDEBAR' });
        sidebarStates.set(tab.id, true);
        try { await setIconForTab(tab.id, false); } catch (e) {}
        try { await chrome.storage.local.set({ isSidebarExplicitlyClosed: false }, () => { try { void chrome.runtime.lastError; } catch (e) {} }); } catch (e) {}
        saveSidebarStates();
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    sidebarStates.delete(tabId);
    locatorModeStates.delete(tabId);
    tabOrigins.delete(tabId);
    saveSidebarStates();
});

chrome.runtime.onInstalled.addListener(() => {
    sidebarStates.clear();
    saveSidebarStates();
    loadSidebarStates();
});

chrome.runtime.onStartup.addListener(() => {
    loadSidebarStates();
});

if (chrome.windows && chrome.windows.onRemoved) {
    chrome.windows.onRemoved.addListener(() => { saveSidebarStates(); });
}

function safeStringify(obj, depth) {
    depth = depth || 4;
    const seen = new WeakSet();
    return JSON.stringify(obj, function(k, v) {
        if (v === null || v === undefined) return v;
        if (typeof v === 'function') return '[fn]';
        if (typeof v !== 'object') return v;
        if (seen.has(v)) return '[circular]';
        seen.add(v);
        return v;
    }, 2);
}

async function getAiConfig() {
    try {
        const res = await chrome.storage.local.get(['aiConfigs', 'currentProvider', 'aiConfig']);
        const currentProvider = res.currentProvider || 'chatgpt';
        let cfg = null;
        // New format: per-provider configs
        if (res.aiConfigs && res.aiConfigs[currentProvider]) {
            cfg = JSON.parse(JSON.stringify(res.aiConfigs[currentProvider]));
            cfg.provider = currentProvider;
        }
        // Fallback to old single aiConfig
        if (!cfg && res.aiConfig) {
            cfg = JSON.parse(JSON.stringify(res.aiConfig));
        }
        if (!cfg) cfg = { provider: 'chatgpt', model: 'gpt-4o-mini', url: 'https://api.openai.com/v1/chat/completions', enabled: true };
        const provider = cfg.provider || 'chatgpt';
        if (!cfg.url) {
            const PRESETS = {
                chatgpt: 'https://api.openai.com/v1/chat/completions',
                gemini: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
                deepseek: 'https://api.deepseek.com/v1/chat/completions',
                claude: 'https://api.anthropic.com/v1/messages',
                ark: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions'
            };
            if (PRESETS[provider]) cfg.url = PRESETS[provider];
        }
        if (!cfg.model) {
            const MODELS = { chatgpt: 'gpt-4o-mini', gemini: 'gemini-2.0-flash', deepseek: 'deepseek-chat', claude: 'claude-3-haiku-20240307', ark: 'ep-xxxxxxxxxxxx' };
            cfg.model = MODELS[provider] || '';
        }
        return cfg;
    } catch (e) {
        return { provider: 'chatgpt', model: 'gpt-4o-mini', url: 'https://api.openai.com/v1/chat/completions', enabled: true };
    }
}

function buildPromptRulesSection(promptRules) {
    if (!promptRules) return '';
    var parts = [];
    if (promptRules.frameworks && promptRules.frameworks.length) {
        parts.push('TARGET FRAMEWORK: ' + promptRules.frameworks.join(', '));
    }
    if (promptRules.rules && promptRules.rules.length) {
        var ruleDescriptions = {
            'prefer-id': 'Prefer ID-based locators whenever possible',
            'prefer-data-attr': 'Prefer data-* attributes (data-testid, data-cy, etc.)',
            'prefer-aria': 'Use ARIA roles and labels for locators',
            'prefer-semantic': 'Prefer semantic HTML selectors',
            'no-random-id': 'Avoid auto-generated or dynamic IDs',
            'no-text-locator': 'Avoid text-based locators when possible',
            'no-index': 'Avoid index-based selectors (nth-child, etc.)',
            'no-absolute-xpath': 'Never use absolute XPath starting from /html',
            'playwright-locator-api': 'Use Playwright Locator API style (getByRole, getByLabel, etc.)'
        };
        var rulesList = promptRules.rules.map(function(r) { return ruleDescriptions[r] || r; }).filter(Boolean);
        if (rulesList.length) parts.push('LOCATOR RULES: ' + rulesList.join('; '));
    }
    if (promptRules.custom) parts.push('CUSTOM RULES: ' + promptRules.custom);
    return parts.length ? '\n\n=== LOCATOR GENERATION RULES ===\n' + parts.join('\n') + '\n' : '';
}

async function callAiOptimalLocator(payload, config, tabId) {
    const cfg = config || await getAiConfig();
    const snapshot = payload && payload.snapshot;
    const elements = payload && payload.elements;
    const userPrompt = (payload && payload.userPrompt) || '';
    const promptRules = payload && payload.promptRules;
    const systemPromptOverride = payload && payload.systemPrompt;
    const elemCount = (elements && elements.length) || 1;

    const baseSystemPrompt = systemPromptOverride || 'You are a web test automation engineer. Output ONLY valid JSON, no markdown.\n' +
      'Rules: prefer id/data-testid > aria-label > name+type > placeholder > scoped-under-parent-id > class > text > nth-child.\n' +
      'Format: {"elements":[{"index":0,"css":"selector","css_confidence":95,"xpath":"//xpath","xpath_confidence":90,"why":"explanation"}],"general_notes":["note"]}\n' +
      'Be concise: short "why", skip alternatives unless needed.';
    const rulesSection = buildPromptRulesSection(promptRules);
    const systemPrompt = rulesSection ? baseSystemPrompt + '\n\n' + rulesSection : baseSystemPrompt;

    const userContent = [];
    if (snapshot) userContent.push('=== PAGE STRUCTURE ===\n' + (typeof snapshot === 'string' ? snapshot.slice(0, 2500) : safeStringify(snapshot, 3).slice(0, 2500)));
    if (elements && elements.length) userContent.push('=== SELECTED ELEMENTS (their outerHTML) ===\n' + safeStringify(elements, 2));
    if (userPrompt) userContent.push('=== USER INSTRUCTION ===\n' + userPrompt);
    const fullUser = userContent.join('\n\n');

    const provider = cfg.provider || 'chatgpt';
    const apiUrl = cfg.url || '';
    const token = cfg.token || '';
    const model = cfg.model || '';
    if (!token) throw new Error('No API token configured for ' + provider);
    if (!apiUrl) throw new Error('No API URL configured for ' + provider);
    if (!model) throw new Error('No model configured for ' + provider);

    let body, headers = { 'Content-Type': 'application/json' };
    let fetchUrl = apiUrl;

    if (provider === 'gemini') {
        fetchUrl = apiUrl + (apiUrl.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(token);
        body = JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: fullUser + '\n\nRespond with valid JSON ONLY. No markdown, no explanation.' }] }],
            generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
        });
    } else if (provider === 'claude') {
        headers['x-api-key'] = token;
        headers['anthropic-version'] = '2023-06-01';
        body = JSON.stringify({
            model: model,
            max_tokens: 500 + elemCount * 600,
            system: systemPrompt,
            messages: [{ role: 'user', content: fullUser + '\n\nRespond with valid JSON ONLY. No markdown.' }]
        });
    } else {
        headers['Authorization'] = 'Bearer ' + token;
        body = JSON.stringify({
            model: model,
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: fullUser + '\n\nRespond with valid JSON ONLY. No markdown.' }],
            temperature: 0.1,
            max_tokens: 500 + elemCount * 600,
            stream: false
        });
    }

    // -- AbortController with timeout + cancellation support --
    const controller = new AbortController();
    const timeoutMs = 120000 + elemCount * 90000; // 1元素=3.5分, 4元素=8分
    const timeoutId = setTimeout(function(){ controller.abort('AI request timed out after ' + (timeoutMs / 1000) + 's'); }, timeoutMs);
    if (tabId != null) { activeAiRequests.set(tabId, controller); }

    let resp;
    try { resp = await fetch(fetchUrl, { method: 'POST', headers: headers, body: body, signal: controller.signal }); }
    catch (netErr) {
      const errMsg = (netErr && netErr.message || String(netErr));
      const urlHint = (fetchUrl || '').replace(/https?:\/\//, '').split('/')[0];
      throw new Error('Network error @ ' + urlHint + '/' + model + ': ' + errMsg + '. Tips: ① Reload extension ② Check API URL/token ③ Check firewall/proxy');
    } finally {
      clearTimeout(timeoutId);
      if (tabId != null) { activeAiRequests.delete(tabId); }
    }
    const text = await resp.text();
    if (!resp.ok) {
      let errMsg = 'API ' + resp.status + ': ' + text.slice(0, 300);
      // Ark-specific hint
      if (resp.status === 404 && provider === 'ark') {
        errMsg += '\n\nHint: 火山引擎 Ark 要求 model 为推理端点 ID（如 ep-xxxxxxxxxxxx），请前往 Ark 控制台 → 在线推理 创建端点。';
      }
      throw new Error(errMsg);
    }

    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('Non-JSON response: ' + text.slice(0, 300)); }

    let raw = '';
    let reasoning = '';
    if (provider === 'gemini') {
        if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0]) {
            raw = data.candidates[0].content.parts[0].text || '';
        }
    } else if (provider === 'claude') {
        if (data.content && data.content[0]) raw = data.content[0].text || '';
    } else {
        if (data.choices && data.choices[0] && data.choices[0].message) {
            raw = data.choices[0].message.content || '';
            reasoning = data.choices[0].message.reasoning_content || '';
        }
    }

    raw = raw.trim();
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    let jsonStr = raw;
    if (firstBrace >= 0 && lastBrace > firstBrace) jsonStr = raw.slice(firstBrace, lastBrace + 1);

    let parsed;
    try { parsed = JSON.parse(jsonStr); } catch (e) { return { raw_response: raw, parse_error: e && e.message, elements: [] }; }
    if (reasoning) parsed.thinking = reasoning;
    return parsed;
}

async function handleTestAiConnection(request, sender, sendResponse) {
    try {
        const d = request.data || {};
        const src = d.config || d;
        const provider = src.provider || 'chatgpt';
        const model = src.model || '';
        const apiUrl = src.url || '';
        const token = src.token || '';
        if (!token) throw new Error('No API token configured');
        if (!apiUrl) throw new Error('No API URL configured');
        if (!model) throw new Error('No model configured');

        let headers = { 'Content-Type': 'application/json' };
        let fetchUrl = apiUrl, body;
        if (provider === 'gemini') {
            fetchUrl = apiUrl + (apiUrl.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(token);
            body = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }], generationConfig: { temperature: 0, maxOutputTokens: 10 } });
        } else if (provider === 'claude') {
            headers['x-api-key'] = token;
            headers['anthropic-version'] = '2023-06-01';
            body = JSON.stringify({ model: model, max_tokens: 10, messages: [{ role: 'user', content: 'hello' }] });
        } else {
            headers['Authorization'] = 'Bearer ' + token;
            body = JSON.stringify({ model: model, messages: [{ role: 'user', content: 'hello' }], temperature: 0, max_tokens: 10 });
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(function(){ controller.abort('Test connection timed out after 15s'); }, 15000);
        let resp;
        try { resp = await fetch(fetchUrl, { method: 'POST', headers: headers, body: body, signal: controller.signal }); }
        finally { clearTimeout(timeoutId); }

        if (!resp.ok) {
            const txt = await resp.text().catch(function(){ return ''; });
            throw new Error('API ' + resp.status + ': ' + txt.slice(0, 200));
        }
        try { sendResponse({ ok: true, success: true, message: 'AI connection OK' }); } catch (e) {}
    } catch (err) {
        try { sendResponse({ ok: false, success: false, error: String(err && err.message || err) }); } catch (e) {}
    }
}

async function handleWriteConfigFile(request, sendResponse) {
    const config = request.data;
    try {
        // Always persist to chrome.storage.local for runtime access
        await chrome.storage.local.set({
            aiConfigs: config.aiConfigs || {},
            currentProvider: config.currentProvider || 'chatgpt',
            customProviders: config.customProviders || [],
            promptRules: config.promptRules || null,
            customPromptTemplates: config.customPromptTemplates || [],
            selectedPromptTemplateId: config.selectedPromptTemplateId || ''
        });
        // Write to config.json in extension directory (works for unpacked extensions)
        try {
            await new Promise(function(resolve, reject) {
                chrome.runtime.getPackageDirectoryEntry(function(rootDir) {
                    rootDir.getFile('config.json', { create: true }, function(fileEntry) {
                        fileEntry.createWriter(function(writer) {
                            writer.onwriteend = resolve;
                            writer.onerror = reject;
                            var blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
                            writer.write(blob);
                        }, reject);
                    }, reject);
                });
            });
        } catch (fileErr) {
            // File write failed — config is still persisted in storage
            console.warn('config.json write skipped (file system unavailable):', fileErr);
        }
        try { sendResponse({ ok: true }); } catch (e) {}
    } catch (err) {
        try { sendResponse({ ok: false, error: String(err && err.message || err) }); } catch (e) {}
    }
}

async function handleAiSuggestionsRequest(request, sender, sendResponse) {
    try {
        const d = request.data || {};
        const cfg = await getAiConfig();
        const result = await callAiOptimalLocator({ snapshot: d.pageContext || '', elements: [d.element || {}], userPrompt: '' }, cfg);
        try { sendResponse({ ok: true, suggestions: result }); } catch (e) {}
    } catch (err) {
        try { sendResponse({ ok: false, error: String(err && err.message || err) }); } catch (e) {}
    }
}

async function handleChatAiRequest(request, sender, sendResponse) {
    try {
        const d = request.data || {};
        const cfg = await getAiConfig();
        const provider = d.provider || cfg.provider;
        const model = d.modelName || cfg.model;
        const apiUrl = cfg.url || '';
        const token = cfg.token || '';
        const sysPrompt = d.systemPrompt || 'You are a helpful web automation assistant. Answer concisely.';
        if (!token) throw new Error('No API token');
        if (!apiUrl) throw new Error('No API URL');

        let headers = { 'Content-Type': 'application/json' };
        let fetchUrl = apiUrl, body;
        if (provider === 'gemini') {
            fetchUrl = apiUrl + (apiUrl.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(token);
            body = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: d.message || '' }] }], systemInstruction: { parts: [{ text: sysPrompt }] }, generationConfig: { temperature: 0.2 } });
        } else if (provider === 'claude') {
            headers['x-api-key'] = token;
            headers['anthropic-version'] = '2023-06-01';
            body = JSON.stringify({ model: model, max_tokens: 1500, system: sysPrompt, messages: [{ role: 'user', content: d.message || '' }] });
        } else {
            headers['Authorization'] = 'Bearer ' + token;
            body = JSON.stringify({ model: model, messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: d.message || '' }], temperature: 0.2, stream: false });
        }
        const controller = new AbortController();
        const timeoutId = setTimeout(function(){ controller.abort('Chat AI request timed out after 180s'); }, 180000);
        const tabId = sender && sender.tab && sender.tab.id;
        if (tabId != null) { activeAiRequests.set(tabId, controller); }

        let resp;
        try { resp = await fetch(fetchUrl, { method: 'POST', headers: headers, body: body, signal: controller.signal }); }
        finally {
          clearTimeout(timeoutId);
          if (tabId != null) { activeAiRequests.delete(tabId); }
        }
        const text = await resp.text();
        if (!resp.ok) { try { sendResponse({ ok: false, error: 'API ' + resp.status + ': ' + text.slice(0, 200) }); } catch (e) {} return; }
        const data = JSON.parse(text);
        let raw = '';
        if (provider === 'gemini') { if (data.candidates && data.candidates[0] && data.candidates[0].content.parts) raw = data.candidates[0].content.parts[0].text || ''; }
        else if (provider === 'claude') { if (data.content && data.content[0]) raw = data.content[0].text || ''; }
        else { if (data.choices && data.choices[0] && data.choices[0].message) raw = data.choices[0].message.content || ''; }
        try { sendResponse({ ok: true, success: true, text: raw, raw_response: data }); } catch (e) {}
    } catch (err) {
        try { sendResponse({ ok: false, error: String(err && err.message || err) }); } catch (e) {}
    }
}

// -- AXTree: find semantic node at DOM coordinates (chrome.automation API) --
function findAXTreeNodeAtPoint(tabId, rect) {
    return new Promise((resolve, reject) => {
        try {
            chrome.automation.getTree(tabId, (root) => {
                try {
                    if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
                    if (!root) { resolve(null); return; }

                    const cx = Math.round(rect.left + rect.width / 2);
                    const cy = Math.round(rect.top + rect.height / 2);

                    let bestNode = null;
                    let bestArea = Infinity;

                    function walk(node) {
                        if (!node || !node.location) return;
                        const loc = node.location;
                        if (cx >= loc.left && cx <= loc.left + loc.width &&
                            cy >= loc.top && cy <= loc.top + loc.height) {
                            const area = loc.width * loc.height;
                            // Prefer interactive leaf nodes: smaller area wins
                            if (area > 0 && area < bestArea) {
                                bestArea = area;
                                bestNode = node;
                            }
                        }
                        if (node.children) {
                            for (let i = 0; i < node.children.length; i++) {
                                walk(node.children[i]);
                            }
                        }
                    }

                    walk(root);

                    if (!bestNode) { resolve(null); return; }

                    // Extract semantic info — anti-NLS priority attributes
                    const attrs = bestNode.attributes || {};
                    const semantic = {
                        role: bestNode.role || '',
                        name: bestNode.name || '',
                        attributes: {},
                    };

                    // Key anti-NLS attributes (priority order)
                    const KEY_ATTRS = [
                        'data-testid', 'data-cy', 'data-test', 'data-qa',
                        'data-i18n-key', 'data-i18n', 'data-i18n-id',
                        'aria-label', 'aria-labelledby', 'aria-describedby',
                        'placeholder', 'title', 'type', 'name', 'href',
                    ];
                    KEY_ATTRS.forEach((a) => {
                        if (attrs[a] !== undefined && attrs[a] !== null) {
                            semantic.attributes[a] = String(attrs[a]);
                        }
                    });

                    // Build parent chain (up to 5 levels) with roles/names
                    const parentChain = [];
                    let cur = bestNode.parent;
                    while (cur && parentChain.length < 5) {
                        const p = { role: cur.role || '' };
                        if (cur.name) p.name = String(cur.name).slice(0, 100);
                        const pa = cur.attributes || {};
                        ['id', 'aria-label', 'data-testid', 'role'].forEach((a) => {
                            if (pa[a]) p[a] = String(pa[a]);
                        });
                        parentChain.push(p);
                        cur = cur.parent;
                    }
                    semantic.parentChain = parentChain;

                    // NLS risk assessment
                    const hasStableAttr = semantic.attributes['data-testid'] || semantic.attributes['data-cy']
                        || semantic.attributes['data-test'] || semantic.attributes['data-i18n-key']
                        || semantic.attributes['aria-label'];
                    const nameLikelyFromText = !hasStableAttr && !!semantic.name && !semantic.attributes['aria-label']
                        && !semantic.attributes['aria-labelledby'];
                    semantic.nlsRisk = nameLikelyFromText ? 'high' : (hasStableAttr ? 'none' : 'low');

                    resolve(semantic);
                } catch (e) { reject(e); }
            });
        } catch (e) { reject(e); }
    });
}
// -- end AXTree --

let activeAiRequests = new Map();
function cancelActiveAiRequests(tabId) {
    if (tabId == null) return;
    const it = activeAiRequests.get(tabId);
    if (it) { try { it.abort && it.abort(); } catch (e) {} activeAiRequests.delete(tabId); }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    try {
        if (request && request.__forward_to_content__) {
            const payload = request.__forward_to_content__;
            try {
                if (sender && sender.tab && sender.tab.id != null) {
                    chrome.tabs.sendMessage(sender.tab.id, payload, () => { try { void chrome.runtime.lastError; } catch (e) {} });
                }
            } catch (e) {}
            try { sendResponse && sendResponse({ ok: true, forwarded: true }); } catch (e) {}
            return false;
        }
        if (!request || !request.type) { try { sendResponse && sendResponse({ ok: false, error: "Missing type" }); } catch (e) {} return false; }
        const type = request.type;

        if (type === "REQUEST_OPTIMAL_LOCATOR") {
            (async () => {
                try {
                    const d = request.data || {};
                    const cfg = d.config || await getAiConfig();
                    const tabId = sender && sender.tab && sender.tab.id;
                    const result = await callAiOptimalLocator({
                        snapshot: d.snapshot,
                        elements: d.elements,
                        userPrompt: d.userPrompt || '',
                        promptRules: d.promptRules || null,
                        systemPrompt: d.systemPrompt || null
                    }, cfg, tabId);
                    try { sendResponse({ ok: true, result: result }); } catch (e) {}
                } catch (err) { try { sendResponse({ ok: false, error: String(err && err.message || err) }); } catch (e) {} }
            })();
            return true;
        }

        if (type === "REQUEST_AI_SUGGESTIONS") { handleAiSuggestionsRequest(request, sender, sendResponse); return true; }
        if (type === "REQUEST_CHAT_AI") { handleChatAiRequest(request, sender, sendResponse); return true; }
        if (type === "TEST_AI_CONNECTION") { handleTestAiConnection(request, sender, sendResponse); return true; }
        if (type === "WRITE_CONFIG_FILE") { handleWriteConfigFile(request, sendResponse); return true; }
        if (type === "PING") { try { sendResponse && sendResponse({status: "pong"}); } catch (e) {} return false; }
        if (type === "SET_SIDEBAR_EXPLICITLY_CLOSED") { try { chrome.storage.local.set({isSidebarExplicitlyClosed: request.isClosed}, () => { try { void chrome.runtime.lastError; } catch (e) {} }); } catch (e) {} try { sendResponse && sendResponse({ ok: true }); } catch (e) {} return false; }
        if (type === "CANCEL_AI_REQUESTS") { try { cancelActiveAiRequests(sender.tab && sender.tab.id); } catch (e) {} try { sendResponse && sendResponse({ ok: true }); } catch (e) {} return false; }
        if (type === "UPDATE_LOCATOR_MODE") { try { const tabId = sender && sender.tab && sender.tab.id; if (tabId != null) { locatorModeStates.set(tabId, request.active); setIconForTab(tabId, request.active); } } catch (e) {} try { sendResponse && sendResponse({ ok: true }); } catch (e) {} return false; }

        if (type === "REQUEST_AXTREE_NODE") {
            // chrome.automation is not available on MV3; skip silently
            try { sendResponse({ ok: false, error: 'automation not supported in MV3' }); } catch (e) {}
            return false;
        }

        try { sendResponse && sendResponse({ ok: false, error: "Unhandled: " + type }); } catch (e) {}
        return false;
    } catch (e) {
        try { sendResponse && sendResponse({ ok: false, error: String(e && e.message || e) }); } catch (e) {}
        return false;
    }
});
