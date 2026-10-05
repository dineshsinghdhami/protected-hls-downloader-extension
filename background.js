// Blob Video Downloader background service worker.
// Detects media, collapses HLS variants, and coordinates persistent offscreen downloads.

const detectedVideos = {};
const sessionRulesByDownload = new Map();
// Top-to-bottom media order captured from the page DOM.
const pageMediaOrderByTab = new Map();
const pagePlayerMetaByTab = new Map();
let nextRuleId = 1000;
const JOBS_KEY = 'download_jobs_v2';

function storageKey(tabId) { return `tab_${tabId}`; }
function now() { return Date.now(); }

function simpleHash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function normalizedIdentity(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`.toLowerCase();
  } catch (_) { return String(url || '').split('?')[0].toLowerCase(); }
}

function videoIdFor(url, frameId = -1) {
  return `v_${simpleHash(`${frameId}|${normalizedIdentity(url)}`)}`;
}

async function loadTabVideos(tabId) {
  if (detectedVideos[tabId]) return detectedVideos[tabId];
  const data = await chrome.storage.local.get(storageKey(tabId));
  detectedVideos[tabId] = Array.isArray(data[storageKey(tabId)]) ? data[storageKey(tabId)] : [];
  return detectedVideos[tabId];
}

chrome.tabs.onRemoved.addListener((tabId) => {
  delete detectedVideos[tabId];
  pageMediaOrderByTab.delete(tabId);
  pagePlayerMetaByTab.delete(tabId);
  displayCacheByTab.delete(tabId);
  chrome.storage.local.remove([storageKey(tabId), displayCacheKey(tabId)]);
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0) {
    detectedVideos[details.tabId] = [];
    pageMediaOrderByTab.delete(details.tabId);
    pagePlayerMetaByTab.delete(details.tabId);
    displayCacheByTab.delete(details.tabId);
    chrome.storage.local.remove([storageKey(details.tabId), displayCacheKey(details.tabId)]);
    updateBadge(details.tabId, 0);
  }
});

function getFriendlyFilename(url) {
  try {
    const urlObj = new URL(url);
    let name = urlObj.pathname.substring(urlObj.pathname.lastIndexOf('/') + 1);
    name = decodeURIComponent(name).split('?')[0];
    if (!name || ['index.m3u8', 'playlist.m3u8', 'master.m3u8', 'manifest.mpd', 'video.mp4'].includes(name.toLowerCase())) return '';
    return name;
  } catch (_) { return ''; }
}

function safePageUrl(value) {
  if (!value || value === 'null') return '';
  try {
    const u = new URL(value);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : '';
  } catch (_) { return ''; }
}

function sanitizeReplayHeaders(headers = []) {
  const blocked = new Set([
    'cookie', 'cookie2', 'host', 'origin', 'referer', 'user-agent', 'connection',
    'content-length', 'accept-encoding', 'sec-fetch-dest', 'sec-fetch-mode',
    'sec-fetch-site', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'
  ]);
  const out = {};
  for (const item of headers) {
    if (!item?.name || item.value == null) continue;
    const name = item.name.toLowerCase();
    if (blocked.has(name) || name.startsWith('proxy-')) continue;
    if (name === 'authorization' || name === 'accept' || name === 'accept-language' ||
        name === 'cache-control' || name === 'pragma' || name.startsWith('x-')) out[name] = item.value;
  }
  return out;
}

function extractBrowserContextHeaders(headers = []) {
  const out = {};
  for (const item of headers) {
    if (!item?.name || item.value == null) continue;
    const name = item.name.toLowerCase();
    if (name === 'referer' || name === 'origin') out[name] = item.value;
  }
  return out;
}

async function addDetectedVideo(tabId, url, type, title = '', context = {}) {
  const list = await loadTabVideos(tabId);
  const pageUrl = safePageUrl(context.pageUrl || context.documentUrl || context.initiator);
  const requestHeaders = context.requestHeaders || {};
  const browserHeaders = context.browserHeaders || {};
  const frameId = Number.isInteger(context.frameId) ? context.frameId : -1;
  const identity = normalizedIdentity(url);
  const existing = list.find(v => normalizedIdentity(v.url) === identity && (v.frameId ?? -1) === frameId);

  if (existing) {
    if (pageUrl) existing.pageUrl = pageUrl;
    if (Object.keys(requestHeaders).length) existing.requestHeaders = { ...(existing.requestHeaders || {}), ...requestHeaders };
    if (Object.keys(browserHeaders).length) existing.browserHeaders = { ...(existing.browserHeaders || {}), ...browserHeaders };
    if (title && (!existing.title || existing.title === 'Detected Video')) existing.title = title;
    existing.detectedAt = now();
    await chrome.storage.local.set({ [storageKey(tabId)]: list });
    return;
  }

  const filename = getFriendlyFilename(url);
  list.push({
    id: videoIdFor(url, frameId), url, type, filename,
    title: title || filename || 'Detected Video', pageUrl,
    requestHeaders, browserHeaders, frameId,
    parentFrameId: Number.isInteger(context.parentFrameId) ? context.parentFrameId : -1,
    detectedAt: now()
  });
  await chrome.storage.local.set({ [storageKey(tabId)]: list });
  updateBadge(tabId, list.length);
}

function updateBadge(tabId, count) {
  chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#6366f1' }).catch(() => {});
}

function detectType(url) {
  const lower = url.toLowerCase();
  if (lower.includes('.m3u8') || lower.includes('/m3u8')) return 'HLS (m3u8)';
  if (lower.includes('.mp4') || lower.includes('/mp4/')) return 'MP4';
  if (lower.includes('.webm') || lower.includes('/webm/')) return 'WEBM';
  if (lower.includes('.mpd') || lower.includes('/mpd/')) return 'DASH (mpd)';
  return null;
}

chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (details.tabId == null || details.tabId === -1) return;
  const type = detectType(details.url);
  if (!type) return;
  addDetectedVideo(details.tabId, details.url, type, '', {
    pageUrl: details.documentUrl || details.initiator,
    frameId: details.frameId,
    parentFrameId: details.parentFrameId
  }).catch(console.error);
}, { urls: ['<all_urls>'] });

chrome.webRequest.onBeforeSendHeaders.addListener((details) => {
  if (details.tabId == null || details.tabId === -1) return;
  const type = detectType(details.url);
  if (!type) return;
  addDetectedVideo(details.tabId, details.url, type, '', {
    pageUrl: details.documentUrl || details.initiator,
    requestHeaders: sanitizeReplayHeaders(details.requestHeaders || []),
    browserHeaders: extractBrowserContextHeaders(details.requestHeaders || []),
    frameId: details.frameId,
    parentFrameId: details.parentFrameId
  }).catch(console.error);
}, { urls: ['<all_urls>'] }, ['requestHeaders', 'extraHeaders']);

async function createContextRule(sessionId, pageUrl, targetUrl, browserHeaders = {}) {
  const page = safePageUrl(pageUrl);
  if (!page) return;
  let host, origin;
  try {
    host = new URL(targetUrl).hostname;
    origin = browserHeaders.origin || new URL(page).origin;
  } catch (_) { return; }
  if (!host) return;
  if (!sessionRulesByDownload.has(sessionId)) sessionRulesByDownload.set(sessionId, new Map());
  const hostMap = sessionRulesByDownload.get(sessionId);
  if (hostMap.has(host)) return;

  const id = nextRuleId++;
  const rule = {
    id, priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [
      { header: 'Referer', operation: 'set', value: browserHeaders.referer || page },
      ...(origin ? [{ header: 'Origin', operation: 'set', value: origin }] : [])
    ]},
    condition: { requestDomains: [host], resourceTypes: ['xmlhttprequest'] }
  };
  await chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule], removeRuleIds: [] });
  hostMap.set(host, id);
}

async function removeDownloadRules(sessionId) {
  const hostMap = sessionRulesByDownload.get(sessionId);
  if (!hostMap) return;
  const ids = [...hostMap.values()];
  sessionRulesByDownload.delete(sessionId);
  if (ids.length) {
    try { await chrome.declarativeNetRequest.updateSessionRules({ addRules: [], removeRuleIds: ids }); }
    catch (err) { console.warn('Could not remove temporary media rules:', err); }
  }
}

function parseMasterVariantUrls(text, baseUrl) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('#EXT-X-STREAM-INF:')) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const c = lines[j].trim();
      if (!c) continue;
      if (!c.startsWith('#')) {
        try { out.push(new URL(c, baseUrl).href); } catch (_) {}
        break;
      }
    }
  }
  return out;
}

async function fetchPlaylistForClassification(video, sessionId) {
  try {
    await createContextRule(sessionId, video.pageUrl, video.url, video.browserHeaders || {});
    const response = await fetch(video.url, {
      headers: video.requestHeaders || {}, credentials: 'include', cache: 'no-store'
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (!text.includes('#EXTM3U')) return null;
    return { isMaster: text.includes('#EXT-X-STREAM-INF'), variants: parseMasterVariantUrls(text, video.url) };
  } catch (_) { return null; }
}

function variantishParentKey(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    parts.pop(); // playlist filename
    if (!parts.length) return `${u.origin}/`;
    const last = parts[parts.length - 1].toLowerCase();
    const variantish = /^(?:\d{3,4}p|\d{2,6}(?:k|kbps)?|\d{2,5}x\d{2,5}|low|medium|high|sd|hd|fhd|uhd|4k|audio|video|variant[-_]?\d+|level[-_]?\d+|rendition[-_]?\d+)$/i;
    if (variantish.test(last)) parts.pop();
    return `${u.origin}/${parts.join('/')}`.toLowerCase();
  } catch (_) { return normalizedIdentity(url); }
}


function pageIdentity(value) {
  try {
    const u = new URL(value);
    return `${u.origin}${u.pathname}`.replace(/\/$/, '').toLowerCase();
  } catch (_) { return String(value || '').split('?')[0].replace(/\/$/, '').toLowerCase(); }
}

function orderForVideo(tabId, video) {
  const meta = pagePlayerMetaByTab.get(tabId) || {};
  const frameIds = Array.isArray(meta.frameIds) ? meta.frameIds : [];
  const vf = Number.isInteger(video.frameId) ? video.frameId : -1;
  if (vf >= 0) {
    const fi = frameIds.indexOf(vf);
    if (fi >= 0) return fi;
  }

  const order = pageMediaOrderByTab.get(tabId) || [];
  if (!order.length) return Number.POSITIVE_INFINITY;
  const candidates = [video.pageUrl, video.documentUrl, video.url].filter(Boolean).map(pageIdentity);
  for (let i = 0; i < order.length; i++) {
    const key = pageIdentity(order[i]);
    if (!key) continue;
    if (candidates.some(c => c === key || c.startsWith(key + '/') || key.startsWith(c + '/'))) return i;
  }
  return Number.POSITIVE_INFINITY;
}


function displayCacheKey(tabId) { return `display_cache_${tabId}`; }
const displayCacheByTab = new Map();

async function saveDisplayCache(tabId, videos) {
  displayCacheByTab.set(tabId, videos || []);
  try { await chrome.storage.local.set({ [displayCacheKey(tabId)]: videos || [] }); } catch (_) {}
}

async function getCachedDisplayVideos(tabId) {
  if (displayCacheByTab.has(tabId)) return displayCacheByTab.get(tabId) || [];
  try {
    const data = await chrome.storage.local.get(displayCacheKey(tabId));
    const cached = data[displayCacheKey(tabId)];
    if (Array.isArray(cached)) {
      displayCacheByTab.set(tabId, cached);
      return cached;
    }
  } catch (_) {}
  return [];
}

// Fast, network-free approximation used only for instant popup startup.
// The full classifier still runs in the background and replaces this cache.
async function buildFastDisplayVideos(tabId) {
  const raw = await loadTabVideos(tabId);
  if (!raw.length) return [];

  const exactMap = new Map();
  for (const v of raw) {
    const key = `${normalizedIdentity(v.url)}|f${v.frameId ?? -1}`;
    const prev = exactMap.get(key);
    if (!prev || (v.detectedAt || 0) > (prev.detectedAt || 0)) exactMap.set(key, v);
  }
  const unique = [...exactMap.values()];
  const hls = unique.filter(v => v.type?.includes('HLS'));
  const others = unique.filter(v => !v.type?.includes('HLS'));

  // One representative per apparent stream family inside each player/frame.
  const grouped = new Map();
  for (const v of hls) {
    const framePart = (v.frameId ?? -1) >= 0 ? `f${v.frameId}` : 'f?';
    const key = `${framePart}|${variantishParentKey(v.url)}`;
    const prev = grouped.get(key);
    if (!prev || (v.detectedAt || 0) < (prev.detectedAt || 0)) grouped.set(key, v);
  }

  let output = [...grouped.values(), ...others].sort((a, b) => {
    const ao = orderForVideo(tabId, a);
    const bo = orderForVideo(tabId, b);
    if (ao !== bo) return ao - bo;
    const af = Number.isInteger(a.frameId) ? a.frameId : Number.MAX_SAFE_INTEGER;
    const bf = Number.isInteger(b.frameId) ? b.frameId : Number.MAX_SAFE_INTEGER;
    if (af !== bf) return af - bf;
    return (a.detectedAt || 0) - (b.detectedAt || 0);
  });

  const meta = pagePlayerMetaByTab.get(tabId) || {};
  const playerCount = Number(meta.playerCount || 0);
  if (playerCount > 0 && output.length > playerCount) output = output.slice(0, playerCount);
  return output.map((v, i) => ({ ...v, displayTitle: `Video ${i + 1}`, pageOrder: orderForVideo(tabId, v) }));
}

async function buildDisplayVideos(tabId) {
  const raw = await loadTabVideos(tabId);
  if (!raw.length) return [];

  // Exact URL/path duplicates are one stream even if the signed query changed.
  const exactMap = new Map();
  for (const v of raw) {
    const key = normalizedIdentity(v.url);
    const prev = exactMap.get(key);
    if (!prev || (v.detectedAt || 0) > (prev.detectedAt || 0)) exactMap.set(key, v);
  }
  const unique = [...exactMap.values()];
  const hls = unique.filter(v => v.type?.includes('HLS'));
  const others = unique.filter(v => !v.type?.includes('HLS'));

  const classifySession = `classify_${tabId}_${Date.now()}`;
  const classifications = new Map();
  let cursor = 0;
  const worker = async () => {
    while (cursor < hls.length) {
      const idx = cursor++;
      const v = hls[idx];
      classifications.set(v.id || v.url, await fetchPlaylistForClassification(v, classifySession));
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, hls.length) }, () => worker()));
  await removeDownloadRules(classifySession);

  const childIds = new Set();
  const masters = new Set();
  for (const v of hls) {
    const c = classifications.get(v.id || v.url);
    if (c?.isMaster) {
      masters.add(v.id || v.url);
      for (const child of c.variants) childIds.add(normalizedIdentity(child));
    }
  }

  let visibleHls = hls.filter(v => masters.has(v.id || v.url) || !childIds.has(normalizedIdentity(v.url)));

  // If the player never exposed a master playlist, collapse obvious quality renditions.
  const grouped = new Map();
  for (const v of visibleHls) {
    const c = classifications.get(v.id || v.url);
    const framePart = (v.frameId ?? -1) >= 0 ? `f${v.frameId}` : 'f?';
    const key = c?.isMaster ? `master|${framePart}|${variantishParentKey(v.url)}` : `media|${framePart}|${variantishParentKey(v.url)}`;
    const prev = grouped.get(key);
    if (!prev || c?.isMaster || (v.detectedAt || 0) < (prev.detectedAt || 0)) grouped.set(key, v);
  }
  visibleHls = [...grouped.values()];

  // Within a single iframe/player, a master is the preferred single representative.
  const byFrame = new Map();
  const noFrame = [];
  for (const v of visibleHls) {
    const frameId = v.frameId ?? -1;
    if (frameId < 0) { noFrame.push(v); continue; }
    if (!byFrame.has(frameId)) byFrame.set(frameId, []);
    byFrame.get(frameId).push(v);
  }
  const collapsedFrame = [];
  for (const group of byFrame.values()) {
    if (group.length === 1) { collapsedFrame.push(group[0]); continue; }
    const master = group.find(v => classifications.get(v.id || v.url)?.isMaster);
    if (master) collapsedFrame.push(master);
    else {
      // Only collapse same apparent stream family; otherwise keep distinct media playlists.
      const families = new Map();
      for (const v of group) {
        const k = variantishParentKey(v.url);
        if (!families.has(k)) families.set(k, v);
      }
      collapsedFrame.push(...families.values());
    }
  }

  let output = [...collapsedFrame, ...noFrame, ...others]
    .sort((a, b) => {
      const ao = orderForVideo(tabId, a);
      const bo = orderForVideo(tabId, b);
      if (ao !== bo) return ao - bo;
      const af = Number.isInteger(a.frameId) ? a.frameId : Number.MAX_SAFE_INTEGER;
      const bf = Number.isInteger(b.frameId) ? b.frameId : Number.MAX_SAFE_INTEGER;
      if (af !== bf) return af - bf;
      return (a.detectedAt || 0) - (b.detectedAt || 0);
    });

  // The actual visible player count is the source of truth. Network HLS traffic can
  // contain helper/audio/quality playlists that are not separate page videos.
  const meta = pagePlayerMetaByTab.get(tabId) || {};
  const playerCount = Number(meta.playerCount || 0);
  if (playerCount > 0 && output.length > playerCount) {
    // Prefer streams that mapped to a real page frame/order, then fill any missing
    // slots with the earliest remaining detections.
    const mapped = output.filter(v => Number.isFinite(orderForVideo(tabId, v)));
    const unmapped = output.filter(v => !Number.isFinite(orderForVideo(tabId, v)));
    output = [...mapped, ...unmapped].slice(0, playerCount);
  }

  output = output.map((v, i) => ({ ...v, displayTitle: `Video ${i + 1}`, pageOrder: orderForVideo(tabId, v) }));
  updateBadge(tabId, output.length);
  await saveDisplayCache(tabId, output);
  return output;
}

function genericTitle(title, url) {
  const t = String(title || '').trim().toLowerCase();
  let base = '';
  try { base = new URL(url).pathname.split('/').pop()?.toLowerCase() || ''; } catch (_) {}
  return !t || t === 'detected video' || t === base || ['playlist.m3u8', 'master.m3u8', 'index.m3u8'].includes(t);
}

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL('offscreen.html');
  if (chrome.runtime.getContexts) {
    const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
    if (existing.length) return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['BLOBS'],
      justification: 'Keep authorized HLS downloads running after the popup closes and assemble the finished media file.'
    });
  } catch (err) {
    if (!String(err?.message || err).includes('Only a single offscreen')) throw err;
  }
}

async function getJobs() {
  const data = await chrome.storage.local.get(JOBS_KEY);
  return data[JOBS_KEY] || {};
}
async function setJob(jobId, patch) {
  const jobs = await getJobs();
  jobs[jobId] = { ...(jobs[jobId] || {}), ...patch, updatedAt: now() };
  await chrome.storage.local.set({ [JOBS_KEY]: jobs });
  return jobs[jobId];
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === 'offscreen') return false;
  (async () => {
    if (message.action === 'getDetectedVideos') {
      sendResponse({ videos: await loadTabVideos(message.tabId) }); return;
    }
    if (message.action === 'getDisplayVideos') {
      sendResponse({ videos: await buildDisplayVideos(message.tabId) }); return;
    }
    if (message.action === 'getCachedDisplayVideos') {
      let videos = await getCachedDisplayVideos(message.tabId);
      if (!videos.length) videos = await buildFastDisplayVideos(message.tabId);
      sendResponse({ videos }); return;
    }
    if (message.action === 'refreshDisplayVideos') {
      const videos = await buildDisplayVideos(message.tabId);
      sendResponse({ videos }); return;
    }
    if (message.action === 'setPageMediaOrder') {
      const order = Array.isArray(message.urls) ? message.urls.filter(Boolean) : [];
      const frameIds = Array.isArray(message.frameIds) ? message.frameIds.filter(Number.isInteger) : [];
      const playerCount = Math.max(0, Number(message.playerCount || order.length || frameIds.length || 0));
      pageMediaOrderByTab.set(message.tabId, order);
      pagePlayerMetaByTab.set(message.tabId, { frameIds, playerCount });
      sendResponse({ success: true, count: order.length, frameCount: frameIds.length, playerCount });
      return;
    }

    if (message.action === 'addScrapedVideos') {
      if (Array.isArray(message.videos)) {
        for (const v of message.videos) await addDetectedVideo(message.tabId, v.url, v.type, v.title, {
          pageUrl: v.pageUrl || message.pageUrl, frameId: v.frameId ?? -1
        });
      }
      sendResponse({ success: true }); return;
    }
    if (message.action === 'clearDetectedVideos') {
      detectedVideos[message.tabId] = [];
      displayCacheByTab.delete(message.tabId);
      await chrome.storage.local.remove([storageKey(message.tabId), displayCacheKey(message.tabId)]);
      updateBadge(message.tabId, 0);
      sendResponse({ success: true }); return;
    }
    if (message.action === 'startDownloadSession' || message.action === 'ensureDownloadHost') {
      await createContextRule(message.sessionId, message.pageUrl, message.targetUrl, message.browserHeaders || {});
      sendResponse({ success: true }); return;
    }
    if (message.action === 'endDownloadSession') {
      await removeDownloadRules(message.sessionId); sendResponse({ success: true }); return;
    }
    if (message.action === 'startHlsDownload') {
      await ensureOffscreenDocument();
      const jobId = message.jobId || `job_${simpleHash(message.video.url)}_${Date.now()}`;
      await setJob(jobId, {
        id: jobId, tabId: message.tabId, videoId: message.video.id, filename: message.filename,
        status: 'Starting…', progress: 0, state: 'running', error: '', startedAt: now()
      });
      const result = await chrome.runtime.sendMessage({
        target: 'offscreen', action: 'runHlsDownload', jobId,
        video: message.video, filename: message.filename, fallbackPageUrl: message.pageUrl
      });
      if (result?.success === false) throw new Error(result.error || 'Could not start background download.');
      sendResponse({ success: true, jobId }); return;
    }
    if (message.action === 'cancelHlsDownload') {
      const result = await chrome.runtime.sendMessage({ target: 'offscreen', action: 'cancelHlsDownload', jobId: message.jobId });
      sendResponse(result || { success: true }); return;
    }
    if (message.action === 'downloadProgress') {
      await setJob(message.jobId, {
        status: message.status, progress: message.progress, state: message.state || 'running', error: message.error || ''
      });
      sendResponse({ success: true }); return;
    }
    if (message.action === 'saveCompletedBlob') {
      const downloadId = await new Promise((resolve, reject) => {
        chrome.downloads.download({ url: message.blobUrl, filename: message.filename, saveAs: false }, (id) => {
          const err = chrome.runtime.lastError;
          if (err || id == null) reject(new Error(err?.message || 'Chrome could not save the finished video.'));
          else resolve(id);
        });
      });
      await setJob(message.jobId, { state: 'complete', status: 'Complete', progress: 100, chromeDownloadId: downloadId });
      sendResponse({ success: true, downloadId }); return;
    }
    if (message.action === 'getDownloadJobs') {
      sendResponse({ jobs: await getJobs() }); return;
    }
    sendResponse({ success: false, error: 'Unknown action' });
  })().catch(async (err) => {
    console.error(err);
    if (message?.jobId) await setJob(message.jobId, { state: 'error', status: 'Error', error: err.message || String(err) }).catch(() => {});
    sendResponse({ success: false, error: err.message || String(err) });
  });
  return true;
});
