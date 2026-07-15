(function () {
    'use strict';

    let extensionContextValid = true;

    function chromeIsReady() {
        try {
            if (!extensionContextValid) return false;
            if (typeof chrome === 'undefined' || !chrome || !chrome.runtime) { extensionContextValid = false; return false; }
            const id = chrome.runtime.id;
            if (!id) { extensionContextValid = false; return false; }
            if (typeof chrome.runtime.sendMessage !== 'function') { extensionContextValid = false; return false; }
            if (typeof chrome.runtime.getURL !== 'function') { extensionContextValid = false; return false; }
            return true;
        } catch (e) { extensionContextValid = false; return false; }
    }
    function safeGetUrl(path) {
        try {
            if (!chromeIsReady()) return '';
            const url = chrome.runtime.getURL(path);
            return url || '';
        } catch (e) { extensionContextValid = false; return ''; }
    }
    function safeStorageGet(key, cb) {
        try {
            if (!chromeIsReady() || !chrome.storage || !chrome.storage.local) { cb(null); return; }
            chrome.storage.local.get(key, cb);
        } catch (e) { cb(null); }
    }
    function safeStorageSet(obj, cb) {
        try {
            if (!chromeIsReady() || !chrome.storage || !chrome.storage.local) { if (cb) cb(null); return; }
            chrome.storage.local.set(obj, cb || function(){});
        } catch (e) { if (cb) cb(null); }
    }
    function safeRuntimeSendMessage(msg, cb) {
        try {
            if (!chromeIsReady()) { if (cb) cb(new Error('Extension context invalid')); return; }
            chrome.runtime.sendMessage(msg, function(res) {
                if (chrome.runtime && chrome.runtime.lastError) {
                    if (cb) cb(new Error(chrome.runtime.lastError.message));
                    return;
                }
                if (cb) cb(null, res);
            });
        } catch (e) { if (cb) cb(e); }
    }
    function safeRuntimeOnMessage(fn) {
        try {
            if (!chromeIsReady()) return false;
            chrome.runtime.onMessage.addListener(fn);
            return true;
        } catch (e) { return false; }
    }

    const allTimers = new Set();
    function safeSetTimeout(fn, ms) {
        const id = setTimeout(fn, ms);
        allTimers.add(id);
        return id;
    }
    let keepAliveIntervalId = null;

    const cleanupFns = [];
    function onExtensionInvalid(callback) { cleanupFns.push(callback); }
    function fireExtensionInvalid() {
        for (const fn of cleanupFns) { try { fn(); } catch (e) {} }
    }

    function isSidebarContainerPresent() {
        try { return !!document.getElementById('elementLocatorContainer'); } catch (e) { return false; }
    }

    const sidebarContainerAlreadyPresent = isSidebarContainerPresent();
    if (!sidebarContainerAlreadyPresent) {
        const wasOpen = localStorage.getItem('elementLocatorSidebarOpen') === 'true';
        if (wasOpen) {
            safeStorageGet(['sidebarStates'], function(result) {
                safeSetTimeout(() => {
                    if (!isSidebarContainerPresent() && chromeIsReady()) window.createSidebar();
                }, 1000);
            });
        }
    }

    let sidebarIframe = null;
    let locatorGenerator = null;
    let isLocatorModeActive = false;
    let highlightOverlay = null;
    let elementHistory = [];
    let currentHistoryIndex = -1;
    let locatorCache = new Map();
    let listenersAttached = false;
    let commListenerAttached = false;
    let currentOrigin = window.location.origin;

    function checkExtensionContext() {
        try { return chromeIsReady(); } catch (e) { return false; }
    }

    let messageQueue = [];
    let isProcessingQueue = false;
    let currentEventListeners = [];

    function addEventListenerSafely(element, event, handler, options) {
        element.addEventListener(event, handler, options);
        currentEventListeners.push({ element, event, handler, options });
    }

    function removeAllEventListeners() {
        currentEventListeners.forEach(({ element, event, handler, options }) => {
            try {
                element.removeEventListener(event, handler, options);
            } catch (error) {
                console.warn('Error removing event listener:', error);
            }
        });
        currentEventListeners = [];
    }

    function attachListenersToIframes() {
        const iframes = document.querySelectorAll('iframe');
        const mouseOptions = { passive: false };
        const clickOptions = { capture: true, passive: false };
        
        for (let i = 0; i < iframes.length; i++) {
            const iframe = iframes[i];
            // Skip the sidebar's own iframe and data-extension elements
            if (iframe.hasAttribute('data-extension-element') || (sidebarIframe && iframe === sidebarIframe)) {
                continue;
            }
            try {
                const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                if (iframeDoc) {
                    addEventListenerSafely(iframeDoc, "mouseover", handleMouseOver, mouseOptions);
                    addEventListenerSafely(iframeDoc, "mouseout", handleMouseOut, mouseOptions);
                    addEventListenerSafely(iframeDoc, "click", handleElementClick, clickOptions);
                }
            } catch (e) {
                // Cross-origin iframe - silently skip, this is expected
            }
        }
    }

    function getElementFromShadowRoot(event) {
        let element = event.target;
        let composedPath = event.composedPath ? event.composedPath() : [];
        
        if (composedPath.length > 0) {
            element = composedPath[0];
        }
        
        return element;
    }

    window.createSidebar = function() {
        if (!chromeIsReady()) return;
        const existingContainer = document.getElementById("elementLocatorContainer");
        if (existingContainer) {
            existingContainer.style.display = "flex";
            const existingHandle = document.getElementById("elementLocatorResizeHandle");
            if (existingHandle) {
                existingHandle.style.display = "block";
            }
            return;
        }
        createSidebarInternal();
    };

    function createSidebarInternal() {
        if (!chromeIsReady()) return;
        if (sidebarIframe) return;

        const sidebarContainer = document.createElement('div');
        sidebarContainer.id = 'elementLocatorContainer';
        sidebarContainer.setAttribute('data-extension-element', 'true');
        sidebarContainer.style.cssText = `
            position: fixed !important;
            top: 20px !important;
            right: 20px !important;
            width: 380px !important;
            min-width: 280px !important;
            max-width: 600px !important;
            height: 500px !important;
            min-height: 200px !important;
            max-height: 80vh !important;
            z-index: 2147483647 !important;
            background: white !important;
            box-shadow: 0 10px 40px rgba(0,0,0,0.3) !important;
            pointer-events: auto !important;
            border-radius: 12px !important;
            overflow: hidden !important;
            display: flex !important;
            flex-direction: column !important;
        `;

        const titleBar = document.createElement('div');
        titleBar.id = 'elementLocatorTitleBar';
        titleBar.setAttribute('data-extension-element', 'true');
        titleBar.style.cssText = `
            flex-shrink: 0 !important;
            height: 40px !important;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%) !important;
            color: white !important;
            display: flex !important;
            align-items: center !important;
            justify-content: space-between !important;
            padding: 0 12px !important;
            cursor: move !important;
            user-select: none !important;
            font-size: 13px !important;
            font-weight: 600 !important;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
        `;

        const titleLeft = document.createElement('div');
        titleLeft.style.cssText = `
            display: flex !important;
            align-items: center !important;
            gap: 8px !important;
            pointer-events: none !important;
        `;
        const titleIcon = document.createElement('span');
        titleIcon.innerHTML = '🎯';
        titleIcon.style.cssText = 'font-size: 16px !important;';
        const titleText = document.createElement('span');
        titleText.textContent = 'Web Element Selector';
        titleLeft.appendChild(titleIcon);
        titleLeft.appendChild(titleText);

        const titleControls = document.createElement('div');
        titleControls.style.cssText = `
            display: flex !important;
            align-items: center !important;
            gap: 6px !important;
        `;

        const minimizeBtn = document.createElement('button');
        minimizeBtn.id = 'elementLocatorMinimizeBtn';
        minimizeBtn.setAttribute('data-extension-element', 'true');
        minimizeBtn.innerHTML = '&#8211;';
        minimizeBtn.style.cssText = `
            width: 26px !important;
            height: 26px !important;
            border: none !important;
            background: rgba(255,255,255,0.2) !important;
            color: white !important;
            border-radius: 50% !important;
            cursor: pointer !important;
            font-size: 16px !important;
            line-height: 1 !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            transition: all 0.2s ease !important;
            padding: 0 !important;
        `;
        minimizeBtn.addEventListener('mouseenter', () => {
            minimizeBtn.style.background = 'rgba(255,255,255,0.35) !important';
            minimizeBtn.style.transform = 'scale(1.1) !important';
        });
        minimizeBtn.addEventListener('mouseleave', () => {
            minimizeBtn.style.background = 'rgba(255,255,255,0.2) !important';
            minimizeBtn.style.transform = 'scale(1) !important';
        });
        minimizeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleMinimizeSidebar();
        });

        const closeBtn = document.createElement('button');
        closeBtn.id = 'elementLocatorCloseBtn';
        closeBtn.setAttribute('data-extension-element', 'true');
        closeBtn.innerHTML = '&times;';
        closeBtn.style.cssText = `
            width: 26px !important;
            height: 26px !important;
            border: none !important;
            background: rgba(255,255,255,0.2) !important;
            color: white !important;
            border-radius: 50% !important;
            cursor: pointer !important;
            font-size: 18px !important;
            line-height: 1 !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            transition: all 0.2s ease !important;
            padding: 0 !important;
        `;
        closeBtn.addEventListener('mouseenter', () => {
            closeBtn.style.background = 'rgba(255,80,80,0.8) !important';
            closeBtn.style.transform = 'scale(1.1) !important';
        });
        closeBtn.addEventListener('mouseleave', () => {
            closeBtn.style.background = 'rgba(255,255,255,0.2) !important';
            closeBtn.style.transform = 'scale(1) !important';
        });
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeSidebar();
        });

        titleControls.appendChild(minimizeBtn);
        titleControls.appendChild(closeBtn);
        titleBar.appendChild(titleLeft);
        titleBar.appendChild(titleControls);

        let isDragging = false;
        let dragStartX = 0;
        let dragStartY = 0;
        let dragStartLeft = 0;
        let dragStartTop = 0;

        titleBar.addEventListener('mousedown', (e) => {
            if (e.target.closest('button')) return;
            isDragging = true;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            const rect = sidebarContainer.getBoundingClientRect();
            dragStartLeft = rect.left;
            dragStartTop = rect.top;
            document.body.style.userSelect = 'none !important';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const deltaX = e.clientX - dragStartX;
            const deltaY = e.clientY - dragStartY;
            let newLeft = dragStartLeft + deltaX;
            let newTop = dragStartTop + deltaY;
            const maxLeft = window.innerWidth - 100;
            const maxTop = window.innerHeight - 50;
            newLeft = Math.max(-sidebarContainer.offsetWidth + 100, Math.min(maxLeft, newLeft));
            newTop = Math.max(0, Math.min(maxTop, newTop));
            sidebarContainer.style.left = newLeft + 'px';
            sidebarContainer.style.top = newTop + 'px';
            sidebarContainer.style.right = 'auto !important';
            resizeHandle.style.left = 'auto !important';
            resizeHandle.style.right = 'auto !important';
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                document.body.style.userSelect = '';
            }
        });

        sidebarContainer.appendChild(titleBar);

        // Create resize handle at bottom-right corner
        const resizeHandle = document.createElement('div');
        resizeHandle.id = 'elementLocatorResizeHandle';
        resizeHandle.setAttribute('data-extension-element', 'true');
        resizeHandle.style.cssText = `
            position: fixed !important;
            bottom: 0 !important;
            right: 0 !important;
            width: 16px !important;
            height: 16px !important;
            z-index: 2147483648 !important;
            cursor: nwse-resize !important;
            background: transparent !important;
            pointer-events: auto !important;
        `;

        let isResizing = false;
        let resizeStartX = 0;
        let resizeStartY = 0;
        let resizeStartWidth = 0;
        let resizeStartHeight = 0;

        resizeHandle.addEventListener('mousedown', (e) => {
            isResizing = true;
            resizeStartX = e.clientX;
            resizeStartY = e.clientY;
            const rect = sidebarContainer.getBoundingClientRect();
            resizeStartWidth = rect.width;
            resizeStartHeight = rect.height;
            document.body.style.userSelect = 'none !important';
            e.preventDefault();
            e.stopPropagation();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const deltaX = e.clientX - resizeStartX;
            const deltaY = e.clientY - resizeStartY;
            let newWidth = resizeStartWidth + deltaX;
            let newHeight = resizeStartHeight + deltaY;
            newWidth = Math.max(280, Math.min(600, newWidth));
            newHeight = Math.max(200, Math.min(window.innerHeight * 0.8, newHeight));
            sidebarContainer.style.width = newWidth + 'px';
            sidebarContainer.style.height = newHeight + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                document.body.style.userSelect = '';
            }
        });

        document.body.appendChild(resizeHandle);

        sidebarIframe = document.createElement('iframe');
        sidebarIframe.id = 'elementLocatorSidebar';
        const sidebarUrl = safeGetUrl('sidebar.html');
        if (!sidebarUrl) { return; }
        try { sidebarIframe.src = sidebarUrl; }
        catch (urlAssignError) { return; }
        sidebarIframe.setAttribute('data-extension-element', 'true');
        sidebarIframe.style.cssText = `
            width: 100% !important;
            flex: 1 !important;
            min-height: 0 !important;
            border: none !important;
            background: white !important;
        `;

        sidebarContainer.appendChild(sidebarIframe);

        function toggleMinimizeSidebar() {
            const iframe = document.getElementById('elementLocatorSidebar');
            const handle = document.getElementById('elementLocatorResizeHandle');
            const container = document.getElementById('elementLocatorContainer');
            if (!container) return;
            if (container.dataset.minimized === 'true') {
                container.dataset.minimized = 'false';
                if (iframe) iframe.style.display = 'block';
                if (handle) handle.style.display = 'block';
                const prevH = container.dataset.prevHeight || '500px';
                const prevW = container.dataset.prevWidth || '380px';
                container.style.height = prevH;
                container.style.width = prevW;
            } else {
                container.dataset.minimized = 'true';
                container.dataset.prevHeight = container.style.height;
                container.dataset.prevWidth = container.style.width;
                if (iframe) iframe.style.display = 'none';
                if (handle) handle.style.display = 'none';
                container.style.height = '40px';
            }
        }

        locatorGenerator = new UnifiedLocatorGenerator();

        sidebarIframe.onload = function () {
            if (!chromeIsReady()) return;
            const waitForReady = (triesLeft) => {
                if (!chromeIsReady()) return;
                if (!sidebarIframe || !sidebarIframe.contentWindow) {
                    if (triesLeft > 0) return safeSetTimeout(() => waitForReady(triesLeft - 1), 100);
                    return setupAlternativeCommunication();
                }
                try {
                    const cw = sidebarIframe.contentWindow;
                    const readyState = cw.document && cw.document.readyState;
                    if (readyState === 'complete' || readyState === 'interactive') {
                        sidebarReady = true;
                        try { cw.postMessage({ type: 'ARE_YOU_READY' }, '*'); } catch (e) {}
                        if (messageQueue.length > 0) processMessageQueue();
                    } else if (triesLeft > 0) {
                        safeSetTimeout(() => waitForReady(triesLeft - 1), 100);
                    } else {
                        setupAlternativeCommunication();
                    }
                } catch (documentAccessError) {
                    setupAlternativeCommunication();
                }
            };
            waitForReady(50);
        };

        function setupAlternativeCommunication() {
            if (!chromeIsReady()) return;
            if (commListenerAttached) return;
            commListenerAttached = true;

            const messageHandler = function(event) {
                if (!sidebarIframe || !sidebarIframe.contentWindow) return;
                if (event.source !== sidebarIframe.contentWindow) return;
                if (!chromeIsReady()) return;
                const msg = event.data || {};
                const type = msg.type;
                console.log('[Content] messageHandler received:', type);

                if (type === 'SIDEBAR_READY' || type === 'ARE_YOU_READY_ACK') {
                    sidebarReady = true;
                    if (messageQueue.length > 0) processMessageQueue();
                } else {
                    console.log('[Content] Calling handleSidebarMessage:', type);
                    handleSidebarMessage(type, msg.data);
                }
            };
            window.addEventListener("message", messageHandler);
            cleanupFns.push(() => { try { window.removeEventListener("message", messageHandler); } catch (e) {} });

            try {
                if (sidebarIframe && sidebarIframe.contentWindow) {
                    sidebarIframe.contentWindow.postMessage({ type: 'CONTENT_READY_CHECK', data: {} }, '*');
                }
            } catch (e) {}

            if (messageQueue.length > 0) processMessageQueue();
        }

        sidebarIframe.onerror = function (error) {
            if (!chromeIsReady()) return;
        };
        document.body.appendChild(sidebarContainer);

        // Ensure sidebar stays on top by re-appending when new modals/dialogs appear
        ensureSidebarOnTop();
    }

    function getTopMostContainer(targetElement) {
        if (!targetElement) return document.body;
        var dialogs = document.querySelectorAll('dialog[open]');
        for (var i = dialogs.length - 1; i >= 0; i--) {
            var dialog = dialogs[i];
            if (dialog.contains(targetElement)) {
                return dialog;
            }
        }
        var allModals = document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, .Modal, .popup, .Popover, .dropdown, .Dropdown');
        for (var k = allModals.length - 1; k >= 0; k--) {
            var modal = allModals[k];
            if (modal.contains(targetElement) && getComputedStyle(modal).display !== 'none' && getComputedStyle(modal).visibility !== 'hidden') {
                var modalRect = modal.getBoundingClientRect();
                if (modalRect.width > 0 && modalRect.height > 0) {
                    return modal;
                }
            }
        }
        return document.body;
    }

    function ensureOverlayOnTop(overlay) {
        if (!overlay || !overlay.parentNode) return;
        var parent = overlay.parentNode;
        if (parent.lastChild !== overlay) {
            parent.appendChild(overlay);
        }
    }

    // Keep sidebar and highlight on top of any dynamically created modals/dialogs
    let topLayerObserver = null;
    function ensureSidebarOnTop() {
        if (topLayerObserver) return;
        topLayerObserver = new MutationObserver(function(mutations) {
            var sidebarContainer = document.getElementById('elementLocatorContainer');
            var resizeHandle = document.getElementById('elementLocatorResizeHandle');
            var needsRaise = false;
            var hasNewDialog = false;
            for (var i = 0; i < mutations.length; i++) {
                var added = mutations[i].addedNodes;
                for (var j = 0; j < added.length; j++) {
                    var node = added[j];
                    if (node.nodeType === 1 && !node.hasAttribute('data-extension-element')) {
                        var tagName = node.tagName ? node.tagName.toLowerCase() : '';
                        if (tagName === 'dialog' || node.getAttribute('role') === 'dialog' || node.getAttribute('role') === 'alertdialog' || 
                            (node.className && typeof node.className === 'string' && /modal|Modal|popup|Popover|dialog|Dialog/.test(node.className))) {
                            needsRaise = true;
                            if (tagName === 'dialog') hasNewDialog = true;
                            break;
                        }
                        if (node.querySelectorAll) {
                            var nestedDialogs = node.querySelectorAll('dialog, [role="dialog"], [role="alertdialog"]');
                            if (nestedDialogs && nestedDialogs.length > 0) {
                                needsRaise = true;
                                var dialogElems = node.querySelectorAll('dialog');
                                if (dialogElems && dialogElems.length > 0) hasNewDialog = true;
                                break;
                            }
                        }
                    }
                }
                if (needsRaise) break;
            }
            if (needsRaise) {
                if (sidebarContainer && sidebarContainer.parentNode) {
                    sidebarContainer.parentNode.appendChild(sidebarContainer);
                }
                if (resizeHandle && resizeHandle.parentNode) {
                    resizeHandle.parentNode.appendChild(resizeHandle);
                }
                if (highlightOverlay && highlightOverlay.parentNode) {
                    highlightOverlay.parentNode.appendChild(highlightOverlay);
                }
            }
        });
        try {
            topLayerObserver.observe(document.body, { childList: true, subtree: true });
        } catch(e) {}
    }

    // DOM Isolation Configuration.
    const DOM_ISOLATION_CONFIG = {
        excludeSelectors: [
            '#elementLocatorSidebar',
            '#elementLocatorContainer',
            '#elementLocatorOverlay',
            'iframe[id*="elementLocator"]',
            '[data-extension-element="true"]',
            '[data-locator-extension]',
            '[data-extension-hidden]',
            '[data-locator-invisible]'
        ],
        shouldExclude: function(element) {
            if (!element || !element.tagName) return true;
            return this.excludeSelectors.some(selector => {
                try {
                    return element.matches(selector) || element.closest(selector);
                } catch (e) {
                    return false;
                }
            });
        },
        getMatchingElements: function(locator, isXPath = false) {
            const elements = [];
            try {
                if (isXPath) {
                    const result = document.evaluate(
                        locator, 
                        document, 
                        null, 
                        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, 
                        null
                    );
                    for (let i = 0; i < result.snapshotLength; i++) {
                        const element = result.snapshotItem(i);
                        if (element && !this.shouldExclude(element)) {
                            elements.push(element);
                        }
                    }
                } else {
                    try {
                        const foundElements = document.querySelectorAll(locator);
                        Array.from(foundElements).forEach(element => {
                            if (element && !this.shouldExclude(element)) {
                                elements.push(element);
                            }
                        });
                    } catch (cssError) {
                        return [];
                    }
                }
            } catch (e) {
                return [];
            }
            return elements;
        }
    };

    // Validate unique locator.
    function validateUniqueLocator(locator, targetElement) {
        try {
            const isXPath = locator.includes('//') || locator.includes('/');
            const matchingElements = DOM_ISOLATION_CONFIG.getMatchingElements(locator, isXPath);
            const isUnique = matchingElements.length === 1;
            const isCorrect = matchingElements.length > 0 && matchingElements.some(el => {
                return el === targetElement || el.isSameNode(targetElement);
            });
            return {
                isUnique: isUnique,
                isCorrect: isCorrect,
                matchCount: matchingElements.length,
                isValid: isUnique && isCorrect
            };
        } catch (error) {
            return {
                isUnique: false,
                isCorrect: false,
                matchCount: 0,
                isValid: false,
                error: error.message
            };
        }
    }

    class UnifiedLocatorGenerator {
        constructor() {
            this.uniqueAttributes = ['id', 'name', 'data-testid', 'data-cy', 'data-test','aria-label', 'placeholder', 'title', 'alt', 'href', 'src', 'role'];
            this.priorityWeights = {
                id: 95,
                name: 85,
                dataTestId: 90,
                dataAttributes: 80,
                ariaLabel: 75,
                href: 85,
                src: 90,
                alt: 85,
                tagWithType: 70,
                className: 60,
                textContent: 50,
                position: 30,
                parentBased: 65
            };
            
            // Icon detection patterns
            this.iconPatterns = {
                classPatterns: [
                    /^icon-/,
                    /-icon$/,
                    /icon/,
                    /^fa-/,
                    /^fas$/,
                    /^far$/,
                    /^fal$/,
                    /^fab$/,
                    /material-icons/,
                    /glyphicon/,
                    /lucide/,
                    /feather/,
                    /heroicon/,
                    /tabler/,
                    /phosphor/,
                    /remix/,
                    /bootstrap-icons/,
                    /bi-/
                ],
                textPatterns: [
                    /^[\u2190-\u21FF]$/, // Arrows
                    /^[\u2600-\u26FF]$/, // Miscellaneous Symbols
                    /^[\u2700-\u27BF]$/, // Dingbats
                    /^[\uE000-\uF8FF]$/, // Private Use Area (icon fonts)
                    /^[\u{1F300}-\u{1F5FF}]$/u, // Miscellaneous Symbols and Pictographs
                    /^[\u{1F600}-\u{1F64F}]$/u, // Emoticons
                    /^[\u{1F680}-\u{1F6FF}]$/u, // Transport and Map Symbols
                    /^[\u{1F700}-\u{1F77F}]$/u, // Alchemical Symbols
                    /^[\u{1F780}-\u{1F7FF}]$/u, // Geometric Shapes Extended
                    /^[\u{1F800}-\u{1F8FF}]$/u, // Supplemental Arrows-C
                    /^[\u{1F900}-\u{1F9FF}]$/u, // Supplemental Symbols and Pictographs
                    /^[\u{1FA00}-\u{1FA6F}]$/u, // Chess Symbols
                    /^[\u{1FA70}-\u{1FAFF}]$/u, // Symbols and Pictographs Extended-A
                    /^[×✓✗✘✕✖✔✅❌⚠⚡⭐❤💡🔍🔒🔓📧📞🏠🛒🛍️💰💳🎯📊📈📉⚙️🔧🔨🎨🖼️📷📹🎵🎶🔊🔇📱💻🖥️⌨️🖱️🖨️📺📻📡🔋🔌💾💿📀💽💻🖥️📱☎️📞📠📧📨📩📤📥📦📫📪📬📭📮🗳️✏️✒️🖋️🖊️🖌️🖍️📝📄📃📑📊📈📉📋📌📍📎🖇️📏📐✂️🗃️🗄️🗑️🔒🔓🔏🔐🔑🗝️🔨⛏️⚒️🛠️🗡️⚔️🔫🏹🛡️🔧🔩⚙️🗜️⚖️🔗⛓️🧰🧲⚗️🧪🧫🧬🔬🔭📡💉💊🩹🩺🚪🛏️🛋️🚽🚿🛁🧴🧷🧹🧺🧻🧼🧽🧯🛒🚬⚰️⚱️🗿🏺🔮📿🧿🪬💎🔔🔕📯📻📱📞☎️📠📧📨📩📤📥📦📫📪📬📭📮🗳️✏️✒️🖋️🖊️🖌️🖍️📝📄📃📑📊📈📉📋📌📍📎🖇️📏📐✂️🗃️🗄️🗑️]$/
                ],
                dataAttributes: [
                    'data-icon',
                    'data-feather',
                    'data-lucide',
                    'data-heroicon',
                    'data-tabler',
                    'data-phosphor'
                ]
            };
            
            // Button detection patterns
            this.buttonPatterns = {
                roles: ['button', 'menuitem', 'tab', 'option', 'checkbox', 'radio', 'switch'],
                clickableClasses: [
                    /btn/,
                    /button/,
                    /clickable/,
                    /interactive/,
                    /action/,
                    /trigger/,
                    /toggle/,
                    /submit/,
                    /cancel/,
                    /close/,
                    /save/,
                    /delete/,
                    /edit/,
                    /add/,
                    /remove/
                ],
                clickableAttributes: [
                    'onclick',
                    'onmousedown',
                    'onmouseup',
                    'data-action',
                    'data-click',
                    'data-toggle',
                    'data-dismiss',
                    'data-target'
                ]
            };
            
            // XPath Axis detection patterns 
            this.xpathAxisPatterns = [
                'following-sibling::',
                'preceding-sibling::',
                'ancestor::',
                'descendant::',
                'parent::',
                'child::',
                'self::',
                'following::',
                'preceding::'
            ];
        }

        // NEW - Helper function to detect advanced XPath axis usage
        isAdvancedXPathAxis(value) {
            return this.xpathAxisPatterns.some(axis => value.includes(axis));
        }

        getCacheKey(element) {
            var cls = element.getAttribute('class') || '';
            return `${element.tagName}_${element.id}_${cls}_${element.textContent?.substring(0, 20)}`;
        }

        // Generates unified locators for an element.
        generateUnifiedLocators(element) {
            const cacheKey = this.getCacheKey(element);
            const cached = locatorCache.get(cacheKey);
            if (cached) {
                return cached;
            }

            const allLocators = [];
            const elementType = this.detectElementType(element);

            if (this.isSVGElement(element)) {
                const svgLocators = [...this.generateSVGXPathLocators(element), ...this.generateSVGCSSSelectors(element)];
                allLocators.push(...svgLocators);
            } else {
                const specificLocators = this.generateSpecificLocators(element, elementType);
                const xpathLocators = this.generateXPathLocators(element);
                const cssLocators = this.generateCSSLocators(element);
                const advancedLocators = this.generateAdvancedFallbackLocators(element);
                allLocators.push(...specificLocators, ...xpathLocators, ...cssLocators, ...advancedLocators);
            }

            // Remove duplicates before validation.
            const uniqueLocators = this.removeDuplicateLocators(allLocators);

            // Validate locators.
            const validatedLocators = uniqueLocators.map(locator => {
                const validation = validateUniqueLocator(locator.value, element);
                locator.isUnique = validation.isUnique;
                locator.isCorrect = validation.isCorrect;
                locator.matchCount = validation.matchCount;
                locator.isValid = validation.isValid;
                return locator;
            });

            const validLocators = validatedLocators.filter(locator => locator.isValid);

            // If too few unique locators, try enhanced versions.
            if (validLocators.length < 3) {
                const enhancedLocators = this.enhanceLocatorsForUniqueness(element, uniqueLocators);
                validLocators.push(...enhancedLocators);
            }

            const prioritizedLocators = this.prioritizeLocators(validLocators, element);
            
            // Pass element type to groupLocatorsByCategory 
            const result = this.groupLocatorsByCategory(prioritizedLocators, elementType);

            // Add UI enhancements for better display 
            this.addUiEnhancements(result);

            // Cache result.
            if (locatorCache.size >= 100) {
                const firstKey = locatorCache.keys().next().value;
                locatorCache.delete(firstKey);
            }
            locatorCache.set(cacheKey, result);
            return result;
        }
        
        // Adds UI enhancements to locators
        addUiEnhancements(groupedLocators) {
            ['xpath', 'css'].forEach(type => {
                ['simple', 'medium', 'advanced'].forEach(level => {
                    groupedLocators[type][level].forEach(locator => {
                        // Add visual labels
                        if (locator.value.includes('data-testid')) {
                            locator.uiLabel = '🎯 TestID';
                            locator.stability = 'High';
                        } else if (locator.value.startsWith('#') || locator.value.includes('@id=')) {
                            locator.uiLabel = '🆔 ID';
                            locator.stability = 'High';
                        } else if (locator.value.includes('aria-label') || locator.value.includes('@aria-label')) {
                            locator.uiLabel = '♿ A11y';
                            locator.stability = 'Medium';
                        } else if (locator.value.includes('normalize-space(text())')) {
                            locator.uiLabel = '📝 Text';
                            locator.stability = 'Low';
                        } else if (locator.value.includes('class') || locator.value.startsWith('.')) {
                            locator.uiLabel = '🔍 Class';
                            locator.stability = 'Low';
                        }
                        
                        // Add accessibility rating
                        if (locator.value.includes('aria') || locator.value.includes('role')) {
                            locator.a11yRating = 'Good';
                        } else if (locator.value.includes('text()')) {
                            locator.a11yRating = 'Moderate';
                        } else {
                            locator.a11yRating = 'Basic';
                        }
                    });
                });
            });
        }

        // Removes duplicate locators, keeping the one with higher confidence.
        removeDuplicateLocators(locators) {
            const seen = new Set();
            const unique = [];
            for (const locator of locators) {
                const normalizedValue = locator.value.trim().toLowerCase();
                if (!seen.has(normalizedValue)) {
                    seen.add(normalizedValue);
                    unique.push(locator);
                } else {
                    const existingIndex = unique.findIndex(l => 
                        l.value.trim().toLowerCase() === normalizedValue
                    );
                    if (existingIndex !== -1 && locator.confidence > unique[existingIndex].confidence) {
                        unique[existingIndex] = locator;
                    }
                }
            }
            return unique;
        }

        // Enhanced element type detection
        detectElementType(element) {
            const tag = element.tagName.toLowerCase();
            const type = element.getAttribute('type');
            const role = element.getAttribute('role');
            const classList = Array.from(element.classList);

            // Priority order is important
            if (this.isEcommerceButton(element)) return 'ecommerce-button';
            if (tag === 'input' && type === 'checkbox') return 'checkbox';
            if (this.isSVGElement(element)) return 'svg';
            if (this.isIconElement(element)) return 'icon';
            if (this.isImageElement(element)) return 'image';
            if (this.isClickableButton(element)) return 'button';
            if (tag === 'span') return 'span';

            if (tag === 'a' || element.getAttribute('href')) return 'link';
            if (tag === 'button' || role === 'button') return 'button';
            if (['input', 'textarea', 'select'].includes(tag)) return 'input';
            if (tag === 'table' || tag === 'tr' || tag === 'td') return 'table';
            if (tag === 'ul' || tag === 'ol' || tag === 'li') return 'list';
            return 'generic';
        }

        // Enhanced clickable button detection
        isClickableButton(element) {
            const tag = element.tagName.toLowerCase();
            const role = element.getAttribute('role');
            const classList = Array.from(element.classList);
            
            // Direct button elements
            if (tag === 'button' || role === 'button') return true;
            
            // Check for button-like roles
            if (this.buttonPatterns.roles.includes(role)) return true;
            
            // Check for button-like classes
            if (classList.some(cls => 
                this.buttonPatterns.clickableClasses.some(pattern => pattern.test(cls))
            )) return true;
            
            // Check for clickable attributes
            if (this.buttonPatterns.clickableAttributes.some(attr => 
                element.hasAttribute(attr)
            )) return true;
            
            // Check for cursor pointer style
            const computedStyle = window.getComputedStyle(element);
            if (computedStyle.cursor === 'pointer') return true;
            
            return false;
        }

        // Checks if an element is an e-commerce related button.
        isEcommerceButton(element) {
            const classList = Array.from(element.classList);
            const text = element.textContent?.toLowerCase() || '';
            const ariaLabel = element.getAttribute('aria-label')?.toLowerCase() || '';
            const title = element.getAttribute('title')?.toLowerCase() || '';
            const ecommerceKeywords = [
                'favorite', 'fav', 'wishlist', 'heart', 'like',
                'cart', 'basket', 'buy', 'purchase', 'add-to',
                'share', 'social', 'facebook', 'twitter', 'pinterest',
                'compare', 'quick-view', 'zoom', 'gallery'
            ];
            return ecommerceKeywords.some(keyword => 
                classList.some(cls => cls.includes(keyword)) ||
                text.includes(keyword) ||
                ariaLabel.includes(keyword) ||
                title.includes(keyword)
            );
        }

        // Checks if an element is an SVG element.
        isSVGElement(element) {
            if (!element || !element.tagName) return false;
            const tag = element.tagName.toLowerCase();
            if (tag === 'svg') return true;
            try { if (element.namespaceURI === 'http://www.w3.org/2000/svg') return true; } catch(e) {}
            let cur = element.parentElement;
            while (cur && cur.tagName) {
              if (cur.tagName.toLowerCase() === 'svg') return true;
              cur = cur.parentElement;
            }
            return false;
        }

        // Enhanced icon element detection
        isIconElement(element) {
            const tag = element.tagName.toLowerCase();
            const classList = Array.from(element.classList);
            const textContent = element.textContent?.trim() || '';
            
            // SVG elements are always considered icons
            if (tag === 'svg' || element instanceof SVGElement) return true;
            
            // Check for icon-specific data attributes
            if (this.iconPatterns.dataAttributes.some(attr => element.hasAttribute(attr))) return true;
            
            // Check for icon classes using patterns
            if (classList.some(cls => 
                this.iconPatterns.classPatterns.some(pattern => pattern.test(cls))
            )) return true;
            
            // Check for icon text content (Unicode symbols, emoji, etc.)
            if (textContent.length <= 3 && this.iconPatterns.textPatterns.some(pattern => 
                pattern.test(textContent)
            )) return true;
            
            // Check if element contains SVG
            if (element.querySelector('svg')) return true;
            
            // Check parent for icon context
            const parent = element.parentElement;
            if (parent) {
                const parentClasses = Array.from(parent.classList);
                if (parentClasses.some(cls => 
                    this.iconPatterns.classPatterns.some(pattern => pattern.test(cls))
                )) return true;
            }
            
            // Check for pseudo-element icons by examining computed styles
            try {
                const beforeContent = window.getComputedStyle(element, '::before').content;
                const afterContent = window.getComputedStyle(element, '::after').content;
                
                if ((beforeContent && beforeContent !== 'none' && beforeContent !== '""') ||
                    (afterContent && afterContent !== 'none' && afterContent !== '""')) {
                    // Check if the content looks like an icon
                    const content = (beforeContent || afterContent).replace(/['"]/g, '');
                    if (content.length <= 3 && this.iconPatterns.textPatterns.some(pattern => 
                        pattern.test(content)
                    )) return true;
                }
            } catch (e) {
                // Ignore errors in computed style access
            }
            
            return false;
        }

        isImageElement(element) {
            const tag = element.tagName.toLowerCase();
            return tag === 'img' || tag === 'picture' || tag === 'figure' || 
                   element.getAttribute('role') === 'img' ||
                   element.getAttribute('data-src') || 
                   element.querySelector('img');
        }

        generateSpecificLocators(element, elementType) {
            const locators = [];
            switch (elementType) {
                case 'ecommerce-button':
                    locators.push(...this.generateEcommerceButtonLocators(element));
                    break;
                case 'checkbox':
                    locators.push(...this.generateCheckboxLocators(element));
                    break;
                case 'span':
                    locators.push(...this.generateSpanLocators(element));
                    break;
                case 'image':
                    locators.push(...this.generateImageLocators(element));
                    break;
                case 'icon':
                    locators.push(...this.generateIconLocators(element));
                    break;
                case 'link':
                    locators.push(...this.generateLinkLocators(element));
                    break;
                case 'button':
                    locators.push(...this.generateButtonLocators(element));
                    break;
                case 'input':
                    locators.push(...this.generateInputLocators(element));
                    break;
                case 'table':
                    locators.push(...this.generateTableLocators(element));
                    break;
                case 'list':
                    locators.push(...this.generateListLocators(element));
                    break;
            }
            return locators;
        }
        
        // NEW - Generate locators for table elements
        generateTableLocators(element) {
            const locators = [];
            const tagName = element.tagName.toLowerCase();
            const id = element.id;
            const caption = element.querySelector('caption')?.textContent?.trim();
            
            if (id) {
                locators.push({
                    type: 'Table by ID [ID]',
                    value: `#${id}`,
                    confidence: 95,
                    level: 'simple'
                });
                
                locators.push({
                    type: 'Table by ID XPath [ID]',
                    value: `//${tagName}[@id="${id}"]`,
                    confidence: 95,
                    level: 'simple'
                });
            }
            
            if (caption) {
                locators.push({
                    type: 'Table by Caption [Text]',
                    value: `//table[./caption[normalize-space(text())="${caption}"]]`,
                    confidence: 90,
                    level: 'simple'
                });
            }
            
            // For table rows, find position in table
            if (tagName === 'tr') {
                const parentTable = element.closest('table');
                if (parentTable && parentTable.id) {
                    const rowIndex = Array.from(parentTable.rows).indexOf(element) + 1;
                    locators.push({
                        type: 'Table Row by Index [Position]',
                        value: `#${parentTable.id} tr:nth-child(${rowIndex})`,
                        confidence: 85,
                        level: 'medium'
                    });
                    
                    locators.push({
                        type: 'Table Row by Index XPath [Position]',
                        value: `//table[@id="${parentTable.id}"]/tr[${rowIndex}]`,
                        confidence: 85,
                        level: 'medium'
                    });
                }
            }
            
            // For table cells, find position in row and table
            if (tagName === 'td' || tagName === 'th') {
                const parentRow = element.closest('tr');
                const cellIndex = Array.from(parentRow?.cells || []).indexOf(element) + 1;
                const parentTable = element.closest('table');
                
                if (parentTable && parentTable.id && cellIndex > 0) {
                    const rowIndex = Array.from(parentTable.rows).indexOf(parentRow) + 1;
                    
                    locators.push({
                        type: 'Table Cell by Coordinates [Position]',
                        value: `#${parentTable.id} tr:nth-child(${rowIndex}) td:nth-child(${cellIndex})`,
                        confidence: 80,
                        level: 'medium'
                    });
                    
                    locators.push({
                        type: 'Table Cell by Coordinates XPath [Position]',
                        value: `//table[@id="${parentTable.id}"]/tr[${rowIndex}]/td[${cellIndex}]`,
                        confidence: 80,
                        level: 'medium'
                    });
                }
                
                // If cell contains text, locate by text
                const cellText = element.textContent?.trim();
                if (cellText && cellText.length > 0 && cellText.length < 50) {
                    locators.push({
                        type: 'Table Cell by Text [Text]',
                        value: `//${tagName}[normalize-space(text())="${cellText}"]`,
                        confidence: 75,
                        level: 'medium'
                    });
                }
            }
            
            return locators;
        }
        
        //  Generate locators for list elements
        generateListLocators(element) {
            const locators = [];
            const tagName = element.tagName.toLowerCase();
            const id = element.id;
            
            if (id) {
                locators.push({
                    type: 'List by ID [ID]',
                    value: `#${id}`,
                    confidence: 95,
                    level: 'simple'
                });
            }
            
            // For list items, find position in list
            if (tagName === 'li') {
                const parentList = element.closest('ul, ol');
                if (parentList && parentList.id) {
                    const itemIndex = Array.from(parentList.children).indexOf(element) + 1;
                    
                    locators.push({
                        type: 'List Item by Index [Position]',
                        value: `#${parentList.id} > li:nth-child(${itemIndex})`,
                        confidence: 85,
                        level: 'medium'
                    });
                    
                    locators.push({
                        type: 'List Item by Index XPath [Position]',
                        value: `//${parentList.tagName.toLowerCase()}[@id="${parentList.id}"]/li[${itemIndex}]`,
                        confidence: 85,
                        level: 'medium'
                    });
                }
                
                // If list item contains text, locate by text
                const itemText = element.textContent?.trim();
                if (itemText && itemText.length > 0 && itemText.length < 50) {
                    locators.push({
                        type: 'List Item by Text [Text]',
                        value: `//li[normalize-space(text())="${itemText}"]`,
                        confidence: 80,
                        level: 'medium'
                    });
                }
            }
            
            return locators;
        }

        // Generates locators for e-commerce buttons.
        generateEcommerceButtonLocators(element) {
            const locators = [];
            const classList = Array.from(element.classList);
            const ariaLabel = element.getAttribute('aria-label');
            const title = element.getAttribute('title');
            const dataTestId = element.getAttribute('data-testid');

            if (dataTestId) {
                locators.push({
                    type: 'E-commerce by TestID [TestID]',
                    value: `[data-testid="${dataTestId}"]`,
                    confidence: 95,
                    level: 'simple'
                });
            }

            if (ariaLabel) {
                locators.push({
                    type: 'E-commerce by Aria-Label [Accessibility]',
                    value: `[aria-label="${ariaLabel}"]`,
                    confidence: 90,
                    level: 'simple'
                });
                locators.push({
                    type: 'E-commerce by Aria-Label XPath [Accessibility]',
                    value: `//*[@aria-label="${ariaLabel}"]`,
                    confidence: 90,
                    level: 'simple'
                });
            }

            const relevantClasses = classList.filter(cls => 
                cls.includes('fav') || cls.includes('heart') || cls.includes('cart') ||
                cls.includes('wishlist') || cls.includes('share') || cls.includes('like')
            );
            relevantClasses.forEach(cls => {
                locators.push({
                    type: 'E-commerce by Class [Style]',
                    value: `.${cls}`,
                    confidence: 85,
                    level: 'simple'
                });
            });

            if (title) {
                locators.push({
                    type: 'E-commerce by Title [Attribute]',
                    value: `[title="${title}"]`,
                    confidence: 80,
                    level: 'simple'
                });
            }

            const parent = element.closest('[data-product-id], [data-item-id], .product, .item, .card');
            if (parent) {
                const parentId = parent.id;
                const parentClass = parent.classList[0];
                if (parentId) {
                    locators.push({
                        type: 'E-commerce by Product Context [Context]',
                        value: `#${parentId} [aria-label="${ariaLabel}"]`,
                        confidence: 90,
                        level: 'simple'
                    });
                } else if (parentClass) {
                    locators.push({
                        type: 'E-commerce by Product Context [Context]',
                        value: `.${parentClass} [aria-label="${ariaLabel}"]`,
                        confidence: 85,
                        level: 'medium'
                    });
                }
            }
            return locators;
        }

        // Generates XPath locators for SVG elements.
        generateSVGXPathLocators(element) {
            const locators = [];
            if (!element || !element.tagName) return locators;
            const tag = element.tagName.toLowerCase();
            const self = this;

            function xpEsc(s) { return String(s).replace(/'/g, "&apos;").replace(/"/g, '&quot;'); }

            function ln(tagName) {
                return "*[local-name()='" + tagName + "']";
            }

            function getClassList(el) {
                try {
                    if (el.classList && typeof el.classList === 'object' && el.classList.length !== undefined) {
                        return Array.from(el.classList);
                    }
                } catch(e) {}
                try {
                    const cls = el.getAttribute('class');
                    if (cls && typeof cls === 'string') {
                        return cls.trim().split(/\s+/).filter(Boolean);
                    }
                } catch(e) {}
                return [];
            }

            function isMeaningfulClass(cls) {
                if (!cls || cls.length < 3) return false;
                if (/^\d/.test(cls)) return false;
                const randomPatterns = [/^[a-z]\d+$/i, /^[a-f0-9]{8,}$/i, /[-_][a-f0-9]{6,}$/i];
                for (const pat of randomPatterns) {
                    if (pat.test(cls)) return false;
                }
                return true;
            }

            function getSvgRoot(el) {
                let cur = el;
                while (cur && cur.tagName && cur.tagName.toLowerCase() !== 'svg') {
                    cur = cur.parentElement;
                }
                return cur;
            }

            function getHtmlAncestors(el, maxDepth) {
                const ancestors = [];
                let cur = el.parentElement;
                while (cur && cur.tagName && ancestors.length < maxDepth) {
                    const ns = cur.namespaceURI || '';
                    if (ns !== 'http://www.w3.org/2000/svg') {
                        ancestors.push(cur);
                    }
                    cur = cur.parentElement;
                }
                return ancestors;
            }

            function getPositionIndex(el) {
                try {
                    const parent = el.parentElement;
                    if (!parent) return -1;
                    const siblings = parent.querySelectorAll(el.tagName.toLowerCase());
                    for (let i = 0; i < siblings.length; i++) {
                        if (siblings[i].isSameNode(el)) return i + 1;
                    }
                } catch(e) {}
                return -1;
            }

            function buildAncestorXpath(ancestors, levels) {
                let xp = '';
                const count = Math.min(levels, ancestors.length);
                for (let i = count - 1; i >= 0; i--) {
                    const anc = ancestors[i];
                    const ancTag = anc.tagName.toLowerCase();
                    const ancId = anc.id || anc.getAttribute('id');
                    const ancClasses = getClassList(anc).filter(isMeaningfulClass);

                    if (ancId) {
                        xp += '//*[@id="' + xpEsc(ancId) + '"]';
                    } else if (ancClasses.length > 0) {
                        xp += '//' + ancTag + '[contains(@class, "' + xpEsc(ancClasses[0]) + '")]';
                    } else {
                        xp += '//' + ancTag;
                    }
                }
                return xp;
            }

            function findTextAncestors(el) {
                const results = [];
                const svgRoot = getSvgRoot(el);
                if (!svgRoot) return results;
                
                const textElements = svgRoot.querySelectorAll('text');
                for (let i = 0; i < textElements.length; i++) {
                    const textEl = textElements[i];
                    const textContent = (textEl.textContent || '').trim();
                    if (!textContent || textContent.length > 30) continue;
                    
                    let cur = textEl.parentElement;
                    let depth = 0;
                    while (cur && cur !== svgRoot && depth < 5) {
                        if (cur.contains(el)) {
                            results.push({ text: textContent, gDepth: depth + 1, textEl: textEl });
                            break;
                        }
                        cur = cur.parentElement;
                        depth++;
                    }
                }
                return results;
            }

            function hasTitleChild(el) {
                const children = el.children;
                for (let i = 0; i < children.length; i++) {
                    if (children[i].tagName.toLowerCase() === 'title') return children[i];
                }
                return null;
            }

            const svgRoot = getSvgRoot(element);
            const htmlAncestors = getHtmlAncestors(svgRoot || element, 6);
            const isSvgTag = tag === 'svg';
            const targetSvg = svgRoot || element;

            const id = element.id || element.getAttribute('id');
            const dataTestId = element.getAttribute('data-testid') || element.getAttribute('data-test');
            const ariaLabel = element.getAttribute('aria-label');
            const dataIcon = element.getAttribute('data-icon');
            const roleAttr = element.getAttribute('role');
            const classList = getClassList(element).filter(isMeaningfulClass);

            const viewBox = element.getAttribute('viewBox');
            const fillAttr = element.getAttribute('fill');
            const strokeAttr = element.getAttribute('stroke');
            const strokeWidthAttr = element.getAttribute('stroke-width');
            const transformAttr = element.getAttribute('transform');

            const svgId = targetSvg ? (targetSvg.id || targetSvg.getAttribute('id')) : '';
            const svgViewBox = targetSvg ? targetSvg.getAttribute('viewBox') : '';
            const svgClasses = targetSvg ? getClassList(targetSvg).filter(isMeaningfulClass) : [];

            const titleChild = hasTitleChild(element);
            const titleText = titleChild ? (titleChild.textContent || '').trim() : '';
            const textAnchors = !isSvgTag ? findTextAncestors(element) : [];

            // ===== Strategy 1: Direct unique attributes (highest confidence) =====
            // Enterprise: always use local-name() for SVG elements to avoid namespace issues
            if (id) {
                locators.push({ type: 'SVG by ID', value: '//*[@id="' + xpEsc(id) + '"]', confidence: 100, level: 'simple' });
            }
            if (dataTestId) {
                locators.push({ type: 'SVG by data-testid', value: '//' + ln(tag) + '[@data-testid="' + xpEsc(dataTestId) + '"]', confidence: 98, level: 'simple' });
            }
            if (ariaLabel) {
                locators.push({ type: 'SVG by aria-label', value: '//' + ln(tag) + '[@aria-label="' + xpEsc(ariaLabel) + '"]', confidence: 94, level: 'simple' });
            }
            if (dataIcon) {
                locators.push({ type: 'SVG by data-icon', value: '//' + ln(tag) + '[@data-icon="' + xpEsc(dataIcon) + '"]', confidence: 94, level: 'simple' });
            }
            if (roleAttr) {
                locators.push({ type: 'SVG by role', value: '//' + ln(tag) + '[@role="' + xpEsc(roleAttr) + '"]', confidence: 82, level: 'simple' });
            }

            // ===== Strategy 2: Title child element (SVG tooltip pattern) =====
            // Enterprise: leverage <title> tooltip elements for stable identification
            if (titleText) {
                locators.push({
                    type: 'SVG by title text',
                    value: '//' + ln(tag) + '[.//' + ln('title') + '/text()="' + xpEsc(titleText) + '"]',
                    confidence: 88,
                    level: 'simple'
                });
                locators.push({
                    type: 'SVG by title (contains)',
                    value: '//' + ln(tag) + '[contains(.//' + ln('title') + '/text(), "' + xpEsc(titleText.slice(0, 10)) + '")]',
                    confidence: 82,
                    level: 'medium'
                });
            }

            // ===== Strategy 3: Text anchor method (SVG chart pattern) =====
            // Enterprise: use <text> as "lighthouse" to find related shapes
            if (textAnchors.length > 0) {
                textAnchors.slice(0, 3).forEach((anchor, idx) => {
                    const confidence = 92 - idx * 5;
                    locators.push({
                        type: 'SVG by text anchor (exact)',
                        value: '//' + ln('text') + '[normalize-space(text())="' + xpEsc(anchor.text) + '"]/ancestor::' + ln('g') + '[' + anchor.gDepth + ']/' + ln(tag),
                        confidence: confidence,
                        level: 'simple'
                    });
                    locators.push({
                        type: 'SVG by text anchor (contains)',
                        value: '//' + ln('text') + '[contains(text(), "' + xpEsc(anchor.text.slice(0, 5)) + '")]/ancestor::' + ln('g') + '[' + anchor.gDepth + ']/' + ln(tag),
                        confidence: confidence - 6,
                        level: 'medium'
                    });
                });
            }

            // ===== Strategy 4: With HTML ancestor context (icon SVG pattern) =====
            if (htmlAncestors.length > 0) {
                for (let depth = 1; depth <= Math.min(3, htmlAncestors.length); depth++) {
                    const ancestorBase = buildAncestorXpath(htmlAncestors, depth);
                    if (!ancestorBase) continue;

                    const svgTagXp = ln('svg');
                    const targetTagXp = ln(tag);

                    if (isSvgTag) {
                        locators.push({
                            type: `SVG by ${depth}-ancestor + svg`,
                            value: ancestorBase + '//' + svgTagXp,
                            confidence: 88 - (depth - 1) * 5,
                            level: depth === 1 ? 'simple' : 'medium'
                        });

                        if (svgViewBox) {
                            locators.push({
                                type: `SVG by ${depth}-ancestor + viewBox`,
                                value: ancestorBase + '//' + svgTagXp + '[@viewBox="' + xpEsc(svgViewBox) + '"]',
                                confidence: 92 - (depth - 1) * 3,
                                level: 'medium'
                            });
                        }
                        if (svgClasses.length > 0) {
                            locators.push({
                                type: `SVG by ${depth}-ancestor + class`,
                                value: ancestorBase + '//' + svgTagXp + '[contains(@class, "' + xpEsc(svgClasses[0]) + '")]',
                                confidence: 90 - (depth - 1) * 3,
                                level: 'medium'
                            });
                            if (svgClasses.length >= 2) {
                                locators.push({
                                    type: `SVG by ${depth}-ancestor + multi-class`,
                                    value: ancestorBase + '//' + svgTagXp + '[contains(@class, "' + xpEsc(svgClasses[0]) + '") and contains(@class, "' + xpEsc(svgClasses[1]) + '")]',
                                    confidence: 94 - (depth - 1) * 3,
                                    level: 'medium'
                                });
                            }
                        }
                        if (svgViewBox && svgClasses.length > 0) {
                            locators.push({
                                type: `SVG by ${depth}-ancestor + viewBox + class`,
                                value: ancestorBase + '//' + svgTagXp + '[@viewBox="' + xpEsc(svgViewBox) + '" and contains(@class, "' + xpEsc(svgClasses[0]) + '")]',
                                confidence: 96 - (depth - 1) * 3,
                                level: 'medium'
                            });
                        }
                    } else {
                        locators.push({
                            type: `SVG Child by ${depth}-ancestor`,
                            value: ancestorBase + '//' + targetTagXp,
                            confidence: 85 - (depth - 1) * 5,
                            level: depth === 1 ? 'simple' : 'medium'
                        });

                        locators.push({
                            type: `SVG Child by ${depth}-ancestor + svg + tag`,
                            value: ancestorBase + '//' + svgTagXp + '//' + targetTagXp,
                            confidence: 88 - (depth - 1) * 5,
                            level: 'medium'
                        });

                        if (svgViewBox) {
                            locators.push({
                                type: `SVG Child by ${depth}-ancestor + viewBox + tag`,
                                value: ancestorBase + '//' + svgTagXp + '[@viewBox="' + xpEsc(svgViewBox) + '"]//' + targetTagXp,
                                confidence: 91 - (depth - 1) * 3,
                                level: 'medium'
                            });
                        }

                        if (svgClasses.length > 0) {
                            locators.push({
                                type: `SVG Child by ${depth}-ancestor + svg-class + tag`,
                                value: ancestorBase + '//' + svgTagXp + '[contains(@class, "' + xpEsc(svgClasses[0]) + '")]//' + targetTagXp,
                                confidence: 90 - (depth - 1) * 3,
                                level: 'medium'
                            });
                        }

                        if (strokeAttr && strokeAttr !== 'currentColor' && strokeAttr !== 'none') {
                            locators.push({
                                type: `SVG Child by ${depth}-ancestor + stroke`,
                                value: ancestorBase + '//' + targetTagXp + '[@stroke="' + xpEsc(strokeAttr) + '"]',
                                confidence: 80 - (depth - 1) * 3,
                                level: 'medium'
                            });
                        }
                        if (fillAttr && fillAttr !== 'currentColor' && fillAttr !== 'none') {
                            locators.push({
                                type: `SVG Child by ${depth}-ancestor + fill`,
                                value: ancestorBase + '//' + targetTagXp + '[@fill="' + xpEsc(fillAttr) + '"]',
                                confidence: 75 - (depth - 1) * 3,
                                level: 'medium'
                            });
                        }
                        if (strokeAttr && fillAttr && strokeAttr !== 'currentColor' && fillAttr !== 'currentColor') {
                            locators.push({
                                type: `SVG Child by ${depth}-ancestor + stroke + fill`,
                                value: ancestorBase + '//' + targetTagXp + '[@stroke="' + xpEsc(strokeAttr) + '" and @fill="' + xpEsc(fillAttr) + '"]',
                                confidence: 85 - (depth - 1) * 3,
                                level: 'medium'
                            });
                        }
                    }
                }

                const firstAnc = htmlAncestors[0];
                if (firstAnc) {
                    const firstAncClasses = getClassList(firstAnc).filter(isMeaningfulClass);
                    const posIdx = getPositionIndex(firstAnc);
                    if (posIdx > 0 && firstAncClasses.length > 0) {
                        const ancXp = '//' + firstAnc.tagName.toLowerCase() + '[contains(@class, "' + xpEsc(firstAncClasses[0]) + '")][' + posIdx + ']';
                        locators.push({
                            type: 'SVG by ancestor[pos]',
                            value: ancXp + '//' + (isSvgTag ? ln('svg') : ln(tag)),
                            confidence: 86,
                            level: 'advanced'
                        });
                    }
                }
            }

            // ===== Strategy 5: Transform attribute (fixed layout pattern) =====
            if (transformAttr && transformAttr.length > 5) {
                const transformShort = transformAttr.slice(0, 25);
                locators.push({
                    type: 'SVG by transform (partial)',
                    value: '//' + ln(tag) + '[contains(@transform, "' + xpEsc(transformShort) + '")]',
                    confidence: 65,
                    level: 'advanced'
                });
            }

            // ===== Strategy 6: SVG internal attributes =====
            if (isSvgTag) {
                if (viewBox) {
                    locators.push({ type: 'SVG by ViewBox', value: '//' + ln('svg') + '[@viewBox="' + xpEsc(viewBox) + '"]', confidence: 80, level: 'simple' });
                }
                if (classList.length > 0) {
                    locators.push({ type: 'SVG by Class', value: '//' + ln('svg') + '[contains(@class, "' + xpEsc(classList[0]) + '")]', confidence: 75, level: 'medium' });
                    if (classList.length >= 2) {
                        locators.push({
                            type: 'SVG by Multi-Class',
                            value: '//' + ln('svg') + '[contains(@class, "' + xpEsc(classList[0]) + '") and contains(@class, "' + xpEsc(classList[1]) + '")]',
                            confidence: 85,
                            level: 'medium'
                        });
                    }
                }
                const svgPosIdx = getPositionIndex(element);
                if (svgPosIdx > 0) {
                    locators.push({ type: 'SVG by Position', value: '(//' + ln('svg') + ')[' + svgPosIdx + ']', confidence: 45, level: 'advanced' });
                }
            } else {
                if (classList.length > 0) {
                    classList.forEach(cls => {
                        locators.push({ type: 'SVG Child by Class', value: '//' + ln('svg') + '//' + ln(tag) + '[contains(@class, "' + xpEsc(cls) + '")]', confidence: 72, level: 'medium' });
                    });
                    if (classList.length >= 2) {
                        locators.push({
                            type: 'SVG Child by Multi-Class',
                            value: '//' + ln('svg') + '//' + ln(tag) + '[contains(@class, "' + xpEsc(classList[0]) + '") and contains(@class, "' + xpEsc(classList[1]) + '")]',
                            confidence: 82,
                            level: 'medium'
                        });
                    }
                }

                if (strokeAttr && strokeAttr !== 'currentColor' && strokeAttr !== 'none') {
                    locators.push({ type: 'SVG Child by Stroke', value: '//' + ln('svg') + '//' + ln(tag) + '[@stroke="' + xpEsc(strokeAttr) + '"]', confidence: 55, level: 'medium' });
                }
                if (fillAttr && fillAttr !== 'currentColor' && fillAttr !== 'none') {
                    locators.push({ type: 'SVG Child by Fill', value: '//' + ln('svg') + '//' + ln(tag) + '[@fill="' + xpEsc(fillAttr) + '"]', confidence: 48, level: 'medium' });
                }
                if (strokeAttr && fillAttr && strokeAttr !== 'currentColor' && fillAttr !== 'currentColor') {
                    locators.push({
                        type: 'SVG Child by Stroke+Fill',
                        value: '//' + ln('svg') + '//' + ln(tag) + '[@stroke="' + xpEsc(strokeAttr) + '"][@fill="' + xpEsc(fillAttr) + '"]',
                        confidence: 72,
                        level: 'medium'
                    });
                }

                if (tag === 'circle') {
                    const cx = element.getAttribute('cx'), cy = element.getAttribute('cy'), r = element.getAttribute('r');
                    if (cx && cy && r) {
                        locators.push({
                            type: 'SVG Circle by cx+cy+r',
                            value: '//' + ln('svg') + '//' + ln('circle') + '[@cx="' + xpEsc(cx) + '"][@cy="' + xpEsc(cy) + '"][@r="' + xpEsc(r) + '"]',
                            confidence: 78,
                            level: 'medium'
                        });
                    }
                }

                if ((tag === 'rect' || tag === 'image')) {
                    const x = element.getAttribute('x'), y = element.getAttribute('y');
                    const w = element.getAttribute('width'), h = element.getAttribute('height');
                    if (x && y && w && h) {
                        locators.push({
                            type: 'SVG ' + tag + ' by position+size',
                            value: '//' + ln('svg') + '//' + ln(tag) + '[@x="' + xpEsc(x) + '"][@y="' + xpEsc(y) + '"][@width="' + xpEsc(w) + '"][@height="' + xpEsc(h) + '"]',
                            confidence: 78,
                            level: 'medium'
                        });
                    }
                }

                if (tag === 'path') {
                    const dAttr = element.getAttribute('d');
                    if (dAttr && dAttr.length > 5) {
                        const midStart = Math.floor(dAttr.length / 3);
                        const midEnd = midStart + 20;
                        const partialD = dAttr.slice(midStart, midEnd);
                        locators.push({
                            type: 'SVG Path by d (mid-section)',
                            value: '//' + ln('svg') + '//' + ln('path') + '[contains(@d, "' + xpEsc(partialD) + '")]',
                            confidence: 72,
                            level: 'advanced'
                        });
                        if (fillAttr && fillAttr !== 'currentColor') {
                            locators.push({
                                type: 'SVG Path by d+fill',
                                value: '//' + ln('svg') + '//' + ln('path') + '[contains(@d, "' + xpEsc(partialD) + '")][@fill="' + xpEsc(fillAttr) + '"]',
                                confidence: 82,
                                level: 'advanced'
                            });
                        }
                    }
                }

                if (tag === 'polygon') {
                    const points = element.getAttribute('points');
                    if (points && points.length > 5) {
                        const partialPts = points.slice(0, 15);
                        locators.push({
                            type: 'SVG Polygon by points (partial)',
                            value: '//' + ln('svg') + '//' + ln('polygon') + '[starts-with(@points, "' + xpEsc(partialPts) + '")]',
                            confidence: 70,
                            level: 'advanced'
                        });
                    }
                }

                if (svgViewBox) {
                    locators.push({
                        type: 'SVG Child by Parent ViewBox',
                        value: '//' + ln('svg') + '[@viewBox="' + xpEsc(svgViewBox) + '"]//' + ln(tag),
                        confidence: 70,
                        level: 'simple'
                    });
                }
                if (svgId) {
                    locators.push({
                        type: 'SVG Child by Parent SVG ID',
                        value: '//' + ln('svg') + '[@id="' + xpEsc(svgId) + '"]//' + ln(tag),
                        confidence: 88,
                        level: 'simple'
                    });
                }

                const childPosIdx = getPositionIndex(element);
                if (childPosIdx > 0) {
                    if (svgViewBox) {
                        locators.push({
                            type: 'SVG Child by ViewBox+Index',
                            value: '(//' + ln('svg') + '[@viewBox="' + xpEsc(svgViewBox) + '"]//' + ln(tag) + ')[' + childPosIdx + ']',
                            confidence: 80,
                            level: 'advanced'
                        });
                    }
                    locators.push({
                        type: 'SVG Child by Position',
                        value: '(//' + ln('svg') + '//' + ln(tag) + ')[' + childPosIdx + ']',
                        confidence: 42,
                        level: 'advanced'
                    });
                }
            }

            // ===== Strategy 7: Context-aware fallback (never just "//svg") =====
            {
                let ctxXp = '';
                let ctxFound = false;
                let ctxAnc = element.parentElement;
                let ctxD = 0;
                while (ctxAnc && ctxAnc !== document.body && ctxD < 6 && !ctxFound) {
                    if (ctxAnc.id) {
                        ctxXp = '//*[@id="' + xpEsc(ctxAnc.id) + '"]';
                        ctxFound = true;
                    } else {
                        var ctxCls2 = getClassList(ctxAnc).filter(isMeaningfulClass);
                        if (ctxCls2.length > 0) {
                            ctxXp = '//' + ctxAnc.tagName.toLowerCase() + '[contains(@class, "' + xpEsc(ctxCls2[0]) + '")]';
                            ctxFound = true;
                        }
                    }
                    ctxAnc = ctxAnc.parentElement;
                    ctxD++;
                }

                if (ctxFound) {
                    if (isSvgTag) {
                        locators.push({ type: 'SVG by context [Fallback]', value: ctxXp + '//' + ln('svg'), confidence: 50, level: 'advanced' });
                        if (svgViewBox) {
                            locators.push({ type: 'SVG by context+viewBox [Fallback]', value: ctxXp + '//' + ln('svg') + '[@viewBox="' + xpEsc(svgViewBox) + '"]', confidence: 65, level: 'advanced' });
                        }
                    } else {
                        locators.push({ type: 'SVG Child by context [Fallback]', value: ctxXp + '//' + ln('svg') + '//' + ln(tag), confidence: 50, level: 'advanced' });
                        if (svgViewBox) {
                            locators.push({ type: 'SVG Child by context+viewBox [Fallback]', value: ctxXp + '//' + ln('svg') + '[@viewBox="' + xpEsc(svgViewBox) + '"]//' + ln(tag), confidence: 65, level: 'advanced' });
                        }
                    }
                } else {
                    // Last resort: only if no context ancestor found at all
                    if (isSvgTag) {
                        locators.push({ type: 'SVG Element [Basic]', value: '//' + ln('svg'), confidence: 15, level: 'advanced' });
                    } else {
                        locators.push({ type: 'SVG Child [Basic]', value: '//' + ln('svg') + '//' + ln(tag), confidence: 20, level: 'advanced' });
                    }
                }
            }

            return locators;
        }

        generateSVGCSSSelectors(element) {
            const selectors = [];
            if (!element || !element.tagName) return selectors;
            const tag = element.tagName.toLowerCase();
            const self = this;

            function cssEsc(s) {
                try { return CSS.escape(s); } catch(e) { return String(s).replace(/"/g, '\\"'); }
            }

            function getClassList(el) {
                try {
                    if (el.classList && typeof el.classList === 'object' && el.classList.length !== undefined) {
                        return Array.from(el.classList);
                    }
                } catch(e) {}
                try {
                    const cls = el.getAttribute('class');
                    if (cls && typeof cls === 'string') {
                        return cls.trim().split(/\s+/).filter(Boolean);
                    }
                } catch(e) {}
                return [];
            }

            function isMeaningfulClass(cls) {
                if (!cls || cls.length < 3) return false;
                if (/^\d/.test(cls)) return false;
                const randomPatterns = [/^[a-z]\d+$/i, /^[a-f0-9]{8,}$/i, /[-_][a-f0-9]{6,}$/i];
                for (const pat of randomPatterns) {
                    if (pat.test(cls)) return false;
                }
                return true;
            }

            function getSvgRoot(el) {
                let cur = el;
                while (cur && cur.tagName && cur.tagName.toLowerCase() !== 'svg') {
                    cur = cur.parentElement;
                }
                return cur;
            }

            function getHtmlAncestors(el, maxDepth) {
                const ancestors = [];
                let cur = el.parentElement;
                while (cur && cur.tagName && ancestors.length < maxDepth) {
                    const ns = cur.namespaceURI || '';
                    if (ns !== 'http://www.w3.org/2000/svg') {
                        ancestors.push(cur);
                    }
                    cur = cur.parentElement;
                }
                return ancestors;
            }

            function getNthChildIndex(el) {
                try {
                    const parent = el.parentElement;
                    if (!parent) return -1;
                    const siblings = parent.children;
                    for (let i = 0; i < siblings.length; i++) {
                        if (siblings[i].isSameNode(el)) return i + 1;
                    }
                } catch(e) {}
                return -1;
            }

            function buildAncestorSelector(ancestors, levels) {
                let sel = '';
                const count = Math.min(levels, ancestors.length);
                for (let i = count - 1; i >= 0; i--) {
                    const anc = ancestors[i];
                    const ancTag = anc.tagName.toLowerCase();
                    const ancId = anc.id || anc.getAttribute('id');
                    const ancClasses = getClassList(anc).filter(isMeaningfulClass);

                    if (ancId) {
                        sel += '#' + cssEsc(ancId) + ' ';
                    } else if (ancClasses.length > 0) {
                        sel += ancTag + '.' + cssEsc(ancClasses[0]) + ' ';
                    } else {
                        sel += ancTag + ' ';
                    }
                }
                return sel;
            }

            function hasTitleChild(el) {
                const children = el.children;
                for (let i = 0; i < children.length; i++) {
                    if (children[i].tagName.toLowerCase() === 'title') return children[i];
                }
                return null;
            }

            function supportsHas() {
                try {
                    document.querySelector(':has(*)');
                    return true;
                } catch(e) {
                    return false;
                }
            }

            const svgRoot = getSvgRoot(element);
            const htmlAncestors = getHtmlAncestors(svgRoot || element, 6);
            const isSvgTag = tag === 'svg';
            const targetSvg = svgRoot || element;

            const id = element.id || element.getAttribute('id');
            const dataTestId = element.getAttribute('data-testid') || element.getAttribute('data-test');
            const ariaLabel = element.getAttribute('aria-label');
            const dataIcon = element.getAttribute('data-icon');
            const roleAttr = element.getAttribute('role');
            const classList = getClassList(element).filter(isMeaningfulClass);

            const viewBox = element.getAttribute('viewBox');
            const fillAttr = element.getAttribute('fill');
            const strokeAttr = element.getAttribute('stroke');
            const strokeWidthAttr = element.getAttribute('stroke-width');
            const transformAttr = element.getAttribute('transform');

            const svgId = targetSvg ? (targetSvg.id || targetSvg.getAttribute('id')) : '';
            const svgViewBox = targetSvg ? targetSvg.getAttribute('viewBox') : '';
            const svgClasses = targetSvg ? getClassList(targetSvg).filter(isMeaningfulClass) : [];

            const titleChild = hasTitleChild(element);
            const titleText = titleChild ? (titleChild.textContent || '').trim() : '';
            const hasHasSupport = supportsHas();

            // ===== Strategy 1: Direct unique attributes (highest confidence) =====
            if (id) {
                selectors.push({ type: 'SVG by ID', value: '#' + cssEsc(id), confidence: 100, level: 'simple' });
            }
            if (dataTestId) {
                selectors.push({ type: 'SVG by data-testid', value: tag + '[data-testid="' + dataTestId + '"]', confidence: 98, level: 'simple' });
            }
            if (ariaLabel) {
                selectors.push({ type: 'SVG by aria-label', value: tag + '[aria-label="' + ariaLabel + '"]', confidence: 94, level: 'simple' });
            }
            if (dataIcon) {
                selectors.push({ type: 'SVG by data-icon', value: tag + '[data-icon="' + dataIcon + '"]', confidence: 94, level: 'simple' });
            }
            if (roleAttr) {
                selectors.push({ type: 'SVG by role', value: tag + '[role="' + roleAttr + '"]', confidence: 82, level: 'simple' });
            }

            // ===== Strategy 2: :has(title) child element (CSS4 pattern) =====
            // Enterprise: leverage <title> tooltip elements via :has() selector
            if (hasHasSupport && titleText) {
                selectors.push({
                    type: 'SVG by :has(title)',
                    value: tag + ':has(> title)',
                    confidence: 85,
                    level: 'medium'
                });
                if (isSvgTag && svgClasses.length > 0) {
                    selectors.push({
                        type: 'SVG by class+title',
                        value: 'svg.' + cssEsc(svgClasses[0]) + ':has(title)',
                        confidence: 88,
                        level: 'medium'
                    });
                }
            }

            // ===== Strategy 3: With HTML ancestor context (icon SVG pattern) =====
            if (htmlAncestors.length > 0) {
                for (let depth = 1; depth <= Math.min(3, htmlAncestors.length); depth++) {
                    const ancestorPrefix = buildAncestorSelector(htmlAncestors, depth);
                    if (!ancestorPrefix) continue;

                    if (isSvgTag) {
                        selectors.push({
                            type: `SVG by ${depth}-ancestor + svg`,
                            value: ancestorPrefix + 'svg',
                            confidence: 88 - (depth - 1) * 5,
                            level: depth === 1 ? 'simple' : 'medium'
                        });

                        if (svgViewBox) {
                            selectors.push({
                                type: `SVG by ${depth}-ancestor + viewBox`,
                                value: ancestorPrefix + 'svg[viewBox="' + svgViewBox + '"]',
                                confidence: 92 - (depth - 1) * 3,
                                level: 'medium'
                            });
                        }
                        if (svgClasses.length > 0) {
                            selectors.push({
                                type: `SVG by ${depth}-ancestor + class`,
                                value: ancestorPrefix + 'svg.' + cssEsc(svgClasses[0]),
                                confidence: 90 - (depth - 1) * 3,
                                level: 'medium'
                            });
                        }
                    } else {
                        selectors.push({
                            type: `SVG Child by ${depth}-ancestor`,
                            value: ancestorPrefix + tag,
                            confidence: 85 - (depth - 1) * 5,
                            level: depth === 1 ? 'simple' : 'medium'
                        });

                        selectors.push({
                            type: `SVG Child by ${depth}-ancestor + svg + tag`,
                            value: ancestorPrefix + 'svg ' + tag,
                            confidence: 88 - (depth - 1) * 5,
                            level: 'medium'
                        });

                        if (svgViewBox) {
                            selectors.push({
                                type: `SVG Child by ${depth}-ancestor + viewBox + tag`,
                                value: ancestorPrefix + 'svg[viewBox="' + svgViewBox + '"] ' + tag,
                                confidence: 91 - (depth - 1) * 3,
                                level: 'medium'
                            });
                        }

                        if (svgClasses.length > 0) {
                            selectors.push({
                                type: `SVG Child by ${depth}-ancestor + svg-class + tag`,
                                value: ancestorPrefix + 'svg.' + cssEsc(svgClasses[0]) + ' ' + tag,
                                confidence: 90 - (depth - 1) * 3,
                                level: 'medium'
                            });
                        }

                        if (strokeAttr && strokeAttr !== 'currentColor' && strokeAttr !== 'none') {
                            selectors.push({
                                type: `SVG Child by ${depth}-ancestor + stroke`,
                                value: ancestorPrefix + tag + '[stroke="' + strokeAttr + '"]',
                                confidence: 80 - (depth - 1) * 3,
                                level: 'medium'
                            });
                        }
                        if (fillAttr && fillAttr !== 'currentColor' && fillAttr !== 'none') {
                            selectors.push({
                                type: `SVG Child by ${depth}-ancestor + fill`,
                                value: ancestorPrefix + tag + '[fill="' + fillAttr + '"]',
                                confidence: 75 - (depth - 1) * 3,
                                level: 'medium'
                            });
                        }
                        if (strokeAttr && fillAttr && strokeAttr !== 'currentColor' && fillAttr !== 'currentColor') {
                            selectors.push({
                                type: `SVG Child by ${depth}-ancestor + stroke + fill`,
                                value: ancestorPrefix + tag + '[stroke="' + strokeAttr + '"][fill="' + fillAttr + '"]',
                                confidence: 85 - (depth - 1) * 3,
                                level: 'medium'
                            });
                        }
                    }
                }

                const firstAnc = htmlAncestors[0];
                if (firstAnc) {
                    const firstAncClasses = getClassList(firstAnc).filter(isMeaningfulClass);
                    const nthIdx = getNthChildIndex(firstAnc);
                    if (nthIdx > 0 && firstAncClasses.length > 0) {
                        const ancSel = firstAnc.tagName.toLowerCase() + '.' + cssEsc(firstAncClasses[0]) + ':nth-child(' + nthIdx + ')';
                        selectors.push({
                            type: 'SVG by ancestor:nth-child',
                            value: ancSel + ' ' + (isSvgTag ? 'svg' : tag),
                            confidence: 86,
                            level: 'advanced'
                        });
                    }
                }
            }

            // ===== Strategy 4: Transform attribute (fixed layout pattern) =====
            if (transformAttr && transformAttr.length > 5) {
                const transformShort = transformAttr.slice(0, 25);
                selectors.push({
                    type: 'SVG by transform*=',
                    value: tag + '[transform*="' + transformShort + '"]',
                    confidence: 65,
                    level: 'advanced'
                });
            }

            // ===== Strategy 5: SVG internal attributes =====
            if (isSvgTag) {
                if (viewBox) {
                    selectors.push({ type: 'SVG by ViewBox', value: 'svg[viewBox="' + viewBox + '"]', confidence: 80, level: 'simple' });
                }
                if (classList.length > 0) {
                    selectors.push({ type: 'SVG by Class', value: 'svg.' + cssEsc(classList[0]), confidence: 75, level: 'medium' });
                    if (classList.length >= 2) {
                        selectors.push({ type: 'SVG by Multi-Class', value: 'svg.' + cssEsc(classList[0]) + '.' + cssEsc(classList[1]), confidence: 85, level: 'medium' });
                    }
                }
                const svgPosIdx = getNthChildIndex(element);
                if (svgPosIdx > 0) {
                    selectors.push({ type: 'SVG by nth-of-type', value: 'svg:nth-of-type(' + svgPosIdx + ')', confidence: 45, level: 'advanced' });
                }
            } else {
                if (classList.length > 0) {
                    classList.forEach(cls => {
                        selectors.push({ type: 'SVG Child by Class', value: 'svg ' + tag + '.' + cssEsc(cls), confidence: 72, level: 'medium' });
                    });
                    if (classList.length >= 2) {
                        selectors.push({
                            type: 'SVG Child by Multi-Class',
                            value: 'svg ' + tag + '.' + cssEsc(classList[0]) + '.' + cssEsc(classList[1]),
                            confidence: 82,
                            level: 'medium'
                        });
                    }
                }

                if (strokeAttr && strokeAttr !== 'currentColor' && strokeAttr !== 'none') {
                    selectors.push({ type: 'SVG Child by Stroke', value: 'svg ' + tag + '[stroke="' + strokeAttr + '"]', confidence: 55, level: 'medium' });
                }
                if (fillAttr && fillAttr !== 'currentColor' && fillAttr !== 'none') {
                    selectors.push({ type: 'SVG Child by Fill', value: 'svg ' + tag + '[fill="' + fillAttr + '"]', confidence: 48, level: 'medium' });
                }
                if (strokeAttr && fillAttr && strokeAttr !== 'currentColor' && fillAttr !== 'currentColor') {
                    selectors.push({
                        type: 'SVG Child by Stroke+Fill',
                        value: 'svg ' + tag + '[stroke="' + strokeAttr + '"][fill="' + fillAttr + '"]',
                        confidence: 72,
                        level: 'medium'
                    });
                }

                if (tag === 'circle') {
                    const cx = element.getAttribute('cx'), cy = element.getAttribute('cy'), r = element.getAttribute('r');
                    if (cx && cy && r) {
                        selectors.push({
                            type: 'SVG Circle by cx+cy+r',
                            value: 'svg circle[cx="' + cx + '"][cy="' + cy + '"][r="' + r + '"]',
                            confidence: 78,
                            level: 'medium'
                        });
                    }
                }

                if ((tag === 'rect' || tag === 'image')) {
                    const x = element.getAttribute('x'), y = element.getAttribute('y');
                    const w = element.getAttribute('width'), h = element.getAttribute('height');
                    if (x && y && w && h) {
                        selectors.push({
                            type: 'SVG ' + tag + ' by position+size',
                            value: 'svg ' + tag + '[x="' + x + '"][y="' + y + '"][width="' + w + '"][height="' + h + '"]',
                            confidence: 78,
                            level: 'medium'
                        });
                    }
                }

                if (svgViewBox) {
                    selectors.push({
                        type: 'SVG Child by Parent ViewBox',
                        value: 'svg[viewBox="' + svgViewBox + '"] ' + tag,
                        confidence: 70,
                        level: 'simple'
                    });
                }
                if (svgId) {
                    selectors.push({
                        type: 'SVG Child by Parent SVG ID',
                        value: 'svg#' + cssEsc(svgId) + ' ' + tag,
                        confidence: 88,
                        level: 'simple'
                    });
                }

                const childPosIdx = getNthChildIndex(element);
                if (childPosIdx > 0) {
                    if (svgViewBox) {
                        selectors.push({
                            type: 'SVG Child by ViewBox+nth',
                            value: 'svg[viewBox="' + svgViewBox + '"] ' + tag + ':nth-of-type(' + childPosIdx + ')',
                            confidence: 80,
                            level: 'advanced'
                        });
                    }
                    selectors.push({
                        type: 'SVG Child by nth-of-type',
                        value: 'svg ' + tag + ':nth-of-type(' + childPosIdx + ')',
                        confidence: 42,
                        level: 'advanced'
                    });
                }
            }

            // ===== Strategy 6: Context-aware fallback (never just "svg") =====
            {
                let ctxPrefix = '';
                let ctxFound = false;
                let ctxAnc = element.parentElement;
                let ctxD = 0;
                while (ctxAnc && ctxAnc !== document.body && ctxD < 6 && !ctxFound) {
                    if (ctxAnc.id) {
                        ctxPrefix = '#' + cssEsc(ctxAnc.id) + ' ';
                        ctxFound = true;
                    } else {
                        var ctxCls = getClassList(ctxAnc).filter(isMeaningfulClass);
                        if (ctxCls.length > 0) {
                            ctxPrefix = ctxAnc.tagName.toLowerCase() + '.' + cssEsc(ctxCls[0]) + ' ';
                            ctxFound = true;
                        }
                    }
                    ctxAnc = ctxAnc.parentElement;
                    ctxD++;
                }

                if (ctxFound) {
                    if (isSvgTag) {
                        selectors.push({ type: 'SVG by context [Fallback]', value: ctxPrefix + 'svg', confidence: 50, level: 'advanced' });
                        if (svgViewBox) {
                            selectors.push({ type: 'SVG by context+viewBox [Fallback]', value: ctxPrefix + 'svg[viewBox="' + svgViewBox + '"]', confidence: 65, level: 'advanced' });
                        }
                        if (svgClasses.length > 0) {
                            selectors.push({ type: 'SVG by context+class [Fallback]', value: ctxPrefix + 'svg.' + cssEsc(svgClasses[0]), confidence: 60, level: 'advanced' });
                        }
                    } else {
                        selectors.push({ type: 'SVG Child by context [Fallback]', value: ctxPrefix + 'svg ' + tag, confidence: 50, level: 'advanced' });
                        if (svgViewBox) {
                            selectors.push({ type: 'SVG Child by context+viewBox [Fallback]', value: ctxPrefix + 'svg[viewBox="' + svgViewBox + '"] ' + tag, confidence: 65, level: 'advanced' });
                        }
                    }
                } else {
                    // Last resort: only if no context ancestor found at all
                    if (isSvgTag) {
                        selectors.push({ type: 'SVG Element [Basic]', value: 'svg', confidence: 15, level: 'advanced' });
                    } else {
                        selectors.push({ type: 'SVG Child [Basic]', value: 'svg ' + tag, confidence: 20, level: 'advanced' });
                    }
                }
            }

            return selectors;
        }

        generateXPathLocators(element) {
            const xpaths = [];
            const tagName = element.tagName.toLowerCase();
            if (this.isSVGElement(element)) {
                return xpaths;
            }
            if (element.id) {
                xpaths.push({ 
                    type: 'ID-Based [Unique]', 
                    value: `//${tagName}[@id="${element.id}"]`, 
                    confidence: 95, 
                    level: 'simple'
                });
            }
            for (const attr of this.uniqueAttributes) {
                const value = element.getAttribute(attr);
                if (value) {
                    let confidence = 85;
                    if (attr === 'data-testid') confidence = 95;
                    else if (attr === 'src' || attr === 'alt') confidence = 90;
                    else if (attr === 'name') confidence = 90;
                    xpaths.push({ 
                        type: `${attr.replace('-', ' ').toUpperCase()} [Attribute]`, 
                        value: `//${tagName}[@${attr}="${value}"]`, 
                        confidence: confidence, 
                        level: 'simple'
                    });
                }
            }
            const text = element.textContent?.trim();
            if (text && text.length > 0 && text.length <= 50) {
                xpaths.push({ 
                    type: 'Exact Text Match [Text]', 
                    value: `//${tagName}[normalize-space(text())="${text}"]`, 
                    confidence: 75, 
                    level: 'medium'
                });
            }
            return xpaths;
        }

        generateCSSLocators(element) {
            const selectors = [];
            const tagName = element.tagName.toLowerCase();
            if (this.isSVGElement(element)) {
                return selectors;
            }
            if (element.id) {
                selectors.push({ 
                    type: 'ID-Based [Unique]', 
                    value: `#${element.id}`, 
                    confidence: 95, 
                    level: 'simple'
                });
            }
            for (const attr of this.uniqueAttributes) {
                const value = element.getAttribute(attr);
                if (value) {
                    let confidence = 85;
                    if (attr === 'data-testid') confidence = 95;
                    else if (attr === 'src' || attr === 'alt') confidence = 90;
                    else if (attr === 'name') confidence = 90;
                    selectors.push({ 
                        type: `${attr.replace('-', ' ').toUpperCase()} [Attribute]`, 
                        value: `${tagName}[${attr}="${value}"]`, 
                        confidence: confidence, 
                        level: 'simple'
                    });
                }
            }
            if (element.classList.length > 0) {
                const classList = Array.from(element.classList);
                classList.forEach(cls => {
                    if (cls && cls.length > 2) {
                        selectors.push({ 
                            type: 'Single Class [Class]', 
                            value: `.${cls}`, 
                            confidence: 70, 
                            level: 'medium'
                        });
                    }
                });
                if (classList.length >= 2) {
                    selectors.push({ 
                        type: 'Combined Classes [Class]', 
                        value: `.${classList[0]}.${classList[1]}`, 
                        confidence: 80, 
                        level: 'medium'
                    });
                }
            }
            return selectors;
        }

        enhanceLocatorsForUniqueness(element, allLocators) {
            const enhancedLocators = [];
            const nonUniqueLocators = allLocators.filter(locator => {
                const validation = validateUniqueLocator(locator.value, element);
                return !validation.isValid && validation.matchCount > 1;
            });

            // Helper: find nearest ancestor with id or meaningful class
            function findContextAncestor(el, maxDepth) {
                var cur = el.parentElement;
                var depth = 0;
                while (cur && cur !== document.body && depth < maxDepth) {
                    if (cur.id) return { el: cur, type: 'id', value: cur.id };
                    var cls = cur.getAttribute('class');
                    if (cls) {
                        var classes = cls.trim().split(/\s+/).filter(function(c) {
                            return c.length >= 3 && !/^\d/.test(c) && !/^(hover|active|focus|selected|disabled|open|closed|show|hide|visible|hidden)$/i.test(c);
                        });
                        if (classes.length > 0) return { el: cur, type: 'class', value: classes[0] };
                    }
                    cur = cur.parentElement;
                    depth++;
                }
                return null;
            }

            nonUniqueLocators.forEach(locator => {
                var ctx = findContextAncestor(element, 6);
                if (!ctx) return;

                var value = locator.value;
                if (value.startsWith('//')) {
                    // XPath locator
                    if (ctx.type === 'id') {
                        enhancedLocators.push({
                            ...locator,
                            type: locator.type + ' + Ancestor ID [Enhanced]',
                            value: '//*[@id="' + ctx.value + '"]' + value.substring(1),
                            confidence: Math.min(95, locator.confidence + 5)
                        });
                    } else {
                        var ancTag = ctx.el.tagName.toLowerCase();
                        enhancedLocators.push({
                            ...locator,
                            type: locator.type + ' + Ancestor Class [Enhanced]',
                            value: '//' + ancTag + '[contains(@class,"' + ctx.value + '")]' + value.substring(1),
                            confidence: Math.min(95, locator.confidence + 3)
                        });
                    }
                } else {
                    // CSS locator
                    if (ctx.type === 'id') {
                        enhancedLocators.push({
                            ...locator,
                            type: locator.type + ' + Ancestor ID [Enhanced]',
                            value: '#' + ctx.value + ' ' + value,
                            confidence: Math.min(95, locator.confidence + 5)
                        });
                    } else {
                        var ancTag2 = ctx.el.tagName.toLowerCase();
                        try { ancTag2 = CSS.escape(ancTag2); } catch(e) {}
                        var escCls = ctx.value;
                        try { escCls = CSS.escape(escCls); } catch(e) {}
                        enhancedLocators.push({
                            ...locator,
                            type: locator.type + ' + Ancestor Class [Enhanced]',
                            value: ancTag2 + '.' + escCls + ' ' + value,
                            confidence: Math.min(95, locator.confidence + 3)
                        });
                    }
                }
            });

            return enhancedLocators.filter(enhanced => {
                const validation = validateUniqueLocator(enhanced.value, element);
                enhanced.isUnique = validation.isUnique;
                enhanced.isCorrect = validation.isCorrect;
                enhanced.matchCount = validation.matchCount;
                enhanced.isValid = validation.isValid;
                return validation.isValid;
            });
        }

        prioritizeLocators(locators, element) {
            return locators.map(locator => {
                const reliability = this.calculateReliability(locator, element);
                const performance = this.calculatePerformance(locator);
                const readability = this.calculateReadability(locator);
                const priorityScore = (reliability * 0.5) + (performance * 0.3) + (readability * 0.2);
                return {
                    ...locator,
                    reliability,
                    performance,
                    readability,
                    priorityScore,
                    priorityLevel: this.getPriorityLevel(priorityScore)
                };
            }).sort((a, b) => b.priorityScore - a.priorityScore);
        }

        calculateReliability(locator, element) {
            let score = 50;
            const value = locator.value.toLowerCase();
            const elementType = this.detectElementType(element);

            if (elementType === 'ecommerce-button') {
                if (value.includes('data-testid')) score = 95;
                else if (value.includes('aria-label')) score = 90;
                else if (value.includes('fav') || value.includes('heart') || value.includes('cart')) score = 85;
            } else if (elementType === 'svg') {
                if (value.includes('data-testid')) score = 95;
                else if (value.includes('aria-label')) score = 90;
                else if (value.includes('#') || value.includes('@id=')) score = 90;
                else if (value.includes('local-name()')) score = 88;
                else if (value.includes('title') && (value.includes(':has') || value.includes('.//'))) score = 86;
                else if (value.includes('ancestor::') || value.includes('text()')) score = 85;
                else if (value.includes('[viewBox') || value.includes('@viewBox')) score = 80;
                else if (value.includes('svg') && value.includes('.')) score = 75;
                else if (value.includes('transform')) score = 68;
                else if (value.includes('parent') && value.includes('id')) score = 85;
            } else if (elementType === 'checkbox') {
                if (value.includes('name=') || value.includes('@name=')) score = 95;
                else if (value.includes('id=') || value.includes('@id=')) score = 95;
                else if (value.includes('value=') || value.includes('@value=')) score = 85;
            } else if (elementType === 'icon') {
                if (value.includes('data-testid') || value.includes('data-icon')) score = 95;
                else if (value.includes('aria-label')) score = 90;
                else if (value.includes('parent') && (value.includes('id') || value.includes('testid'))) score = 90;
                else if (value.includes('fa-') || value.includes('icon')) score = 85;
            } else if (elementType === 'button') {
                if (value.includes('data-testid')) score = 95;
                else if (value.includes('#') || value.includes('@id=')) score = 95;
                else if (value.includes('aria-label')) score = 90;
                else if (value.includes('name=') || value.includes('@name=')) score = 90;
                else if (value.includes('text()')) score = 85;
            } else {
                if (value.includes('#') || value.includes('@id=')) score = 95;
                else if (value.includes('[data-testid') || value.includes('@data-testid')) score = 95;
                else if (value.includes('[name=') || value.includes('@name=')) score = 85;
            }
            
            // Apply penalty for XPath axis usage
            if (this.isAdvancedXPathAxis(value)) {
                score = Math.max(40, score - 25);
            }
            
            return Math.max(0, Math.min(100, score));
        }

        calculatePerformance(locator) {
            const value = locator.value.toLowerCase();
            if (value.startsWith('#')) return 95;
            if (value.includes('[data-testid')) return 90;
            if (value.includes('[') && !value.includes('//')) return 75;
            if (value.startsWith('//') && !value.includes('text()')) return 60;
            
            // Low performance for XPath axes
            if (this.isAdvancedXPathAxis(value)) return 40;
            
            return 50;
        }

        calculateReadability(locator) {
            const value = locator.value;
            let score = 70;
            if (value.length < 20) score += 20;
            else if (value.length > 80) score -= 20;
            if (value.startsWith('#') || value.startsWith('.')) score += 15;
            
            // Lower readability for advanced XPath
            if (this.isAdvancedXPathAxis(value)) score -= 10;
            
            return Math.max(0, Math.min(100, score));
        }

        getPriorityLevel(score) {
            if (score >= 85) return 'high';
            if (score >= 70) return 'medium';
            if (score >= 50) return 'low';
            return 'risky';
        }

        // Groups locators by category and level, preventing duplicates.
        //  to use element type
        groupLocatorsByCategory(locators, elementType) {
            const grouped = {
                xpath: { simple: [], medium: [], advanced: [] },
                css: { simple: [], medium: [], advanced: [] }
            };
            
            // Element type specific thresholds
            let thresholds = {
                simple: 80,
                medium: 60
            };
            
            // Adjust thresholds based on element type
            if (elementType === 'button' || elementType === 'link') {
                thresholds.simple = 82; // Higher standard for buttons and links
            } else if (elementType === 'input' || elementType === 'checkbox') {
                thresholds.simple = 78; // Lower standard for form elements
            } else if (elementType === 'svg' || elementType === 'icon') {
                thresholds.medium = 65; // Higher medium threshold for SVG and icons
            } else if (elementType === 'table' || elementType === 'list') {
                thresholds.simple = 82; // Higher standard for structured elements
            }
            
            const usedValues = new Set();
            
            // Process locators in two passes - first handle all non-XPath-axis locators
            locators.forEach(locator => {
                if (usedValues.has(locator.value)) {
                    return;
                }
                
                // Skip XPath axis locators in the first pass
                if (this.isAdvancedXPathAxis(locator.value)) {
                    return;
                }
                
                usedValues.add(locator.value);
                const isXPath = locator.value.includes('//') || locator.value.includes('/');
                const category = isXPath ? 'xpath' : 'css';
                
                let level = 'advanced';
                if (locator.priorityScore >= thresholds.simple) level = 'simple';
                else if (locator.priorityScore >= thresholds.medium) level = 'medium';
                
                grouped[category][level].push(locator);
            });
            
            // Second pass - handle XPath axis locators, always put them in advanced
            locators.forEach(locator => {
                if (usedValues.has(locator.value)) {
                    return;
                }
                
                // Only process XPath axis locators now
                if (!this.isAdvancedXPathAxis(locator.value)) {
                    return;
                }
                
                usedValues.add(locator.value);
                const category = 'xpath'; // These are always XPath
                const level = 'advanced'; // XPath axes are always advanced
                
                grouped[category][level].push(locator);
            });

            // Element type specific max values for each category
            const maxLocators = {
                simple: elementType === 'button' || elementType === 'input' ? 5 : 4,
                medium: 4,
                advanced: elementType === 'table' || elementType === 'svg' ? 4 : 3
            };
            
            // Limit results per category to avoid overcrowding
            ['xpath', 'css'].forEach(type => {
                ['simple', 'medium', 'advanced'].forEach(level => {
                    if (grouped[type][level].length > maxLocators[level]) {
                        grouped[type][level] = grouped[type][level].slice(0, maxLocators[level]);
                    }
                });
            });
            
            return grouped;
        }
        generateButtonLocators(element) {
            const locators = [];
            const tagName = element.tagName.toLowerCase();
            const id = element.id;
            const text = (element.textContent || '').trim().slice(0, 40);
            const ariaLabel = element.getAttribute('aria-label');
            const dataTestId = element.getAttribute('data-testid');
            if (dataTestId) locators.push({ type: 'Button by TestID', value: `[data-testid="${dataTestId}"]`, confidence: 95, level: 'simple' });
            if (id) locators.push({ type: 'Button by ID', value: `#${id}`, confidence: 95, level: 'simple' });
            if (id) locators.push({ type: 'Button by ID XPath', value: `//${tagName}[@id="${id}"]`, confidence: 95, level: 'simple' });
            if (ariaLabel) {
                locators.push({ type: 'Button by Aria-Label', value: `[aria-label="${ariaLabel}"]`, confidence: 90, level: 'simple' });
                locators.push({ type: 'Button by Aria-Label XPath', value: `//*[@aria-label="${ariaLabel}"]`, confidence: 90, level: 'simple' });
            }
            if (tagName !== 'button') locators.push({ type: 'Button Role XPath', value: `//*[@role="button" and normalize-space(.)="${text}"]`, confidence: 85, level: 'medium' });
            else if (text) locators.push({ type: 'Button Text XPath', value: `//${tagName}[normalize-space(text())="${text}"]`, confidence: 80, level: 'medium' });
            return locators;
        }

        generateImageLocators(element) {
            const locators = [];
            const id = element.id;
            const alt = element.getAttribute('alt');
            const src = element.getAttribute('src');
            const width = element.getAttribute('width');
            const height = element.getAttribute('height');
            const dataTestId = element.getAttribute('data-testid');
            const tagName = element.tagName.toLowerCase();
            if (dataTestId) locators.push({ type: 'Image by TestID', value: `[data-testid="${dataTestId}"]`, confidence: 95, level: 'simple' });
            if (id) locators.push({ type: 'Image by ID', value: `#${id}`, confidence: 95, level: 'simple' });
            if (id) locators.push({ type: 'Image by ID XPath', value: `//${tagName}[@id="${id}"]`, confidence: 95, level: 'simple' });
            if (alt) {
                locators.push({ type: 'Image by Alt CSS', value: `img[alt="${alt}"]`, confidence: 90, level: 'simple' });
                locators.push({ type: 'Image by Alt XPath', value: `//img[@alt="${alt}"]`, confidence: 90, level: 'simple' });
            }
            if (src) {
                const shortSrc = src.split('/').pop();
                locators.push({ type: 'Image by Src Partial', value: `img[src*="${shortSrc}"]`, confidence: 80, level: 'medium' });
            }
            if (width && height) locators.push({ type: 'Image by Size', value: `img[width="${width}"][height="${height}"]`, confidence: 65, level: 'medium' });
            return locators;
        }

        generateCheckboxLocators(element) {
            const locators = [];
            const id = element.id;
            const name = element.getAttribute('name');
            const type = element.getAttribute('type');
            const tagName = element.tagName.toLowerCase();
            if (id) locators.push({ type: 'Checkbox by ID', value: `#${id}`, confidence: 95, level: 'simple' });
            if (id) locators.push({ type: 'Checkbox by ID XPath', value: `//${tagName}[@id="${id}"]`, confidence: 95, level: 'simple' });
            if (name) locators.push({ type: 'Checkbox by Name', value: `[name="${name}"]`, confidence: 90, level: 'simple' });
            if (type === 'checkbox') {
                locators.push({ type: 'Checkbox Type', value: `input[type="checkbox"]${name ? `[name="${name}"]` : ''}`, confidence: name ? 90 : 60, level: name ? 'simple' : 'medium' });
            }
            locators.push({ type: 'Checkbox Role', value: `//*[@role="checkbox"${id ? ` and @id="${id}"` : ''}]`, confidence: id ? 90 : 60, level: id ? 'simple' : 'medium' });
            return locators;
        }

        generateSpanLocators(element) {
            const locators = [];
            const id = element.id;
            const text = (element.textContent || '').trim().slice(0, 40);
            const ariaLabel = element.getAttribute('aria-label');
            const className = element.getAttribute('class') || '';
            if (id) locators.push({ type: 'Span by ID', value: `#${id}`, confidence: 95, level: 'simple' });
            if (id) locators.push({ type: 'Span by ID XPath', value: `//span[@id="${id}"]`, confidence: 95, level: 'simple' });
            if (ariaLabel) {
                locators.push({ type: 'Span Aria-Label', value: `span[aria-label="${ariaLabel}"]`, confidence: 90, level: 'simple' });
                locators.push({ type: 'Span Aria-Label XPath', value: `//span[@aria-label="${ariaLabel}"]`, confidence: 90, level: 'simple' });
            }
            if (className && typeof className === 'string' && className.split(' ').length <= 2) {
                locators.push({ type: 'Span by Class', value: `span.${className.split(' ')[0]}`, confidence: 70, level: 'medium' });
            }
            if (text) locators.push({ type: 'Span Text XPath', value: `//span[normalize-space(text())="${text}"]`, confidence: 75, level: 'medium' });
            return locators;
        }

        generateIconLocators(element) {
            const locators = [];
            const id = element.id;
            const ariaLabel = element.getAttribute('aria-label');
            const svgInside = element.querySelector('svg');
            if (id) locators.push({ type: 'Icon by ID', value: `#${id}`, confidence: 95, level: 'simple' });
            if (ariaLabel) {
                locators.push({ type: 'Icon by Aria-Label', value: `[aria-label="${ariaLabel}"]`, confidence: 90, level: 'simple' });
                locators.push({ type: 'Icon by Aria-Label XPath', value: `//*[@aria-label="${ariaLabel}"]`, confidence: 90, level: 'simple' });
            }
            if (svgInside) locators.push({ type: 'Icon Contains SVG', value: `//*[svg]${id ? `[@id="${id}"]` : ''}`, confidence: id ? 90 : 70, level: id ? 'simple' : 'medium' });
            return locators;
        }

        generateLinkLocators(element) {
            const locators = [];
            const id = element.id;
            const href = element.getAttribute('href');
            const text = (element.textContent || '').trim().slice(0, 40);
            const ariaLabel = element.getAttribute('aria-label');
            if (id) locators.push({ type: 'Link by ID', value: `#${id}`, confidence: 95, level: 'simple' });
            if (id) locators.push({ type: 'Link by ID XPath', value: `//a[@id="${id}"]`, confidence: 95, level: 'simple' });
            if (href) {
                locators.push({ type: 'Link by Href Exact', value: `a[href="${href}"]`, confidence: 90, level: 'simple' });
                const clean = href.split('?')[0].split('/').filter(Boolean).pop();
                if (clean) locators.push({ type: 'Link by Href Partial', value: `a[href*="${clean}"]`, confidence: 80, level: 'medium' });
            }
            if (ariaLabel) {
                locators.push({ type: 'Link by Aria-Label', value: `a[aria-label="${ariaLabel}"]`, confidence: 90, level: 'simple' });
            }
            if (text) locators.push({ type: 'Link Text XPath', value: `//a[normalize-space(text())="${text}"]`, confidence: 75, level: 'medium' });
            return locators;
        }

        generateInputLocators(element) {
            const locators = [];
            const id = element.id;
            const name = element.getAttribute('name');
            const type = element.getAttribute('type');
            const placeholder = element.getAttribute('placeholder');
            const tagName = element.tagName.toLowerCase();
            if (id) locators.push({ type: 'Input by ID', value: `#${id}`, confidence: 95, level: 'simple' });
            if (id) locators.push({ type: 'Input by ID XPath', value: `//${tagName}[@id="${id}"]`, confidence: 95, level: 'simple' });
            if (name) locators.push({ type: 'Input by Name', value: `${tagName}[name="${name}"]`, confidence: 90, level: 'simple' });
            if (type) locators.push({ type: 'Input by Type', value: `${tagName}[type="${type}"]${name ? `[name="${name}"]` : ''}`, confidence: name ? 90 : 65, level: name ? 'simple' : 'medium' });
            if (placeholder) {
                locators.push({ type: 'Input by Placeholder', value: `${tagName}[placeholder="${placeholder}"]`, confidence: 85, level: 'simple' });
                locators.push({ type: 'Input by Placeholder XPath', value: `//${tagName}[@placeholder="${placeholder}"]`, confidence: 85, level: 'medium' });
            }
            return locators;
        }

        generateAdvancedFallbackLocators(element) {
            const locators = [];
            const parent = element.parentElement;
            const tagName = element.tagName.toLowerCase();
            const nthOfType = getNthOfType(element);
            if (parent && parent.id) {
                locators.push({ type: 'Fallback Parent ID > Tag', value: `#${parent.id} > ${tagName}${nthOfType > 1 ? `:nth-of-type(${nthOfType})` : ''}`, confidence: 65, level: 'medium' });
                locators.push({ type: 'Fallback Descendant XPath', value: `//*[@id="${parent.id}"]//${tagName}${nthOfType > 1 ? `[${nthOfType}]` : ''}`, confidence: 60, level: 'advanced' });
            }
            const idx = getIndexAmongSiblings(element);
            if (idx >= 0) {
                locators.push({ type: 'Fallback Nth Child', value: `${tagName}:nth-child(${idx + 1})`, confidence: 45, level: 'advanced' });
            }
            return locators;
        }
    }

    function getNthOfType(el) {
        let n = 1;
        let cur = el;
        while ((cur = cur.previousElementSibling)) {
            if (cur.tagName === el.tagName) n++;
        }
        return n;
    }

    function getIndexAmongSiblings(el) {
        let n = 0;
        let cur = el;
        while ((cur = cur.previousElementSibling)) { n++; }
        return n;
    }

    function buildElementData(element) {
        if (!locatorGenerator) return null;
        var isSvg = locatorGenerator.isSVGElement(element);
        if (isSvg) {
            console.log('[SVG] buildElementData called for:', element.tagName, 'className:', element.getAttribute('class'));
        }
        const locators = locatorGenerator.generateUnifiedLocators(element);
        if (isSvg) {
            var locCount = 0;
            if (locators.xpath) ['simple','medium','advanced'].forEach(function(l){ if(locators.xpath[l]) locCount += locators.xpath[l].length; });
            if (locators.css) ['simple','medium','advanced'].forEach(function(l){ if(locators.css[l]) locCount += locators.css[l].length; });
            console.log('[SVG] generateUnifiedLocators returned, total locators:', locCount);
        }
        // Capture the element's HTML (truncated to avoid excessive size)
        let outerHTML = '';
        try {
            outerHTML = element.outerHTML || element.cloneNode(false).outerHTML || '';
            if (outerHTML.length > 500) {
                outerHTML = outerHTML.substring(0, 500) + '...';
            }
        } catch (e) {
            outerHTML = '<' + element.tagName.toLowerCase() + '>...</' + element.tagName.toLowerCase() + '>';
        }
        // Build ancestor chain (key for AI to distinguish similar elements)
        var ancestors = [];
        try {
            var parent = element.parentElement;
            while (parent && parent !== document.body && ancestors.length < 6) {
                var anc = { tag: parent.tagName.toLowerCase() };
                if (parent.id) anc.id = parent.id;
                if (parent.className && typeof parent.className === 'string') anc.cls = parent.className.trim().split(/\s+/).slice(0, 3).join(' ');
                else if (parent.className && typeof parent.className !== 'string') { try { anc.cls = String(parent.className); } catch(ec){} }
                // key attributes that distinguish containers
                ['role', 'aria-label', 'data-testid', 'name'].forEach(function(a){
                    var v = parent.getAttribute(a);
                    if (v) { anc[a] = v; }
                });
                ancestors.push(anc);
                parent = parent.parentElement;
            }
        } catch(e) {}

        // Sibling context: one element before and after (if they exist)
        var siblingContext = '';
        try {
            var prev = element.previousElementSibling;
            var next = element.nextElementSibling;
            if (prev) siblingContext += 'Prev: <' + prev.tagName.toLowerCase() + (prev.id ? '#"' + prev.id + '"' : '') + (prev.className ? '."' + String(prev.className).trim().split(/\s+/).slice(0,2).join(' ') + '"' : '') + (prev.textContent ? ' "' + prev.textContent.trim().slice(0,30) + '"' : '') + '>; ';
            if (next) siblingContext += 'Next: <' + next.tagName.toLowerCase() + (next.id ? '#"' + next.id + '"' : '') + (next.className ? '."' + String(next.className).trim().split(/\s+/).slice(0,2).join(' ') + '"' : '') + (next.textContent ? ' "' + next.textContent.trim().slice(0,30) + '"' : '') + '>';
        } catch(e) {}

        // Extract only key attributes (reduce noise)
        var keyAttrs = {};
        ['id', 'name', 'type', 'placeholder', 'aria-label', 'role', 'data-testid', 'data-cy', 'data-qa', 'data-test', 'href', 'src', 'alt', 'title', 'for', 'value'].forEach(function(a){
            var v = element.getAttribute(a);
            if (v) keyAttrs[a] = v;
        });

        // Try local locator generation (instant, no AI needed) — single unique locator, CSS priority
        var localHeuristic = null;
        try {
            if (typeof generatePlaywrightStyleLocators === 'function') {
                var pwResult = generatePlaywrightStyleLocators(element);
                if (pwResult && pwResult.locator) {
                    localHeuristic = { css: pwResult.type === 'css' ? pwResult.locator : null, xpath: pwResult.type === 'xpath' ? pwResult.locator : null, method: pwResult.method, type: pwResult.type };
                }
            }
            if (!localHeuristic && typeof generateLocalHeuristicLocators === 'function') {
                localHeuristic = generateLocalHeuristicLocators(element);
            }
        } catch(e) {}

        var elementData = {
            tag: element.tagName.toLowerCase(),
            id: element.id || '',
            className: element.getAttribute('class') || '',
            text: element.textContent?.trim().substring(0, 100) || '',
            attributes: Object.fromEntries(Array.from(element.attributes).map(attr => [attr.name, attr.value])),
            keyAttrs: keyAttrs,
            ancestors: ancestors,
            siblingContext: siblingContext,
            src: element.getAttribute('src') || '',
            alt: element.getAttribute('alt') || '',
            href: element.getAttribute('href') || '',
            outerHTML: outerHTML,
            locators,
            localHeuristic: localHeuristic,   // Single unique locally generated locator (CSS priority, no AI needed)
            timestamp: new Date().toLocaleString(),
            elementType: locatorGenerator.detectElementType(element),
            pageUrl: window.location.href,
            pageTitle: document.title
        };
        return elementData;
    }

    function previewElement(element) {
        if (!locatorGenerator) return;
        var elementData = buildElementData(element);
        if (!elementData) return;
        // Strip heavy fields for preview to keep it lightweight
        var previewData = {
            tag: elementData.tag,
            id: elementData.id,
            className: elementData.className,
            text: elementData.text,
            keyAttrs: elementData.keyAttrs,
            locators: elementData.locators,
            localHeuristic: elementData.localHeuristic,
            elementType: elementData.elementType,
            ancestors: elementData.ancestors
        };
        if (elementData.elementType === 'svg') {
            console.log('[SVG] previewElement sending PREVIEW_ELEMENT, className type:', typeof previewData.className);
        }
        sendToSidebar('PREVIEW_ELEMENT', previewData);
    }

    function selectElement(element) {
        if (!locatorGenerator) return;
        var elementData = buildElementData(element);
        if (!elementData) return;
        elementHistory.push(elementData);
        currentHistoryIndex = elementHistory.length - 1;

        if (elementData.elementType === 'svg') {
            console.log('[SVG] selectElement: sending ELEMENT_SELECTED, className type:', typeof elementData.className, 'value:', elementData.className);
        }

        console.log('[Debug] selectElement: elementData built, about to send ELEMENT_SELECTED', {
            tag: elementData.tag,
            hasLocators: !!elementData.locators,
            hasLocalHeuristic: !!elementData.localHeuristic,
            sidebarIframeExists: !!sidebarIframe,
            sidebarIframeSrc: sidebarIframe ? sidebarIframe.src : 'N/A'
        });

        // Send both full DOM snapshot and compact ARIA snapshot
        (function(){
            try {
                var sn = (typeof capturePageSnapshot === 'function') ? capturePageSnapshot() : null;
                var ariaSn = (typeof captureAriaSnapshot === 'function') ? captureAriaSnapshot() : null;
                sendToSidebar('PAGE_SNAPSHOT', { snapshot: sn, ariaSnapshot: ariaSn });
            } catch(e) {}
        })();
        sendToSidebar('ELEMENT_SELECTED', elementData);
        sendToSidebar('ELEMENT_HISTORY_UPDATED', { elements: elementHistory });
        console.log('[Debug] selectElement: ELEMENT_SELECTED sent');
        removeHighlight();

        // Enrich element with semantic DOM attributes (AXTree replacement for MV3)
        (function(){
            try {
                var axtree = {};
                var role = element.getAttribute('role') || element.getAttribute('aria-role') || '';
                if (role) axtree.role = role;
                var ariaLabel = element.getAttribute('aria-label') || '';
                if (ariaLabel) axtree.label = ariaLabel;
                var ariaDesc = element.getAttribute('aria-describedby') || '';
                if (ariaDesc) axtree.describedby = ariaDesc;
                var dataI18n = element.getAttribute('data-i18n-key') || element.getAttribute('data-i18n-id') || element.getAttribute('data-i18n') || '';
                if (dataI18n) axtree['data-i18n-key'] = dataI18n;
                var dataTestid = element.getAttribute('data-testid') || element.getAttribute('data-test') || element.getAttribute('data-cy') || element.getAttribute('data-qa') || '';
                if (dataTestid) axtree['data-testid'] = dataTestid;
                var accName = element.getAttribute('aria-label') || element.getAttribute('aria-labelledby') || '';
                if (accName && !axtree.label) axtree.label = accName;
                if (Object.keys(axtree).length) {
                    var lastEl = elementHistory[elementHistory.length - 1];
                    if (lastEl) {
                        lastEl.axtree = axtree;
                        sendToSidebar('ELEMENT_HISTORY_UPDATED', { elements: elementHistory });
                    }
                }
            } catch(e) {}
        })();
    }

    function selectElementGroup(element) {
        if (!locatorGenerator) return;

        var groupLocator = generateGroupLocator(element);

        var matchingElements = [];
        try {
            if (groupLocator.type === 'css') {
                var found = document.querySelectorAll(groupLocator.value);
                for (var i = 0; i < found.length; i++) {
                    if (!DOM_ISOLATION_CONFIG.shouldExclude(found[i])) {
                        matchingElements.push(found[i]);
                    }
                }
            } else {
                var xpResult = document.evaluate(groupLocator.value, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                for (var j = 0; j < xpResult.snapshotLength; j++) {
                    var xpEl = xpResult.snapshotItem(j);
                    if (xpEl && !DOM_ISOLATION_CONFIG.shouldExclude(xpEl)) {
                        matchingElements.push(xpEl);
                    }
                }
            }
        } catch (e) {
            matchingElements = [element];
        }

        var elementData = {
            tag: element.tagName.toLowerCase(),
            id: element.id || '',
            className: element.getAttribute('class') || '',
            text: '',
            locators: null,
            localHeuristic: {
                css: groupLocator.type === 'css' ? groupLocator.value : null,
                xpath: groupLocator.type === 'xpath' ? groupLocator.value : null,
                method: groupLocator.method + ' (group, ' + matchingElements.length + ' elements)',
                type: groupLocator.type
            },
            timestamp: new Date().toLocaleString(),
            isList: true,
            groupCount: matchingElements.length
        };

        elementHistory.push(elementData);
        currentHistoryIndex = elementHistory.length - 1;

        sendToSidebar('ELEMENT_SELECTED', elementData);
        sendToSidebar('ELEMENT_HISTORY_UPDATED', { elements: elementHistory });
        removeHighlight();
    }

    function generateGroupLocator(element) {
        var tag = element.tagName.toLowerCase();
        var isSvg = locatorGenerator && locatorGenerator.isSVGElement && locatorGenerator.isSVGElement(element);

        function escCss(s) { try { return CSS.escape(s); } catch(e) { return s.replace(/"/g,'\\"'); } }

        function qsaCount(sel) {
            try {
                var els = document.querySelectorAll(sel);
                var count = 0;
                for (var i = 0; i < els.length; i++) {
                    if (!DOM_ISOLATION_CONFIG.shouldExclude(els[i])) count++;
                }
                return count;
            } catch(e) { return 0; }
        }

        var best = { type: 'css', value: tag, method: 'tag', count: 0 };

        var cls = (typeof element.className === 'string') ? element.className.trim().split(/\s+/).filter(function(c){ return c.length > 0; }) : [];

        if (cls.length > 0) {
            var singleClassSel = tag + '.' + escCss(cls[0]);
            var c1 = qsaCount(singleClassSel);
            if (c1 >= 2 && c1 <= 100) {
                best = { type: 'css', value: singleClassSel, method: 'tag+class', count: c1 };
            }

            if (cls.length >= 2) {
                var multiClassSel = tag + '.' + cls.slice(0, 2).map(escCss).join('.');
                var c2 = qsaCount(multiClassSel);
                if (c2 >= 2 && c2 <= 100 && c2 < (best.count || 999)) {
                    best = { type: 'css', value: multiClassSel, method: 'tag+classes', count: c2 };
                }
            }
        }

        var stableAttrs = ['data-testid', 'data-cy', 'data-test', 'data-qa', 'role', 'type', 'name'];
        for (var a = 0; a < stableAttrs.length; a++) {
            var attr = stableAttrs[a];
            var val = element.getAttribute(attr);
            if (val) {
                var attrSel = tag + '[' + attr + '="' + escCss(val) + '"]';
                var ac = qsaCount(attrSel);
                if (ac >= 2 && ac <= 100 && ac < (best.count || 999)) {
                    best = { type: 'css', value: attrSel, method: attr, count: ac };
                }
            }
        }

        var parent = element.parentElement;
        if (parent) {
            var pId = parent.id;
            if (pId) {
                var parentScoped = '#' + escCss(pId) + ' > ' + tag;
                var pc = qsaCount(parentScoped);
                if (pc >= 2 && pc <= 100 && pc < (best.count || 999)) {
                    best = { type: 'css', value: parentScoped, method: 'parent>#id > tag', count: pc };
                }
            }

            var pTag = parent.tagName.toLowerCase();
            var pClass = (typeof parent.className === 'string') ? parent.className.trim().split(/\s+/).filter(function(c){ return c.length > 0 && !/^\d/.test(c); })[0] : null;
            if (pClass) {
                var parentClassScoped = pTag + '.' + escCss(pClass) + ' > ' + tag;
                var pclsc = qsaCount(parentClassScoped);
                if (pclsc >= 2 && pclsc <= 100 && pclsc < (best.count || 999)) {
                    best = { type: 'css', value: parentClassScoped, method: 'parent.class > tag', count: pclsc };
                }
            }
        }

        if (isSvg) {
            var svgParent = element.closest('svg');
            if (svgParent) {
                var viewBox = svgParent.getAttribute('viewBox');
                if (viewBox) {
                    var svgScoped = 'svg[viewBox="' + escCss(viewBox) + '"] ' + tag;
                    var svgC = qsaCount(svgScoped);
                    if (svgC >= 2 && svgC <= 100 && svgC < (best.count || 999)) {
                        best = { type: 'css', value: svgScoped, method: 'svg[viewBox] tag', count: svgC };
                    }
                }
            }
        }

        var tagCount = qsaCount(tag);
        if (tagCount >= 2 && tagCount <= 50 && best.count === 0) {
            best = { type: 'css', value: tag, method: 'tag (all)', count: tagCount };
        }

        if (best.count === 0 || best.count === 1) {
            best = { type: 'css', value: tag + '.' + (cls[0] || 'group'), method: 'suggested class group', count: 0 };
        }

        return best;
    }

    // Captures a compact DOM structure snapshot for AI context.
    // Traverses visible body elements and records tag, id, class, text for top 3 layers.
    function capturePageSnapshot() {
        try {
            var maxDepth = 3;
            var maxNodes = 200;
            var count = 0;
            var lines = [];
            lines.push('URL: ' + (window.location.href || ''));
            lines.push('Title: ' + (document.title || '').slice(0, 200));

            function walk(el, depth) {
                if (count >= maxNodes || depth > maxDepth) return;
                if (!el || !el.tagName) return;
                var tag = el.tagName.toLowerCase();
                if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'link' || tag === 'meta' || tag === 'br' || tag === 'hr') return;
                var indent = '  '.repeat(depth);
                var parts = [indent + '<' + tag];
                if (el.id) parts.push(' id="' + String(el.id).slice(0, 60) + '"');
                var cls = (typeof el.className === 'string') ? el.className.trim() : '';
                if (cls) parts.push(' class="' + cls.slice(0, 80) + '"');
                var txt = (el.childNodes && el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) ? el.textContent.trim().slice(0, 50) : '';
                if (txt) parts.push(' text="' + txt.replace(/\s+/g, ' ') + '"');
                parts.push('>');
                lines.push(parts.join(''));
                count++;
                if (el.children) {
                    for (var i = 0; i < el.children.length; i++) {
                        if (count >= maxNodes) break;
                        walk(el.children[i], depth + 1);
                    }
                }
            }
            try { walk(document.body, 0); } catch(e) {}
            lines.push('--- Total nodes captured: ' + count + ' ---');
            return lines.join('\n');
        } catch(e) { return null; }
    }

    // Captures a compact ARIA accessibility tree — much smaller than raw HTML but
    // contains all the semantic info AI needs (roles, labels, names, states).
    // This is the Playwright-recommended approach: structured, semantic, tiny.
    function captureAriaSnapshot() {
        try {
            var maxNodes = 100;
            var maxDepth = 4;
            var count = 0;
            var lines = [];
            lines.push('URL: ' + (window.location.href || ''));
            lines.push('Title: ' + (document.title || '').slice(0, 200));

            function computeRole(el) {
                // Heuristic role detection following ARIA practices
                var tag = el.tagName.toLowerCase();
                var explicitRole = el.getAttribute('role');
                if (explicitRole) return explicitRole;
                // Implicit roles per HTML spec
                var implicitRoles = {
                    'button': 'button', 'a': el.hasAttribute('href') ? 'link' : null,
                    'input': function() {
                        var t = el.getAttribute('type') || 'text';
                        if (t === 'checkbox') return 'checkbox';
                        if (t === 'radio') return 'radio';
                        if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
                        return 'textbox';
                    },
                    'select': 'combobox', 'textarea': 'textbox',
                    'img': 'img', 'nav': 'navigation', 'main': 'main',
                    'header': 'banner', 'footer': 'contentinfo',
                    'form': el.getAttribute('aria-label') || el.getAttribute('name') ? 'form' : null,
                    'table': 'table', 'li': 'listitem', 'ul': 'list', 'ol': 'list',
                    'h1': 'heading', 'h2': 'heading', 'h3': 'heading', 'h4': 'heading', 'h5': 'heading', 'h6': 'heading',
                    'dialog': 'dialog', 'article': 'article', 'aside': 'complementary',
                    'section': 'region', 'label': null, 'span': null, 'div': null, 'p': null, 'td': 'cell', 'tr': 'row',
                    'summary': 'button', 'details': 'group'
                };
                var implied = implicitRoles[tag];
                if (implied === undefined || implied === null) return null;
                if (typeof implied === 'function') return implied();
                return implied;
            }

            function getName(el) {
                // Accessible name computation (simplified)
                var ariaLabel = el.getAttribute('aria-label');
                if (ariaLabel) return ariaLabel.trim().slice(0, 60);
                var ariaLabelledBy = el.getAttribute('aria-labelledby');
                if (ariaLabelledBy) {
                    try {
                        var labelEl = document.getElementById(ariaLabelledBy.trim().split(/\s+/)[0]);
                        if (labelEl) return (labelEl.textContent || '').trim().slice(0, 60);
                    } catch(e) {}
                }
                // Check associated <label> element
                if (el.id) {
                    try {
                        var assocLabel = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
                        if (assocLabel) return (assocLabel.textContent || '').trim().slice(0, 60);
                    } catch(e) {}
                }
                // For links/buttons, use text content
                var tag = el.tagName.toLowerCase();
                if (tag === 'a' || tag === 'button' || tag === 'summary') {
                    var txt = (el.textContent || '').trim().slice(0, 40);
                    if (txt) return txt;
                }
                return '';
            }

            // Collect only semantic (role-bearing) elements
            var semanticTags = ['button', 'a', 'input', 'select', 'textarea', 'img', 'nav', 'main',
                'header', 'footer', 'form', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                'dialog', 'article', 'aside', 'section', 'summary', 'details', 'li', 'ul', 'ol'];

            function walkAria(el, depth) {
                if (count >= maxNodes || depth > maxDepth) return;
                if (!el || !el.tagName) return;
                var tag = el.tagName.toLowerCase();
                if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'link' || tag === 'meta' || tag === 'br' || tag === 'hr' || tag === 'svg' || tag === 'path') return;

                var role = computeRole(el);
                var name = getName(el);
                var hasId = !!el.id;

                // Only record elements that have semantic meaning
                if (role || hasId || (el.getAttribute && (el.getAttribute('data-testid') || el.getAttribute('data-cy') || el.getAttribute('data-test')))) {
                    var indent = '  '.repeat(depth);
                    var parts = [indent + '<' + tag];
                    if (el.id) parts.push(' #' + String(el.id).slice(0, 40));
                    if (role) parts.push(' role=' + role);
                    if (name) parts.push(' name="' + name + '"');
                    var tid = el.getAttribute && (el.getAttribute('data-testid') || el.getAttribute('data-cy'));
                    if (tid) parts.push(' testid=' + tid);
                    var cls = (typeof el.className === 'string') ? el.className.trim().split(/\s+/).slice(0, 2).join(' ') : '';
                    if (cls && !el.id) parts.push(' .' + cls.slice(0, 50));
                    parts.push('>');
                    lines.push(parts.join(''));
                    count++;
                }

                if (el.children) {
                    for (var i = 0; i < el.children.length; i++) {
                        if (count >= maxNodes) break;
                        walkAria(el.children[i], depth + 1);
                    }
                }
            }
            try { walkAria(document.body, 0); } catch(e) {}
            lines.push('--- Semantic nodes: ' + count + ' ---');
            return lines.join('\n');
        } catch(e) { return null; }
    }

    // ── Local locator generator ─────────────────────────────────────────────────────
    // Generates a SINGLE unique locator. CSS first, XPath fallback.
    // No absolute XPath, no scores, no random/auto-generated attribute usage.
    // Returns { locator: string, type: 'css'|'xpath', method: string } or null.
    function generatePlaywrightStyleLocators(element) {
        // Generates a SINGLE unique locator for the given element.
        // CSS is prioritized; XPath is used only when CSS can't produce a unique result.
        // No absolute XPath, no scores, no random/auto-generated attribute usage.
        try {
            var tag = element.tagName.toLowerCase();

            function esc(s) { try { return CSS.escape(s); } catch(e) { return s.replace(/"/g,'\\"'); } }
            function xpEsc(s) { return s.replace(/'/g, "&apos;").replace(/"/g, '&quot;'); }

            function qsaCount(sel) { try { return document.querySelectorAll(sel).length; } catch(e) { return 999; } }
            function verifyCss(sel) {
                try { var els = document.querySelectorAll(sel); return els.length === 1 && els[0].isSameNode(element); } catch(e) { return false; }
            }
            function verifyXp(xp) {
                try { var r = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); return r.singleNodeValue && r.singleNodeValue.isSameNode(element); } catch(e) { return false; }
            }
            function xpCount(xp) {
                try { return document.evaluate('count(' + xp + ')', document, null, XPathResult.NUMBER_TYPE, null).numberValue; } catch(e) { return 999; }
            }

            // Detect SVG element (including children of SVG)
            var isSvgElement = false;
            try {
                if (element.namespaceURI === 'http://www.w3.org/2000/svg') isSvgElement = true;
            } catch(e) {}
            if (!isSvgElement) {
                try {
                    var p = element.parentElement;
                    while (p && p.tagName) {
                        if (p.tagName.toLowerCase() === 'svg') { isSvgElement = true; break; }
                        p = p.parentElement;
                    }
                } catch(e) {}
            }

            // Helper: get class list safely (SVG elements have SVGAnimatedString for className)
            function getClassList(el) {
                try {
                    if (el.classList && typeof el.classList === 'object' && el.classList.length !== undefined) {
                        return Array.from(el.classList);
                    }
                } catch(e) {}
                try {
                    var cls = el.getAttribute('class');
                    if (cls && typeof cls === 'string') {
                        return cls.trim().split(/\s+/).filter(Boolean);
                    }
                } catch(e) {}
                return [];
            }

            // Find parent SVG element
            function getParentSvg(el) {
                try {
                    var cur = el;
                    while (cur && cur.tagName) {
                        if (cur.tagName.toLowerCase() === 'svg') return cur;
                        cur = cur.parentElement;
                    }
                } catch(e) {}
                return null;
            }

            // Get element position index among siblings with same tag
            function getSiblingIndex(el) {
                try {
                    var parent = el.parentElement;
                    if (!parent) return -1;
                    var siblings = parent.querySelectorAll(el.tagName.toLowerCase());
                    for (var i = 0; i < siblings.length; i++) {
                        if (siblings[i].isSameNode(el)) return i + 1;
                    }
                } catch(e) {}
                return -1;
            }

            // Try CSS selector: if unique and verified, return immediately.
            // If count > 1, try parent-scoping up to 6 levels.
            function tryCss(sel, method) {
                var c = qsaCount(sel);
                if (c === 1 && verifyCss(sel)) return { locator: sel, type: 'css', method: method };
                if (c > 1) return scopeCss(sel, method);
                return null;
            }

            function scopeCss(sel, method) {
                var p = element.parentElement, d = 0;
                while (p && p !== document.body && d < 6) {
                    if (p.id) {
                        var scoped = '#' + esc(p.id) + ' > ' + sel;
                        if (qsaCount(scoped) === 1 && verifyCss(scoped)) return { locator: scoped, type: 'css', method: method + ' (#' + p.id + ' >)' };
                        scoped = '#' + esc(p.id) + ' ' + sel;
                        if (qsaCount(scoped) === 1 && verifyCss(scoped)) return { locator: scoped, type: 'css', method: method + ' (#' + p.id + ')' };
                    }
                    var pcls = getClassList(p).filter(function(c){ return c.length>0 && !/^\d/.test(c); });
                    if (pcls.length === 1 && !/^(hover|active|focus|selected|disabled|open|closed|show|hide|visible|hidden)$/i.test(pcls[0])) {
                        var sc2 = p.tagName.toLowerCase() + '.' + esc(pcls[0]) + ' > ' + sel;
                        if (qsaCount(sc2) === 1 && verifyCss(sc2)) return { locator: sc2, type: 'css', method: method + ' (.' + pcls[0] + ' >)' };
                        sc2 = p.tagName.toLowerCase() + '.' + esc(pcls[0]) + ' ' + sel;
                        if (qsaCount(sc2) === 1 && verifyCss(sc2)) return { locator: sc2, type: 'css', method: method + ' (.' + pcls[0] + ')' };
                    }
                    p = p.parentElement;
                    d++;
                }
                return null;
            }

            // Try XPath selector. If count > 1, try parent-scoping then position index.
            // No absolute paths.
            function tryXp(xp, method) {
                var c = xpCount(xp);
                if (c === 1 && verifyXp(xp)) return { locator: xp, type: 'xpath', method: method };
                if (c > 1) {
                    // Try parent-scoping
                    var p = element.parentElement, d = 0;
                    while (p && p !== document.body && d < 6) {
                        if (p.id) {
                            var scoped = '//*[@id="' + xpEsc(p.id) + '"]' + xp.substring(1);
                            if (xpCount(scoped) === 1 && verifyXp(scoped)) return { locator: scoped, type: 'xpath', method: method + ' (#' + p.id + ')' };
                        }
                        var pcls = getClassList(p).filter(function(c){ return c.length>0 && !/^\d/.test(c); });
                        if (pcls.length === 1 && !/^(hover|active|focus|selected|disabled|open|closed|show|hide|visible|hidden)$/i.test(pcls[0])) {
                            var sc2 = '//' + p.tagName.toLowerCase() + '[contains(@class,"' + xpEsc(pcls[0]) + '")]' + xp.substring(1);
                            if (xpCount(sc2) === 1 && verifyXp(sc2)) return { locator: sc2, type: 'xpath', method: method + ' (.' + pcls[0] + ')' };
                        }
                        p = p.parentElement;
                        d++;
                    }
                    // Position index
                    try {
                        var snap = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                        for (var i = 0; i < snap.snapshotLength; i++) {
                            if (snap.snapshotItem(i).isSameNode(element)) {
                                var indexed = '(' + xp + ')[' + (i + 1) + ']';
                                if (verifyXp(indexed)) return { locator: indexed, type: 'xpath', method: method + '[' + (i + 1) + ']' };
                            }
                        }
                    } catch(e) {}
                }
                return null;
            }

            // Detect auto-generated suffix patterns in IDs and extract the stable part.
            // Returns { stable: string, type: 'prefix'|'suffix'|'contains'|'exact'|null }
            // type indicates which CSS partial-match operator to use.
            function extractStableIdPart(id) {
                if (!id) return null;
                var len = id.length;

                // Too long = likely random hash, reject
                if (len > 60) return null;

                // Patterns known to be auto-generated suffix (e.g. input-12345, field-abc1)
                // Try stripping common numeric/UUID-like suffixes to find stable prefix
                var prefix = id;

                // Pattern: static-prefix + separator + dynamic-suffix
                // e.g. form-username-1234  → form-username (prefix)
                // e.g. menu-item_998877   → menu-item (prefix)
                // e.g. id_form_12345      → id_form (prefix)
                var m;

                // Strip trailing numeric suffix: foo1234, foo-1234, foo_1234
                m = id.match(/^(.+?)[-_]?\d{2,}$/);
                if (m && m[1].length >= 3) {
                    prefix = m[1];
                    // Ensure the stripped part looks dynamic (pure digits or hex)
                    var suffix = id.slice(prefix.length);
                    if (/^[-_]?\d+$/.test(suffix) || /^[a-f0-9]{4,}$/i.test(suffix)) {
                        return { stable: prefix, type: 'prefix', full: id };
                    }
                }

                // Strip UUID-like suffix: foo-a1b2c3d4 or foo_a1b2c3d4 (hex ≥ 4 chars)
                m = id.match(/^(.+?)[-_]?([a-f0-9]{8,})$/i);
                if (m && m[1].length >= 3) {
                    return { stable: m[1], type: 'prefix', full: id };
                }

                // Strip ember/react-style hash suffix: foo-abc123def
                m = id.match(/^(.+?)[-_]?[a-z]+\d+[a-z0-9]*$/i);
                if (m && m[1].length >= 3) {
                    return { stable: m[1], type: 'prefix', full: id };
                }

                // Known auto-generated prefixes → reject entirely
                if (/^(ember|react|gwt|unique|view|ctrl|comp|__b_|jsx-|v-)[-_]?/.test(id)) return null;

                // Long hex hash → reject
                if (/[a-f0-9]{16,}/i.test(id)) return null;

                // Starts with a single letter followed by only digits → likely random
                if (/^[a-z]\d{4,}$/.test(id)) return null;

                // Multiple separators in a row → likely random
                if (/[-_]{3,}/.test(id)) return null;

                // Looks stable enough for exact match
                return { stable: id, type: 'exact', full: id };
            }

            // Try CSS partial-match selector if the exact ID is not unique or was rejected
            function tryCssPartial(idPart, matchType, method) {
                var sel;
                if (matchType === 'prefix') sel = '[id^="' + idPart.replace(/"/g,'\\"') + '"]';
                else if (matchType === 'suffix') sel = '[id$="' + idPart.replace(/"/g,'\\"') + '"]';
                else sel = '[id*="' + idPart.replace(/"/g,'\\"') + '"]';
                var r = tryCss(sel, method);
                if (r) return r;
                // Also try tag-qualified
                var sel2 = tag + sel;
                return tryCss(sel2, method);
            }

            // Try XPath partial-match if CSS can't make it unique
            function tryXpPartial(idPart, matchType, method) {
                var xp;
                if (matchType === 'prefix') xp = '//*[starts-with(@id,"' + xpEsc(idPart) + '")]';
                else if (matchType === 'suffix') xp = '//*[substring(@id,string-length(@id)-' + (idPart.length - 1) + ')="' + xpEsc(idPart) + '"]';
                else xp = '//*[contains(@id,"' + xpEsc(idPart) + '")]';
                return tryXp(xp, method);
            }

            // ======== Priority-ordered attempt chain ========

            // 1. data-testid
            var testid = element.getAttribute('data-testid');
            if (testid) {
                var r = tryCss('[data-testid="' + esc(testid) + '"]', 'data-testid');
                if (r) return r;
                r = tryXp('//*[@data-testid="' + xpEsc(testid) + '"]', 'data-testid');
                if (r) return r;
            }

            // 2. data-cy, data-test, data-qa
            var testAttrs = ['data-cy', 'data-test', 'data-qa'];
            for (var ta = 0; ta < testAttrs.length; ta++) {
                var tv = element.getAttribute(testAttrs[ta]);
                if (tv) {
                    var r = tryCss('[' + testAttrs[ta] + '="' + esc(tv) + '"]', testAttrs[ta]);
                    if (r) return r;
                    r = tryXp('//*[@' + testAttrs[ta] + '="' + xpEsc(tv) + '"]', testAttrs[ta]);
                    if (r) return r;
                }
            }

            // 3. unique id — exact match first; if not unique, try partial matches on stable substrings
            var id = element.id;
            if (id) {
                var idInfo = extractStableIdPart(id);
                if (idInfo) {
                    var r;
                    if (idInfo.type === 'exact') {
                        // Stable static id: try exact match only
                        r = tryCss('#' + esc(id), 'id');
                        if (r) return r;
                        r = tryCss(tag + '#' + esc(id), 'tag+id');
                        if (r) return r;
                        r = tryXp('//*[@id="' + xpEsc(id) + '"]', 'id');
                        if (r) return r;
                    } else {
                        // Auto-generated suffix detected: try partial match directly
                        var method = 'id[' + idInfo.type + '="' + idInfo.stable + '"]';
                        r = tryCssPartial(idInfo.stable, idInfo.type, method);
                        if (r) return r;
                        r = tryXpPartial(idInfo.stable, idInfo.type, method);
                        if (r) return r;
                    }
                }
            }

            // 4. aria-label
            var ariaLabel = element.getAttribute('aria-label');
            if (ariaLabel) {
                var r = tryCss('[aria-label="' + ariaLabel.replace(/"/g,'\\"') + '"]', 'aria-label');
                if (r) return r;
                r = tryCss(tag + '[aria-label="' + ariaLabel.replace(/"/g,'\\"') + '"]', 'tag+aria-label');
                if (r) return r;
                r = tryXp('//*[@aria-label="' + xpEsc(ariaLabel) + '"]', 'aria-label');
                if (r) return r;
            }

            // 5. placeholder
            var placeholder = element.getAttribute('placeholder');
            if (placeholder) {
                var r = tryCss(tag + '[placeholder="' + placeholder.replace(/"/g,'\\"') + '"]', 'placeholder');
                if (r) return r;
                r = tryXp('//' + tag + '[@placeholder="' + xpEsc(placeholder) + '"]', 'placeholder');
                if (r) return r;
            }

            // 6. name + type
            var name = element.getAttribute('name');
            var type = element.getAttribute('type');
            if (name && type) {
                var r = tryCss(tag + '[name="' + esc(name) + '"][type="' + type + '"]', 'name+type');
                if (r) return r;
                r = tryXp('//' + tag + '[@name="' + xpEsc(name) + '" and @type="' + type + '"]', 'name+type');
                if (r) return r;
            }

            // 7. name only
            if (name) {
                var r = tryCss(tag + '[name="' + esc(name) + '"]', 'name');
                if (r) return r;
                r = tryXp('//' + tag + '[@name="' + xpEsc(name) + '"]', 'name');
                if (r) return r;
            }

            // 8. title
            var title = element.getAttribute('title');
            if (title) {
                var r = tryCss(tag + '[title="' + title.replace(/"/g,'\\"') + '"]', 'title');
                if (r) return r;
                r = tryXp('//' + tag + '[@title="' + xpEsc(title) + '"]', 'title');
                if (r) return r;
            }

            // 9. class-based (scoped under parent)
            var clsList = getClassList(element);
            var goodCls = clsList.filter(function(c) {
                return c.length > 0 && !/^\d/.test(c) && !/^(hover|active|focus|selected|disabled|open|closed|show|hide|visible|hidden)$/i.test(c);
            });
            if (goodCls.length > 0) {
                var sel = tag + '.' + esc(goodCls[0]);
                var r = tryCss(sel, 'tag+class');
                if (r) return r;
                r = tryXp('//' + tag + '[contains(@class,"' + xpEsc(goodCls[0]) + '")]', 'tag+class');
                if (r) return r;
            }

            // 10. SVG-specific strategies (for SVG elements and their children)
            // Enterprise-grade: reference Playwright codegen + SVG best practices
            if (isSvgElement) {
                var parentSvg = getParentSvg(element);

                // Helper: find HTML ancestors (non-SVG) for icon SVG pattern
                function getHtmlAncestors(el, maxDepth) {
                    var anc = [];
                    var cur = el.parentElement;
                    while (cur && cur.tagName && anc.length < maxDepth) {
                        try {
                            var ns = cur.namespaceURI || '';
                            if (ns !== 'http://www.w3.org/2000/svg') {
                                anc.push(cur);
                            }
                        } catch(e) {}
                        cur = cur.parentElement;
                    }
                    return anc;
                }

                // Helper: filter meaningful class names (skip random/auto-generated)
                function isMeaningfulCls(cls) {
                    if (!cls || cls.length < 3) return false;
                    if (/^\d/.test(cls)) return false;
                    var patterns = [/^[a-z]\d+$/i, /^[a-f0-9]{8,}$/i, /[-_][a-f0-9]{6,}$/i];
                    for (var i = 0; i < patterns.length; i++) {
                        if (patterns[i].test(cls)) return false;
                    }
                    return true;
                }

                // Helper: check if browser supports :has()
                function supportsHas() {
                    try { document.querySelector(':has(*)'); return true; } catch(e) { return false; }
                }

                // Helper: find text siblings/ancestors in SVG for chart/flow pattern
                function findRelatedText(el) {
                    if (!parentSvg) return [];
                    var results = [];
                    var texts = parentSvg.querySelectorAll('text');
                    for (var i = 0; i < texts.length; i++) {
                        var txt = (texts[i].textContent || '').trim();
                        if (!txt || txt.length > 30) continue;
                        // Check if same group ancestor
                        var curEl = el.parentElement;
                        var curTxt = texts[i].parentElement;
                        var depth = 0;
                        while (curEl && curEl !== parentSvg && depth < 5) {
                            if (curEl.contains(texts[i])) {
                                results.push({ text: txt, depth: depth + 1, textEl: texts[i] });
                                break;
                            }
                            curEl = curEl.parentElement;
                            depth++;
                        }
                    }
                    return results.sort(function(a, b) { return a.depth - b.depth; });
                }

                var htmlAncestors = getHtmlAncestors(parentSvg || element, 6);
                var hasHasSupport = supportsHas();
                var relatedTexts = !parentSvg || tag === 'svg' ? [] : findRelatedText(element);

                // ===== Strategy S1: Role + name (Playwright style, ARIA-first) =====
                var role = element.getAttribute('role');
                var ariaLabel = element.getAttribute('aria-label');
                if (role && ariaLabel) {
                    var roleSel = tag + '[role="' + role + '"][aria-label="' + ariaLabel.replace(/"/g,'\\"') + '"]';
                    var roleR = tryCss(roleSel, 'svg role+aria-label');
                    if (roleR) return roleR;
                }

                // ===== Strategy S2: HTML ancestor + svg (icon button pattern) =====
                // Enterprise: most icon SVGs are wrapped in <div class="xxx-icon">
                if (htmlAncestors.length > 0) {
                    for (var depth = 1; depth <= Math.min(3, htmlAncestors.length); depth++) {
                        var anc = htmlAncestors[depth - 1];
                        var ancId = anc.id;
                        var ancClsList = getClassList(anc).filter(isMeaningfulCls);

                        if (ancId) {
                            var idSel = '#' + esc(ancId) + ' svg';
                            if (tag !== 'svg') idSel = '#' + esc(ancId) + ' ' + tag;
                            var idR = tryCss(idSel, 'html-ancestor#' + ancId + (tag==='svg'?' svg':' '+tag));
                            if (idR) return idR;
                            
                            if (tag !== 'svg') {
                                var idSelWithAttr = '#' + esc(ancId) + ' svg ' + tag;
                                var idR2 = tryCss(idSelWithAttr, 'html-ancestor#' + ancId + ' svg ' + tag);
                                if (idR2) return idR2;
                            }
                        }

                        if (ancClsList.length > 0) {
                            var clsSel = anc.tagName.toLowerCase() + '.' + esc(ancClsList[0]) + ' svg';
                            if (tag !== 'svg') clsSel = anc.tagName.toLowerCase() + '.' + esc(ancClsList[0]) + ' ' + tag;
                            var clsR = tryCss(clsSel, 'html-ancestor.' + ancClsList[0] + (tag==='svg'?' svg':' '+tag));
                            if (clsR) return clsR;

                            var descSel = anc.tagName.toLowerCase() + '.' + esc(ancClsList[0]) + ' > svg';
                            if (tag !== 'svg') descSel = anc.tagName.toLowerCase() + '.' + esc(ancClsList[0]) + ' > ' + tag;
                            var descR = tryCss(descSel, 'html-ancestor>' + (tag==='svg'?'svg':tag));
                            if (descR) return descR;

                            if (ancClsList.length > 1) {
                                var multiClsSel = anc.tagName.toLowerCase() + '.' + esc(ancClsList[0]) + '.' + esc(ancClsList[1]) + ' svg';
                                if (tag !== 'svg') multiClsSel = anc.tagName.toLowerCase() + '.' + esc(ancClsList[0]) + '.' + esc(ancClsList[1]) + ' ' + tag;
                                var multiClsR = tryCss(multiClsSel, 'html-ancestor.' + ancClsList[0] + '.' + ancClsList[1] + (tag==='svg'?' svg':' '+tag));
                                if (multiClsR) return multiClsR;
                            }

                            if (tag !== 'svg') {
                                var clsSvgTagSel = anc.tagName.toLowerCase() + '.' + esc(ancClsList[0]) + ' svg ' + tag;
                                var clsSvgTagR = tryCss(clsSvgTagSel, 'html-ancestor.' + ancClsList[0] + ' svg ' + tag);
                                if (clsSvgTagR) return clsSvgTagR;
                            }
                        }
                    }
                }

                // ===== Strategy S3: :has(title) CSS4 pattern (tooltip SVGs) =====
                if (hasHasSupport) {
                    var titleChild = null;
                    try {
                        var kids = element.children;
                        for (var ti = 0; ti < kids.length; ti++) {
                            if (kids[ti].tagName.toLowerCase() === 'title') { titleChild = kids[ti]; break; }
                        }
                    } catch(e) {}
                    if (titleChild) {
                        var hasTitleSel = tag + ':has(> title)';
                        var hasR = tryCss(hasTitleSel, 'svg:has(title)');
                        if (hasR) return hasR;
                    }
                }

                // ===== Strategy S4: Text anchor method (chart/flow diagram pattern) =====
                // XPath: find text -> go up to g -> find target shape
                if (relatedTexts.length > 0) {
                    for (var ri = 0; ri < Math.min(3, relatedTexts.length); ri++) {
                        var anchor = relatedTexts[ri];
                        var exactTextXp = '//*[local-name()="text" and normalize-space(text())="' + xpEsc(anchor.text) + '"]/ancestor::*[local-name()="g"][' + anchor.depth + ']//*[local-name()="' + tag + '"]';
                        var txtR = tryXp(exactTextXp, 'svg-text-anchor(exact)');
                        if (txtR) return txtR;

                        var containsTextXp = '//*[local-name()="text" and contains(text(), "' + xpEsc(anchor.text.slice(0,5)) + '")]/ancestor::*[local-name()="g"][' + anchor.depth + ']//*[local-name()="' + tag + '"]';
                        txtR = tryXp(containsTextXp, 'svg-text-anchor(contains)');
                        if (txtR) return txtR;
                    }
                }

                // ===== Strategy S5: Parent SVG viewBox + tag =====
                if (parentSvg) {
                    var parentViewBox = parentSvg.getAttribute('viewBox');
                    var parentSvgId = parentSvg.id || parentSvg.getAttribute('id');

                    if (parentViewBox) {
                        var vbSel = 'svg[viewBox="' + parentViewBox + '"] ' + tag;
                        var vbR = tryCss(vbSel, 'svg[viewBox] tag');
                        if (vbR) return vbR;
                        var vbXp = '//*[local-name()="svg"][@viewBox="' + xpEsc(parentViewBox) + '"]//*[local-name()="' + tag + '"]';
                        vbR = tryXp(vbXp, 'svg[viewBox]//tag(local-name)');
                        if (vbR) return vbR;
                    }

                    if (parentSvgId) {
                        var idSel2 = 'svg#' + esc(parentSvgId) + ' ' + tag;
                        var idR2 = tryCss(idSel2, 'svg#id tag');
                        if (idR2) return idR2;
                    }
                }

                // ===== Strategy S6: SVG-specific attributes =====
                var stroke = element.getAttribute('stroke');
                var fill = element.getAttribute('fill');
                var strokeWidth = element.getAttribute('stroke-width');
                var transform = element.getAttribute('transform');

                if (stroke && stroke !== 'currentColor' && stroke !== 'none') {
                    var strokeSel = tag + '[stroke="' + stroke + '"]';
                    var strokeR = tryCss(strokeSel, 'svg-tag[stroke]');
                    if (strokeR) return strokeR;
                }

                if (fill && tag !== 'svg' && fill !== 'currentColor' && fill !== 'none') {
                    var fillSel = tag + '[fill="' + fill + '"]';
                    var fillR = tryCss(fillSel, 'svg-tag[fill]');
                    if (fillR) return fillR;
                }

                if (stroke && fill && tag !== 'svg' && stroke !== 'currentColor' && fill !== 'currentColor') {
                    var comboSel = tag + '[stroke="' + stroke + '"][fill="' + fill + '"]';
                    var comboR = tryCss(comboSel, 'svg-tag[stroke+fill]');
                    if (comboR) return comboR;
                }

                // Transform attribute (fixed layout pattern)
                if (transform && transform.length > 5) {
                    var tShort = transform.slice(0, 25);
                    var transSel = tag + '[transform*="' + tShort + '"]';
                    var transR = tryCss(transSel, 'svg-tag[transform*=]');
                    if (transR) return transR;
                }

                // ===== Strategy S7: Shape-specific attributes =====
                if (tag === 'circle') {
                    var cx = element.getAttribute('cx');
                    var cy = element.getAttribute('cy');
                    var rad = element.getAttribute('r');
                    if (cx && cy && rad) {
                        var circSel = 'circle[cx="' + cx + '"][cy="' + cy + '"][r="' + rad + '"]';
                        var circR = tryCss(circSel, 'circle[cx+cy+r]');
                        if (circR) return circR;
                    }
                }

                if (tag === 'rect' || tag === 'image') {
                    var rx = element.getAttribute('x');
                    var ry = element.getAttribute('y');
                    var rw = element.getAttribute('width');
                    var rh = element.getAttribute('height');
                    if (rx && ry && rw && rh) {
                        var rectSel = tag + '[x="' + rx + '"][y="' + ry + '"][width="' + rw + '"][height="' + rh + '"]';
                        var rectR = tryCss(rectSel, 'rect[x+y+w+h]');
                        if (rectR) return rectR;
                    }
                }

                if (tag === 'path') {
                    var dAttr = element.getAttribute('d');
                    if (dAttr && dAttr.length > 10) {
                        // Enterprise: use middle section of d for better noise resistance
                        var midStart = Math.floor(dAttr.length / 3);
                        var midEnd = Math.min(midStart + 20, dAttr.length);
                        var partialD = dAttr.slice(midStart, midEnd);
                        var parentVb = parentSvg ? parentSvg.getAttribute('viewBox') : '';
                        var pathXp = '//*[local-name()="svg"]';
                        if (parentVb) pathXp = '//*[local-name()="svg"][@viewBox="' + xpEsc(parentVb) + '"]';
                        pathXp += '//*[local-name()="path"][contains(@d, "' + xpEsc(partialD) + '")]';
                        var pathR = tryXp(pathXp, 'path[contains(d,mid)]');
                        if (pathR) return pathR;
                    }
                }

                // ===== Strategy S8: Position index under parent SVG (last resort) =====
                var sibIdx = getSiblingIndex(element);
                if (sibIdx > 0) {
                    if (parentSvg) {
                        var pVb = parentSvg.getAttribute('viewBox');
                        if (pVb) {
                            var nthSel = 'svg[viewBox="' + pVb + '"] ' + tag + ':nth-of-type(' + sibIdx + ')';
                            var nthR = tryCss(nthSel, 'svg[viewBox] tag:nth-of-type');
                            if (nthR) return nthR;
                        }
                    }
                }

                // ===== Strategy S9: Context-aware fallback (never return just "svg") =====
                // Build a locator using ancestor context + position to ensure uniqueness
                if (isSvgElement) {
                    var ctxPath = '';
                    var ctxAnc = element.parentElement;
                    var ctxDepth = 0;

                    // Walk up to find an ancestor with id or meaningful class
                    while (ctxAnc && ctxAnc !== document.body && ctxDepth < 6) {
                        var ctxId = ctxAnc.id;
                        var ctxCls = getClassList(ctxAnc).filter(isMeaningfulCls);
                        var ctxTag = ctxAnc.tagName.toLowerCase();

                        if (ctxId) {
                            ctxPath = '#' + esc(ctxId) + ' ' + (ctxPath ? ctxPath : tag);
                            break;
                        }
                        if (ctxCls.length > 0) {
                            ctxPath = ctxTag + '.' + esc(ctxCls[0]) + ' ' + (ctxPath ? ctxPath : tag);
                            break;
                        }
                        // No id or class on this ancestor, prepend tag
                        var childTag = ctxPath ? ctxPath.split(' ')[0] : tag;
                        var childIdx = 1;
                        try {
                            var ctxSiblings = ctxAnc.parentElement.querySelectorAll(ctxTag);
                            for (var si = 0; si < ctxSiblings.length; si++) {
                                if (ctxSiblings[si].isSameNode(ctxAnc)) { childIdx = si + 1; break; }
                            }
                        } catch(e) {}
                        ctxPath = ctxTag + ':nth-of-type(' + childIdx + ') > ' + (ctxPath ? ctxPath : tag);
                        ctxAnc = ctxAnc.parentElement;
                        ctxDepth++;
                    }

                    if (ctxPath) {
                        var ctxR = tryCss(ctxPath, 'svg-context-fallback');
                        if (ctxR) return ctxR;

                        // Try XPath equivalent with local-name for SVG namespace safety
                        var ctxXp = '';
                        var xpAnc = element.parentElement;
                        var xpDepth = 0;
                        while (xpAnc && xpAnc !== document.body && xpDepth < 6) {
                            var xpId = xpAnc.id;
                            var xpCls = getClassList(xpAnc).filter(isMeaningfulCls);
                            var xpTag = xpAnc.tagName.toLowerCase();

                            if (xpId) {
                                ctxXp = '//*[@id="' + xpEsc(xpId) + '"]';
                                break;
                            }
                            if (xpCls.length > 0) {
                                ctxXp = '//' + xpTag + '[contains(@class,"' + xpEsc(xpCls[0]) + '")]';
                                break;
                            }
                            xpAnc = xpAnc.parentElement;
                            xpDepth++;
                        }

                        if (ctxXp) {
                            var svgXpTarget = isSvgElement ? '//*[local-name()="' + tag + '"]' : '//' + tag;
                            var ctxXpFull = ctxXp + '//' + (tag === 'svg' ? '*[local-name()="svg"]' : '*[local-name()="svg"]//*[local-name()="' + tag + '"]');
                            var ctxXpR = tryXp(ctxXpFull, 'svg-context-fallback-xp');
                            if (ctxXpR) return ctxXpR;

                            // Add position index for SVG children
                            if (tag !== 'svg' && sibIdx > 0) {
                                var ctxXpPos = ctxXp + '//*[local-name()="svg"]//*[local-name()="' + tag + '"][' + sibIdx + ']';
                                var ctxXpPosR = tryXp(ctxXpPos, 'svg-context-fallback-xp[pos]');
                                if (ctxXpPosR) return ctxXpPosR;
                            }
                        }
                    }
                }
            }

            // No reliable locator found
            return null;
        } catch(e) { return null; }
    }

    // -- Keep old function name for backward compatibility, wraps the new generator --
    function generateLocalHeuristicLocators(element) {
        var pw = generatePlaywrightStyleLocators(element);
        if (!pw || !pw.locator) return null;
        return { css: pw.type === 'css' ? pw.locator : null, xpath: pw.type === 'xpath' ? pw.locator : null, method: pw.method, type: pw.type };
    }
    function getSessionId() {
        let sessionId = sessionStorage.getItem('elementLocatorSessionId');
        if (!sessionId) {
            sessionId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            sessionStorage.setItem('elementLocatorSessionId', sessionId);
        }
        return sessionId;
    }

    function findDialogOrModal(element) {
        if (!element) return null;
        var cur = element;
        while (cur && cur !== document.documentElement) {
            if (cur.tagName) {
                var tag = cur.tagName.toLowerCase();
                if (tag === 'dialog') return cur;
                var role = cur.getAttribute('role');
                if (role === 'dialog' || role === 'alertdialog') return cur;
                var cls = cur.className;
                if (cls && typeof cls === 'string' && /(modal|Modal|dialog|Dialog|popup|Popover|drawer|Drawer)/.test(cls)) {
                    var style = getComputedStyle(cur);
                    if (style.position === 'fixed' || style.position === 'absolute') {
                        return cur;
                    }
                }
            }
            cur = cur.parentElement;
        }
        return null;
    }

    // Handles element clicks for locator mode.
    function handleElementClick(event) {
        if (!isLocatorModeActive) return;
        // Site Lock: ensure we're still on the same origin
        if (window.location.origin !== currentOrigin) {
            toggleLocatorMode();
            return;
        }
        if (sidebarIframe && sidebarIframe.contains(event.target)) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        let element = getElementFromShadowRoot(event);

        // SVG promotion — promote SVG child elements to nearest meaningful container
        const svgTagNames = new Set(['circle','rect','path','g','line','polygon','polyline','text','tspan','use','image','mask','clipPath','defs','foreignObject']);
        if (element && element.tagName) {
            const tag = element.tagName.toLowerCase();
            if (svgTagNames.has(tag) || (element.namespaceURI && element.namespaceURI === 'http://www.w3.org/2000/svg')) {
                let foundGroup = null;
                let cur = element;
                while (cur && cur.tagName && cur.tagName.toLowerCase() !== 'svg') {
                    const t = cur.tagName.toLowerCase();
                    if (t === 'g' && (cur.id || cur.getAttribute('class') || cur.getAttribute('aria-label'))) {
                        foundGroup = cur;
                        break;
                    }
                    cur = cur.parentElement;
                }
                if (foundGroup) {
                    element = foundGroup;
                } else {
                    let svgRoot = event.target;
                    while (svgRoot && svgRoot.tagName && svgRoot.tagName.toLowerCase() !== 'svg') {
                        svgRoot = svgRoot.parentElement;
                    }
                    if (svgRoot) {
                        element = svgRoot;
                    }
                }
            }
        }

        if (element === sidebarIframe || element.closest("#elementLocatorSidebar")) return;
        if (element.closest("#elementLocatorContainer")) return;
        if (element.closest("#elementLocatorOverlay")) return;
        if (DOM_ISOLATION_CONFIG.shouldExclude(element)) return;

        var isGroupPick = event.ctrlKey || event.metaKey;

        if (isGroupPick) {
            selectElementGroup(element);
        } else {
            selectElement(element);
        }

        highlightElement(element);
    }

    let previewDebounceTimer = null;
    let lastPreviewedElement = null;

    function handleMouseOver(event) {
        if (!isLocatorModeActive) return;
        if (window.location.origin !== currentOrigin) { toggleLocatorMode(); return; }
        let element = getElementFromShadowRoot(event);

        // Walk up to find a pickable element, but prefer SVG container over its internals
        // For <circle>/<rect>/<path>/<g>/<line>/<polygon>/<polyline>/<text>/<tspan> inside <svg>,
        // promote to the nearest <g> (group) if it has a recognizable class/id, else <svg> root.
        const svgTagNames = new Set(['circle','rect','path','g','line','polygon','polyline','text','tspan','use','image','mask','clipPath','defs','foreignObject']);
        if (element && element.tagName) {
            const tag = element.tagName.toLowerCase();
            if (svgTagNames.has(tag) || (element.namespaceURI && element.namespaceURI === 'http://www.w3.org/2000/svg')) {
                let foundGroup = null;
                let cur = element;
                while (cur && cur.tagName && cur.tagName.toLowerCase() !== 'svg') {
                    const t = cur.tagName.toLowerCase();
                    if (t === 'g' && (cur.id || cur.getAttribute('class') || cur.getAttribute('aria-label'))) {
                        foundGroup = cur;
                        break;
                    }
                    cur = cur.parentElement;
                }
                if (foundGroup) {
                    element = foundGroup;
                } else {
                    let svgRoot = event.target;
                    while (svgRoot && svgRoot.tagName && svgRoot.tagName.toLowerCase() !== 'svg') {
                        svgRoot = svgRoot.parentElement;
                    }
                    if (svgRoot) {
                        element = svgRoot;
                    }
                }
            }
        }

        if (element === sidebarIframe || element.closest('#elementLocatorSidebar')) return;
        if (element.closest('#elementLocatorContainer')) return;
        if (element.closest('#elementLocatorOverlay')) return;
        if (DOM_ISOLATION_CONFIG.shouldExclude(element)) return;

        if (lastPreviewedElement === element) return;
        lastPreviewedElement = element;

        highlightElement(element);

        if (previewDebounceTimer) {
            clearTimeout(previewDebounceTimer);
        }
        previewDebounceTimer = safeSetTimeout(function() {
            previewElement(element);
        }, 80);
    }

    function handleMouseOut(event) {
        if (!isLocatorModeActive) return;
        const element = event.target;
        // Only remove highlight when mouse truly leaves the element (not just enters a child)
        if (element === sidebarIframe || element.closest('#elementLocatorSidebar')) return;
        if (element.closest('#elementLocatorContainer')) return;
        if (element.closest('#elementLocatorOverlay')) return;
        if (DOM_ISOLATION_CONFIG.shouldExclude(element)) return;
        // Check if the relatedTarget is still within the same element
        if (event.relatedTarget && element.contains(event.relatedTarget)) return;
        removeHighlight();
        lastPreviewedElement = null;
        if (previewDebounceTimer) {
            clearTimeout(previewDebounceTimer);
            previewDebounceTimer = null;
        }
        sendToSidebar('CLEAR_PREVIEW', null);
    }

    function highlightElement(element) {
        removeHighlight();
        const rect = element.getBoundingClientRect();
        highlightOverlay = document.createElement('div');
        highlightOverlay.setAttribute('data-extension-element', 'true');
        const elementType = locatorGenerator?.detectElementType(element);
        let borderColor = '#3498db';
        let backgroundColor = 'rgba(52, 152, 219, 0.1)';
        let indicatorText = 'ELEMENT';

        // highlighting based on element type.
        switch (elementType) {
            case 'ecommerce-button':
                borderColor = '#e91e63';
                backgroundColor = 'rgba(233, 30, 99, 0.1)';
                indicatorText = 'E-COMMERCE';
                break;
            case 'checkbox':
                borderColor = '#9b59b6';
                backgroundColor = 'rgba(155, 89, 182, 0.1)';
                indicatorText = 'CHECKBOX';
                break;
            case 'span':
                borderColor = '#2ecc71';
                backgroundColor = 'rgba(46, 204, 113, 0.1)';
                indicatorText = 'SPAN';
                break;
            case 'image':
                borderColor = '#e74c3c';
                backgroundColor = 'rgba(231, 76, 60, 0.1)';
                indicatorText = 'IMG';
                break;
            case 'svg':
                borderColor = '#f39c12';
                backgroundColor = 'rgba(243, 156, 18, 0.1)';
                indicatorText = 'SVG';
                break;
            case 'icon':
                borderColor = '#e67e22';
                backgroundColor = 'rgba(230, 126, 34, 0.1)';
                indicatorText = 'ICON';
                break;
            case 'button':
                borderColor = '#3498db';
                backgroundColor = 'rgba(52, 152, 219, 0.1)';
                indicatorText = 'BUTTON';
                break;
            case 'table':
                borderColor = '#16a085';
                backgroundColor = 'rgba(22, 160, 133, 0.1)';
                indicatorText = 'TABLE';
                break;
            case 'list':
                borderColor = '#2980b9';
                backgroundColor = 'rgba(41, 128, 185, 0.1)';
                indicatorText = 'LIST';
                break;
        }

        highlightOverlay.style.setProperty('width', rect.width + 'px', 'important');
        highlightOverlay.style.setProperty('height', rect.height + 'px', 'important');
        highlightOverlay.style.setProperty('border', '2px solid ' + borderColor, 'important');
        highlightOverlay.style.setProperty('background', backgroundColor, 'important');
        highlightOverlay.style.setProperty('z-index', '2147483647', 'important');
        highlightOverlay.style.setProperty('pointer-events', 'none', 'important');
        highlightOverlay.style.setProperty('box-shadow', '0 0 10px rgba(52, 152, 219, 0.5)', 'important');

        const indicator = document.createElement('div');
        indicator.style.cssText = `
            position: absolute !important;
            top: -22px !important;
            left: 0 !important;
            background: ${borderColor} !important;
            color: white !important;
            padding: 2px 6px !important;
            font-size: 11px !important;
            font-family: Arial, sans-serif !important;
            border-radius: 3px !important;
            font-weight: bold !important;
        `;
        indicator.textContent = indicatorText;
        highlightOverlay.appendChild(indicator);
        
        var targetContainer = getTopMostContainer(element);
        if (targetContainer && targetContainer !== document.body && targetContainer.tagName && targetContainer.tagName.toLowerCase() === 'dialog') {
            var dialogRect = targetContainer.getBoundingClientRect();
            highlightOverlay.style.setProperty('position', 'absolute', 'important');
            highlightOverlay.style.setProperty('top', (rect.top - dialogRect.top) + 'px', 'important');
            highlightOverlay.style.setProperty('left', (rect.left - dialogRect.left) + 'px', 'important');
            targetContainer.appendChild(highlightOverlay);
        } else {
            highlightOverlay.style.setProperty('position', 'fixed', 'important');
            highlightOverlay.style.setProperty('top', rect.top + 'px', 'important');
            highlightOverlay.style.setProperty('left', rect.left + 'px', 'important');
            document.body.appendChild(highlightOverlay);
        }
        
        ensureOverlayOnTop(highlightOverlay);
    }

    // Closes the sidebar.
   function closeSidebar() {
    removeAllEventListeners();

    if (sidebarIframe) {
        const container = document.getElementById("elementLocatorContainer");
        if (container) {
            container.remove();
        }
        const resizeHandle = document.getElementById("elementLocatorResizeHandle");
        if (resizeHandle) {
            resizeHandle.remove();
        }
        sidebarIframe = null;
        // Reset isLocatorModeActive when sidebar is closed
        isLocatorModeActive = false;
    }
    
    document.body.style.width = "";
    
    removeHighlight();
    
    if (window.sidebarMessageListener) {
        try { window.removeEventListener('message', window.sidebarMessageListener); } catch (e) {}
        window.sidebarMessageListener = null;
    }

    if (chromeIsReady()) {
        safeRuntimeSendMessage({ type: "SET_SIDEBAR_EXPLICITLY_CLOSED", isClosed: true }, function() {});
        safeStorageSet({ "isSidebarExplicitlyClosed": true }, function() {});
    }
    try { localStorage.setItem('elementLocatorSidebarOpen', 'false'); } catch (e) {}
}

    

    function handleSidebarMessage(type, data) {
        console.log('[Content] handleSidebarMessage:', type);
        switch (type) {
            case 'CLEAR_CAPTURED_ELEMENTS': elementHistory = []; currentHistoryIndex = -1; break;
            case 'ELEMENT_HISTORY_UPDATED': elementHistory = (data && data.elements) || []; currentHistoryIndex = elementHistory.length - 1; break;
            case 'TOGGLE_LOCATOR_MODE': console.log('[Content] TOGGLE_LOCATOR_MODE received'); toggleLocatorMode(); break;
            case 'CLOSE_SIDEBAR': closeSidebar(); break;
            case 'COPY_LOCATOR': copyToClipboard(data.locator); break;
            case 'REQUEST_AI_SUGGESTIONS': requestAiSuggestions(data); break;
            case 'TEST_AI_CONNECTION': testAiConnection(data); break;
            case 'LOAD_AI_CONFIG': loadAiConfiguration(); break;
            case 'SAVE_AI_CONFIG': saveAiConfig(data.provider, data.token, data.apiUrl); break;
            case 'SAVE_AI_TOKEN': saveAiToken(data.provider, data.token); break;
            case 'LOAD_AI_TOKEN': loadAiToken(data.provider); break;
            case 'LOAD_ALL_AI_TOKENS': loadAllAiTokens(); break;
            case 'REMOVE_AI_TOKEN': removeAiToken(data.provider); break;
            case 'CANCEL_AI_REQUESTS': safeRuntimeSendMessage({ type: 'CANCEL_AI_REQUESTS' }); break;
            case 'LOAD_CUSTOM_PROVIDERS': loadCustomProviders(); break;
            case 'SAVE_CUSTOM_PROVIDERS': saveCustomProviders(data.providers); break;
            case 'REQUEST_CHAT_AI': requestChatAi(data); break;
            case 'CLEAR_SELECTED_AI_PROVIDER':
                try { if (chromeIsReady() && chrome.storage && chrome.storage.sync) chrome.storage.sync.remove(['selectedAiProvider']); } catch (e) {}
                break;
        }
    }

    function loadCustomProviders() {
        try {
            if (!chromeIsReady() || !chrome.storage || !chrome.storage.sync) return;
            chrome.storage.sync.get(['customAiProviders'], function(result) {
                const providers = (result && result.customAiProviders) || {};
                sendToSidebar('CUSTOM_PROVIDERS_LOADED', { providers });
            });
        } catch (e) {}
    }

    function saveCustomProviders(providers) {
        try {
            if (!chromeIsReady() || !chrome.storage || !chrome.storage.sync) return;
            chrome.storage.sync.set({ customAiProviders: providers }, function() {});
        } catch (e) {}
    }

    function loadAllAiTokens() {
        if (!chromeIsReady() || !chrome.storage || !chrome.storage.sync) return;
        const builtinProviders = ['chatgpt', 'gemini', 'deepseek', 'claude'];
        builtinProviders.forEach(provider => {
            try {
                chrome.storage.sync.get([`aiToken_${provider}`, `aiApiUrl_${provider}`], function(result) {
                    if (result && result[`aiToken_${provider}`]) {
                        sendToSidebar('UPDATE_TOKEN_MANAGER', {
                            provider: provider,
                            token: result[`aiToken_${provider}`],
                            apiUrl: result[`aiApiUrl_${provider}`] || ''
                        });
                    }
                });
            } catch (e) {}
        });
        try {
            chrome.storage.sync.get(['customAiProviders'], function(result) {
                const customProviders = (result && result.customAiProviders) || {};
                Object.keys(customProviders).forEach(provider => {
                    chrome.storage.sync.get([`aiToken_${provider}`, `aiApiUrl_${provider}`], function(tokenResult) {
                        if (tokenResult && tokenResult[`aiToken_${provider}`]) {
                            sendToSidebar('UPDATE_TOKEN_MANAGER', {
                                provider: provider,
                                token: tokenResult[`aiToken_${provider}`],
                                apiUrl: tokenResult[`aiApiUrl_${provider}`] || ''
                            });
                        }
                    });
                });
            });
        } catch (e) {}
    }

    function removeAiToken(provider) {
        try {
            if (!chromeIsReady() || !chrome.storage || !chrome.storage.sync) return;
            chrome.storage.sync.remove([`aiToken_${provider}`, `aiApiUrl_${provider}`], function() {
                sendToSidebar('AI_TOKEN_REMOVED', { provider, success: true });
            });
        } catch (e) {}
    }

    window.addEventListener('message', function (event) {
        try {
            if (sidebarIframe && sidebarIframe.contentWindow && event.source === sidebarIframe.contentWindow) {
                return;
            }
            const { type, data } = event.data || {};
            if (type === 'VALIDATE_LOCATOR') {
                const { locator, locatorType, locatorId } = data;
                const result = validateLocator(locatorType, locator);
                try {
                    event.source.postMessage({
                        type: 'LOCATOR_VALIDATION_RESULT',
                        data: { locator, locatorType, locatorId, isValid: result.isValid, foundCount: result.foundCount }
                    }, '*');
                } catch (e) {}
                return;
            } else if (type === 'VALIDATE_LOCATORS') {
                // Batch validation for AI results
                var tests = (data && data.tests) || [];
                var results = tests.map(function(t) {
                    try {
                        var r = validateLocator(t.kind, t.value);
                        return { idx: t.idx, kind: t.kind, value: t.value, count: r.foundCount, unique: r.foundCount === 1 };
                    } catch(e) { return { idx: t.idx, kind: t.kind, value: t.value, count: -1, error: String(e) }; }
                });
                var correlation = event.data._correlation;
                try {
                    event.source.postMessage({ ok: true, results: results, _correlation: correlation }, '*');
                } catch (e) {}
                return;
            } else if (type && type !== 'CONTENT_READY_CHECK' && type !== 'ARE_YOU_READY') {
                handleSidebarMessage(type, data);
            }
        } catch (e) {}
    });

    function doSend(res) { try { sendResponse && sendResponse(res); } catch (e) {} }
    function storageOp(method, args) {
        return new Promise((resolve, reject) => {
            try {
                if (!chromeIsReady() || !chrome.storage || !chrome.storage.local) return reject(new Error('Storage unavailable'));
                chrome.storage.local[method](args, (res) => {
                    const err = chrome.runtime && chrome.runtime.lastError;
                    if (err) reject(err); else resolve(res);
                });
            } catch (e) { reject(e); }
        });
    }
    function storageSet(obj) { return new Promise((resolve, reject) => { try { if (!chromeIsReady()||!chrome.storage||!chrome.storage.local) return reject(new Error('Storage unavailable')); chrome.storage.local.set(obj,()=>{const e=chrome.runtime&&chrome.runtime.lastError;if(e)reject(e);else resolve();});} catch(e){reject(e);} }); }

    safeRuntimeOnMessage(function(request, sender, sendResponse) {
        if (!request || !request.type) return false;
        if (request.type === "__KEEPALIVE_PING__") return false;
        if (request.type === "PING") return false;
        if (request.type === "OPEN_SIDEBAR") {
            if (chromeIsReady()) createSidebar();
            doSend({ ok: true }); return false;
        }
        if (request.type === "CLOSE_SIDEBAR") {
            closeSidebar(); doSend({ ok: true }); return false;
        }
        if (request.type === "UPDATE_LOCATOR_MODE") {
            isLocatorModeActive = !!(request && request.active);
            sendToSidebar('LOCATOR_MODE_CHANGED', { active: isLocatorModeActive });
            doSend({ ok: true }); return false;
        }
        if (request.type === "AI_SUGGESTIONS_RESULT") {
            if (currentHistoryIndex >= 0 && elementHistory[currentHistoryIndex]) {
                elementHistory[currentHistoryIndex].aiSuggestions = request.data.suggestions;
                elementHistory[currentHistoryIndex].aiQueried = true;
            }
            sendToSidebar('AI_SUGGESTIONS_RESULT', request.data);
            doSend({ success: true }); return false;
        }
        if (request.type === "CANCEL_AI_REQUESTS") {
            safeRuntimeSendMessage({ type: 'CANCEL_AI_REQUESTS' });
            doSend({ ok: true }); return false;
        }

        const type = request.type;
        if (type === "REMOVE_AI_TOKEN") {
            const provider = request.data && request.data.provider;
            if (!provider) { doSend({ success: false, error: 'Invalid request data' }); return false; }
            storageOp('remove', [`aiToken_${provider}`]).then(() => {
                try { sendToSidebarPost({ type: 'AI_TOKEN_REMOVED', data: { provider } }); } catch (e) {}
                doSend({ success: true });
            }).catch((err) => doSend({ success: false, error: (err && err.message) || String(err) }));
            return true;
        }
        if (type === "SAVE_AI_TOKEN") {
            const payload = request.data && request.data.data;
            if (!payload || !payload.provider || !payload.token) { doSend({ success: false, error: 'Invalid request data' }); return false; }
            storageSet({ [`aiToken_${payload.provider}`]: payload.token }).then(() => {
                try { sendToSidebarPost({ type: 'AI_TOKEN_SAVED', data: { provider: payload.provider, token: payload.token } }); } catch (e) {}
                doSend({ success: true });
            }).catch((err) => doSend({ success: false, error: (err && err.message) || String(err) }));
            return true;
        }
        if (type === "LOAD_AI_TOKEN") {
            const provider = request.data && request.data.provider;
            if (!provider) { doSend({ success: false, error: 'Invalid request data' }); return false; }
            storageOp('get', [`aiToken_${provider}`]).then((result) => {
                const token = result && result[`aiToken_${provider}`];
                if (token) { try { sendToSidebarPost({ type: 'AI_TOKEN_LOADED', data: { provider, token } }); } catch (e) {} }
                doSend({ success: true, token: token || '' });
            }).catch((err) => doSend({ success: false, error: (err && err.message) || String(err) }));
            return true;
        }
        if (type === "LOAD_ALL_AI_TOKENS") {
            storageOp('get', null).then((result) => {
                const aiTokens = {};
                for (const key in (result || {})) {
                    if (key.startsWith('aiToken_')) aiTokens[key.replace('aiToken_', '')] = result[key];
                }
                if (window.sidebarIframe && window.sidebarIframe.contentWindow) {
                    for (const p in aiTokens) {
                        try { window.sidebarIframe.contentWindow.postMessage({ type: 'AI_TOKEN_LOADED', data: { provider: p, token: aiTokens[p] } }, '*'); } catch (e) {}
                    }
                }
                doSend({ success: true, tokens: aiTokens });
            }).catch((err) => doSend({ success: false, error: (err && err.message) || String(err) }));
            return true;
        }

        // Fall through: let handleSidebarMessage dispatch any unhandled type (TOGGLE_LOCATOR_MODE etc.)
        try { handleSidebarMessage(type, request.data || {}); } catch (e) {}
        doSend({ ok: true });
        return false;
    });

    function sendToSidebarPost(msg) {
        if (window.sidebarIframe && window.sidebarIframe.contentWindow) {
            try { window.sidebarIframe.contentWindow.postMessage(msg, '*'); } catch (e) {}
        }
    }
    
    function validateLocator(type, value) {
        try {
            const isXPath = type === 'xpath' || value.includes('//') || value.includes('/');
            const matchingElements = DOM_ISOLATION_CONFIG.getMatchingElements(value, isXPath);
            const isValid = matchingElements.length === 1;
            const foundCount = matchingElements.length;
            return {
                isValid: isValid,
                foundCount: foundCount,
                elements: matchingElements
            };
        } catch (e) {
            return {
                isValid: false,
                foundCount: 0,
                elements: []
            };
        }
    }

    // Manages event listeners for locator mode.
    // MutationObserver for dynamically created iframes (e.g., modal dialogs using iframe)
    let iframeObserver = null;
    function startIframeObserver() {
        if (iframeObserver) return;
        iframeObserver = new MutationObserver(function(mutations) {
            if (!isLocatorModeActive) return;
            var hasNewIframe = false;
            for (var i = 0; i < mutations.length; i++) {
                var added = mutations[i].addedNodes;
                for (var j = 0; j < added.length; j++) {
                    var node = added[j];
                    if (node.tagName && node.tagName.toLowerCase() === 'iframe') {
                        hasNewIframe = true;
                    } else if (node.querySelectorAll) {
                        if (node.querySelectorAll('iframe').length > 0) hasNewIframe = true;
                    }
                }
            }
            if (hasNewIframe) {
                setTimeout(function() { attachListenersToIframes(); }, 100);
            }
        });
        iframeObserver.observe(document.body, { childList: true, subtree: true });
    }
    function stopIframeObserver() {
        if (iframeObserver) {
            iframeObserver.disconnect();
            iframeObserver = null;
        }
    }

    function toggleLocatorMode() {
        console.log('[Content] toggleLocatorMode called, current state:', isLocatorModeActive);
        isLocatorModeActive = !isLocatorModeActive;
        const mouseOptions = { passive: false };
        const clickOptions = { capture: true, passive: false };

        if (isLocatorModeActive) {
            removeAllEventListeners();
            addEventListenerSafely(document, "mouseover", handleMouseOver, mouseOptions);
            addEventListenerSafely(document, "mouseout", handleMouseOut, mouseOptions);
            addEventListenerSafely(document, "click", handleElementClick, clickOptions);
            attachListenersToIframes();
            startIframeObserver();
            listenersAttached = true;
            document.body.style.cursor = "crosshair";
            console.log('[Content] Locator mode activated - listeners added');
            // Send page snapshot immediately when entering pick mode so the sidebar has the full page context ready for AI
            (function(){ try { var sn = (typeof capturePageSnapshot==='function')?capturePageSnapshot():null; var ariaSn = (typeof captureAriaSnapshot==='function')?captureAriaSnapshot():null; sendToSidebar('PAGE_SNAPSHOT', { snapshot: sn, ariaSnapshot: ariaSn }); } catch(e){} })();
        } else {
            removeAllEventListeners();
            stopIframeObserver();
            document.body.style.cursor = "";
            removeHighlight();
            lastPreviewedElement = null;
            if (previewDebounceTimer) {
                clearTimeout(previewDebounceTimer);
                previewDebounceTimer = null;
            }
            sendToSidebar('CLEAR_PREVIEW', null);
            console.log('[Content] Locator mode deactivated - listeners removed');
        }

        sendToSidebar("LOCATOR_MODE_CHANGED", { active: isLocatorModeActive });
        safeRuntimeSendMessage({ type: "UPDATE_LOCATOR_MODE", active: isLocatorModeActive });
    }

    function removeHighlight() {
        if (highlightOverlay) {
            highlightOverlay.remove();
            highlightOverlay = null;
        }
    }

    let sidebarReady = false;
    let sidebarReadyCheckTimer = null;

    function sendToSidebar(type, data) {
        sendToBackgroundForStandalone(type, data);
        
        if (!sidebarIframe) {
            console.log('[Debug] sendToSidebar: no sidebarIframe, queuing', type);
            queueSidebarMessage(type, data);
            return;
        }
        try {
            const cw = sidebarIframe.contentWindow;
            if (!cw) {
                console.log('[Debug] sendToSidebar: no contentWindow, queuing', type);
                queueSidebarMessage(type, data);
                return;
            }
            var payload = { type, data };
            try {
                cw.postMessage(payload, '*');
                console.log('[Debug] sendToSidebar: sent', type);
            } catch (postErr) {
                console.warn('[Debug] sendToSidebar: postMessage failed for', type, postErr && postErr.message);
                // Try with stripped data for large payloads
                if (type === 'ELEMENT_SELECTED' && data) {
                    var stripped = {
                        tag: data.tag,
                        id: data.id,
                        className: data.className,
                        text: data.text,
                        keyAttrs: data.keyAttrs,
                        ancestors: data.ancestors,
                        locators: data.locators,
                        localHeuristic: data.localHeuristic,
                        elementType: data.elementType,
                        timestamp: data.timestamp,
                        pageUrl: data.pageUrl,
                        pageTitle: data.pageTitle
                    };
                    try {
                        cw.postMessage({ type: type, data: stripped }, '*');
                        console.log('[Debug] sendToSidebar: sent stripped ELEMENT_SELECTED');
                    } catch (e2) {
                        console.error('[Debug] sendToSidebar: even stripped payload failed', e2 && e2.message);
                        queueSidebarMessage(type, stripped);
                    }
                } else {
                    queueSidebarMessage(type, data);
                }
            }
        } catch (e) {
            console.warn('[Debug] sendToSidebar: general error', type, e && e.message);
            queueSidebarMessage(type, data);
            scheduleProcessQueue();
        }
    }

    function sendToBackgroundForStandalone(type, data) {
        if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) return;
        try {
            chrome.runtime.sendMessage({ type, data }, () => {
                try { void chrome.runtime.lastError; } catch (e) {}
            });
        } catch (e) {}
    }

    function copyToClipboard(text) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(() => {
                    sendToSidebar('COPY_SUCCESS', { locator: text });
                }).catch(() => { fallbackCopyToClipboard(text); });
            } else {
                fallbackCopyToClipboard(text);
            }
        } catch (e) { fallbackCopyToClipboard(text); }
    }

    function fallbackCopyToClipboard(text) {
        try {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            textarea.style.top = '-9999px';
            textarea.style.left = '-9999px';
            document.body.appendChild(textarea);
            textarea.select();
            textarea.setSelectionRange(0, 99999);
            const successful = document.execCommand('copy');
            document.body.removeChild(textarea);
            if (successful) {
                sendToSidebar('COPY_SUCCESS', { locator: text });
            } else {
                sendToSidebar('COPY_ERROR', { error: 'Copy failed' });
            }
        } catch (err) {
            try { sendToSidebar('COPY_ERROR', { error: err && err.message }); } catch (e) {}
        }
    }

    function requestAiSuggestions(data) {
        const pageContext = collectPageStructureContext();
        safeRuntimeSendMessage({
            type: 'REQUEST_AI_SUGGESTIONS',
            data: { ...data, pageContext }
        });
    }

    function requestChatAi(data) {
        safeRuntimeSendMessage({
            type: 'REQUEST_CHAT_AI',
            data: {
                provider: data.provider,
                message: data.message,
                modelName: data.modelName || ''
            }
        }, (err, response) => {
            if (err) return;
            if (response) sendToSidebar('AI_CHAT_RESULT', response);
        });
    }

    function testAiConnection(data) {
        safeRuntimeSendMessage({
            type: 'TEST_AI_CONNECTION',
            data: {
                provider: data.provider,
                token: data.token,
                apiUrl: data.apiUrl
            }
        }, (err, response) => {
            if (err || !response) {
                sendToSidebar('AI_TEST_RESULT', {
                    success: false,
                    error: err ? err.message : 'No response from background script'
                });
                return;
            }
            sendToSidebar('AI_TEST_RESULT', response);
        });
    }

    /**
     * Collects page structure context including key elements, headings, forms, and navigation.
     * Returns a structured summary of the page for AI analysis.
     */
    function collectPageStructureContext() {
        try {
            const context = {
                pageTitle: document.title,
                pageUrl: window.location.href,
                bodyText: document.body ? document.body.innerText?.substring(0, 2000) || '' : '',
                headings: [],
                forms: [],
                links: [],
                buttons: [],
                inputs: [],
                containers: []
            };

            // Collect headings (h1-h3)
            document.querySelectorAll('h1, h2, h3').forEach(el => {
                const text = el.textContent?.trim().substring(0, 80) || '';
                if (text) {
                    context.headings.push({
                        tag: el.tagName.toLowerCase(),
                        id: el.id || '',
                        class: (el.getAttribute('class') || '').substring(0, 60),
                        text: text
                    });
                }
            });

            // Collect forms
            document.querySelectorAll('form').forEach(el => {
                const label = el.getAttribute('aria-label') || el.getAttribute('name') || el.id || '';
                context.forms.push({
                    id: el.id || '',
                    class: (el.getAttribute('class') || '').substring(0, 60),
                    action: el.getAttribute('action') || '',
                    method: el.getAttribute('method') || 'get',
                    label: label,
                    inputCount: el.querySelectorAll('input, select, textarea').length
                });
            });

            // Collect key interactive elements
            document.querySelectorAll('a[href], button, input, select, textarea').forEach(el => {
                const text = (el.textContent || el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').trim().substring(0, 60);
                const entry = {
                    tag: el.tagName.toLowerCase(),
                    id: el.id || '',
                    class: (el.getAttribute('class') || '').substring(0, 60),
                    text: text,
                    type: el.getAttribute('type') || '',
                    name: el.getAttribute('name') || '',
                    href: el.getAttribute('href') || ''
                };

                if (el.tagName === 'A' && el.getAttribute('href')) {
                    if (context.links.length < 30) context.links.push(entry);
                } else if (el.tagName === 'BUTTON') {
                    if (context.buttons.length < 20) context.buttons.push(entry);
                } else if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) {
                    if (context.inputs.length < 20) context.inputs.push(entry);
                }
            });

            // Collect key containers (divs with id or meaningful class)
            document.querySelectorAll('div[id], section[id], nav[id], main[id], aside[id], header[id], footer[id], [role="main"], [role="navigation"], [role="form"]').forEach(el => {
                if (context.containers.length < 15) {
                    const text = el.textContent?.trim().substring(0, 60) || '';
                    context.containers.push({
                        tag: el.tagName.toLowerCase(),
                        id: el.id || '',
                        class: (el.getAttribute('class') || '').substring(0, 60),
                        role: el.getAttribute('role') || '',
                        text: text
                    });
                }
            });

            return context;
        } catch (e) {
            return { error: 'Failed to collect page structure', pageTitle: document.title, pageUrl: window.location.href };
        }
    }

    const MESSAGE_MAX_LIFETIME_MS = 60 * 1000;

    function queueSidebarMessage(type, data) {
        messageQueue.push({ type, data, timestamp: Date.now(), attempts: 0 });
        scheduleProcessQueue();
    }

    function scheduleProcessQueue() {
        if (isProcessingQueue) return;
        if (!sidebarReadyCheckTimer) {
            sidebarReadyCheckTimer = setTimeout(() => {
                sidebarReadyCheckTimer = null;
                processMessageQueue();
            }, 150);
        }
    }

    function processMessageQueue() {
        if (messageQueue.length === 0 || isProcessingQueue) return;
        const now = Date.now();
        messageQueue = messageQueue.filter(msg => (now - msg.timestamp) <= MESSAGE_MAX_LIFETIME_MS);
        if (messageQueue.length === 0) return;
        if (!sidebarIframe || !sidebarIframe.contentWindow) {
            if (!sidebarReadyCheckTimer) {
                sidebarReadyCheckTimer = setTimeout(() => {
                    sidebarReadyCheckTimer = null;
                    processMessageQueue();
                }, 200);
            }
            return;
        }
        isProcessingQueue = true;
        try {
            const cw = sidebarIframe.contentWindow;
            if (!cw) { isProcessingQueue = false; scheduleProcessQueue(); return; }
            const remaining = [];
            while (messageQueue.length > 0) {
                const msg = messageQueue.shift();
                try {
                    cw.postMessage({ type: msg.type, data: msg.data }, '*');
                } catch (e) {
                    if (msg.attempts++ < 10 && (now - msg.timestamp) <= MESSAGE_MAX_LIFETIME_MS) remaining.push(msg);
                }
            }
            messageQueue = remaining;
        } catch (e) {
        }
        isProcessingQueue = false;
        if (messageQueue.length > 0) scheduleProcessQueue();
    }

    function loadAiConfiguration() {
        try {
            if (!chromeIsReady() || !chrome.storage || !chrome.storage.sync) return;
            chrome.storage.sync.get(['selectedAiProvider'], function(result) {
                if (!result || !result.selectedAiProvider) {
                    sendToSidebar('AI_CONFIG_LOADED', { selectedAiProvider: null, hasToken: false });
                    return;
                }
                const selected = result.selectedAiProvider;
                chrome.storage.sync.get([`aiToken_${selected}`, `aiApiUrl_${selected}`], function(tokenResult) {
                    const tr = tokenResult || {};
                    sendToSidebar('AI_CONFIG_LOADED', {
                        selectedAiProvider: selected,
                        hasToken: !!tr[`aiToken_${selected}`]
                    });
                    if (tr[`aiToken_${selected}`]) {
                        sendToSidebar('UPDATE_TOKEN_MANAGER', {
                            provider: selected,
                            token: tr[`aiToken_${selected}`],
                            apiUrl: tr[`aiApiUrl_${selected}`] || ''
                        });
                    }
                });
            });
        } catch (e) {}
    }

    function saveAiConfig(provider, token, apiUrl) {
        try {
            if (!chromeIsReady() || !chrome.storage || !chrome.storage.sync) return;
            const storageData = {
                [`aiToken_${provider}`]: token,
                'selectedAiProvider': provider
            };
            if (apiUrl) {
                storageData[`aiApiUrl_${provider}`] = apiUrl;
            } else {
                try { chrome.storage.sync.remove([`aiApiUrl_${provider}`]); } catch (e) {}
            }
            chrome.storage.sync.set(storageData, function() {
                sendToSidebar('AI_TOKEN_SAVED', { provider, token, success: true });
                sendToSidebar('UPDATE_TOKEN_MANAGER', { provider, token, apiUrl: apiUrl || '' });
            });
        } catch (e) {}
    }

    function saveAiToken(provider, token) {
        try {
            if (!chromeIsReady() || !chrome.storage || !chrome.storage.sync) return;
            chrome.storage.sync.set({
                [`aiToken_${provider}`]: token,
                'selectedAiProvider': provider
            }, function() {
                sendToSidebar('AI_TOKEN_SAVED', { provider, token, success: true });
                sendToSidebar('UPDATE_TOKEN_MANAGER', { provider, token });
            });
        } catch (e) {}
    }

    function loadAiToken(provider) {
        try {
            if (!chromeIsReady() || !chrome.storage || !chrome.storage.sync) return;
            chrome.storage.sync.get([`aiToken_${provider}`], function(result) {
                sendToSidebar('AI_TOKEN_LOADED', {
                    provider: provider,
                    token: (result && result[`aiToken_${provider}`]) || ''
                });
            });
        } catch (e) {}
    }

    const onVisibilityChange = () => {
        if (document.visibilityState === 'visible' && sidebarIframe && chromeIsReady()) {
            safeSetTimeout(() => {
                if (!chromeIsReady()) return;
                if (!checkSidebarHealth()) {
                    recreateSidebar();
                }
            }, 1000);
        }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    cleanupFns.push(() => { try { document.removeEventListener('visibilitychange', onVisibilityChange); } catch (e) {} });
    cleanupFns.push(() => { try { document.removeEventListener('visibilitychange', onVisibilityChange); } catch (e) {} });

    function checkSidebarHealth() {
        try {
            if (!chromeIsReady()) return false;
            if (!sidebarIframe || !sidebarIframe.contentWindow) return false;
            const testAccess = sidebarIframe.contentWindow.location;
            return true;
        } catch (error) { return false; }
    }

    function recreateSidebar() {
        if (!chromeIsReady()) return;
        const wasLocatorActive = isLocatorModeActive;
        if (sidebarIframe) {
            try {
                const container = document.getElementById("elementLocatorContainer");
                if (container) container.remove();
            } catch (e) {}
            sidebarIframe = null;
            window.sidebarIframe = null;
            removeAllEventListeners();
        }
        createSidebar();
        if (wasLocatorActive) {
            safeSetTimeout(() => {
                if (chromeIsReady()) { try { toggleLocatorMode(); } catch (e) {} }
            }, 1000);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeSidebar);
        cleanupFns.push(() => { try { document.removeEventListener('DOMContentLoaded', initializeSidebar); } catch (e) {} });
    } else {
        initializeSidebar();
    }

    function initializeSidebar() {
        safeStorageGet(["isSidebarExplicitlyClosed"], function(result) {
            if (!chromeIsReady()) return;
            const wasExplicitlyClosed = result && result.isSidebarExplicitlyClosed;
            if (!wasExplicitlyClosed && !document.getElementById("elementLocatorContainer") && chromeIsReady()) {
                createSidebar();
            }
        });
    }

})();
