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
            chrome.runtime.sendMessage(msg, cb);
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

    window.createSidebar = function() {
        if (!chromeIsReady()) return;
        const existingContainer = document.getElementById("elementLocatorContainer");
        if (existingContainer) {
            existingContainer.style.display = "block";
            const existingHandle = document.getElementById("elementLocatorResizeHandle");
            if (existingHandle) {
                existingHandle.style.display = "block";
                existingHandle.style.right = existingContainer.style.width;
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
            top: 0 !important;
            right: 0 !important;
            width: 380px !important;
            min-width: 280px !important;
            max-width: 600px !important;
            height: 100vh !important;
            z-index: 2147483647 !important;
            background: white !important;
            box-shadow: -5px 0 15px rgba(0,0,0,0.3) !important;
            pointer-events: auto !important;
        `;

        // Create resize handle on the left edge
        const resizeHandle = document.createElement('div');
        resizeHandle.id = 'elementLocatorResizeHandle';
        resizeHandle.setAttribute('data-extension-element', 'true');
        resizeHandle.style.cssText = `
            position: fixed !important;
            top: 0 !important;
            right: ${sidebarContainer.style.width} !important;
            width: 6px !important;
            height: 100vh !important;
            z-index: 2147483648 !important;
            cursor: ew-resize !important;
            background: transparent !important;
            pointer-events: auto !important;
            transition: background 0.2s ease !important;
        `;
        resizeHandle.addEventListener('mouseenter', () => {
            resizeHandle.style.background = 'rgba(102, 126, 234, 0.3) !important';
        });
        resizeHandle.addEventListener('mouseleave', () => {
            if (!isResizing) resizeHandle.style.background = 'transparent !important';
        });

        let isResizing = false;
        let startX = 0;
        let startWidth = 0;

        resizeHandle.addEventListener('mousedown', (e) => {
            isResizing = true;
            startX = e.clientX;
            startWidth = sidebarContainer.offsetWidth;
            resizeHandle.style.background = 'rgba(102, 126, 234, 0.6) !important';
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'ew-resize';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const deltaX = startX - e.clientX;
            let newWidth = startWidth + deltaX;
            newWidth = Math.max(280, Math.min(600, newWidth));
            sidebarContainer.style.width = newWidth + 'px';
            resizeHandle.style.right = newWidth + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                resizeHandle.style.background = 'transparent !important';
                document.body.style.userSelect = '';
                document.body.style.cursor = '';
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
            height: 100% !important;
            border: none !important;
            background: white !important;
        `;

        sidebarContainer.appendChild(sidebarIframe);
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
            if (listenersAttached) return;
            listenersAttached = true;

            const messageHandler = function(event) {
                if (!sidebarIframe || !sidebarIframe.contentWindow) return;
                if (event.source !== sidebarIframe.contentWindow) return;
                if (!chromeIsReady()) return;
                const msg = event.data || {};
                const type = msg.type;

                if (type === 'SIDEBAR_READY' || type === 'ARE_YOU_READY_ACK') {
                    sidebarReady = true;
                    if (messageQueue.length > 0) processMessageQueue();
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
            return `${element.tagName}_${element.id}_${element.className}_${element.textContent?.substring(0, 20)}`;
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
            const ariaLabel = element.getAttribute('aria-label');
            const dataIcon = element.getAttribute('data-icon');
            const classList = Array.from(element.classList || []);
            const id = element.id || element.getAttribute('id');
            const viewBox = element.getAttribute('viewBox');
            const widthAttr = element.getAttribute('width');
            const heightAttr = element.getAttribute('height');
            const fillAttr = element.getAttribute('fill');
            const strokeAttr = element.getAttribute('stroke');

            const parentSvg = (() => { let cur = element; while (cur && cur.tagName && cur.tagName.toLowerCase() !== 'svg') cur = cur.parentElement; return cur; })();
            if (tag !== 'svg' && parentSvg) {
                const parentId = parentSvg.id || parentSvg.getAttribute('id');
                const parentViewBox = parentSvg.getAttribute('viewBox');
                const parentWidth = parentSvg.getAttribute('width');
                const parentHeight = parentSvg.getAttribute('height');
                const parentFill = parentSvg.getAttribute('fill');

                if (id) locators.push({ type: 'SVG Child by ID', value: '//svg//' + tag + '[@id="' + id + '"]', confidence: 95, level: 'simple' });
                if (ariaLabel) locators.push({ type: 'SVG Child by Aria', value: '//svg//' + tag + '[@aria-label="' + ariaLabel + '"]', confidence: 95, level: 'simple' });
                if (dataIcon) locators.push({ type: 'SVG Child by Data-Icon', value: '//svg//' + tag + '[@data-icon="' + dataIcon + '"]', confidence: 95, level: 'simple' });
                if (classList) classList.forEach(cls => { if (cls && cls.length > 2) locators.push({ type: 'SVG Child by Class', value: '//svg//' + tag + '[contains(@class, "' + cls + '")]', confidence: 85, level: 'medium' }); });

                // Use parent SVG's viewBox (most unique attribute)
                if (parentViewBox) {
                    locators.push({ type: 'SVG Child by Parent ViewBox', value: '//svg[@viewBox="' + parentViewBox + '"]//' + tag, confidence: 90, level: 'simple' });
                }
                if (parentId) locators.push({ type: 'SVG Child by Parent SVG ID', value: '//svg[@id="' + parentId + '"]//' + tag, confidence: 90, level: 'simple' });
                if (parentWidth && parentHeight) {
                    locators.push({ type: 'SVG Child by Parent Size', value: '//svg[@width="' + parentWidth + '"][@height="' + parentHeight + '"]//' + tag, confidence: 75, level: 'medium' });
                }
                if (strokeAttr) {
                    locators.push({ type: 'SVG Child Stroke', value: '//svg//' + tag + '[@stroke="' + strokeAttr + '"]', confidence: 70, level: 'medium' });
                }
                if (tag === 'path' || tag === 'rect' || tag === 'circle') {
                    const attrD = element.getAttribute('d');
                    if (attrD && attrD.length > 5) {
                        locators.push({ type: 'SVG Path by d (partial)', value: '//svg[@viewBox="' + (parentViewBox || '') + '"]//' + tag + '[starts-with(@d, "' + attrD.slice(0, 12).replace(/"/g, '&quot;') + '")]', confidence: 65, level: 'advanced' });
                    }
                }
                locators.push({ type: 'SVG Child [Basic]', value: '//svg//' + tag, confidence: 40, level: 'advanced' });
                return locators;
            }

            // Direct <svg> element
            if (id) locators.push({ type: 'SVG by ID', value: '//svg[@id="' + id + '"]', confidence: 100, level: 'simple' });
            if (ariaLabel) locators.push({ type: 'SVG by Aria-Label', value: '//svg[@aria-label="' + ariaLabel + '"]', confidence: 95, level: 'simple' });
            if (classList && classList.length > 0) locators.push({ type: 'SVG by Class', value: '//svg[contains(@class, "' + classList[0] + '")]', confidence: 85, level: 'medium' });
            if (viewBox) {
                locators.push({ type: 'SVG by ViewBox', value: '//svg[@viewBox="' + viewBox + '"]', confidence: 90, level: 'simple' });
            }
            if (widthAttr && heightAttr) {
                locators.push({ type: 'SVG by Size', value: '//svg[@width="' + widthAttr + '"][@height="' + heightAttr + '"]', confidence: 75, level: 'medium' });
            }
            if (fillAttr) {
                locators.push({ type: 'SVG by Fill', value: '//svg[@fill="' + fillAttr + '"]', confidence: 60, level: 'medium' });
            }
            locators.push({ type: 'SVG Element [Basic]', value: '//svg', confidence: 30, level: 'advanced' });
            return locators;
        }

                generateSVGCSSSelectors(element) {
            const selectors = [];
            if (!element || !element.tagName) return selectors;
            const tag = element.tagName.toLowerCase();
            const ariaLabel = element.getAttribute('aria-label');
            const dataIcon = element.getAttribute('data-icon');
            const classList = Array.from(element.classList || []);
            const id = element.id || element.getAttribute('id');
            const viewBox = element.getAttribute('viewBox');
            const widthAttr = element.getAttribute('width');
            const heightAttr = element.getAttribute('height');

            const parentSvg = (() => { let cur = element; while (cur && cur.tagName && cur.tagName.toLowerCase() !== 'svg') cur = cur.parentElement; return cur; })();
            if (tag !== 'svg' && parentSvg) {
                const parentId = parentSvg.id || parentSvg.getAttribute('id');
                const parentViewBox = parentSvg.getAttribute('viewBox');
                const parentWidth = parentSvg.getAttribute('width');
                const parentHeight = parentSvg.getAttribute('height');

                if (id) selectors.push({ type: 'SVG Child by ID', value: 'svg ' + tag + '#' + id, confidence: 95, level: 'simple' });
                if (ariaLabel) selectors.push({ type: 'SVG Child by Aria', value: 'svg ' + tag + '[aria-label="' + ariaLabel + '"]', confidence: 95, level: 'simple' });
                if (dataIcon) selectors.push({ type: 'SVG Child by Data-Icon', value: 'svg ' + tag + '[data-icon="' + dataIcon + '"]', confidence: 95, level: 'simple' });
                if (classList) classList.forEach(cls => { if (cls && cls.length > 2) selectors.push({ type: 'SVG Child by Class', value: 'svg ' + tag + '.' + cls, confidence: 85, level: 'medium' }); });

                if (parentViewBox) {
                    selectors.push({ type: 'SVG Child by Parent ViewBox', value: 'svg[viewBox="' + parentViewBox + '"] ' + tag, confidence: 90, level: 'simple' });
                }
                if (parentId) selectors.push({ type: 'SVG Child by Parent SVG ID', value: 'svg#' + parentId + ' ' + tag, confidence: 90, level: 'simple' });
                if (parentWidth && parentHeight) {
                    selectors.push({ type: 'SVG Child by Parent Size', value: 'svg[width="' + parentWidth + '"][height="' + parentHeight + '"] ' + tag, confidence: 70, level: 'medium' });
                }
                selectors.push({ type: 'SVG Child [Basic]', value: 'svg ' + tag, confidence: 35, level: 'advanced' });
                return selectors;
            }

            if (id) selectors.push({ type: 'SVG by ID', value: 'svg#' + id, confidence: 100, level: 'simple' });
            if (ariaLabel) selectors.push({ type: 'SVG by Aria-Label', value: 'svg[aria-label="' + ariaLabel + '"]', confidence: 95, level: 'simple' });
            if (classList && classList.length > 0) selectors.push({ type: 'SVG by Class', value: 'svg.' + classList[0], confidence: 85, level: 'medium' });
            if (viewBox) selectors.push({ type: 'SVG by ViewBox', value: 'svg[viewBox="' + viewBox + '"]', confidence: 90, level: 'simple' });
            if (widthAttr && heightAttr) selectors.push({ type: 'SVG by Size', value: 'svg[width="' + widthAttr + '"][height="' + heightAttr + '"]', confidence: 70, level: 'medium' });
            selectors.push({ type: 'SVG Element [Basic]', value: 'svg', confidence: 25, level: 'advanced' });
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

            nonUniqueLocators.forEach(locator => {
                if (element.parentElement && element.parentElement.id) {
                    const parentId = element.parentElement.id;
                    const value = locator.value;
                    if (value.startsWith('//')) {
                        enhancedLocators.push({
                            ...locator,
                            type: locator.type + ' + Parent ID [Enhanced]',
                            value: `//*[@id="${parentId}"]${value.substring(1)}`,
                            confidence: Math.min(95, locator.confidence + 5)
                        });
                    } else {
                        enhancedLocators.push({
                            ...locator,
                            type: locator.type + ' + Parent ID [Enhanced]',
                            value: `#${parentId} ${value}`,
                            confidence: Math.min(95, locator.confidence + 5)
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
            
            console.log('📊 Final grouped locators:', {
                xpath: {
                    simple: grouped.xpath.simple.length,
                    medium: grouped.xpath.medium.length,
                    advanced: grouped.xpath.advanced.length
                },
                css: {
                    simple: grouped.css.simple.length,
                    medium: grouped.css.medium.length,
                    advanced: grouped.css.advanced.length
                }
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
            const className = element.className;
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

    function selectElement(element) {
        if (!locatorGenerator) return;
        const locators = locatorGenerator.generateUnifiedLocators(element);
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

        // Try local heuristic locator generation (no AI needed for clear identifiers)
        var localHeuristic = null;
        try { localHeuristic = (typeof generateLocalHeuristicLocators === 'function') ? generateLocalHeuristicLocators(element) : null; } catch(e) {}

        var elementData = {
            tag: element.tagName.toLowerCase(),
            id: element.id || '',
            className: element.className || '',
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
            localHeuristic: localHeuristic,   // Locally generated locator (no AI needed)
            timestamp: new Date().toLocaleString(),
            elementType: locatorGenerator.detectElementType(element),
            pageUrl: window.location.href,
            pageTitle: document.title
        };
        elementHistory.push(elementData);
        currentHistoryIndex = elementHistory.length - 1;

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
        removeHighlight();

        // Request AXTree semantic enrichment (chrome.automation) for anti-NLS locators
        (function(){
            try {
                var rect = element.getBoundingClientRect();
                safeRuntimeSendMessage({
                    type: 'REQUEST_AXTREE_NODE',
                    data: { rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } }
                }, function(response) {
                    if (response && response.ok && response.node) {
                        var lastEl = elementHistory[elementHistory.length - 1];
                        if (lastEl) {
                            lastEl.axtree = response.node;
                            sendToSidebar('ELEMENT_HISTORY_UPDATED', { elements: elementHistory });
                        }
                    }
                });
            } catch(e) {}
        })();
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

    // Local heuristic locator generation — no AI needed for elements with clear identifiers.
    // Returns { css: string, xpath: string, confidence: number, method: string } or null.
    function generateLocalHeuristicLocators(element) {
        try {
            var tag = element.tagName.toLowerCase();
            var id = element.id;
            var testId = element.getAttribute('data-testid') || element.getAttribute('data-cy') || element.getAttribute('data-test') || element.getAttribute('data-qa');
            var name = element.getAttribute('name');
            var ariaLabel = element.getAttribute('aria-label');
            var placeholder = element.getAttribute('placeholder');
            var type = element.getAttribute('type');

            // Tier 1: data-testid (highest confidence — designed for testing)
            if (testId) {
                var css = '[data-testid="' + testId + '"]';
                if (!element.getAttribute('data-testid')) {
                    var attr = element.getAttribute('data-cy') ? 'data-cy' : element.getAttribute('data-test') ? 'data-test' : 'data-qa';
                    css = '[' + attr + '="' + testId + '"]';
                }
                return { css: css, xpath: '//*[@data-testid="' + testId + '"]', confidence: 95, method: 'data-testid' };
            }

            // Tier 2: Unique ID
            if (id) {
                var count = document.querySelectorAll('#' + CSS.escape(id)).length;
                if (count === 1) {
                    return { css: '#' + CSS.escape(id), xpath: '//*[@id="' + id + '"]', confidence: 100, method: 'unique-id' };
                }
                // Non-unique ID — scope to tag
                return { css: tag + '#' + CSS.escape(id), xpath: '//' + tag + '[@id="' + id + '"]', confidence: 70, method: 'scoped-id' };
            }

            // Tier 3: name + type combination (forms)
            if (name && type) {
                var count2 = document.querySelectorAll('[name="' + CSS.escape(name) + '"][type="' + type + '"]').length;
                if (count2 === 1) {
                    return { css: '[name="' + CSS.escape(name) + '"][type="' + type + '"]',
                             xpath: '//' + tag + '[@name="' + name + '" and @type="' + type + '"]',
                             confidence: 90, method: 'name+type' };
                }
            }
            if (name) {
                var count3 = document.querySelectorAll('[name="' + CSS.escape(name) + '"]').length;
                if (count3 === 1) {
                    return { css: '[name="' + CSS.escape(name) + '"]',
                             xpath: '//*[@name="' + name + '"]',
                             confidence: 85, method: 'unique-name' };
                }
            }

            // Tier 4: aria-label
            if (ariaLabel) {
                return { css: '[aria-label="' + ariaLabel.replace(/"/g, '\\"') + '"]',
                         xpath: '//*[@aria-label="' + ariaLabel + '"]',
                         confidence: 75, method: 'aria-label' };
            }

            // Tier 5: placeholder
            if (placeholder) {
                return { css: '[placeholder="' + placeholder.replace(/"/g, '\\"') + '"]',
                         xpath: '//*[@placeholder="' + placeholder + '"]',
                         confidence: 70, method: 'placeholder' };
            }

            return null; // Need AI for this element
        } catch(e) { return null; }
    }
    function getSessionId() {
        let sessionId = sessionStorage.getItem('elementLocatorSessionId');
        if (!sessionId) {
            sessionId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            sessionStorage.setItem('elementLocatorSessionId', sessionId);
        }
        return sessionId;
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

        let element = event.target;

        // SVG promotion — same logic as handleMouseOver so SVG children like <circle>, <rect>, <path> etc. are captured as part of their SVG/group parent
        const svgTagNames = new Set(['circle','rect','path','g','line','polygon','polyline','text','tspan','use','image','mask','clipPath','defs','foreignObject']);
        if (element && element.tagName) {
            const tag = element.tagName.toLowerCase();
            if (svgTagNames.has(tag) || (element.namespaceURI && element.namespaceURI === 'http://www.w3.org/2000/svg')) {
                let cur = element;
                while (cur && cur.tagName && cur.tagName.toLowerCase() !== 'svg') {
                    const t = cur.tagName.toLowerCase();
                    if (t === 'g' && (cur.id || cur.getAttribute('class') || cur.getAttribute('aria-label'))) {
                        element = cur;
                        break;
                    }
                    cur = cur.parentElement;
                }
                if (!element || element.tagName.toLowerCase() === 'svg' || svgTagNames.has(element.tagName.toLowerCase())) {
                    let r = event.target;
                    while (r && r.tagName && r.tagName.toLowerCase() !== 'svg') r = r.parentElement;
                    if (r) element = r;
                }
            }
        }

        if (element === sidebarIframe || element.closest("#elementLocatorSidebar")) return;
        if (element.closest("#elementLocatorContainer")) return;
        if (element.closest("#elementLocatorOverlay")) return;
        if (DOM_ISOLATION_CONFIG.shouldExclude(element)) return;

        // Select element — do NOT close locator mode (support continuous multi-element selection)
        selectElement(element);

        // Re-apply highlight on selected element for visual feedback
        highlightElement(element);
    }

    function handleMouseOver(event) {
        if (!isLocatorModeActive) return;
        if (window.location.origin !== currentOrigin) { toggleLocatorMode(); return; }
        let element = event.target;

        // Walk up to find a pickable element, but prefer SVG container over its internals
        // For <circle>/<rect>/<path>/<g>/<line>/<polygon>/<polyline>/<text>/<tspan> inside <svg>,
        // promote to the nearest <g> (group) if it has a recognizable class/id, else <svg> root.
        const svgTagNames = new Set(['circle','rect','path','g','line','polygon','polyline','text','tspan','use','image','mask','clipPath','defs','foreignObject']);
        if (element && element.tagName) {
            const tag = element.tagName.toLowerCase();
            if (svgTagNames.has(tag)) {
                let cur = element;
                while (cur && cur.tagName && cur.tagName.toLowerCase() !== 'svg') {
                    const t = cur.tagName.toLowerCase();
                    // Prefer a named group
                    if (t === 'g' && (cur.id || cur.getAttribute('class') || cur.getAttribute('aria-label'))) {
                        element = cur;
                        break;
                    }
                    cur = cur.parentElement;
                }
                if (!element || !element.tagName || !svgTagNames.has(element.tagName.toLowerCase()) || element.tagName.toLowerCase() === 'svg') {
                    // Fallback: pick the <svg> root
                    let r = element;
                    while (r && r.tagName && r.tagName.toLowerCase() !== 'svg') r = r.parentElement;
                    if (r) element = r;
                }
            } else if (element.namespaceURI === 'http://www.w3.org/2000/svg') {
                // Defensive: also catch namespaceURI case (older code path)
                let r = element;
                while (r && r.tagName && r.tagName.toLowerCase() !== 'svg') r = r.parentElement;
                if (r) element = r;
            }
        }

        if (element === sidebarIframe || element.closest('#elementLocatorSidebar')) return;
        if (element.closest('#elementLocatorContainer')) return;
        if (element.closest('#elementLocatorOverlay')) return;
        if (DOM_ISOLATION_CONFIG.shouldExclude(element)) return;
        highlightElement(element);
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
    }

    function highlightElement(element) {
        removeHighlight();
        const rect = element.getBoundingClientRect();
        highlightOverlay = document.createElement('div');
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

        highlightOverlay.style.cssText = `
            position: fixed !important;
            top: ${rect.top}px !important;
            left: ${rect.left}px !important;
            width: ${rect.width}px !important;
            height: ${rect.height}px !important;
            border: 2px solid ${borderColor} !important;
            background: ${backgroundColor} !important;
            z-index: 2147483646 !important;
            pointer-events: none !important;
            box-shadow: 0 0 10px rgba(52, 152, 219, 0.5) !important;
        `;

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
        document.body.appendChild(highlightOverlay);
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
        switch (type) {
            case 'CLEAR_CAPTURED_ELEMENTS': elementHistory = []; currentHistoryIndex = -1; sendToSidebar('ELEMENT_HISTORY_UPDATED', { elements: [] }); break;
            case 'TOGGLE_LOCATOR_MODE': toggleLocatorMode(); break;
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
        if (request.type === "TOGGLE_LOCATOR_MODE") {
            toggleLocatorMode();
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
    function toggleLocatorMode() {
        isLocatorModeActive = !isLocatorModeActive;
        const mouseOptions = { passive: false };
        const clickOptions = { capture: true, passive: false };

        if (isLocatorModeActive) {
            removeAllEventListeners();
            addEventListenerSafely(document, "mouseover", handleMouseOver, mouseOptions);
            addEventListenerSafely(document, "mouseout", handleMouseOut, mouseOptions);
            addEventListenerSafely(document, "click", handleElementClick, clickOptions);
            listenersAttached = true;
            document.body.style.cursor = "crosshair";
            // Send page snapshot immediately when entering pick mode so the sidebar has the full page context ready for AI
            (function(){ try { var sn = (typeof capturePageSnapshot==='function')?capturePageSnapshot():null; var ariaSn = (typeof captureAriaSnapshot==='function')?captureAriaSnapshot():null; sendToSidebar('PAGE_SNAPSHOT', { snapshot: sn, ariaSnapshot: ariaSn }); } catch(e){} })();
        } else {
            removeAllEventListeners();
            document.body.style.cursor = "";
            removeHighlight();
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
        if (!sidebarIframe) {
            queueSidebarMessage(type, data);
            return;
        }
        try {
            const cw = sidebarIframe.contentWindow;
            if (!cw) {
                queueSidebarMessage(type, data);
                return;
            }
            cw.postMessage({ type, data }, '*');
        } catch (e) {
            queueSidebarMessage(type, data);
            scheduleProcessQueue();
        }
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
        }, (response) => {
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
        }, (response) => {
            if (response) {
                sendToSidebar('AI_TEST_RESULT', response);
            } else {
                sendToSidebar('AI_TEST_RESULT', {
                    success: false,
                    error: 'No response from background script'
                });
            }
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
                        class: el.className?.substring(0, 60) || '',
                        text: text
                    });
                }
            });

            // Collect forms
            document.querySelectorAll('form').forEach(el => {
                const label = el.getAttribute('aria-label') || el.getAttribute('name') || el.id || '';
                context.forms.push({
                    id: el.id || '',
                    class: el.className?.substring(0, 60) || '',
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
                    class: el.className?.substring(0, 60) || '',
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
                        class: el.className?.substring(0, 60) || '',
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
