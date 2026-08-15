// ==UserScript==
// @name         Twitch Chat Auto Translator
// @namespace    https://github.com/shigeXdw/Twitch-Chat-Auto-Translator
// @version      3.6.6
// @description  Automatically translates Twitch chat messages into your chosen language
// @author       BomboclatChickenNugget48/Nanahira
// @match        https://www.twitch.tv/*
// @match        https://dashboard.twitch.tv/*
// @icon         https://www.twitch.tv/favicon.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      translate.googleapis.com
// @connect      api-free.deepl.com
// @connect      api.deepl.com
// @connect      *
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict';

  const SCRIPT_PREFIX = 'tat';
  const SCRIPT_VERSION = '3.6.6';
  // Twitch's chat input is a Slate editor: injecting text via execCommand only
  // updates the visible DOM. Slate has to separately detect that mutation and
  // resync its own internal document model, which is what Twitch actually reads
  // from when a message is submitted — and the Send button's disabled/enabled
  // state lags behind the same way (most visibly on the first send of a
  // session, before that reconciliation has ever "warmed up"). These control
  // how long we poll for both to settle before we trust it enough to send.
  const OUTGOING_SYNC_STABLE_FRAMES = 3; // consecutive matching animation frames required
  const OUTGOING_SEND_READY_TIMEOUT = 2500; // ms safety cap before we give up and bail out
  const CHAT_INPUT_SELECTOR = [
    '[data-a-target="chat-input"]',
    '[data-test-selector="chat-input"]',
    '[contenteditable="true"][data-slate-editor="true"]',
    '[contenteditable="true"][role="textbox"]',
  ].join(',');
  const SEND_BUTTON_SELECTOR = '[data-a-target="chat-send-button"],[data-test-selector="chat-send-button"]';
  const CACHE_LIMIT = 200;
  const MAINTENANCE_INTERVAL = 5000;
  const MESSAGE_SELECTOR = [
    '[data-a-target="chat-line-message"]',
    '[data-test-selector="chat-line-message"]',
    '.chat-line__message',
  ].join(',');

  const LANGUAGES = {
    auto: 'Choose a language…',
    en: 'English', es: 'Spanish', de: 'German', fr: 'French', it: 'Italian',
    pt: 'Portuguese', 'pt-BR': 'Portuguese (Brazil)', nl: 'Dutch', pl: 'Polish',
    ru: 'Russian', uk: 'Ukrainian', ja: 'Japanese', ko: 'Korean',
    'zh-CN': 'Chinese (Simplified)', 'zh-TW': 'Chinese (Traditional)',
    ar: 'Arabic', hi: 'Hindi', tr: 'Turkish', sv: 'Swedish', no: 'Norwegian',
    da: 'Danish', fi: 'Finnish', cs: 'Czech', hu: 'Hungarian', ro: 'Romanian',
    el: 'Greek', he: 'Hebrew', id: 'Indonesian', vi: 'Vietnamese', th: 'Thai',
  };

  const PROVIDERS = {
    google: 'Google Translate',
    'deepl-free': 'DeepL API Free',
    'deepl-pro': 'DeepL API Pro',
    ai: 'AI (OpenAI compatible)',
  };

  const DEEPL_TARGETS = new Set([
    'AR','BG','CS','DA','DE','EL','EN-GB','EN-US','ES','ES-419','ET','FI','FR','HE','HU',
    'ID','IT','JA','KO','LT','LV','NB','NL','PL','PT-BR','PT-PT','RO','RU','SK','SL','SV',
    'TH','TR','UK','VI','ZH','ZH-HANS','ZH-HANT',
  ]);

  // Country-style source labels
  // Tooltips show the detected language
  const SOURCE_BADGES = {
    en: 'GB', es: 'ES', de: 'DE', fr: 'FR', it: 'IT', pt: 'PT', nl: 'NL',
    pl: 'PL', ru: 'RU', uk: 'UA', ja: 'JP', ko: 'KR', zh: 'CN', ar: 'SA',
    hi: 'IN', tr: 'TR', sv: 'SE', no: 'NO', da: 'DK', fi: 'FI', cs: 'CZ',
    hu: 'HU', ro: 'RO', el: 'GR', he: 'IL', id: 'ID', vi: 'VN', th: 'TH',
  };

  const state = {
    enabled: GM_getValue('enabled', true),
    target: GM_getValue('targetLanguage', 'en'),
    showOriginal: GM_getValue('showOriginal', true),
    outgoingEnabled: GM_getValue('outgoingEnabled', false),
    outgoingTarget: GM_getValue('outgoingTarget', 'en'),
    incomingProvider: GM_getValue('incomingProvider', 'google'),
    outgoingProvider: GM_getValue('outgoingProvider', 'google'),
    aiOutgoingOverride: GM_getValue('aiOutgoingOverride', false),
    deeplApiKey: GM_getValue('deeplApiKey', ''),
    aiApiKey: GM_getValue('aiApiKey', ''),
    aiModel: GM_getValue('aiModel', 'deepseek/deepseek-v3.2'),
    aiEndpoint: GM_getValue('aiEndpoint', 'https://openrouter.ai/api/v1/chat/completions'),
    aiSystemPrompt: GM_getValue('aiSystemPrompt', ''),
    aiMaxTokens: clampNumber(GM_getValue('aiMaxTokens', 250), 32, 2000, 250),
    detectRomaji: GM_getValue('detectRomaji', true),
    requestsPerMinute: clampNumber(GM_getValue('requestsPerMinute', 15), 1, 60, 15),
    maxQueueSize: clampNumber(GM_getValue('maxQueueSize', 50), 5, 200, 50),
    maxMessageAgeSeconds: clampNumber(GM_getValue('maxMessageAgeSeconds', 30), 5, 300, 30),
    maxViewerCount: clampNumber(GM_getValue('maxViewerCount', 0), 0, 10000000, 0),
    queue: [],
    active: 0,
    cache: new Map(),
    requestTimes: [],
    queueTimer: null,
    cooldownUntil: 0,
    consecutiveRateLimits: 0,
    viewerEligible: null,
    currentViewerCount: null,
    chatRoot: null,
    chatObserver: null,
    outgoingBusy: false,
    bypassSend: false,
  };

  window.addEventListener('keydown', interceptOutgoingEnter, true);
  window.addEventListener('click', interceptOutgoingClick, true);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }

  function initialize() {
    addStyles();
    registerMenu();
    bindChatObserver();
    refreshViewerEligibility();
    scanExistingMessages();
    ensureComposerButton();
    setInterval(runMaintenance, MAINTENANCE_INTERVAL);
    document.addEventListener('visibilitychange', handleVisibilityChange, { passive: true });
  }

  function registerMenu() {
    GM_registerMenuCommand('⚙ Translation settings', openSettings);
    GM_registerMenuCommand('Translation services', openProviderSettings);
    GM_registerMenuCommand(state.enabled ? '⏸ Disable translation' : '▶ Enable translation', () => {
      state.enabled = !state.enabled;
      GM_setValue('enabled', state.enabled);
      if (state.enabled) {
        bindChatObserver();
        scanExistingMessages();
      } else {
        state.queue.length = 0;
        stopChatObserver();
      }
      showToast(`Twitch translator ${state.enabled ? 'enabled' : 'disabled'}`);
    });
  }

  function bindChatObserver() {
    if (document.hidden || !state.enabled) return;
    const root = document.querySelector(
      '[data-test-selector="chat-scrollable-area__message-container"], .chat-scrollable-area__message-container, [role="log"]'
    );
    if (!root || root === state.chatRoot) return;
    state.chatObserver?.disconnect();
    state.chatRoot = root;
    state.chatObserver = new MutationObserver((mutations) => {
      if (document.hidden || !state.enabled || state.target === 'auto') return;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches(MESSAGE_SELECTOR)) enqueueMessage(node);
          node.querySelectorAll(MESSAGE_SELECTOR).forEach(enqueueMessage);
        }
      }
    });
    state.chatObserver.observe(root, { childList: true, subtree: true });
  }

  function scanExistingMessages() {
    if (document.hidden || !state.enabled || state.target === 'auto') return;
    (state.chatRoot || document).querySelectorAll(MESSAGE_SELECTOR).forEach(enqueueMessage);
  }

  function runMaintenance() {
    if (document.hidden) return;
    bindChatObserver();
    ensureComposerButton();
    if (state.maxViewerCount > 0) refreshViewerEligibility();
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      stopChatObserver();
      state.queue.length = 0;
      clearTimeout(state.queueTimer);
      state.queueTimer = null;
      return;
    }
    bindChatObserver();
    refreshViewerEligibility();
    scanExistingMessages();
    ensureComposerButton();
  }

  function stopChatObserver() {
    state.chatObserver?.disconnect();
    state.chatObserver = null;
    state.chatRoot = null;
  }

  function enqueueMessage(element) {
    if (element.dataset[`${SCRIPT_PREFIX}Handled`] || element.closest(`.${SCRIPT_PREFIX}-settings`)) return;
    if (!viewerLimitAllowsTranslation()) return;
    element.dataset[`${SCRIPT_PREFIX}Handled`] = 'true';

    // Extract message text without usernames or badges
    const fragments = [...element.querySelectorAll('[data-a-target="chat-message-text"]')];
    const text = (fragments.length ? fragments.map((node) => node.textContent).join('') : fallbackMessageText(element)).trim();

    if (!shouldTranslate(text)) return;
    const source = sourceLanguageFor(text);
    const provider = state.incomingProvider;
    const cached = state.cache.get(translationCacheKey(text, state.target, source, provider));
    if (cached) {
      renderTranslation(element, cached, state.target);
      return;
    }
    state.queue.push({ element, text, target: state.target, source, provider, createdAt: Date.now(), notBefore: 0, attempt: 0 });
    while (state.queue.length > state.maxQueueSize) state.queue.shift();
    processQueue();
  }

  function fallbackMessageText(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll(
      `.${SCRIPT_PREFIX}-translation, [data-a-target="chat-message-username"], .chat-author__display-name, .chat-badge`
    ).forEach((node) => node.remove());
    const full = clone.textContent.trim();
    const separator = full.indexOf(':');
    return separator >= 0 ? full.slice(separator + 1).trim() : full;
  }

  function shouldTranslate(text) {
    if (!text || text.length < 2 || text.length > 450) return false;
    const withoutUrls = text.replace(/https?:\/\/\S+/gi, '').trim();
    if (!withoutUrls) return false;
    // Skip messages without letters
    return /\p{L}/u.test(withoutUrls);
  }

  function processQueue() {
    clearTimeout(state.queueTimer);
    state.queueTimer = null;
    if (document.hidden || !state.enabled || !state.queue.length) return;
    if (state.outgoingBusy) {
      scheduleQueue(100);
      return;
    }

    const now = Date.now();
    const maxAge = state.maxMessageAgeSeconds * 1000;
    const viewerAllowed = viewerLimitAllowsTranslation();
    state.queue = state.queue.filter((job) =>
      job.element.isConnected && job.target === state.target && job.provider === state.incomingProvider && now - job.createdAt <= maxAge
      && viewerAllowed
    );
    if (!state.queue.length) return;

    const waitForCooldown = Math.max(0, state.cooldownUntil - now);
    state.requestTimes = state.requestTimes.filter((time) => now - time < 60000);
    const waitForRateSlot = state.requestTimes.length >= state.requestsPerMinute
      ? Math.max(0, 60000 - (now - state.requestTimes[0]))
      : 0;

    if (waitForCooldown || waitForRateSlot) {
      scheduleQueue(Math.max(waitForCooldown, waitForRateSlot) + 50);
      return;
    }

    while (state.active < 2 && state.queue.length && state.requestTimes.length < state.requestsPerMinute) {
      // Pick the newest ready job
      let index = -1;
      for (let i = 0; i < state.queue.length; i += 1) {
        if (state.queue[i].notBefore <= Date.now()
          && (index < 0 || state.queue[i].createdAt > state.queue[index].createdAt)) index = i;
      }
      if (index < 0) {
        scheduleQueue(Math.max(50, Math.min(...state.queue.map((job) => job.notBefore)) - Date.now()));
        return;
      }
      const [job] = state.queue.splice(index, 1);
      state.active += 1;
      state.requestTimes.push(Date.now());
      translate(job.text, job.target, job.source, job.provider)
        .then((result) => {
          state.consecutiveRateLimits = 0;
          renderTranslation(job.element, result, job.target);
        })
        .catch((error) => handleTranslationError(job, error))
        .finally(() => {
          state.active -= 1;
          processQueue();
        });
    }
  }

  function scheduleQueue(delay) {
    if (state.queueTimer) return;
    state.queueTimer = setTimeout(processQueue, Math.min(Math.max(delay, 50), 60000));
  }

  function handleTranslationError(job, error) {
    console.debug('[Twitch Auto Translator]', error);
    if (error.status !== 429) return;

    state.consecutiveRateLimits += 1;
    job.attempt += 1;
    if (job.attempt <= 3 && Date.now() - job.createdAt <= state.maxMessageAgeSeconds * 1000) {
      const exponentialDelay = 2000 * (2 ** (job.attempt - 1));
      const jitter = Math.floor(Math.random() * 1000);
      job.notBefore = Date.now() + exponentialDelay + jitter;
      state.queue.push(job);
      while (state.queue.length > state.maxQueueSize) state.queue.shift();
    }

    if (state.consecutiveRateLimits >= 3) {
      state.cooldownUntil = Date.now() + 5 * 60 * 1000;
      state.consecutiveRateLimits = 0;
      showToast('Translation paused for 5 minutes due to rate limiting');
    }
  }

  async function translate(text, target, source = 'auto', provider = 'google') {
    const key = translationCacheKey(text, target, source, provider);
    if (state.cache.has(key)) return Promise.resolve(state.cache.get(key));

    const result = provider === 'google'
      ? await requestGoogleTranslation(text, target, source)
      : provider === 'ai'
        ? await requestAiTranslation(text, target, source)
        : await requestDeepLTranslation(text, target, source, provider);
    state.cache.set(key, result);
    if (state.cache.size > CACHE_LIMIT) state.cache.delete(state.cache.keys().next().value);
    return result;
  }

  function requestGoogleTranslation(text, target, source) {
    const url = 'https://translate.googleapis.com/translate_a/single'
      + `?client=gtx&sl=${encodeURIComponent(source)}&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, timeout: 10000,
        onload: (response) => {
          try {
            if (response.status < 200 || response.status >= 300) {
              const error = new Error(`Translation HTTP ${response.status}`);
              error.status = response.status;
              throw error;
            }
            const data = JSON.parse(response.responseText);
            const translated = (data[0] || []).map((part) => part[0] || '').join('').trim();
            const detectedSource = data[2] || source;
            resolve({ translated, source: detectedSource });
          } catch (error) { reject(error); }
        },
        onerror: () => reject(new Error('Translation request failed')),
        ontimeout: () => reject(new Error('Translation request timed out')),
      });
    });
  }

  function requestDeepLTranslation(text, target, source, provider) {
    if (!state.deeplApiKey.trim()) return Promise.reject(new Error('DeepL API key required'));
    const targetLang = deepLTargetCode(target);
    if (!DEEPL_TARGETS.has(targetLang)) return Promise.reject(new Error(`DeepL does not support ${LANGUAGES[target] || target}`));
    const body = { text: [text], target_lang: targetLang };
    if (source !== 'auto') body.source_lang = deepLSourceCode(source);
    const url = provider === 'deepl-pro'
      ? 'https://api.deepl.com/v2/translate'
      : 'https://api-free.deepl.com/v2/translate';

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST', url, timeout: 10000,
        headers: {
          Authorization: `DeepL-Auth-Key ${state.deeplApiKey.trim()}`,
          'Content-Type': 'application/json',
        },
        data: JSON.stringify(body),
        onload: (response) => {
          try {
            const data = JSON.parse(response.responseText || '{}');
            if (response.status < 200 || response.status >= 300) {
              const error = new Error(data.message || `DeepL HTTP ${response.status}`);
              error.status = response.status;
              throw error;
            }
            const item = data.translations?.[0];
            if (!item?.text) throw new Error('Empty DeepL translation');
            resolve({ translated: item.text.trim(), source: (item.detected_source_language || source).toLowerCase() });
          } catch (error) { reject(error); }
        },
        onerror: () => reject(new Error('DeepL request failed')),
        ontimeout: () => reject(new Error('DeepL request timed out')),
      });
    });
  }

  function requestAiTranslation(text, target, source) {
    if (!state.aiApiKey.trim()) return Promise.reject(new Error('AI API key required'));
    if (!state.aiEndpoint.trim() || !state.aiModel.trim()) return Promise.reject(new Error('AI endpoint and model required'));
    const sourceName = source === 'auto' ? 'the detected language' : (LANGUAGES[source] || source);
    const targetName = LANGUAGES[target] || target;
    const styleInstruction = state.aiSystemPrompt.trim();
    const systemPrompt = [
      `Translate the user's message from ${sourceName} to ${targetName}`,
      'Preserve its meaning while making it sound natural in the target language',
      styleInstruction ? `Tone and style instruction: ${styleInstruction}` : '',
      'Return only the rewritten translation with no quotation marks, labels or explanation',
    ].filter(Boolean).join('. ');
    const body = {
      model: state.aiModel.trim(),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text },
      ],
      max_tokens: state.aiMaxTokens,
      temperature: 0.1,
      stream: false,
    };

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST', url: state.aiEndpoint.trim(), timeout: 30000,
        headers: { Authorization: `Bearer ${state.aiApiKey.trim()}`, 'Content-Type': 'application/json' },
        data: JSON.stringify(body),
        onload: (response) => {
          try {
            const data = JSON.parse(response.responseText || '{}');
            if (response.status < 200 || response.status >= 300) {
              const error = new Error(data.error?.message || data.message || `AI HTTP ${response.status}`);
              error.status = response.status;
              throw error;
            }
            const translated = data.choices?.[0]?.message?.content?.trim();
            if (!translated) throw new Error('Empty AI translation');
            resolve({ translated, source });
          } catch (error) { reject(error); }
        },
        onerror: () => reject(new Error('AI request failed')),
        ontimeout: () => reject(new Error('AI request timed out')),
      });
    });
  }

  function deepLTargetCode(code) {
    const mapped = { en: 'EN-US', pt: 'PT-PT', 'pt-BR': 'PT-BR', 'zh-CN': 'ZH-HANS', 'zh-TW': 'ZH-HANT', no: 'NB' };
    return mapped[code] || code.toUpperCase();
  }

  function deepLSourceCode(code) {
    const mapped = { 'pt-BR': 'PT', 'zh-CN': 'ZH', 'zh-TW': 'ZH', no: 'NB' };
    return mapped[code] || code.toUpperCase();
  }

  function translationCacheKey(text, target, source = 'auto', provider = 'google') {
    return `${provider}\u0000${source}\u0000${target}\u0000${text}`;
  }

  function sourceLanguageFor(text) {
    return state.detectRomaji && looksLikeRomajiJapanese(text) ? 'ja' : 'auto';
  }

  function looksLikeRomajiJapanese(text) {
    if (!/^[\p{L}\p{N}\s'!?.,~-]+$/u.test(text) || /[^\x00-\x7F]/.test(text)) return false;
    const tokens = text.toLowerCase().replace(/[^a-z'\s]/g, ' ').split(/\s+/).filter(Boolean);
    if (!tokens.length) return false;
    const strong = new Set([
      'arigatou','arigato','ohayou','ohayo','konnichiwa','konbanwa','oyasumi','sayonara',
      'matane','mata','jaane','jaa','sumimasen','gomen','gomennasai','daijoubu','daijobu',
      'onegaishimasu','onegai','itadakimasu','gochisousama','hajimemashite','yoroshiku',
      'sugoi','kawaii','kowai','oishii','tanoshii','ureshii','kanashii','muzukashii',
      'wakaru','wakarimasu','wakaranai','shiranai','daisuki','suki','kirai','ganbatte',
      'nani','nande','doushite','doko','dare','itsu','ikura','nihongo','eigo','anime',
      'senpai','sensei','chan','kun','san','sama','suru','shimasu','shita','owari','hontou',
    ]);
    const particles = new Set(['wa','ga','wo','o','ni','de','to','mo','no','kara','made','ne','yo','ka','na']);
    let score = 0;
    let strongMatches = 0;
    for (const token of tokens) {
      if (strong.has(token)) { score += 2; strongMatches += 1; }
      else if (particles.has(token)) score += 1;
      else if (/(masu|mashita|masen|desu|datta|nai|tai|teiru|teru|sou)$/.test(token)) score += 1;
    }
    return strongMatches >= 2 || (strongMatches >= 1 && score >= 3);
  }

  function ensureComposerButton() {
    if (document.hidden) return;
    const composer = findTwitchComposer();
    if (!composer) return;
    const existing = document.querySelector(`.${SCRIPT_PREFIX}-composer-button`);
    const host = composer.closest('.chat-input__textarea') || composer.parentElement;
    if (!host) return;
    if (existing?.isConnected && host.contains(existing)) {
      updateComposerButton(existing);
      return;
    }
    existing?.remove();
    host.classList.add(`${SCRIPT_PREFIX}-composer-host`);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `${SCRIPT_PREFIX}-composer-button`;
    button.textContent = '文A';
    button.setAttribute('aria-label', 'Chat translation controls');
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      translateCurrentDraft(findTwitchComposer());
    });
    button.addEventListener('auxclick', (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      toggleOutgoingTranslation(button);
    });
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openSettings();
    });
    const badgeArea = host.querySelector('.chat-input__badge-carousel');
    host.insertBefore(button, badgeArea?.parentElement === host ? badgeArea : null);
    updateComposerButton(button);
  }

  function updateComposerButton(button = document.querySelector(`.${SCRIPT_PREFIX}-composer-button`), loading = false) {
    if (!button) return;
    button.classList.toggle(`${SCRIPT_PREFIX}-active`, state.outgoingEnabled);
    button.classList.toggle(`${SCRIPT_PREFIX}-loading`, loading || state.outgoingBusy);
    button.setAttribute('aria-pressed', String(state.outgoingEnabled));
    button.title = `${loading || state.outgoingBusy ? 'Translating draft' : `Outgoing translation: ${state.outgoingEnabled ? 'ON' : 'OFF'}`}\nLeft-click: translate draft\nMiddle-click: toggle\nRight-click: settings`;
  }

  function toggleOutgoingTranslation(button) {
    state.outgoingEnabled = !state.outgoingEnabled;
    GM_setValue('outgoingEnabled', state.outgoingEnabled);
    if (!state.outgoingEnabled && state.aiOutgoingOverride) {
      state.aiOutgoingOverride = false;
      GM_setValue('aiOutgoingOverride', false);
    }
    updateComposerButton(button);
    showToast(`Outgoing translation ${state.outgoingEnabled ? 'enabled' : 'disabled'}`);
  }

  function findTwitchComposer() {
    for (const candidate of document.querySelectorAll(CHAT_INPUT_SELECTOR)) {
      const composer = normalizeComposer(candidate);
      if (composer) return composer;
    }
    return null;
  }

  function normalizeComposer(candidate) {
    if (!candidate) return null;
    if (candidate.matches('textarea,input,[contenteditable="true"]')) return candidate;
    return candidate.querySelector('textarea,input,[contenteditable="true"]') || candidate;
  }

  function interceptOutgoingEnter(event) {
    if (!state.outgoingEnabled || state.bypassSend || event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    const composer = normalizeComposer(
      event.composedPath?.().find((node) => node instanceof Element && node.matches(CHAT_INPUT_SELECTOR))
    );
    const text = getComposerText(composer);
    if (!composer || !text || text.startsWith('/')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    translateThenSend(composer);
  }

  function interceptOutgoingClick(event) {
    const sendButton = event.target.closest?.(SEND_BUTTON_SELECTOR);
    if (!sendButton || !state.outgoingEnabled || state.bypassSend) return;
    const composer = findTwitchComposer();
    const text = getComposerText(composer);
    if (!composer || !text || text.startsWith('/')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    translateThenSend(composer);
  }

  async function translateThenSend(composer) {
    if (state.outgoingBusy) return;
    const originalText = getComposerText(composer);
    const translatedText = await translateCurrentDraft(composer);
    if (!translatedText) return;

    // Don't trust the DOM the instant translatedText lands in it — that only
    // proves the text is visible, not that Twitch's own editor state (and the
    // Send button's enabled state, which lags independently) have caught up.
    // Poll until both are genuinely ready before we allow a send.
    const readiness = await waitForSendReady(composer, translatedText);

    if (readiness.status === 'ready') {
      // A real click on Twitch's own Send button: a synthetic Enter keydown
      // (dispatchComposerEnter) turned out to be read against a different,
      // staler copy of the message than a Send-button click is, which is why
      // the composer could visibly show the translated text right up to send
      // and still ship the original — the two triggers weren't reading the
      // same source of truth.
      state.bypassSend = true;
      if (readiness.buttonReady) readiness.sendButton.click();
      else dispatchComposerEnter(composer);
      setTimeout(() => { state.bypassSend = false; }, 0);
      scheduleComposerCleanup(composer, originalText, translatedText);
    } else if (false) {
      // This layout never exposed a Send button to click at all, so a
      // simulated Enter is the only mechanism left — better than nothing.
      state.bypassSend = true;
      dispatchComposerEnter(composer);
      setTimeout(() => { state.bypassSend = false; }, 0);
      scheduleComposerCleanup(composer, originalText, translatedText);
    } else {
      // Button exists but never stabilized as enabled, or the composer text
      // never settled. Don't guess — silently falling back to Enter here is
      // exactly what caused the original "sends the old text" bug.
      showToast('Translation ready — press Enter to send');
    }
  }

  // Polls until the composer text has settled on `expectedText` AND Twitch's
  // Send button is present + enabled, both holding true across several
  // consecutive animation frames in a row (not just a single lucky read).
  // Resolves with:
  //   { status: 'ready', sendButton }  - safe to click sendButton
  //   { status: 'no-button' }          - selector matched nothing, ever
  //   { status: 'button-stuck' }       - button existed but stayed disabled
  //   { status: 'detached' }           - composer left the page mid-wait
  function waitForSendReady(composer, expectedText) {
    return new Promise((resolve) => {
      const deadline = Date.now() + OUTGOING_SEND_READY_TIMEOUT;
      let stableFrames = 0;
      const check = () => {
        if (!composer.isConnected) return resolve({ status: 'detached' });
        const sendButton = document.querySelector(SEND_BUTTON_SELECTOR);
        const buttonReady = !!sendButton && !sendButton.disabled && sendButton.getAttribute('aria-disabled') !== 'true';
        const textReady = getComposerText(composer) === expectedText;
        if (textReady) {
          stableFrames += 1;
          if (stableFrames >= OUTGOING_SYNC_STABLE_FRAMES) return resolve({ status: 'ready', sendButton, buttonReady });
        } else {
          stableFrames = 0;
        }
        if (Date.now() > deadline) return resolve({ status: 'text-stuck' });
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
  }

  function scheduleComposerCleanup(composer, originalText, translatedText) {
    const clearIfStale = () => {
      if (!composer.isConnected) return;
      const current = getComposerText(composer);
      if (current !== originalText && current !== translatedText) return;
      if ('value' in composer) {
        setNativeValue(composer, '');
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        composer.focus();
        selectComposerContents(composer);
        document.execCommand('delete');
      }
    };
    setTimeout(clearIfStale, 150);
    setTimeout(clearIfStale, 400);
  }

  async function translateCurrentDraft(composer) {
    if (!composer) return false;
    if (!state.outgoingEnabled) {
      showToast('Outgoing translation is disabled');
      return false;
    }
    const original = getComposerText(composer);
    if (!original || original.startsWith('/')) return false;
    if (state.outgoingBusy) return false;
    state.outgoingBusy = true;
    updateComposerButton(undefined, true);
    let release = null;
    try {
      const source = sourceLanguageFor(original);
      const provider = state.aiOutgoingOverride ? 'ai' : state.outgoingProvider;
      const key = translationCacheKey(original, state.outgoingTarget, source, provider);
      let result = state.cache.get(key);
      if (!result) {
        release = await acquireOutgoingSlot(15000);
        result = await translate(original, state.outgoingTarget, source, provider);
      }
      if (!result?.translated) throw new Error('Empty translation');
      if (getComposerText(composer) !== original) return false;
      replaceComposerText(composer, result.translated);
      return result.translated;
    } catch (error) {
      console.debug('[Twitch Auto Translator] Draft translation failed', error);
      if (error.status === 429) state.cooldownUntil = Date.now() + 5 * 60 * 1000;
      showToast(error.status === 429 ? 'Translation paused for 5 minutes' : 'Draft translation failed');
      return false;
    } finally {
      release?.();
      state.outgoingBusy = false;
      updateComposerButton();
      processQueue();
    }
  }

  function acquireOutgoingSlot(maxWaitMs) {
    const deadline = Date.now() + maxWaitMs;
    return new Promise((resolve, reject) => {
      const attempt = () => {
        const now = Date.now();
        if (state.cooldownUntil > now) return reject(new Error('Translation cooldown active'));
        state.requestTimes = state.requestTimes.filter((time) => now - time < 60000);
        if (state.active < 2 && state.requestTimes.length < state.requestsPerMinute) {
          state.active += 1;
          state.requestTimes.push(now);
          resolve(() => { state.active = Math.max(0, state.active - 1); });
        } else if (now >= deadline) reject(new Error('Translation request limit is busy'));
        else setTimeout(attempt, 250);
      };
      attempt();
    });
  }

  function getComposerText(composer) {
    if (!composer) return '';
    return ('value' in composer ? composer.value : composer.textContent || '').trim();
  }

  function replaceComposerText(composer, text) {
    composer.focus();
    if ('value' in composer) {
      composer.setSelectionRange(0, composer.value.length);
      if (!document.execCommand('insertText', false, text)) replaceComposerTextFallback(composer, text);
      restoreComposerFocus(composer, text.length);
      return;
    }

    selectComposerContents(composer);
    if (!document.execCommand('insertText', false, text)) replaceComposerTextFallback(composer, text);
    restoreComposerFocus(composer, text.length);
  }

  function selectComposerContents(composer) {
    const selection = window.getSelection();
    const range = document.createRange();
    const textNodes = composerTextNodes(composer);
    if (textNodes.length) {
      range.setStart(textNodes[0], 0);
      range.setEnd(textNodes[textNodes.length - 1], textNodes[textNodes.length - 1].data.length);
    } else range.selectNodeContents(composer);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function composerTextNodes(composer) {
    const slateStrings = [...composer.querySelectorAll('[data-slate-string="true"]')];
    const roots = slateStrings.length ? slateStrings : [composer];
    const nodes = [];
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (walker.currentNode.data && walker.currentNode.data !== '\uFEFF') nodes.push(walker.currentNode);
      }
    }
    return nodes;
  }

  function replaceComposerTextFallback(composer, text) {
    if ('value' in composer) setNativeValue(composer, text);
    else composer.textContent = text;
    composer.dispatchEvent(new InputEvent('input', {
      bubbles: true, composed: true, inputType: 'insertText', data: text,
    }));
  }

  function dispatchComposerEnter(composer) {
    const options = { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, composed: true };
    const keydown = new KeyboardEvent('keydown', options);
    Object.defineProperties(keydown, { keyCode: { value: 13 }, which: { value: 13 } });
    composer.focus();
    composer.dispatchEvent(keydown);
    composer.dispatchEvent(new KeyboardEvent('keyup', options));
  }

  function restoreComposerFocus(composer, cursorPosition) {
    const restore = () => {
      if (!composer.isConnected) return;
      composer.focus({ preventScroll: true });
      if (composer.setSelectionRange) composer.setSelectionRange(cursorPosition, cursorPosition);
      else {
        const selection = window.getSelection();
        const range = document.createRange();
        const textNodes = composerTextNodes(composer);
        const lastText = textNodes[textNodes.length - 1];
        if (lastText) range.setStart(lastText, lastText.data.length);
        else {
          range.selectNodeContents(composer);
          range.collapse(false);
        }
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    };
    restore();
    requestAnimationFrame(restore);
    setTimeout(restore, 50);
  }

  function setNativeValue(element, value) {
    const ownSetter = Object.getOwnPropertyDescriptor(element, 'value')?.set;
    const prototypeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
    const setter = ownSetter && ownSetter !== prototypeSetter ? prototypeSetter : (ownSetter || prototypeSetter);
    if (!setter) throw new Error('Unable to update Twitch chat input');
    setter.call(element, value);
  }

  function viewerLimitAllowsTranslation() {
    if (state.maxViewerCount === 0) return true;
    return state.currentViewerCount !== null && state.currentViewerCount <= state.maxViewerCount;
  }

  function readViewerCount() {
    const selectors = [
      '[data-a-target="animated-channel-viewers-count"]',
      '[data-a-target="channel-viewers-count"]',
      '[data-test-selector="live-viewers-count"]',
    ];
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (!node) continue;
      const parsed = parseCompactNumber(node.textContent);
      if (parsed !== null) return parsed;
    }
    return null;
  }

  function parseCompactNumber(value) {
    const text = String(value || '').trim().toUpperCase().replace(/\s/g, '');
    const match = text.match(/([\d.,]+)\s*([KMB]?)/);
    if (!match) return null;
    const suffix = match[2];
    let numeric = match[1];
    if (suffix) numeric = numeric.replace(',', '.');
    else numeric = numeric.replace(/[.,](?=\d{3}(?:\D|$))/g, '').replace(',', '.');
    const number = Number.parseFloat(numeric);
    if (!Number.isFinite(number)) return null;
    return Math.round(number * ({ K: 1000, M: 1000000, B: 1000000000 }[suffix] || 1));
  }

  function refreshViewerEligibility() {
    state.currentViewerCount = state.maxViewerCount > 0 ? readViewerCount() : null;
    const eligible = viewerLimitAllowsTranslation();
    if (state.viewerEligible === eligible) return;
    const wasEligible = state.viewerEligible;
    state.viewerEligible = eligible;
    if (!eligible) state.queue.length = 0;
    if (eligible && wasEligible === false && state.enabled) scanExistingMessages();
  }

  function renderTranslation(element, result, targetAtRequest) {
    if (document.hidden || !element.isConnected || targetAtRequest !== state.target || !state.enabled) return;
    if (!viewerLimitAllowsTranslation()) return;
    if (!result.translated || sameLanguage(result.source, targetAtRequest)) return;

    const scrollContainer = findChatScrollContainer(element);
    const shouldFollowChat = isNearBottom(scrollContainer);

    const row = document.createElement('div');
    row.className = `${SCRIPT_PREFIX}-translation`;
    row.lang = targetAtRequest;

    const icon = document.createElement('span');
    icon.className = `${SCRIPT_PREFIX}-icon`;
    icon.textContent = '文A';

    const copy = document.createElement('span');
    copy.className = `${SCRIPT_PREFIX}-copy`;
    copy.textContent = result.translated;

    const sourceBadge = document.createElement('span');
    sourceBadge.className = `${SCRIPT_PREFIX}-source-badge`;
    sourceBadge.textContent = sourceBadgeFor(result.source);
    sourceBadge.title = `Translated from ${languageName(result.source)}`;
    sourceBadge.setAttribute('aria-label', sourceBadge.title);

    row.append(icon, sourceBadge, copy);
    element.append(row);
    if (!state.showOriginal) hideOriginalMessageFragments(element);
    if (shouldFollowChat) keepChatAtBottom(scrollContainer);
  }

  function findChatScrollContainer(element) {
    const twitchContainer = element.closest('.chat-scrollable-area__message-container')
      ?.closest('.simplebar-content-wrapper');
    if (twitchContainer) return twitchContainer;

    let parent = element.parentElement;
    while (parent && parent !== document.body) {
      const style = getComputedStyle(parent);
      if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight) return parent;
      parent = parent.parentElement;
    }
    return null;
  }

  function isNearBottom(container) {
    if (!container) return false;
    return container.scrollHeight - container.scrollTop - container.clientHeight < 120;
  }

  function keepChatAtBottom(container) {
    if (!container) return;
    const scrollToBottom = () => { container.scrollTop = container.scrollHeight; };
    scrollToBottom();
    requestAnimationFrame(() => {
      scrollToBottom();
      requestAnimationFrame(scrollToBottom);
    });
  }

  function sameLanguage(source, target) {
    const normalize = (code) => String(code).toLowerCase().split('-')[0];
    return normalize(source) === normalize(target);
  }

  function languageName(code) {
    if (!code) return 'unknown language';
    try {
      return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(code) || code;
    } catch { return LANGUAGES[code] || code; }
  }

  function sourceBadgeFor(code) {
    const normalized = String(code || '').toLowerCase().split('-')[0];
    return SOURCE_BADGES[normalized] || normalized.toUpperCase() || '?';
  }

  function hideOriginalMessageFragments(element) {
    element.querySelectorAll('[data-a-target="chat-message-text"]').forEach((node) => {
      node.dataset[`${SCRIPT_PREFIX}OriginalDisplay`] = node.style.display;
      node.style.display = 'none';
    });
  }

  function restoreOriginalMessages() {
    document.querySelectorAll(`[data-${SCRIPT_PREFIX}-original-display]`).forEach((node) => {
      node.style.display = node.dataset[`${SCRIPT_PREFIX}OriginalDisplay`] || '';
      delete node.dataset[`${SCRIPT_PREFIX}OriginalDisplay`];
    });
  }

  function openProviderSettings() {
    document.querySelector(`.${SCRIPT_PREFIX}-services-only`)?.remove();
    document.querySelector(`.${SCRIPT_PREFIX}-service-settings`)?.remove();
    const mainOverlay = document.querySelector(`.${SCRIPT_PREFIX}-overlay:not(.${SCRIPT_PREFIX}-services-only)`);
    const overlay = mainOverlay || document.createElement('div');
    if (!mainOverlay) overlay.className = `${SCRIPT_PREFIX}-overlay ${SCRIPT_PREFIX}-services-only`;
    else overlay.classList.add(`${SCRIPT_PREFIX}-paired`);
    const panel = document.createElement('section');
    panel.className = `${SCRIPT_PREFIX}-settings ${SCRIPT_PREFIX}-service-settings`;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', `${SCRIPT_PREFIX}-services-title`);
    panel.innerHTML = `
        <button class="${SCRIPT_PREFIX}-close" aria-label="Close">×</button>
        <h2 id="${SCRIPT_PREFIX}-services-title">Translation services</h2>
        <div class="${SCRIPT_PREFIX}-providers">
          <label>Received chat
            <select class="${SCRIPT_PREFIX}-incoming-provider"></select>
          </label>
          <label>Messages you send
            <select class="${SCRIPT_PREFIX}-outgoing-provider"></select>
          </label>
          <label class="${SCRIPT_PREFIX}-api-key">DeepL API key
            <input type="password" class="${SCRIPT_PREFIX}-deepl-key" autocomplete="off" placeholder="Required only when DeepL is selected">
          </label>
          <small>DeepL Free and Pro use different endpoints. The key is stored locally by Tampermonkey. Use a dedicated revocable key.</small>
        </div>
        <div class="${SCRIPT_PREFIX}-section-title">AI-compatible service</div>
        <div class="${SCRIPT_PREFIX}-ai-settings">
          <label class="${SCRIPT_PREFIX}-check ${SCRIPT_PREFIX}-wide"><input type="checkbox" class="${SCRIPT_PREFIX}-ai-override"> <span>Use AI for outgoing messages</span></label>
          <label>API key
            <input type="password" class="${SCRIPT_PREFIX}-ai-key" autocomplete="off">
          </label>
          <label>Model
            <input type="text" class="${SCRIPT_PREFIX}-ai-model" placeholder="deepseek/deepseek-v3.2">
          </label>
          <label class="${SCRIPT_PREFIX}-wide">Endpoint
            <input type="url" class="${SCRIPT_PREFIX}-ai-endpoint" placeholder="https://openrouter.ai/api/v1/chat/completions">
          </label>
          <label class="${SCRIPT_PREFIX}-wide">Tone and style <span class="${SCRIPT_PREFIX}-optional">optional</span>
            <textarea class="${SCRIPT_PREFIX}-ai-prompt" rows="3" placeholder="Example: Sound casual and British, using natural British expressions"></textarea>
          </label>
          <label>Maximum output tokens
            <input type="number" class="${SCRIPT_PREFIX}-ai-tokens" min="32" max="2000" step="1">
          </label>
          <small class="${SCRIPT_PREFIX}-wide">The selected target language controls translation. Tone and style changes its phrasing. Works with OpenRouter and other OpenAI-compatible APIs. Context is not included.</small>
        </div>
        <div class="${SCRIPT_PREFIX}-footer">
          <span class="${SCRIPT_PREFIX}-version">v${SCRIPT_VERSION}</span>
          <button class="${SCRIPT_PREFIX}-save">Save services</button>
        </div>`;
    overlay.append(panel);

    const incomingSelect = panel.querySelector(`.${SCRIPT_PREFIX}-incoming-provider`);
    const outgoingSelect = panel.querySelector(`.${SCRIPT_PREFIX}-outgoing-provider`);
    for (const [code, name] of Object.entries(PROVIDERS)) {
      incomingSelect.add(new Option(name, code, false, code === state.incomingProvider));
      outgoingSelect.add(new Option(name, code, false, code === state.outgoingProvider));
    }
    const keyInput = panel.querySelector(`.${SCRIPT_PREFIX}-deepl-key`);
    keyInput.value = state.deeplApiKey;
    const aiKeyInput = panel.querySelector(`.${SCRIPT_PREFIX}-ai-key`);
    const aiModelInput = panel.querySelector(`.${SCRIPT_PREFIX}-ai-model`);
    const aiEndpointInput = panel.querySelector(`.${SCRIPT_PREFIX}-ai-endpoint`);
    const aiPromptInput = panel.querySelector(`.${SCRIPT_PREFIX}-ai-prompt`);
    const aiTokensInput = panel.querySelector(`.${SCRIPT_PREFIX}-ai-tokens`);
    const aiOverrideInput = panel.querySelector(`.${SCRIPT_PREFIX}-ai-override`);
    aiKeyInput.value = state.aiApiKey;
    aiModelInput.value = state.aiModel;
    aiEndpointInput.value = state.aiEndpoint;
    aiPromptInput.value = state.aiSystemPrompt;
    aiTokensInput.value = state.aiMaxTokens;
    aiOverrideInput.checked = state.aiOutgoingOverride;
    const syncAiOverrideUi = () => {
      if (aiOverrideInput.checked) outgoingSelect.value = 'ai';
      outgoingSelect.disabled = aiOverrideInput.checked;
    };
    aiOverrideInput.addEventListener('change', syncAiOverrideUi);
    syncAiOverrideUi();
    const close = () => {
      if (mainOverlay) {
        panel.remove();
        overlay.classList.remove(`${SCRIPT_PREFIX}-paired`);
      } else overlay.remove();
    };
    panel.querySelector(`.${SCRIPT_PREFIX}-close`).addEventListener('click', close);
    if (!mainOverlay) overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
    panel.querySelector(`.${SCRIPT_PREFIX}-save`).addEventListener('click', () => {
      const key = keyInput.value.trim();
      const usesDeepL = incomingSelect.value.startsWith('deepl') || outgoingSelect.value.startsWith('deepl');
      if (usesDeepL && !key) {
        showToast('Enter a DeepL API key');
        keyInput.focus();
        return;
      }
      const usesAi = incomingSelect.value === 'ai' || outgoingSelect.value === 'ai' || aiOverrideInput.checked;
      if (usesAi && (!aiKeyInput.value.trim() || !aiModelInput.value.trim() || !aiEndpointInput.value.trim())) {
        showToast('Enter the AI key, model and endpoint');
        return;
      }
      if (usesAi) {
        try { new URL(aiEndpointInput.value.trim()); }
        catch { showToast('Enter a valid AI endpoint'); return; }
      }
      const incomingChanged = state.incomingProvider !== incomingSelect.value;
      state.incomingProvider = incomingSelect.value;
      state.outgoingProvider = aiOverrideInput.checked ? 'ai' : outgoingSelect.value;
      state.deeplApiKey = key;
      state.aiApiKey = aiKeyInput.value.trim();
      state.aiModel = aiModelInput.value.trim();
      state.aiEndpoint = aiEndpointInput.value.trim();
      state.aiSystemPrompt = aiPromptInput.value.trim();
      state.aiMaxTokens = clampNumber(aiTokensInput.value, 32, 2000, 250);
      state.aiOutgoingOverride = aiOverrideInput.checked;
      if (state.aiOutgoingOverride) {
        state.outgoingEnabled = true;
        const outgoingToggle = document.querySelector(`.${SCRIPT_PREFIX}-outgoing-enabled`);
        if (outgoingToggle) outgoingToggle.checked = true;
      }
      GM_setValue('incomingProvider', state.incomingProvider);
      GM_setValue('outgoingProvider', state.outgoingProvider);
      GM_setValue('deeplApiKey', state.deeplApiKey);
      GM_setValue('aiApiKey', state.aiApiKey);
      GM_setValue('aiModel', state.aiModel);
      GM_setValue('aiEndpoint', state.aiEndpoint);
      GM_setValue('aiSystemPrompt', state.aiSystemPrompt);
      GM_setValue('aiMaxTokens', state.aiMaxTokens);
      GM_setValue('aiOutgoingOverride', state.aiOutgoingOverride);
      GM_setValue('outgoingEnabled', state.outgoingEnabled);
      updateComposerButton();
      if (incomingChanged) {
        state.queue.length = 0;
        document.querySelectorAll(`.${SCRIPT_PREFIX}-translation`).forEach((node) => node.remove());
        document.querySelectorAll(MESSAGE_SELECTOR).forEach((node) => delete node.dataset[`${SCRIPT_PREFIX}Handled`]);
        if (state.enabled) scanExistingMessages();
      }
      close();
      showToast('Translation services saved');
    });
    if (!mainOverlay) document.body.append(overlay);
  }

  function openSettings() {
    document.querySelector(`.${SCRIPT_PREFIX}-overlay`)?.remove();
    const overlay = document.createElement('div');
    overlay.className = `${SCRIPT_PREFIX}-overlay`;
    overlay.innerHTML = `
      <section class="${SCRIPT_PREFIX}-settings" role="dialog" aria-modal="true" aria-labelledby="${SCRIPT_PREFIX}-title">
        <button class="${SCRIPT_PREFIX}-close" aria-label="Close">×</button>
        <h2 id="${SCRIPT_PREFIX}-title">Twitch Chat Translator</h2>
        <label class="${SCRIPT_PREFIX}-language-field">Translate chat to
          <select class="${SCRIPT_PREFIX}-language"></select>
        </label>
        <div class="${SCRIPT_PREFIX}-toggles">
          <label class="${SCRIPT_PREFIX}-check"><input type="checkbox" class="${SCRIPT_PREFIX}-enabled"> <span>Enable automatic translation</span></label>
          <label class="${SCRIPT_PREFIX}-check"><input type="checkbox" class="${SCRIPT_PREFIX}-original"> <span>Keep original message visible</span></label>
          <label class="${SCRIPT_PREFIX}-check"><input type="checkbox" class="${SCRIPT_PREFIX}-romaji"> <span>Recognize romanized Japanese (romaji)</span></label>
        </div>
        <div class="${SCRIPT_PREFIX}-outgoing">
          <label class="${SCRIPT_PREFIX}-check"><input type="checkbox" class="${SCRIPT_PREFIX}-outgoing-enabled"> <span>Translate my messages before sending</span></label>
          <label>Translate my messages to<select class="${SCRIPT_PREFIX}-outgoing-target"></select></label>
          <small>When enabled, Enter or Send translates first and then sends. Left-click only translates the draft.</small>
        </div>
        <button class="${SCRIPT_PREFIX}-services-button" type="button">Translation services...</button>
        <div class="${SCRIPT_PREFIX}-section-title">Rate limiting</div>
        <div class="${SCRIPT_PREFIX}-limits">
          <label><span class="${SCRIPT_PREFIX}-field-title">Requests per minute</span>
            <input type="number" class="${SCRIPT_PREFIX}-rpm" min="1" max="60" step="1">
            <small>Recommended: 15. Lower this if Google returns rate-limit errors.</small>
          </label>
          <label><span class="${SCRIPT_PREFIX}-field-title">Maximum pending messages</span>
            <input type="number" class="${SCRIPT_PREFIX}-queue-size" min="5" max="200" step="1">
            <small>Older pending messages are discarded when this fills up.</small>
          </label>
          <label><span class="${SCRIPT_PREFIX}-field-title">Message lifetime</span>
            <input type="number" class="${SCRIPT_PREFIX}-max-age" min="5" max="300" step="1">
            <small>Seconds before an untranslated message is considered stale.</small>
          </label>
          <label><span class="${SCRIPT_PREFIX}-field-title">Maximum viewers</span>
            <input type="number" class="${SCRIPT_PREFIX}-max-viewers" min="0" max="10000000" step="1">
            <small>Translate only at or below this count. Use 0 to disable it. <span class="${SCRIPT_PREFIX}-viewer-status"></span></small>
          </label>
        </div>
        <p class="${SCRIPT_PREFIX}-note">Newest messages are translated first. Repeated rate-limit responses automatically pause translation for five minutes.</p>
        <div class="${SCRIPT_PREFIX}-footer">
          <span class="${SCRIPT_PREFIX}-version">v${SCRIPT_VERSION}</span>
          <button class="${SCRIPT_PREFIX}-save">Save settings</button>
        </div>
      </section>`;

    const select = overlay.querySelector(`.${SCRIPT_PREFIX}-language`);
    const outgoingSelect = overlay.querySelector(`.${SCRIPT_PREFIX}-outgoing-target`);
    for (const [code, name] of Object.entries(LANGUAGES)) {
      if (code === 'auto') continue;
      select.add(new Option(name, code, false, code === state.target));
      outgoingSelect.add(new Option(name, code, false, code === state.outgoingTarget));
    }
    overlay.querySelector(`.${SCRIPT_PREFIX}-enabled`).checked = state.enabled;
    overlay.querySelector(`.${SCRIPT_PREFIX}-original`).checked = state.showOriginal;
    overlay.querySelector(`.${SCRIPT_PREFIX}-romaji`).checked = state.detectRomaji;
    overlay.querySelector(`.${SCRIPT_PREFIX}-outgoing-enabled`).checked = state.outgoingEnabled;
    overlay.querySelector(`.${SCRIPT_PREFIX}-rpm`).value = state.requestsPerMinute;
    overlay.querySelector(`.${SCRIPT_PREFIX}-queue-size`).value = state.maxQueueSize;
    overlay.querySelector(`.${SCRIPT_PREFIX}-max-age`).value = state.maxMessageAgeSeconds;
    overlay.querySelector(`.${SCRIPT_PREFIX}-max-viewers`).value = state.maxViewerCount;
    const detectedViewers = readViewerCount();
    overlay.querySelector(`.${SCRIPT_PREFIX}-viewer-status`).textContent = detectedViewers === null
      ? 'Viewer count not currently detected.'
      : `Currently detected: ${detectedViewers.toLocaleString()}.`;

    const close = () => overlay.remove();
    overlay.querySelector(`.${SCRIPT_PREFIX}-close`).addEventListener('click', close);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
    overlay.querySelector(`.${SCRIPT_PREFIX}-services-button`).addEventListener('click', openProviderSettings);
    overlay.querySelector(`.${SCRIPT_PREFIX}-save`).addEventListener('click', () => {
      const oldTarget = state.target;
      state.target = select.value;
      state.enabled = overlay.querySelector(`.${SCRIPT_PREFIX}-enabled`).checked;
      state.showOriginal = overlay.querySelector(`.${SCRIPT_PREFIX}-original`).checked;
      state.detectRomaji = overlay.querySelector(`.${SCRIPT_PREFIX}-romaji`).checked;
      state.outgoingEnabled = overlay.querySelector(`.${SCRIPT_PREFIX}-outgoing-enabled`).checked;
      if (!state.outgoingEnabled) {
        state.aiOutgoingOverride = false;
        GM_setValue('aiOutgoingOverride', false);
      }
      state.outgoingTarget = outgoingSelect.value;
      state.requestsPerMinute = clampNumber(overlay.querySelector(`.${SCRIPT_PREFIX}-rpm`).value, 1, 60, 15);
      state.maxQueueSize = clampNumber(overlay.querySelector(`.${SCRIPT_PREFIX}-queue-size`).value, 5, 200, 50);
      state.maxMessageAgeSeconds = clampNumber(overlay.querySelector(`.${SCRIPT_PREFIX}-max-age`).value, 5, 300, 30);
      state.maxViewerCount = clampNumber(overlay.querySelector(`.${SCRIPT_PREFIX}-max-viewers`).value, 0, 10000000, 0);
      GM_setValue('targetLanguage', state.target);
      GM_setValue('enabled', state.enabled);
      GM_setValue('showOriginal', state.showOriginal);
      GM_setValue('detectRomaji', state.detectRomaji);
      GM_setValue('outgoingEnabled', state.outgoingEnabled);
      GM_setValue('outgoingTarget', state.outgoingTarget);
      updateComposerButton();
      GM_setValue('requestsPerMinute', state.requestsPerMinute);
      GM_setValue('maxQueueSize', state.maxQueueSize);
      GM_setValue('maxMessageAgeSeconds', state.maxMessageAgeSeconds);
      GM_setValue('maxViewerCount', state.maxViewerCount);
      while (state.queue.length > state.maxQueueSize) state.queue.shift();
      state.viewerEligible = null;
      refreshViewerEligibility();
      if (state.showOriginal) restoreOriginalMessages();
      if (oldTarget !== state.target) {
        document.querySelectorAll(`.${SCRIPT_PREFIX}-translation`).forEach((node) => node.remove());
        document.querySelectorAll(MESSAGE_SELECTOR).forEach((node) => delete node.dataset[`${SCRIPT_PREFIX}Handled`]);
      }
      close();
      if (state.enabled) {
        bindChatObserver();
        scanExistingMessages();
      } else {
        state.queue.length = 0;
        stopChatObserver();
      }
      showToast(`Translating Twitch chat to ${LANGUAGES[state.target]}`);
    });
    document.body.append(overlay);
  }

  function showToast(message) {
    document.querySelector(`.${SCRIPT_PREFIX}-toast`)?.remove();
    const toast = document.createElement('div');
    toast.className = `${SCRIPT_PREFIX}-toast`;
    toast.textContent = message;
    document.body.append(toast);
    setTimeout(() => toast.remove(), 2800);
  }

  function clampNumber(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  }

  function addStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .${SCRIPT_PREFIX}-translation { display:flex; align-items:baseline; flex-wrap:wrap; gap:.4rem; margin:.3rem 0 .1rem; color:#adadb8; opacity:.5; font-size:1.3rem; font-style:italic; line-height:1.3; transition:opacity .15s ease; }
      .${SCRIPT_PREFIX}-translation:hover { opacity:.8; }
      .${SCRIPT_PREFIX}-icon { color:#8b8b96; font-size:1.05rem; font-style:normal; white-space:nowrap; }
      .${SCRIPT_PREFIX}-copy { color:#b8b8c2; }
      .${SCRIPT_PREFIX}-source-badge { display:inline-flex; align-items:center; align-self:center; border:1px solid #53535f; border-radius:.3rem; padding:.05rem .35rem; color:#adadb8; background:#26262c; cursor:help; font-size:.9rem; font-style:normal; font-weight:700; line-height:1.25; letter-spacing:.04em; }
      .${SCRIPT_PREFIX}-composer-host { position:relative !important; }
      .${SCRIPT_PREFIX}-composer-button { position:absolute; z-index:4; top:50%; right:3.5rem; display:grid; width:2.7rem; height:2.7rem; place-items:center; transform:translateY(-50%); border:0; border-radius:.5rem; padding:0; color:#adadb8; background:#18181b; cursor:pointer; font:600 1.35rem/1 Inter,Arial,sans-serif; opacity:.9; transition:color .15s ease,background .15s ease,opacity .15s ease; }
      .${SCRIPT_PREFIX}-composer-button:hover { color:#efeff1; background:#323239; opacity:1; }
      .${SCRIPT_PREFIX}-composer-button.${SCRIPT_PREFIX}-active { color:#00c274; }
      .${SCRIPT_PREFIX}-composer-button.${SCRIPT_PREFIX}-active:hover { color:#20df91; background:rgba(0,194,116,.12); }
      .${SCRIPT_PREFIX}-composer-button.${SCRIPT_PREFIX}-loading { animation:${SCRIPT_PREFIX}-pulse .7s ease-in-out infinite alternate; }
      @keyframes ${SCRIPT_PREFIX}-pulse { from { opacity:.35; } to { opacity:1; } }
      .${SCRIPT_PREFIX}-overlay { position:fixed; inset:0; z-index:999999; display:grid; place-items:center; padding:2rem; background:rgba(0,0,0,.72); font-family:Inter,Arial,sans-serif; }
      .${SCRIPT_PREFIX}-overlay.${SCRIPT_PREFIX}-paired { grid-template-columns:minmax(0,54rem) minmax(0,46rem); align-items:center; justify-content:center; gap:1.6rem; }
      .${SCRIPT_PREFIX}-overlay.${SCRIPT_PREFIX}-paired > .${SCRIPT_PREFIX}-settings { width:100%; }
      .${SCRIPT_PREFIX}-settings { position:relative; width:min(54rem,100%); max-height:calc(100vh - 4rem); overflow:auto; box-sizing:border-box; border:1px solid #35353b; border-radius:1.2rem; padding:2.4rem; color:#efeff1; background:#18181b; box-shadow:0 1.2rem 4rem rgba(0,0,0,.55); }
      .${SCRIPT_PREFIX}-settings h2 { margin:0 0 2rem; padding-right:3rem; font-size:2rem; font-weight:600; }
      .${SCRIPT_PREFIX}-settings label { font-size:1.35rem; font-weight:600; }
      .${SCRIPT_PREFIX}-optional { color:#8b8b96; font-size:1.05rem; font-weight:400; }
      .${SCRIPT_PREFIX}-language-field { display:block; margin-bottom:1.6rem; }
      .${SCRIPT_PREFIX}-settings select, .${SCRIPT_PREFIX}-settings input[type="number"], .${SCRIPT_PREFIX}-settings input[type="password"], .${SCRIPT_PREFIX}-settings input[type="text"], .${SCRIPT_PREFIX}-settings input[type="url"] { display:block; width:100%; height:4rem; box-sizing:border-box; margin-top:.7rem; border:1px solid #67676b; border-radius:.6rem; padding:0 1.1rem; color:#efeff1; background:#0e0e10; outline:none; }
      .${SCRIPT_PREFIX}-settings textarea { display:block; width:100%; box-sizing:border-box; margin-top:.7rem; border:1px solid #67676b; border-radius:.6rem; padding:1rem 1.1rem; resize:vertical; color:#efeff1; background:#0e0e10; outline:none; font:inherit; font-weight:400; }
      .${SCRIPT_PREFIX}-settings select:focus, .${SCRIPT_PREFIX}-settings input:focus, .${SCRIPT_PREFIX}-settings textarea:focus { border-color:#a970ff; box-shadow:0 0 0 1px #a970ff; }
      .${SCRIPT_PREFIX}-settings select:disabled { color:#bf94ff; border-color:#6642a3; opacity:.85; cursor:not-allowed; }
      .${SCRIPT_PREFIX}-toggles { display:grid; gap:1rem; border-top:1px solid #2f2f35; padding:1.6rem 0; }
      .${SCRIPT_PREFIX}-settings .${SCRIPT_PREFIX}-check { display:flex; gap:.9rem; align-items:center; margin:0; font-weight:400; cursor:pointer; }
      .${SCRIPT_PREFIX}-check input { width:1.6rem; height:1.6rem; margin:0; accent-color:#9147ff; }
      .${SCRIPT_PREFIX}-outgoing { display:grid; grid-template-columns:1fr 1fr; gap:1rem 1.4rem; margin-bottom:1.8rem; border:1px solid #303038; border-radius:.8rem; padding:1.4rem; background:#1f1f23; }
      .${SCRIPT_PREFIX}-outgoing .${SCRIPT_PREFIX}-check { align-self:end; padding-bottom:1.05rem; }
      .${SCRIPT_PREFIX}-outgoing small { grid-column:1/-1; margin:0; }
      .${SCRIPT_PREFIX}-services-button { width:100%; margin:0 0 1.8rem; border:1px solid #67676b; border-radius:.6rem; padding:1rem 1.2rem; color:#efeff1; background:#26262c; cursor:pointer; font-weight:700; text-align:left; }
      .${SCRIPT_PREFIX}-services-button:hover { border-color:#a970ff; background:#323239; }
      .${SCRIPT_PREFIX}-service-settings { width:min(46rem,100%); }
      .${SCRIPT_PREFIX}-providers { display:grid; grid-template-columns:1fr 1fr; gap:1rem 1.4rem; margin-bottom:1.8rem; border:1px solid #303038; border-radius:.8rem; padding:1.4rem; background:#1f1f23; }
      .${SCRIPT_PREFIX}-providers .${SCRIPT_PREFIX}-api-key, .${SCRIPT_PREFIX}-providers small { grid-column:1/-1; }
      .${SCRIPT_PREFIX}-ai-settings { display:grid; grid-template-columns:1fr 1fr; gap:1rem 1.4rem; border:1px solid #303038; border-radius:.8rem; padding:1.4rem; background:#1f1f23; }
      .${SCRIPT_PREFIX}-ai-settings .${SCRIPT_PREFIX}-wide { grid-column:1/-1; }
      .${SCRIPT_PREFIX}-section-title { margin:0 0 1rem; padding-top:.2rem; color:#dedee3; font-size:1.25rem; font-weight:700; letter-spacing:.04em; text-transform:uppercase; }
      .${SCRIPT_PREFIX}-limits { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1rem; }
      .${SCRIPT_PREFIX}-limits label { display:grid; grid-template-rows:3.6rem 4rem 1fr; align-content:start; min-width:0; margin:0; border:1px solid #303038; border-radius:.8rem; padding:1.2rem; background:#1f1f23; }
      .${SCRIPT_PREFIX}-field-title { display:flex; align-items:flex-start; line-height:1.3; }
      .${SCRIPT_PREFIX}-limits input[type="number"] { margin:0; }
      .${SCRIPT_PREFIX}-settings small { display:block; margin-top:.8rem; color:#adadb8; font-size:1.1rem; font-weight:400; line-height:1.4; }
      .${SCRIPT_PREFIX}-note { margin:1.4rem 0 0; border-radius:.6rem; padding:1rem 1.2rem; color:#adadb8; background:#202025; font-size:1.2rem; line-height:1.45; }
      .${SCRIPT_PREFIX}-footer { display:flex; align-items:flex-end; justify-content:space-between; gap:1.5rem; margin-top:1.6rem; }
      .${SCRIPT_PREFIX}-version { color:#73737d; font-size:1.1rem; line-height:1; user-select:none; }
      .${SCRIPT_PREFIX}-save { min-width:11rem; border:0; border-radius:.6rem; padding:1rem 1.5rem; color:white; background:#9147ff; cursor:pointer; font-weight:700; }
      .${SCRIPT_PREFIX}-save:hover { background:#772ce8; }
      .${SCRIPT_PREFIX}-close { position:absolute; top:1.35rem; right:1.5rem; display:grid; width:3.2rem; height:3.2rem; place-items:center; border:0; border-radius:.5rem; padding:0; color:#adadb8; background:none; cursor:pointer; font-size:2.4rem; line-height:1; }
      .${SCRIPT_PREFIX}-close:hover { color:#efeff1; background:#29292e; }
      .${SCRIPT_PREFIX}-toast { position:fixed; z-index:1000000; right:2rem; bottom:2rem; border-radius:.6rem; padding:1.2rem 1.6rem; color:#efeff1; background:#18181b; box-shadow:0 .5rem 2rem rgba(0,0,0,.5); font:600 1.4rem Inter,Arial,sans-serif; }
      @media (max-width:720px) { .${SCRIPT_PREFIX}-overlay.${SCRIPT_PREFIX}-paired { grid-template-columns:1fr; align-content:start; overflow:auto; } .${SCRIPT_PREFIX}-overlay.${SCRIPT_PREFIX}-paired > .${SCRIPT_PREFIX}-settings { max-height:none; } }
      @media (max-width:600px) { .${SCRIPT_PREFIX}-overlay { padding:1rem; } .${SCRIPT_PREFIX}-settings { max-height:calc(100vh - 2rem); padding:2rem; } .${SCRIPT_PREFIX}-outgoing, .${SCRIPT_PREFIX}-providers, .${SCRIPT_PREFIX}-ai-settings { grid-template-columns:1fr; } .${SCRIPT_PREFIX}-outgoing .${SCRIPT_PREFIX}-check { padding-bottom:0; } .${SCRIPT_PREFIX}-outgoing small, .${SCRIPT_PREFIX}-providers .${SCRIPT_PREFIX}-api-key, .${SCRIPT_PREFIX}-providers small, .${SCRIPT_PREFIX}-ai-settings .${SCRIPT_PREFIX}-wide { grid-column:auto; } .${SCRIPT_PREFIX}-limits { grid-template-columns:1fr; } .${SCRIPT_PREFIX}-limits label { grid-template-rows:auto 4rem auto; } .${SCRIPT_PREFIX}-field-title { margin-bottom:.7rem; } }
    `;
    document.head.append(style);
  }
})();
