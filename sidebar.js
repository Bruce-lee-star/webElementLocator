var capturedElements = [];
var toastTimer = null;

function sendToContentScript(type, data){
  var payload = { type: type, data: data, source: 'sidebar' };
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(payload, '*');
      return;
    }
  } catch(e) {}
  try {
    chrome.runtime.sendMessage({ __forward_to_content__: payload }, function() {
      if (chrome.runtime && chrome.runtime.lastError) {}
    });
  } catch(e) {}
}

function showToast(message) {
  var old = document.getElementById('copyToast');
  if (old) old.remove();
  if (toastTimer) clearTimeout(toastTimer);

  var toast = document.createElement('div');
  toast.id = 'copyToast';
  toast.className = 'toast-notification';
  toast.innerHTML = '<span class="toast-icon">✓</span><span class="toast-text">' + escapeHtml(message) + '</span>';
  document.body.appendChild(toast);

  toast.offsetHeight;
  toast.classList.add('show');

  toastTimer = setTimeout(function(){
    toast.classList.remove('show');
    setTimeout(function(){ if (toast && toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
  }, 2000);
}

function escapeHtml(text) {
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(text));
  return div.innerHTML;
}

function getBestLocator(el) {
  if (el && el.localHeuristic) {
    if (el.localHeuristic.css) {
      return { type: 'css', value: el.localHeuristic.css };
    }
    if (el.localHeuristic.xpath) {
      return { type: 'xpath', value: el.localHeuristic.xpath };
    }
  }
  if (el && el.locators) {
    var types = ['css', 'xpath'];
    var levels = ['simple', 'medium', 'advanced'];
    for (var t = 0; t < types.length; t++) {
      var typeGroup = el.locators[types[t]];
      if (typeGroup && typeof typeGroup === 'object') {
        for (var l = 0; l < levels.length; l++) {
          var levelList = typeGroup[levels[l]];
          if (levelList && levelList.length > 0) {
            var first = levelList[0];
            return { type: types[t], value: first.value };
          }
        }
      }
    }
  }
  return { type: 'css', value: el.tag || 'div' };
}

function updateCapturedElementsList() {
  var listContainer = document.getElementById('capturedElementsList');
  if (!listContainer) return;

  var countEl = document.getElementById('capturedElementsCount');
  if (countEl) {
    countEl.textContent = capturedElements.length + ' element' + (capturedElements.length !== 1 ? 's' : '');
  }

  if (capturedElements.length === 0) {
    listContainer.innerHTML = '<div class="captured-empty-hint">' +
      '<i data-lucide="mouse-pointer" class="empty-hint-icon"></i>' +
      '<span>Click <strong>Start Pick</strong> above to select elements</span>' +
      '<br><small style="color:#999; font-size:11px;">Hold Ctrl to pick a group of elements</small>' +
      '</div>';
    try { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); } catch(e){}
    return;
  }

  var table = document.createElement('table');
  table.className = 'captured-elements-table';
  table.innerHTML = '<thead><tr>' +
    '<th class="col-locator">Locator</th>' +
    '<th class="col-type">Type</th>' +
    '<th class="col-text">Text</th>' +
    '<th class="col-actions">Actions</th>' +
    '</tr></thead><tbody></tbody>';
  var tbody = table.querySelector('tbody');

  capturedElements.forEach(function(el, index){
    var tr = document.createElement('tr');
    tr.className = 'captured-element-row' + (el.isList ? ' is-list' : '');
    tr.dataset.idx = index;

    var locator = getBestLocator(el);
    var typeLabel = el.isList ? 'List' : 'Single';
    var text = el.isList ? (el.displayText || el.groupLabel || '') : (el.text || '').trim().slice(0, 50);

    tr.innerHTML =
      '<td class="col-locator">' +
        '<code class="locator-value" title="' + escapeHtml(locator.value) + '">' + escapeHtml(locator.value) + '</code>' +
        '<span class="locator-badge ' + locator.type + '">' + locator.type.toUpperCase() + '</span>' +
      '</td>' +
      '<td class="col-type"><span class="type-badge type-' + (el.isList ? 'list' : 'single') + '">' + typeLabel + '</span></td>' +
      '<td class="col-text">' + escapeHtml(text) + '</td>' +
      '<td class="col-actions">' +
        '<button class="action-btn copy-btn" data-idx="' + index + '" title="Copy Locator">' +
          '<i data-lucide="copy" class="btn-icon-sm"></i>' +
        '</button>' +
        (el.isList ? '<button class="action-btn edit-btn" data-idx="' + index + '" title="Edit Text"><i data-lucide="edit-3" class="btn-icon-sm"></i></button>' : '') +
        '<button class="action-btn delete-btn" data-idx="' + index + '" title="Delete">' +
          '<i data-lucide="trash-2" class="btn-icon-sm"></i>' +
        '</button>' +
      '</td>';

    tbody.appendChild(tr);
  });

  listContainer.innerHTML = '';
  listContainer.appendChild(table);

  listContainer.querySelectorAll('.copy-btn').forEach(function(btn){
    btn.addEventListener('click', function(e){
      e.stopPropagation();
      var idx = parseInt(btn.dataset.idx);
      copySingleLocator(idx);
    });
  });

  listContainer.querySelectorAll('.col-locator').forEach(function(td){
    td.addEventListener('click', function(e){
      e.stopPropagation();
      var idx = parseInt(td.parentElement.dataset.idx);
      copySingleLocator(idx);
    });
    td.style.cursor = 'pointer';
  });

  listContainer.querySelectorAll('.delete-btn').forEach(function(btn){
    btn.addEventListener('click', function(e){
      e.stopPropagation();
      var idx = parseInt(btn.dataset.idx);
      deleteCapturedElement(idx);
    });
  });

  listContainer.querySelectorAll('.edit-btn').forEach(function(btn){
    btn.addEventListener('click', function(e){
      e.stopPropagation();
      var idx = parseInt(btn.dataset.idx);
      editListElement(idx);
    });
  });

  try { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); } catch(e){}
}

function copySingleLocator(index) {
  var el = capturedElements[index];
  if (!el) return;
  var locator = getBestLocator(el);
  copyToClipboard(locator.value, 'Copied!');
}

function copyAllLocators() {
  if (capturedElements.length === 0) return;
  var lines = capturedElements.map(function(el, i){
    var loc = getBestLocator(el);
    var typeLabel = el.isList ? 'List' : 'Single';
    var text = el.isList ? (el.displayText || el.groupLabel || '') : (el.text || '').trim();
    return (i + 1) + '\t' + loc.value + '\t' + typeLabel + '\t' + text;
  });
  var header = 'No.\tLocator\tType\tText';
  copyToClipboard(header + '\n' + lines.join('\n'), 'All copied!');
}

function copyToClipboard(text, successMsg) {
  sendToContentScript('COPY_LOCATOR', { locator: text });
  showToast(successMsg || 'Copied!');
}

function deleteCapturedElement(index) {
  capturedElements.splice(index, 1);
  updateCapturedElementsList();
  sendToContentScript('ELEMENT_HISTORY_UPDATED', { elements: capturedElements });
}

function clearCapturedElements() {
  capturedElements = [];
  updateCapturedElementsList();
  sendToContentScript('CLEAR_CAPTURED_ELEMENTS', null);
}

function editListElement(index) {
  var el = capturedElements[index];
  if (!el || !el.isList) return;
  var currentText = el.displayText || el.groupLabel || '';
  var newValue = prompt('Edit group display text:', currentText);
  if (newValue !== null) {
    el.displayText = newValue.trim();
    updateCapturedElementsList();
    sendToContentScript('ELEMENT_HISTORY_UPDATED', { elements: capturedElements });
  }
}

function toggleCapturedCollapse() {
  var section = document.getElementById('capturedElementsSection');
  var list = document.getElementById('capturedElementsList');
  var header = document.getElementById('capturedElementsHeader');
  if (!section || !list) return;

  if (section.dataset.collapsed === 'true') {
    section.dataset.collapsed = 'false';
    list.style.display = '';
    header.classList.remove('collapsed');
  } else {
    section.dataset.collapsed = 'true';
    list.style.display = 'none';
    header.classList.add('collapsed');
  }
}

function handleSidebarMessage(type, data){
  if (!type) return;
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
    elementData.time = now.toLocaleTimeString();
    elementData.ts = now.getTime();
    capturedElements.push(elementData);
    updateCapturedElementsList();
    return;
  }
  if (type === 'ELEMENT_HISTORY_UPDATED') {
    var hist = (data && data.elements) || [];
    capturedElements = hist;
    updateCapturedElementsList();
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

function onSidebarReady(){
  try {
    if (window.top && window.top !== window) window.top.postMessage({ type: 'SIDEBAR_READY', source: 'sidebar' }, '*');
    else if (window.parent && window.parent !== window) window.parent.postMessage({ type: 'SIDEBAR_READY', source: 'sidebar' }, '*');
  } catch(e){}
}

function setupEventListeners(){
  window.addEventListener('message', handleMessageFromParent);

  try { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); } catch(e){}

  var toggleBtn = document.getElementById('toggleLocator');
  if (toggleBtn) toggleBtn.addEventListener('click', function(){
    var isCurrentlyActive = toggleBtn.classList.contains('is-active');
    var newActive = !isCurrentlyActive;
    var lbl = document.getElementById('locatorBtnText');
    if (lbl) lbl.textContent = newActive ? 'Stop Picking' : 'Start Pick';
    toggleBtn.classList.toggle('is-active', newActive);
    toggleBtn.style.background = newActive ? '#e74c3c' : '';
    sendToContentScript('TOGGLE_LOCATOR_MODE', null);
  });

  var clearBtn = document.getElementById('clearCapturedBtn');
  if (clearBtn) clearBtn.addEventListener('click', clearCapturedElements);

  var copyAllBtn = document.getElementById('copyAllCapturedBtn');
  if (copyAllBtn) copyAllBtn.addEventListener('click', copyAllLocators);

  var header = document.getElementById('capturedElementsHeader');
  if (header) {
    header.style.cursor = 'pointer';
    header.addEventListener('click', function(e){
      if (e.target.closest('button')) return;
      toggleCapturedCollapse();
    });
  }
}

function initSidebar(){
  try { setupEventListeners(); } catch(e){ console.error('setupEventListeners error', e); }
  try { updateCapturedElementsList(); } catch(e){}
  try { onSidebarReady(); } catch(e){}
  try { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); } catch(e){}
}

if (typeof document !== 'undefined' && document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function(){ initSidebar(); }, { once: true });
} else {
  setTimeout(function(){ initSidebar(); }, 0);
}
