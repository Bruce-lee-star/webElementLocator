var currentPageSnapshot = null;
var currentAriaSnapshot = null;
var capturedElements = [];

var PROVIDER_PRESETS = {
  chatgpt: { label: 'ChatGPT', url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o' },
  gemini: { label: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models', model: 'gemini-2.5-pro' },
  deepseek: { label: 'DeepSeek', url: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' },
  claude: { label: 'Claude', url: 'https://api.anthropic.com/v1/messages', model: 'claude-3-5-sonnet-20241022' },
  ark: { label: 'Ark (火山引擎)', url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', model: 'ep-xxxxxxxxxxxx' }
};

var promptTemplates = [];
var selectedPromptTemplateId = '';

var DEFAULT_PROMPT_TEMPLATE_ID = 'pt_default';
var DEFAULT_SYSTEM_PROMPT = 'You are a senior web test automation engineer. For each selected element, return CSS selectors as the PRIMARY output; XPath is a fallback only. Each element comes with: its own tag/attributes, an ancestor chain (parent→grandparent...), sibling context, AXTree semantic data (axtree field from chrome.automation API — browser-filtered semantic truth), and the page snapshot. Use ancestor IDs/roles to build scoped CSS selectors like "#form [name=email]" — NOT just "#email". ⚠️ data-testid may be dynamically generated; verify against axtree first. ## 🌐 Multi-Language / NLS Stability (CRITICAL — apply BEFORE other rules) Elements may have "axtree" semantic info from Chrome AXTree. TREAT IT AS PRIMARY TRUTH. ANTI-NLS PRIORITY: ① data-i18n-key/data-i18n-id → confidence 100 — completely immune to any language switch. ② data-testid/data-cy/data-test/data-qa → confidence 95 — stable across NLS. ③ aria-label (from axtree.attributes) → confidence 90 — static attribute, NOT visible text. ④ role + semantic parent chain (axtree.parentChain roles/names) → confidence 85 — structural, language-independent. ⑤ name+type combo → confidence 85. ⑥ placeholder → confidence 75 (⚠️ may change with language). ❌ AVOID text()/contains(text(),...)/visible text → WILL BREAK on language switch. When axtree.nlsRisk==="high": css_confidence -20, note "NLS-sensitive". When axtree.nlsRisk==="none": css_confidence +5, note "NLS-stable". When axtree provides data-i18n-key: prefer [data-i18n-key="..."] as primary CSS locator. ## 🚫 Hidden/Invisible/Sensitive Element Exclusion DO NOT generate selectors for hidden/invisible elements (type="hidden", [hidden], display:none, visibility:hidden, aria-hidden="true", zero dimensions, clipping, off-screen). Also skip: <input type="password"> (security risk), reCAPTCHA/CAPTCHA (cannot be automated), CSRF hidden inputs. For hidden/sensitive: css=null, xpath=null, confidence=0. ## Table/Grid Strategy Use CSS structural pseudo-classes scoped under stable ancestor: :first-child/:last-child (75), :nth-child/:nth-of-type (65). ## 🏗️ Shadow DOM Mark shadow-boundary in "why". XPath does NOT cross shadow boundaries — set xpath=null, confidence=0. Playwright penetrates open shadow roots natively; Selenium needs getShadowRoot(). ## 🖼️ iframe Generate CSS/XPath relative to iframe document root. Note iframe name/id for frame-switching. ## ⚛️ Dynamic Content CSS Module class names WILL change — never use as primary (confidence≤20). Virtual list nth-child is volatile (confidence≤40). ## 🔄 State-Aware :disabled/[readonly]/error states → include as alternatives. Only for non-default states. ## 🌐 Cross-Browser :has() not in Firefox ESR — avoid. XPath slower in Safari — prefer CSS. ## Reasoning process (0) Check hidden/invisible/sensitive → skip if yes. (0a) IF axtree exists: check data-i18n-key → use as primary. Check aria-label/role from axtree before falling back to DOM attrs. (0b) Verify selector targets SINGLE unique element. (1) Check unique id → #id CSS. (2) Scope under parent with id/role. (3) Table/grid → structural pseudo-classes. (4) Use sibling context. (5) Prefer stable attrs (name, type, aria-label, placeholder — WCAG 2.1 compliant) over class/text. (6) XPath only when CSS cannot express relationship. Output constraints: max 3 alternatives, "why" ≤80 chars, "general_notes" ≤120 chars. Respond in JSON only: {"elements":[{"index":<idx>,"css":<string|null>,"css_confidence":<0-100>,"xpath":<string|null>,"xpath_confidence":<0-100>,"why":<string≤80>,"alternatives":[{"kind":"css|xpath","value":"...","reason":"..."}]}],"general_notes":[...]} Confidence (visible): id=100, data-i18n-key=100, data-i18n-id=100, data-testid=95, aria-label=90, name+type=90, role+parent-chain=85, placeholder=85, scoped-under-parent-id=85, first-child/last-child=75, class=70, text=55, nth-child-in-table=65, nth-child-bare=35. Confidence (hidden/sensitive): always 0. Robustness: -10 if depth>4 levels; -15 if dynamic classes; -20 if axtree.nlsRisk==="high".';

var PROMPT_TEMPLATE_DIR = 'templates';
var PROMPT_TEMPLATE_FILE = 'templates/templates.json';

function escapeForCode(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function suggestVariableName(el, idx) {
  var raw = '';
  if (el.text && el.text.trim()) {
    raw = el.text.trim().replace(/[^a-zA-Z0-9\\u4e00-\\u9fff\\s]/g, ' ').replace(/\\s+/g, ' ').trim();
    if (raw.length > 25) raw = raw.slice(0, 25);
  }
  if (!raw && el.id) raw = el.id.replace(/[^a-zA-Z0-9]/g, ' ');
  if (!raw && el.ariaLabel) raw = el.ariaLabel.replace(/[^a-zA-Z0-9\\s]/g, ' ').trim();
  if (!raw && el.class) raw = el.class.split(' ')[0].replace(/[^a-zA-Z0-9]/g, ' ');
  if (!raw) raw = ((el.tagName || el.tag || 'element') + ' ' + (idx + 1));
  var words = raw.split(/\\s+/).filter(function(w){ return w.length > 0; });
  if (words.length === 0) return 'element' + (idx + 1);
  var first = words[0].toLowerCase();
  var rest = words.slice(1).map(function(w){
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  });
  var result = first + rest.join('');
  if (!/^[a-zA-Z]/.test(result)) result = 'elem' + result;
  return result;
}

function escapeHtml(s){
  return String(s==null?'':s).replace(/[&<>"]/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; });
}

function sendToContentScript(type, data){
  var payload = { type: type, data: data, source: 'sidebar' };

  // Use only ONE path to avoid double-delivery (which causes toggle flash bug).
  // Primary: direct postMessage to parent — sidebar is always in an iframe on the target page
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(payload, '*');
      return;
    }
  } catch(e) {}

  // Fallback: route through background only if postMessage is unavailable
  try {
    chrome.runtime.sendMessage({ __forward_to_content__: payload });
  } catch(e) {}
}

function sendRuntimeMessage(msg){
  return new Promise(function(resolve){
    try { chrome.runtime.sendMessage(msg, function(res){ resolve(res); }); }
    catch(e){ resolve({ ok:false, error: String(e && e.message || e) }); }
  });
}

function getStorage(key){
  return new Promise(function(resolve){
    try { chrome.storage.local.get(key, function(o){ resolve(o && o[key]); }); }
    catch(e){ resolve(null); }
  });
}

function setStorage(obj){
  return new Promise(function(resolve){
    try { chrome.storage.local.set(obj, function(){ resolve(true); }); }
    catch(e){ resolve(false); }
  });
}

async function getAiConfig(){
  var configs = await getStorage('aiConfigs');
  var current = await getStorage('currentProvider');
  // Migrate old single-provider format
  if (!configs) {
    var oldCfg = await getStorage('aiConfig');
    if (oldCfg && oldCfg.provider) {
      configs = {};
      configs[oldCfg.provider] = {
        token: oldCfg.token || '',
        model: oldCfg.model || '',
        url: oldCfg.url || '',
        enabled: oldCfg.enabled !== false
      };
      current = oldCfg.provider;
      await setStorage({ aiConfigs: configs, currentProvider: current });
    } else {
      configs = {};
      current = 'chatgpt';
    }
  }
  var providerId = current || 'chatgpt';
  var saved = configs[providerId] || {};
  var presets = PROVIDER_PRESETS[providerId] || {};
  var custom = null;
  customProviders.forEach(function(cp){ if (cp.id === providerId) custom = cp; });

  return {
    provider: providerId,
    token: saved.token || '',
    model: saved.model || presets.model || (custom ? custom.model : '') || '',
    url: saved.url || presets.url || (custom ? custom.url : '') || '',
    name: presets.label || (custom ? custom.name : providerId) || 'No AI Selected',
    enabled: saved.enabled !== false
  };
}

async function saveAiConfig(cfg){
  var configs = await getStorage('aiConfigs') || {};
  if (!configs[cfg.provider]) configs[cfg.provider] = {};
  configs[cfg.provider].token = cfg.token || '';
  configs[cfg.provider].model = cfg.model || '';
  configs[cfg.provider].url = cfg.url || '';
  configs[cfg.provider].enabled = cfg.enabled !== false;
  await setStorage({ aiConfigs: configs, currentProvider: cfg.provider });
}

function clearCapturedElements(){
  capturedElements = [];
  currentPageSnapshot = null;
  currentAriaSnapshot = null;
  updateCapturedElementsList();
  sendToContentScript('CLEAR_CAPTURED_ELEMENTS', null);
}

function switchToCapturedElement(index){
  var list = document.getElementById('capturedElementsList');
  if (!list) return;
  var items = list.querySelectorAll('.captured-element-item');
  items.forEach(function(it){ it.classList.remove('active'); });
  if (items[index]) items[index].classList.add('active');
}

function updateCapturedElementsList(){
  var list = document.getElementById('capturedElementsList');
  var countEl = document.getElementById('capturedElementsCount');
  if (!list) return;

  list.innerHTML = '';

  if (!capturedElements || capturedElements.length === 0) {
    list.style.display = 'block';
    if (countEl) countEl.textContent = '0 picked';
    var hint = document.createElement('div');
    hint.className = 'captured-empty-hint';
    hint.innerHTML = '<i data-lucide="mouse-pointer" class="empty-hint-icon"></i><span>Click <strong>Start Pick</strong> above to select elements</span>';
    list.appendChild(hint);
    try { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); } catch(e){}
    return;
  }
  list.style.display = 'block';
  if (countEl) countEl.textContent = capturedElements.length + ' picked';

  var frag = document.createDocumentFragment();
  capturedElements.forEach(function(el, index){
    var node = document.createElement('div');
    node.className = 'captured-element';
    node.innerHTML = renderCapturedElementItem(el, index);
    frag.appendChild(node);
  });
  list.appendChild(frag);

  list.querySelectorAll('.captured-element-item').forEach(function(item, i){
    item.addEventListener('click', function(){ switchToCapturedElement(i); });
  });

  // Expand/collapse full outerHTML
  list.querySelectorAll('.captured-html-expand').forEach(function(btn){
    btn.addEventListener('click', function(e){
      e.stopPropagation();
      var idx = parseInt(btn.getAttribute('data-idx'), 10);
      var pre = document.getElementById('captured-html-'+idx);
      var parent = btn.closest('.captured-element-html');
      var code = parent ? parent.querySelector('.captured-html-code') : null;
      if (!pre) return;
      if (pre.style.display === 'none') {
        pre.style.display = 'block';
        btn.textContent = 'Hide full HTML';
        if (code) code.style.display = 'none';
      } else {
        pre.style.display = 'none';
        btn.textContent = 'Show full HTML';
        if (code) code.style.display = 'inline';
      }
    });
  });
}

function renderCapturedElementItem(el, index) {
  var parts = [];
  var outerHTML = el.outerHTML || el.elementHTML || '';
  var preview = (el.preview || el.text || el.className || '').slice(0, 80);
  parts.push('<div class="captured-element-item" data-idx="'+index+'">');
  parts.push('<div class="captured-element-header">');
  parts.push('<span class="captured-element-tag">'+escapeHtml(el.tagName||el.tag||'?')+'</span>');
  parts.push('<span class="captured-element-time">'+escapeHtml(el.time||'')+'</span>');
  parts.push('</div>');
  // OuterHTML preview (truncated, expandable)
  parts.push('<div class="captured-element-html" title="Click to expand">');
  if (outerHTML) {
    var truncated = escapeHtml(outerHTML.slice(0, 200));
    if (outerHTML.length > 200) truncated += '...';
    parts.push('<code class="captured-html-code">'+truncated+'</code>');
    parts.push('<button class="captured-html-expand" data-idx="'+index+'">Show full HTML</button>');
    parts.push('<pre class="captured-html-full" id="captured-html-'+index+'" style="display:none;">'+escapeHtml(outerHTML)+'</pre>');
  } else {
    parts.push('<code class="captured-html-code">'+escapeHtml(preview)+'</code>');
  }
  parts.push('</div>');
  // AI results: inline display when analyzed
  if (el.ai && (el.ai.waiting || el.ai.error)) {
    parts.push('<div class="ai-locator ' + (el.ai.error ? 'ai-error' : 'ai-waiting') + '">' + (el.ai.error ? escapeHtml(el.ai.error) : 'Analyzing...') + '</div>');
  } else if (el.ai && el.ai.css && el.ai.css.recommendation) {
    var conf = el.ai.css.confidence ? ' (' + el.ai.css.confidence + '%)' : '';
    parts.push('<div class="ai-locator ai-done"><span class="ai-locator-kind">CSS</span><code class="ai-locator-value" title="' + escapeHtml(el.ai.css.recommendation) + '">' + escapeHtml(el.ai.css.recommendation) + '</code><span class="ai-locator-conf">' + conf + '</span></div>');
  }
  if (el.ai && el.ai.xpath && el.ai.xpath.recommendation) {
    var conf2 = el.ai.xpath.confidence ? ' (' + el.ai.xpath.confidence + '%)' : '';
    parts.push('<div class="ai-locator ai-done"><span class="ai-locator-kind">XPATH</span><code class="ai-locator-value" title="' + escapeHtml(el.ai.xpath.recommendation) + '">' + escapeHtml(el.ai.xpath.recommendation) + '</code><span class="ai-locator-conf">' + conf2 + '</span></div>');
  }
  parts.push('</div>');
  parts.push('</div>');
  return parts.join('');
}

async function requestOptimalLocatorsBatch(elementsArray, userPrompt, systemPromptOverride){
  try {
    var cfg = await getAiConfig();
    if (!cfg || !cfg.token) return { ok:false, error:'AI token not configured. Open gear -> AI Settings.' };
    var rules = await getStorage('promptRules');
    var resp = await sendRuntimeMessage({
      type: 'REQUEST_OPTIMAL_LOCATOR',
      data: {
        config: cfg,
        elements: elementsArray,
        userPrompt: userPrompt || '',
        promptRules: rules || null,
        systemPrompt: systemPromptOverride || null,
        snapshot: currentPageSnapshot
      }
    });
    return resp || { ok:false, error:'no response from background' };
  } catch(e){ return { ok:false, error: String(e && e.message || e) }; }
}

async function autoValidateLocators(bubble) {
  // Gather primary CSS/XPath locators from AI results
  var checks = [];
  capturedElements.forEach(function(el, idx) {
    if (el.ai && !el.ai.error && !el.ai.waiting) {
      var css = el.ai.css && el.ai.css.recommendation;
      var xp = el.ai.xpath && el.ai.xpath.recommendation;
      if (css) checks.push({ idx: idx, kind: 'css', value: css });
      if (xp) checks.push({ idx: idx, kind: 'xpath', value: xp });
    }
  });
  if (!checks.length) return;

  var correlationId = 'v_' + Date.now();

  try {
    var resp = await new Promise(function(resolve) {
      var timeout = setTimeout(function(){ resolve(null); }, 5000);
      function onMsg(e) {
        if (e.data && e.data._correlation === correlationId) {
          clearTimeout(timeout);
          window.removeEventListener('message', onMsg);
          resolve(e.data);
        }
      }
      window.addEventListener('message', onMsg);
      try {
        window.parent.postMessage({ type: 'VALIDATE_LOCATORS', data: { tests: checks }, _correlation: correlationId }, '*');
      } catch(e) { clearTimeout(timeout); resolve(null); }
    });

    if (!resp || !resp.ok || !resp.results) return;

    // Update bubble with validation results
    var lines = [];
    lines.push('\n--- Validation ---');
    var allPassed = true;
    resp.results.forEach(function(r) {
      var icon = r.count === 1 ? '✓' : r.count === 0 ? '✗' : '⚠';
      if (r.count !== 1) allPassed = false;
      var label;
      if (r.idx != null && r.idx < capturedElements.length) {
        var el = capturedElements[r.idx];
        var name = suggestVariableName(el, r.idx);
        label = '[' + (r.idx + 1) + ':' + name + '] ';
      } else {
        label = '';
      }
      lines.push('  ' + icon + ' ' + label + (r.kind || '').toUpperCase() + ' matches ' + r.count + ' element(s)');
    });
    if (allPassed) lines.push('All locators unique — great!');
    else lines.push('⚠ Some locators may be ambiguous — check alternatives above.');

    if (bubble) bubble.textContent = bubble.textContent + lines.join('\n');
  } catch(e) {
    if (bubble) bubble.textContent = bubble.textContent + '\n\n--- Validation ---\n⚠ Could not validate (page may have changed)';
  }
}

function formatElementsForUserMessage(){
  var lines = [];
  capturedElements.forEach(function(el, idx){
    var desc = '<' + (el.tagName || '?') + '>';
    if (el.text && el.text.trim()) desc += ' "' + el.text.trim().slice(0, 60) + '"';
    if (el.id) desc += ' #' + el.id;
    if (el.className && typeof el.className === 'string') desc += ' .' + el.className.split(' ').slice(0, 2).join('.');
    var name = suggestVariableName(el, idx);
    lines.push('Element ' + (idx + 1) + ': ' + desc + '  (' + name + ')');
    var html = (el.elementHTML || el.outerHTML || el.preview || '').trim();
    if (html) lines.push('```html\n' + html.slice(0, 600) + '\n```');
    lines.push('');
  });
  return lines.join('\n');
}

function formatAiResultsForChat(thinking){
  var lines = [];
  if (thinking && thinking.trim()) {
    lines.push(thinking.trim());
    lines.push('');
  }
  capturedElements.forEach(function(el, idx){
    var name = suggestVariableName(el, idx);
    var desc = '<' + (el.tagName || '?') + '>';
    if (el.text && el.text.trim()) desc += ' "' + el.text.trim().slice(0, 40) + '"';
    lines.push('### ' + (idx + 1) + '. ' + desc + '  (' + name + ')');
    if (!el.ai || el.ai.error) {
      lines.push('❌ ' + (el.ai && el.ai.error ? el.ai.error : 'No locator'));
    } else {
      if (el.ai.css && el.ai.css.recommendation) {
        lines.push('`' + el.ai.css.recommendation + '`' + (el.ai.css.confidence ? '  (' + el.ai.css.confidence + '%)' : ''));
      }
      if (el.ai.xpath && el.ai.xpath.recommendation) {
        lines.push('`' + el.ai.xpath.recommendation + '`' + (el.ai.xpath.confidence ? '  (' + el.ai.xpath.confidence + '%)' : ''));
      }
      if (el.ai.rationale) {
        lines.push('💡 ' + el.ai.rationale);
      }
      if (el.ai.alternatives && el.ai.alternatives.length) {
        lines.push('🔹 Alternatives:');
        el.ai.alternatives.forEach(function(a){
          lines.push('  · `' + a.value + '`');
        });
      }
    }
    lines.push('');
  });
  return lines.join('\n');
}

async function askAiForAllLocators(){
  if (!capturedElements || capturedElements.length === 0) return;
  var btn = document.getElementById('askAiBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Asking...'; }

  // Read user prompt from input field
  var promptInput = document.getElementById('aiUserPrompt');
  var userPrompt = promptInput ? (promptInput.value || '').trim() : '';
  if (promptInput) promptInput.value = '';

  // Auto-expand AI bar and open chat
  var section = document.getElementById('aiSuggestionsSection');
  if (section) section.classList.add('expanded');
  if (!chatOpen) openAiChat();

  // Build user message: elements + prompt
  var userMsg = 'Generate reliable CSS selectors and XPath locators for the following elements:\n\n';
  userMsg += formatElementsForUserMessage();
  if (userPrompt) {
    userMsg += '\n--- Additional Instruction ---\n' + userPrompt;
  }
  appendChatBubble('user', userMsg);

  var loadId = addChatLoadingIndicator();

  var elementsForAI = capturedElements.map(function(el, idx){
    var item = {
      idx: idx,
      tag: el.tagName || el.tag,
      id: el.id || '',
      class: el.className || '',
      preview: (el.elementHTML || el.outerHTML || el.preview || '').slice(0, 300),
      text: el.text || '',
      keyAttrs: el.keyAttrs || null,
      ancestors: el.ancestors || null,
      siblingContext: el.siblingContext || null,
      locators: el.locators || null
    };
    if (el.axtree) {
      item.axtree = el.axtree;
    }
    return item;
  });

  var resp;
  try {
    var activeSystemPrompt = getActiveSystemPrompt();
    resp = await requestOptimalLocatorsBatch(elementsForAI, userPrompt, activeSystemPrompt);
    if (resp && resp.ok && resp.result && resp.result.elements) {
      var results = resp.result.elements;
      results.forEach(function(r){
        if (r && typeof r.idx === 'number' && r.idx < capturedElements.length) {
          capturedElements[r.idx].ai = {
            css: r.css || null,
            xpath: r.xpath || null,
            rationale: (r.css && r.css.rationale) || (r.xpath && r.xpath.rationale) || r.rationale || '',
            alternatives: r.alternatives || null
          };
        }
      });
      capturedElements.forEach(function(el){ if (!el.ai || el.ai.waiting) el.ai = { error: 'AI did not return locator for this element' }; });
    } else {
      var err = (resp && resp.error) || 'AI response malformed';
      capturedElements.forEach(function(el){ el.ai = { error: err }; });
    }
  } catch(e){
    capturedElements.forEach(function(el){ el.ai = { error: String(e.message || e) }; });
  }

  removeChatLoadingIndicator(loadId);

  // Show results in chat
  var thinking = (resp && resp.result && resp.result.thinking) || '';
  var hasAnyError = capturedElements.some(function(el){ return el.ai && el.ai.error; });
  var chatText;
  if (hasAnyError && !thinking) {
    chatText = '❌ ' + (resp && resp.error ? resp.error : 'AI request failed');
  } else {
    chatText = formatAiResultsForChat(thinking);
  }
  var bubble = appendChatBubble('ai', chatText);

  autoValidateLocators(bubble);
  
  updateCapturedElementsList();
  if (btn) { btn.disabled = false; btn.textContent = 'Ask'; }
}

function handleSidebarMessage(type, data){
  if (!type) return;
  if (type === 'PAGE_SNAPSHOT') {
    currentPageSnapshot = data && data.snapshot;
    return;
  }
  if (type === 'LOCATOR_MODE_CHANGED') {
    var active = !!(data && data.active);
    var btn = document.getElementById('toggleLocator');
    var lbl = document.getElementById('locatorBtnText');
    if (lbl) lbl.textContent = active ? 'Stop Picking' : 'Start Pick';
    if (btn) {
      btn.classList.toggle('is-active', active);
      btn.style.background = active ? '#e74c3c' : '';
    }
    return;
  }
  if (type === 'ELEMENT_SELECTED') {
    var elementData = data || {};
    var now = new Date();
    var tagName = elementData.tag || elementData.tagName || elementData.elementType || '?';
    var preview = (elementData.outerHTML || elementData.elementHTML || elementData.preview || '').slice(0, 300);
    elementData.time = now.toLocaleTimeString();
    elementData.ts = now.getTime();
    elementData.tagName = tagName;
    elementData.elementHTML = elementData.outerHTML || elementData.elementHTML || '';
    elementData.preview = preview;
    capturedElements.push(elementData);
    updateCapturedElementsList();
    return;
  }
  if (type === 'ELEMENT_HISTORY_UPDATED') {
    var hist = (data && data.elements) || [];
    var existingAis = {};
    capturedElements.forEach(function(e){ if (e.ai != null && e.ts != null) existingAis[e.ts] = e.ai; });
    capturedElements = hist.map(function(el){
      if (el && el.ts && existingAis[el.ts]) el.ai = existingAis[el.ts];
      return el;
    });
    if (capturedElements.length > 0) updateCapturedElementsList();
    return;
  }
  if (type === 'OPTIMAL_LOCATOR_RESULT') {
    if (data && data.snapshot) currentPageSnapshot = data.snapshot;
    return;
  }
  if (type === 'AI_CONFIG_LOADED' || type === 'AI_CONFIG_UPDATED' || type === 'AI_TOKEN_LOADED') {
    updateAiProviderUi();
    return;
  }
}

function handleMessageFromParent(event){
  try {
    var src = (event.data && event.data.source) || '';
    if (src === 'sidebar') return;
    var payload = event.data || {};
    if (!payload.type) return;
    handleSidebarMessage(payload.type, payload.data);
  } catch (e) {}
}

/* ===================== AI Config Modal ===================== */

var selectedBuiltinProvider = null;
var customProviders = [];

async function openAiConfigModal(){
  var modal = document.getElementById('aiConfigModal');
  if (modal) modal.style.display = 'flex';
  await loadAiConfigForm();
}

function closeAiConfigModal(){
  var modal = document.getElementById('aiConfigModal');
  if (modal) modal.style.display = 'none';
}

function switchConfigTab(tabId){
  document.querySelectorAll('#aiConfigModal .tab-btn').forEach(function(b){
    b.classList.toggle('active', b.getAttribute('data-tab') === tabId);
  });
  document.querySelectorAll('#aiConfigModal .tab-content').forEach(function(c){
    c.classList.toggle('active', c.id === tabId);
  });
}

async function loadAiConfigForm(){
  var cfg = await getAiConfig();
  var custom = await getStorage('customProviders');
  if (Array.isArray(custom)) customProviders = custom;

  // Master toggle
  var enableCb = document.getElementById('enableAiFeatures');
  if (enableCb) enableCb.checked = cfg.enabled !== false;

  var msg = document.getElementById('aiDisabledMessage');
  var provSection = document.getElementById('aiProviderConfiguration');
  if (enableCb && !enableCb.checked) {
    if (msg) msg.style.display = 'block';
    if (provSection) provSection.style.display = 'none';
  } else {
    if (msg) msg.style.display = 'none';
    if (provSection) provSection.style.display = 'block';
  }

  // Provider selection (builtin or custom)
  selectedBuiltinProvider = PROVIDER_PRESETS[cfg.provider] ? cfg.provider : null;

  // Highlight builtin providers
  document.querySelectorAll('#builtinAiProviders .ai-provider').forEach(function(el){
    var p = el.getAttribute('data-provider');
    el.classList.toggle('active', p === cfg.provider);
  });

  // Render custom providers
  renderCustomProvidersList(cfg.provider);

  // Populate token section
  populateTokenSection(cfg);
  updateAiProviderUi();
}

function populateTokenSection(cfg){
  var section = document.getElementById('tokenSection');
  if (!section) return;
  section.style.display = 'block';

  var isBuiltin = !!PROVIDER_PRESETS[cfg.provider];
  var presets = PROVIDER_PRESETS[cfg.provider];

  var titleEl = document.getElementById('tokenSectionTitleText');
  if (titleEl) {
    titleEl.textContent = (isBuiltin ? presets.label : (cfg.name || cfg.provider)) + ' - API Key';
  }

  var urlInput = document.getElementById('aiApiUrlInput');
  var tokenInput = document.getElementById('aiTokenInput');

  if (urlInput) {
    if (isBuiltin) {
      urlInput.value = presets.url;
      urlInput.disabled = true;
      urlInput.placeholder = presets.url;
    } else {
      urlInput.disabled = false;
      urlInput.value = cfg.url || '';
      urlInput.placeholder = 'https://your-api.com/v1/chat/completions';
    }
  }

  // Model input — visible for all providers, editable
  var modelWrapper = document.getElementById('modelNameWrapper');
  var modelInput = document.getElementById('aiModelInput');
  var arkHint = document.getElementById('arkModelHint');
  if (modelWrapper && modelInput) {
    modelWrapper.style.display = 'block';
    modelInput.value = cfg.model || '';
    modelInput.placeholder = isBuiltin ? (presets.model || 'Model name') : 'Model name';
    // Ark-specific hint
    if (arkHint) {
      arkHint.style.display = (cfg.provider === 'ark') ? 'block' : 'none';
    }
  }

  if (tokenInput) tokenInput.value = cfg.token || '';

  // Buttons & status
  var saveBtn = document.getElementById('saveTokenBtn');
  var deleteBtn = document.getElementById('deleteTokenBtn');
  var testBtn = document.getElementById('testAiBtn');
  var statusArea = document.getElementById('tokenStatusArea');
  var inputArea = document.getElementById('tokenInputArea');

  if (inputArea) inputArea.style.display = 'block';
  if (cfg.token) {
    if (statusArea) statusArea.style.display = 'flex';
    if (saveBtn) saveBtn.style.display = 'inline-flex';
    if (deleteBtn) deleteBtn.style.display = 'inline-flex';
    if (testBtn) testBtn.style.display = 'inline-flex';
  } else {
    if (statusArea) statusArea.style.display = 'none';
    if (saveBtn) saveBtn.style.display = 'inline-flex';
    if (deleteBtn) deleteBtn.style.display = 'none';
    if (testBtn) testBtn.style.display = 'inline-flex';
  }
}

function renderCustomProvidersList(selectedProvider){
  var wrap = document.getElementById('customAiProviders');
  var empty = document.getElementById('noCustomProviders');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!customProviders.length) {
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';
  customProviders.forEach(function(cp){
    var item = document.createElement('div');
    item.className = 'custom-provider-item';

    var div = document.createElement('div');
    div.className = 'ai-provider custom' + (selectedProvider === cp.id ? ' active' : '');
    div.setAttribute('data-provider', cp.id);
    div.innerHTML = '<i data-lucide="plug" class="provider-icon"></i><div class="provider-name">'+escapeHtml(cp.name)+'</div>';
    div.addEventListener('click', function(){ selectProvider(cp.id); });

    var delBtn = document.createElement('button');
    delBtn.className = 'custom-provider-delete-btn';
    delBtn.title = 'Delete ' + escapeHtml(cp.name);
    delBtn.innerHTML = '<svg class="delete-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
    delBtn.addEventListener('click', function(e){
      e.stopPropagation();
      e.preventDefault();
      deleteCustomProvider(cp.id);
    });

    item.appendChild(div);
    item.appendChild(delBtn);
    wrap.appendChild(item);
  });
  try { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); } catch(e){}
}

async function deleteCustomProvider(id){
  if (!confirm('Delete this custom provider? This cannot be undone.')) return;
  customProviders = customProviders.filter(function(cp){ return cp.id !== id; });
  await setStorage({ customProviders: customProviders });
  // If the deleted provider was currently selected, switch to default
  var cfg = await getAiConfig();
  if (cfg.provider === id) {
    await selectProvider('chatgpt');
  } else {
    await loadAiConfigForm();
  }
  showToast('Provider deleted');
}

async function selectProvider(providerId){
  var cfg = await getAiConfig();
  // Save current provider config before switching
  await saveAiConfig(cfg);

  cfg.provider = providerId;
  if (PROVIDER_PRESETS[providerId]) {
    var p = PROVIDER_PRESETS[providerId];
    cfg.name = p.label;
    cfg.url = p.url;
    cfg.model = p.model;
  } else {
    var cp = customProviders.find(function(x){ return x.id === providerId; });
    if (cp) {
      cfg.name = cp.name;
      cfg.url = cp.url || '';
      cfg.model = cp.model || '';
    }
  }
  // Load saved config for new provider if exists
  var configs = await getStorage('aiConfigs') || {};
  if (configs[providerId]) {
    cfg.token = configs[providerId].token || '';
    cfg.model = configs[providerId].model || cfg.model;
    cfg.url = configs[providerId].url || cfg.url;
    cfg.enabled = configs[providerId].enabled !== false;
  } else {
    cfg.token = '';
  }
  await saveAiConfig(cfg);
  populateTokenSection(cfg);
  updateAiProviderUi();

  document.querySelectorAll('#builtinAiProviders .ai-provider').forEach(function(el){
    el.classList.toggle('active', el.getAttribute('data-provider') === providerId);
  });
  renderCustomProvidersList(providerId);

  // Hide custom provider form
  var form = document.getElementById('customProviderForm');
  if (form) form.style.display = 'none';
}

function showCustomProviderForm(existing){
  var form = document.getElementById('customProviderForm');
  var title = document.getElementById('customProviderFormTitle');
  var nameIn = document.getElementById('customProviderName');
  var urlIn = document.getElementById('customProviderUrl');
  var modelIn = document.getElementById('customProviderModel');
  var keyIn = document.getElementById('customProviderKey');
  if (!form) return;
  form.style.display = 'block';
  if (existing) {
    title.textContent = 'Edit Custom Provider';
    nameIn.value = existing.name || '';
    urlIn.value = existing.url || '';
    modelIn.value = existing.model || '';
    keyIn.value = existing.token || '';
    form.dataset.editingId = existing.id || '';
  } else {
    title.textContent = 'Add Custom Provider';
    nameIn.value = '';
    urlIn.value = '';
    modelIn.value = '';
    keyIn.value = '';
    form.dataset.editingId = '';
  }
}

async function saveCustomProvider(){
  var form = document.getElementById('customProviderForm');
  var nameEl = document.getElementById('customProviderName');
  var urlEl = document.getElementById('customProviderUrl');
  var modelEl = document.getElementById('customProviderModel');
  var keyEl = document.getElementById('customProviderKey');
  var name = (nameEl && nameEl.value || '').trim();
  var url = (urlEl && urlEl.value || '').trim();
  var model = (modelEl && modelEl.value || '').trim();
  var token = (keyEl && keyEl.value || '').trim();
  if (!name || !url) return showToast('Provider name and URL required');

  var id = (form && form.dataset.editingId) || ('custom_' + Math.random().toString(36).slice(2, 9));
  var existingIdx = customProviders.findIndex(function(x){ return x.id === id; });
  var entry = { id: id, name: name, url: url, model: model, token: token };
  if (existingIdx >= 0) customProviders[existingIdx] = entry;
  else customProviders.push(entry);
  await setStorage({ customProviders: customProviders });

  // Also auto-select
  await selectProvider(id);

  form.style.display = 'none';
  showToast('Provider saved');
}

function cancelCustomProvider(){
  var form = document.getElementById('customProviderForm');
  if (form) form.style.display = 'none';
}

async function saveToken(){
  var tokenInput = document.getElementById('aiTokenInput');
  var urlInput = document.getElementById('aiApiUrlInput');
  var modelInput = document.getElementById('aiModelInput') || document.getElementById('customProviderModel');
  var token = (tokenInput && tokenInput.value || '').trim();
  if (!token) return showToast('Please enter an API key');

  var cfg = await getAiConfig();
  cfg.token = token;
  if (urlInput && urlInput.disabled === false) cfg.url = urlInput.value.trim();
  if (modelInput && modelInput.value.trim()) cfg.model = modelInput.value.trim();

  await saveAiConfig(cfg);
  await loadAiConfigForm();
  updateAiProviderUi();
  showToast('Token saved');
}

async function deleteToken(){
  if (!confirm('Delete token?')) return;
  var cfg = await getAiConfig();
  cfg.token = '';
  await saveAiConfig(cfg);
  await loadAiConfigForm();
  updateAiProviderUi();
  showToast('Token deleted');
}

async function testAi(){
  var btn = document.getElementById('testAiBtn');
  var orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Testing...'; }
  try {
    var cfg = await getAiConfig();
    // Pick up unsaved edits from the form so test uses the current inputs
    var tokenInput = document.getElementById('aiTokenInput');
    var urlInput = document.getElementById('aiApiUrlInput');
    var modelInput = document.getElementById('aiModelInput') || document.getElementById('customProviderModel');
    if (tokenInput && tokenInput.value.trim()) cfg.token = tokenInput.value.trim();
    if (urlInput) cfg.url = urlInput.value.trim() || cfg.url;
    if (modelInput && modelInput.value.trim()) cfg.model = modelInput.value.trim();
    var resp = await sendRuntimeMessage({ type: 'TEST_AI_CONNECTION', data: { config: cfg } });
    if (btn) { btn.disabled = false; btn.textContent = orig; }
    if (resp && resp.ok) showToast('AI OK ✓');
    else showToast('AI Error: ' + (resp && resp.error || 'unknown'));
  } catch(e){
    if (btn) { btn.disabled = false; btn.textContent = orig; }
    showToast('Test failed: ' + e.message);
  }
}

async function toggleMasterAi(){
  var cb = document.getElementById('enableAiFeatures');
  var cfg = await getAiConfig();
  cfg.enabled = !!cb.checked;
  await saveAiConfig(cfg);
  var msg = document.getElementById('aiDisabledMessage');
  var provSection = document.getElementById('aiProviderConfiguration');
  if (!cb.checked) {
    if (msg) msg.style.display = 'block';
    if (provSection) provSection.style.display = 'none';
  } else {
    if (msg) msg.style.display = 'none';
    if (provSection) provSection.style.display = 'block';
  }
  updateAiProviderUi();
}

async function exportAiConfigs(){
  var configs = await getStorage('aiConfigs') || {};
  var custom = await getStorage('customProviders') || [];
  var obj = {
    aiConfigs: configs,
    customProviders: custom,
    exportedAt: new Date().toISOString(),
    version: '1.0'
  };
  var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'web-element-locator-ai-config.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Config exported to JSON');
}

async function importAiConfigs(file){
  var reader = new FileReader();
  reader.onload = async function(e){
    try {
      var obj = JSON.parse(e.target.result);
      if (!obj || !obj.aiConfigs) return showToast('Invalid config file');
      await setStorage({ aiConfigs: obj.aiConfigs });
      if (obj.customProviders) await setStorage({ customProviders: obj.customProviders });
      showToast('Config imported');
      await loadAiConfigForm();
      updateAiProviderUi();
    } catch(err){
      showToast('Import failed: ' + (err && err.message || err));
    }
  };
  reader.readAsText(file);
}

function showToast(text){
  var t = document.getElementById('promptRulesToast');
  if (t) {
    t.textContent = text;
    // Color: red for errors, green for success
    var isError = /error|fail|wrong|invalid|404/i.test(text);
    t.style.background = isError ? 'rgba(231, 76, 60, 0.95)' : 'rgba(39, 174, 96, 0.95)';
    t.style.display = 'block';
    setTimeout(function(){ t.style.display = 'none'; }, 2500);
  } else {
    alert(text);
  }
}

/* ===================== Prompt Rules Modal ===================== */

async function savePromptRules(){
  var sel = document.getElementById('promptFramework');
  var frameworks = [];
  if (sel) {
    Array.from(sel.selectedOptions).forEach(function(o){ frameworks.push(o.value); });
  }
  var rules = [];
  document.querySelectorAll('.prompt-rule-cb:checked').forEach(function(cb){ rules.push(cb.getAttribute('data-rule')); });
  var custom = (document.getElementById('customPromptRules').value || '').trim();

  var payload = { frameworks: frameworks, rules: rules, custom: custom };
  await setStorage({ promptRules: payload });
  var modal = document.getElementById('promptRulesModal');
  if (modal) modal.style.display = 'none';
  showToast('Rules saved');
}

function closePromptRules(){
  var modal = document.getElementById('promptRulesModal');
  if (modal) modal.style.display = 'none';
}

/* ===================== Prompt Template Management ===================== */

async function loadPromptTemplates() {
  promptTemplates = [];
  try {
    var url = chrome.runtime.getURL(PROMPT_TEMPLATE_FILE);
    var resp = await fetch(url);
    if (resp.ok) {
      var data = await resp.json();
      if (Array.isArray(data)) {
        promptTemplates = data;
      }
    }
  } catch(e) { /* file not found or invalid, will use fallback */ }

  // Fallback: ensure at least the default template exists in-memory
  if (!promptTemplates.length || !promptTemplates.some(function(t){ return t.id === DEFAULT_PROMPT_TEMPLATE_ID; })) {
    promptTemplates.unshift({ id: DEFAULT_PROMPT_TEMPLATE_ID, name: 'Default (Comprehensive)', systemPrompt: DEFAULT_SYSTEM_PROMPT, isBuiltin: true });
  }

  // selectedPromptTemplateId is in-memory only, resets on reload
  selectedPromptTemplateId = '';
  renderPromptTemplateDropdown();
}

function getActiveSystemPrompt() {
  if (selectedPromptTemplateId) {
    var tpl = promptTemplates.find(function(t){ return t.id === selectedPromptTemplateId; });
    if (tpl && tpl.systemPrompt) return tpl.systemPrompt;
  }
  return DEFAULT_SYSTEM_PROMPT;
}

function renderPromptTemplateDropdown() {
  var sel = document.getElementById('promptTemplateSelect');
  if (!sel) return;
  sel.innerHTML = '<option value="">--- Default ---</option>';
  promptTemplates.forEach(function(t){
    var o = document.createElement('option');
    o.value = t.id;
    o.textContent = t.name;
    sel.appendChild(o);
  });
  var o2 = document.createElement('option');
  o2.value = '__manage_prompt__';
  o2.textContent = '—— Manage Prompt Templates ——';
  sel.appendChild(o2);
  if (selectedPromptTemplateId) sel.value = selectedPromptTemplateId;
}

function onPromptTemplateChange() {
  var sel = document.getElementById('promptTemplateSelect');
  if (!sel) return;
  var val = sel.value;
  if (val === '__manage_prompt__') {
    openPromptTemplateMgmt();
    sel.value = selectedPromptTemplateId || '';
    return;
  }
  selectedPromptTemplateId = val || '';
}

function openPromptTemplateMgmt() {
  var modal = document.getElementById('promptTemplateMgmtModal');
  if (modal) modal.style.display = 'flex';
  renderPromptTemplateList();
}

function closePromptTemplateMgmt() {
  var modal = document.getElementById('promptTemplateMgmtModal');
  if (modal) modal.style.display = 'none';
}

function renderPromptTemplateList() {
  var list = document.getElementById('promptTemplateMgmtList');
  if (!list) return;
  if (!promptTemplates.length) {
    list.innerHTML = '<div class="no-custom-providers"><i data-lucide="file-text" class="empty-icon"></i><p>No prompt templates. Create one below.</p></div>';
  } else {
    var html = '<div class="template-dir-hint"><i data-lucide="folder" class="label-icon"></i> Source: <code>' + escapeHtml(PROMPT_TEMPLATE_FILE) + '</code> — edit this file in your IDE to persist templates.</div>';
    promptTemplates.forEach(function(t){
      var preview = (t.systemPrompt || '').slice(0, 80) + ((t.systemPrompt || '').length > 80 ? '...' : '');
      var builtinBadge = t.isBuiltin ? ' <small style="color:#999;">(builtin)</small>' : '';
      html += '<div class="template-mgmt-item">' +
        '<div class="template-mgmt-info">' +
        '<strong>' + escapeHtml(t.name) + builtinBadge + '</strong>' +
        '<code class="template-mgmt-format">' + escapeHtml(preview) + '</code>' +
        '</div>' +
        '<div class="template-mgmt-actions">' +
        (t.isBuiltin ? '' : '<button class="btn btn-sm btn-primary-outline edit-ptpl-btn" data-id="' + escapeHtml(t.id) + '">Edit</button>') +
        (t.isBuiltin ? '' : '<button class="btn btn-sm btn-danger delete-ptpl-btn" data-id="' + escapeHtml(t.id) + '">Delete</button>') +
        '</div>' +
        '</div>';
    });
    html += '<div style="margin-top: 12px; display: flex; gap: 8px; justify-content: flex-end;">' +
      '<button id="downloadTemplatesBtn" class="btn btn-sm btn-primary"><i data-lucide="download" class="btn-icon"></i> Download templates.json</button>' +
      '</div>';
    list.innerHTML = html;
  }
  list.querySelectorAll('.edit-ptpl-btn').forEach(function(btn){
    btn.addEventListener('click', function(){ editPromptTemplate(btn.getAttribute('data-id')); });
  });
  list.querySelectorAll('.delete-ptpl-btn').forEach(function(btn){
    btn.addEventListener('click', function(){ deletePromptTemplate(btn.getAttribute('data-id')); });
  });
  var downloadBtn = document.getElementById('downloadTemplatesBtn');
  if (downloadBtn) downloadBtn.addEventListener('click', downloadFullTemplatesFile);
  try { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); } catch(e){}
}

function newPromptTemplate() {
  var nameEl = document.getElementById('promptTemplateFormName');
  var promptEl = document.getElementById('promptTemplateFormPrompt');
  var idEl = document.getElementById('promptTemplateFormId');
  if (nameEl) nameEl.value = '';
  if (promptEl) promptEl.value = '';
  if (idEl) idEl.value = '';
  document.getElementById('promptTemplateFormTitle').textContent = 'New Prompt Template';
}

function editPromptTemplate(id) {
  var tpl = promptTemplates.find(function(t){ return t.id === id; });
  if (!tpl) return;
  var nameEl = document.getElementById('promptTemplateFormName');
  var promptEl = document.getElementById('promptTemplateFormPrompt');
  var idEl = document.getElementById('promptTemplateFormId');
  if (nameEl) nameEl.value = tpl.name || '';
  if (promptEl) promptEl.value = tpl.systemPrompt || '';
  if (idEl) idEl.value = tpl.id || '';
  document.getElementById('promptTemplateFormTitle').textContent = 'Edit Prompt Template';
}

function savePromptTemplate() {
  var nameEl = document.getElementById('promptTemplateFormName');
  var promptEl = document.getElementById('promptTemplateFormPrompt');
  var idEl = document.getElementById('promptTemplateFormId');
  var name = (nameEl && nameEl.value || '').trim();
  var systemPrompt = (promptEl && promptEl.value || '').trim();
  if (!name) return showToast('Template name is required');
  if (!systemPrompt) return showToast('System prompt is required');

  var id = (idEl && idEl.value) || ('pt_' + Math.random().toString(36).slice(2, 9));
  var existing = promptTemplates.find(function(t){ return t.id === id; });
  if (existing && existing.isBuiltin) {
    id = 'pt_' + Math.random().toString(36).slice(2, 9);
  }
  var entry = { id: id, name: name, systemPrompt: systemPrompt, isBuiltin: false };

  // Update in-memory array
  var existingIdx = -1;
  promptTemplates.forEach(function(t, i){ if (t.id === id) existingIdx = i; });
  if (existingIdx >= 0) promptTemplates[existingIdx] = entry;
  else promptTemplates.push(entry);

  renderPromptTemplateList();
  renderPromptTemplateDropdown();

  selectedPromptTemplateId = id;
  var sel = document.getElementById('promptTemplateSelect');
  if (sel) sel.value = id;

  // Trigger download of the complete templates.json so user can replace project file
  downloadFullTemplatesFile();
  showToast('Template saved. Download complete — replace templates/templates.json in project, then reload the extension.');
}

function downloadFullTemplatesFile() {
  try {
    var all = promptTemplates.map(function(t) {
      return { id: t.id, name: t.name, systemPrompt: t.systemPrompt, isBuiltin: t.isBuiltin || false };
    });
    var jsonStr = JSON.stringify(all, null, 2);
    var blob = new Blob([jsonStr], { type: 'application/json' });
    var url = URL.createObjectURL(blob);

    try {
      chrome.downloads.download({ url: url, filename: 'webElementLocator_templates/templates.json', saveAs: true }, function() {
        setTimeout(function() { URL.revokeObjectURL(url); }, 3000);
      });
    } catch(e) {
      var a = document.createElement('a');
      a.href = url;
      a.download = 'templates.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function() { URL.revokeObjectURL(url); }, 3000);
    }
  } catch(e) { /* silent */ }
}

function deletePromptTemplate(id) {
  var tpl = promptTemplates.find(function(t){ return t.id === id; });
  if (tpl && tpl.isBuiltin) return showToast('Cannot delete builtin template');
  if (!confirm('Delete this prompt template?')) return;
  promptTemplates = promptTemplates.filter(function(t){ return t.id !== id; });
  if (selectedPromptTemplateId === id) {
    selectedPromptTemplateId = '';
  }
  renderPromptTemplateList();
  renderPromptTemplateDropdown();
  // Also download updated templates.json
  downloadFullTemplatesFile();
  showToast('Template deleted. Download complete — replace templates/templates.json in project, then reload.');
}



async function updateAiProviderUi(){
  var cfg = await getAiConfig();
  var nameEl = document.getElementById('aiToolName');
  var sectionEl = document.getElementById('aiToolNameInSection');
  var displayEl = document.getElementById('aiToolDisplay');
  var labelEl = document.getElementById('aiEntryLabel');

  var label = cfg.name || (PROVIDER_PRESETS[cfg.provider] && PROVIDER_PRESETS[cfg.provider].label) || cfg.provider || 'No AI Selected';

  if (nameEl) nameEl.textContent = label;
  if (sectionEl) sectionEl.textContent = label;
  if (labelEl) labelEl.textContent = 'AI: ' + label;
  if (displayEl) {
    if (cfg.token && cfg.enabled !== false) displayEl.style.display = 'flex';
    else displayEl.style.display = 'none';
  }
}

/* ===================== AI Chat ===================== */

var chatHistory = [];
var chatOpen = false;

function openAiChat(){
  var chatMsgs = document.getElementById('aiChatMessages');
  var suggestions = document.getElementById('aiSuggestions');
  var section = document.getElementById('aiSuggestionsSection');
  if (chatMsgs) chatMsgs.style.display = 'flex';
  if (suggestions) suggestions.style.display = 'none';
  if (section) { section.classList.add('chat-open'); section.classList.add('expanded'); }
  chatOpen = true;
  updateChatToggleBtn();

  var input = document.getElementById('aiChatInput');
  if (input) setTimeout(function(){ input.focus(); }, 100);
}

function closeAiChat(){
  var chatMsgs = document.getElementById('aiChatMessages');
  var suggestions = document.getElementById('aiSuggestions');
  var section = document.getElementById('aiSuggestionsSection');
  if (chatMsgs) chatMsgs.style.display = 'none';
  if (suggestions) suggestions.style.display = '';
  if (section) { section.classList.remove('chat-open'); }
  chatOpen = false;
  updateChatToggleBtn();
}

function toggleAiBar(){
  var section = document.getElementById('aiSuggestionsSection');
  if (!section) return;
  if (section.classList.contains('expanded')) {
    section.classList.remove('expanded');
    if (chatOpen) closeAiChat();
  } else {
    section.classList.add('expanded');
  }
}

function updateChatToggleBtn(){
  var btn = document.getElementById('aiChatOpenBtn');
  if (!btn) return;
  if (chatOpen) {
    btn.innerHTML = '<i data-lucide="x" class="btn-icon"></i>Close';
    btn.style.background = 'rgba(255,255,255,0.25)';
  } else {
    btn.innerHTML = '<i data-lucide="message-circle" class="btn-icon"></i>Chat';
    btn.style.background = '';
  }
  try { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); } catch(e){}
}

async function sendAiChatMessage(){
  var input = document.getElementById('aiChatInput');
  var sendBtn = document.getElementById('aiChatSendBtn');
  var msg = input ? (input.value || '').trim() : '';
  if (!msg) return;

  var cfg = await getAiConfig();
  if (!cfg || !cfg.token) {
    appendChatBubble('ai', 'Please configure an AI provider first. Click the gear icon → AI Settings.');
    return;
  }

  // Auto-open chat if not open
  if (!chatOpen) openAiChat();

  if (input) input.value = '';
  if (sendBtn) { sendBtn.disabled = true; sendBtn.innerHTML = '<span class="loading-dots"><span>.</span><span>.</span><span>.</span></span>'; }

  // Add user bubble
  appendChatBubble('user', msg);

  // Add loading indicator
  var loadId = addChatLoadingIndicator();

  try {
    var resp = await sendRuntimeMessage({
      type: 'REQUEST_CHAT_AI',
      data: { message: msg, provider: cfg.provider, modelName: cfg.model }
    });
    removeChatLoadingIndicator(loadId);
    if (resp && resp.ok && resp.text) {
      appendChatBubble('ai', resp.text);
    } else {
      appendChatBubble('ai', 'Error: ' + (resp && resp.error || 'No response'));
    }
  } catch(e){
    removeChatLoadingIndicator(loadId);
    appendChatBubble('ai', 'Error: ' + String(e.message || e));
  }

  if (sendBtn) { sendBtn.disabled = false; sendBtn.innerHTML = '<i data-lucide="send" class="btn-icon"></i>'; try { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); } catch(e){} }
  if (input) setTimeout(function(){ input.focus(); }, 100);
}

function appendChatBubble(role, text, isHtml){
  var msgs = document.getElementById('aiChatMessages');
  if (!msgs) return;
  var bubble = document.createElement('div');
  bubble.className = 'chat-bubble chat-bubble-' + role;
  if (isHtml) bubble.innerHTML = text; else bubble.textContent = text;
  msgs.appendChild(bubble);
  msgs.scrollTop = msgs.scrollHeight;
  return bubble;
}

function addChatLoadingIndicator(text){
  var msgs = document.getElementById('aiChatMessages');
  if (!msgs) return null;
  var bubble = document.createElement('div');
  bubble.className = 'chat-bubble chat-bubble-ai chat-bubble-loading';
  var label = text ? escapeHtml(text) : '';
  bubble.innerHTML = '<span class="loading-dots"><span>.</span><span>.</span><span>.</span></span>' + (label ? ' <span class="loading-label">' + label + '</span>' : '');
  var id = 'chat_load_' + Date.now();
  bubble.id = id;
  msgs.appendChild(bubble);
  msgs.scrollTop = msgs.scrollHeight;
  return id;
}

function removeChatLoadingIndicator(id){
  if (!id) return;
  var el = document.getElementById(id);
  if (el) el.remove();
}

/* ===================== Init ===================== */

function onSidebarReady(){
  try {
    if (window.top && window.top !== window) window.top.postMessage({ type: 'SIDEBAR_READY', source: 'sidebar' }, '*');
    else if (window.parent && window.parent !== window) window.parent.postMessage({ type: 'SIDEBAR_READY', source: 'sidebar' }, '*');
  } catch(e){}
}

function setupEventListeners(){
  window.addEventListener('message', handleMessageFromParent);

  // Lucide icons
  try { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); } catch(e){}

  // Close sidebar (header button)
  var closeSidebar = document.getElementById('closeSidebarBtn') || document.getElementById('closeSidebar');
  if (closeSidebar) closeSidebar.addEventListener('click', function(){
    sendToContentScript('CLOSE_SIDEBAR', null);
  });

  // Toggle locator — optimistic UI feedback (no retry — postMessage is single-path now)
  var toggleBtn = document.getElementById('toggleLocator');
  if (toggleBtn) toggleBtn.addEventListener('click', function(){
    var isCurrentlyActive = toggleBtn.classList.contains('is-active');
    var newActive = !isCurrentlyActive;
    var lbl = document.getElementById('locatorBtnText');
    if (lbl) lbl.textContent = newActive ? 'Stop Picking' : 'Start Pick';
    toggleBtn.classList.toggle('is-active', newActive);
    toggleBtn.style.background = newActive ? '#e74c3c' : '';
    // Content script will confirm via LOCATOR_MODE_CHANGED message
    sendToContentScript('TOGGLE_LOCATOR_MODE', null);
  });

  // Clear captured
  var clearBtn = document.getElementById('clearCapturedBtn');
  if (clearBtn) clearBtn.addEventListener('click', clearCapturedElements);
  var clearBtn2 = document.getElementById('aiBatchClearBtn');
  if (clearBtn2) clearBtn2.addEventListener('click', clearCapturedElements);

  // AI Batch Ask
  var batchAskBtn = document.getElementById('aiBatchAskBtn');
  if (batchAskBtn) batchAskBtn.addEventListener('click', askAiForAllLocators);

  // AI Ask (in AI Bar)
  var askAiBtn = document.getElementById('askAiBtn');
  if (askAiBtn) askAiBtn.addEventListener('click', askAiForAllLocators);

  // AI user prompt Enter
  var aiUserPrompt = document.getElementById('aiUserPrompt');
  if (aiUserPrompt) aiUserPrompt.addEventListener('keydown', function(e){
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault(); askAiForAllLocators();
    }
  });

  // Prompt Rules
  var promptRulesBtn = document.getElementById('openPromptRulesBtn');
  var promptModal = document.getElementById('promptRulesModal');
  if (promptRulesBtn && promptModal) promptRulesBtn.addEventListener('click', function(){ promptModal.style.display = 'flex'; });
  var closePromptRulesBtn = document.getElementById('closePromptRulesBtn') || document.getElementById('closePromptRulesModal');
  if (closePromptRulesBtn && promptModal) closePromptRulesBtn.addEventListener('click', closePromptRules);
  var savePromptRulesBtn = document.getElementById('saveCustomRulesBtn');
  if (savePromptRulesBtn) savePromptRulesBtn.addEventListener('click', savePromptRules);

  // AI Config modal
  var aiConfigBtn = document.getElementById('aiConfigBtn');
  if (aiConfigBtn) aiConfigBtn.addEventListener('click', openAiConfigModal);
  var closeConfigBtn = document.getElementById('closeConfigModal');
  if (closeConfigBtn) closeConfigBtn.addEventListener('click', closeAiConfigModal);

  // Config tabs
  document.querySelectorAll('#aiConfigModal .tab-btn').forEach(function(b){
    b.addEventListener('click', function(){ switchConfigTab(b.getAttribute('data-tab')); });
  });

  // Provider selection
  document.querySelectorAll('#builtinAiProviders .ai-provider').forEach(function(el){
    el.addEventListener('click', function(){ selectProvider(el.getAttribute('data-provider')); });
  });

  // Add custom provider
  var addCustomProviderBtn = document.getElementById('addCustomProviderBtn');
  if (addCustomProviderBtn) addCustomProviderBtn.addEventListener('click', function(){ showCustomProviderForm(null); });
  var saveCustomProviderBtn = document.getElementById('saveCustomProviderBtn');
  if (saveCustomProviderBtn) saveCustomProviderBtn.addEventListener('click', saveCustomProvider);
  var cancelCustomProviderBtn = document.getElementById('cancelCustomProviderBtn');
  if (cancelCustomProviderBtn) cancelCustomProviderBtn.addEventListener('click', cancelCustomProvider);

  // Token actions
  var saveTokenBtn = document.getElementById('saveTokenBtn');
  if (saveTokenBtn) saveTokenBtn.addEventListener('click', saveToken);
  var deleteTokenBtn = document.getElementById('deleteTokenBtn');
  if (deleteTokenBtn) deleteTokenBtn.addEventListener('click', deleteToken);
  var testAiBtn = document.getElementById('testAiBtn');
  if (testAiBtn) testAiBtn.addEventListener('click', testAi);

  // Master AI toggle
  var enableAiFeatures = document.getElementById('enableAiFeatures');
  if (enableAiFeatures) enableAiFeatures.addEventListener('change', toggleMasterAi);

  // Export / Import AI Configs
  var exportBtn = document.getElementById('exportAiConfigBtn');
  if (exportBtn) exportBtn.addEventListener('click', exportAiConfigs);
  var importBtn = document.getElementById('importAiConfigBtn');
  var importFile = document.getElementById('importAiConfigFile');
  if (importBtn && importFile) {
    importBtn.addEventListener('click', function(){ importFile.click(); });
    importFile.addEventListener('change', function(e){ if (e.target.files && e.target.files[0]) importAiConfigs(e.target.files[0]); });
  }

  // Toggle token visibility
  var toggleVisibility = document.getElementById('toggleTokenVisibility');
  var tokenInput = document.getElementById('aiTokenInput');
  if (toggleVisibility && tokenInput) {
    toggleVisibility.addEventListener('click', function(){
      // Lucide replaces <i> with <svg> — use data-lucide on the button itself to track icon state
      if (tokenInput.type === 'password') {
        tokenInput.type = 'text';
        toggleVisibility.setAttribute('data-lucide-icon', 'eye');
      } else {
        tokenInput.type = 'password';
        toggleVisibility.setAttribute('data-lucide-icon', 'eye-off');
      }
      // Redraw icon: remove old SVG, insert new <i> with correct data-lucide, recreate
      var newIcon = document.createElement('i');
      newIcon.setAttribute('data-lucide', toggleVisibility.getAttribute('data-lucide-icon') || 'eye-off');
      newIcon.className = 'eye-icon';
      toggleVisibility.innerHTML = '';
      toggleVisibility.appendChild(newIcon);
      try { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); } catch(e){}
    });
  }


  // Code Template selector removed — dead HTML elements cleaned

  // Prompt Template selector
  var promptTemplateSel = document.getElementById('promptTemplateSelect');
  if (promptTemplateSel) promptTemplateSel.addEventListener('change', onPromptTemplateChange);
  // Prompt Template management modal
  var closePtplBtn = document.getElementById('closePromptTemplateMgmtBtn');
  if (closePtplBtn) closePtplBtn.addEventListener('click', closePromptTemplateMgmt);
  var savePtplBtn = document.getElementById('savePromptTemplateBtn');
  if (savePtplBtn) savePtplBtn.addEventListener('click', savePromptTemplate);
  var newPtplBtn = document.getElementById('newPromptTemplateBtn');
  if (newPtplBtn) newPtplBtn.addEventListener('click', newPromptTemplate);
  var ptplModal = document.getElementById('promptTemplateMgmtModal');
  if (ptplModal) ptplModal.addEventListener('click', function(e){ if (e.target === ptplModal) closePromptTemplateMgmt(); });

  // AI Chat
  var chatOpenBtn = document.getElementById('aiChatOpenBtn');
  if (chatOpenBtn) chatOpenBtn.addEventListener('click', function(){
    if (chatOpen) closeAiChat(); else openAiChat();
  });

  // AI Bar header click to expand/collapse
  var aiSectionHeader = document.querySelector('.ai-section-header');
  if (aiSectionHeader) aiSectionHeader.addEventListener('click', function(e){
    // Don't toggle if clicking buttons/selects/inputs inside header
    if (e.target.closest('button') || e.target.closest('select') || e.target.closest('input')) return;
    toggleAiBar();
  });
  var chatSendBtn = document.getElementById('aiChatSendBtn');
  if (chatSendBtn) chatSendBtn.addEventListener('click', sendAiChatMessage);
  var chatInput = document.getElementById('aiChatInput');
  if (chatInput) chatInput.addEventListener('keydown', function(e){
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault(); sendAiChatMessage();
    }
  });

  // Modal backdrops close
  document.querySelectorAll('.ai-config-modal').forEach(function(m){
    m.addEventListener('click', function(e){
      if (e.target === m) m.style.display = 'none';
    });
  });

  var aiEntryBtn = document.getElementById('aiEntryBtn');
  if (aiEntryBtn) aiEntryBtn.style.display = 'none';
}

async function initSidebar(){
  try { setupEventListeners(); } catch(e){ console.error('setupEventListeners error', e); }
  try { await updateAiProviderUi(); } catch(e){}
  try { updateCapturedElementsList(); } catch(e){}
  try { await loadPromptTemplates(); } catch(e){}
  try { onSidebarReady(); } catch(e){}
  try { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); } catch(e){}
}

if (typeof document !== 'undefined' && document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function(){ initSidebar(); }, { once: true });
} else {
  setTimeout(function(){ initSidebar(); }, 0);
}
