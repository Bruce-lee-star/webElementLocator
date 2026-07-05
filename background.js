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

        if (type === "PING") { try { sendResponse && sendResponse({status: "pong"}); } catch (e) {} return false; }
        if (type === "SET_SIDEBAR_EXPLICITLY_CLOSED") { try { chrome.storage.local.set({isSidebarExplicitlyClosed: request.isClosed}, () => { try { void chrome.runtime.lastError; } catch (e) {} }); } catch (e) {} try { sendResponse && sendResponse({ ok: true }); } catch (e) {} return false; }
        if (type === "UPDATE_LOCATOR_MODE") { try { const tabId = sender && sender.tab && sender.tab.id; if (tabId != null) { locatorModeStates.set(tabId, request.active); setIconForTab(tabId, request.active); } } catch (e) {} try { sendResponse && sendResponse({ ok: true }); } catch (e) {} return false; }

        try { sendResponse && sendResponse({ ok: false, error: "Unhandled: " + type }); } catch (e) {}
        return false;
    } catch (e) {
        try { sendResponse && sendResponse({ ok: false, error: String(e && e.message || e) }); } catch (e) {}
        return false;
    }
});
