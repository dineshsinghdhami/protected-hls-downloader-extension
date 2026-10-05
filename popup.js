let currentTab = null;
let displayVideos = [];
let downloadJobs = {};
let videosLoadedOnce = false;
let refreshInFlight = false;
let refreshQueued = false;
let interactionUntil = 0;

const JOBS_KEY = 'download_jobs_v2';

document.addEventListener('DOMContentLoaded', async () => {
  const videoListDiv = document.getElementById('video-list');
  const countBadge = document.getElementById('detected-count');
  const clearBtn = document.getElementById('clear-list');

  // Do not rebuild the list while the user is pressing/clicking a control.
  videoListDiv.addEventListener('pointerdown', () => { interactionUntil = Date.now() + 1200; }, true);
  window.addEventListener('pointerup', () => { interactionUntil = Date.now() + 250; }, true);

  const esc = (s) => String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const domainOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return 'Web Page'; } };

  try {
    [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (_) {}
  if (!currentTab?.id) {
    videoListDiv.innerHTML = '<div class="empty-state"><p class="empty-title">Active tab not found</p></div>';
    return;
  }
  const tabId = currentTab.id;

  clearBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'clearDetectedVideos', tabId });
    displayVideos = [];
    render();
  });

  // FAST START: render cached/already-grouped videos before doing any page scan
  // or network playlist classification. This makes opening the popup immediate.
  await refreshJobs();
  try {
    const cached = await chrome.runtime.sendMessage({ action: 'getCachedDisplayVideos', tabId });
    displayVideos = cached?.videos || [];
    render();
    videosLoadedOnce = true;
  } catch (err) {
    console.log('Fast cache note:', err?.message || err);
  }

  // Do the expensive DOM/frame scans AFTER the popup is already visible.
  // Their results silently refine ordering/grouping without blocking startup.
  (async () => {
    try {
      const orderResult = await chrome.scripting.executeScript({
        target: { tabId },
        func: scrapePageMediaOrder
      });
      const scan = orderResult?.[0]?.result || {};
      const urls = scan.urls || [];
      const players = scan.players || [];
      let frameIds = [];
      try {
        const frames = await chrome.webNavigation.getAllFrames({ tabId }) || [];
        const used = new Set();
        const norm = (value) => { try { const u = new URL(value); u.hash = ''; return u.href; } catch (_) { return String(value || ''); } };
        for (const player of players) {
          if (player.kind !== 'iframe' || !player.url) continue;
          const target = norm(player.url);
          let f = frames.find(x => x.frameId !== 0 && !used.has(x.frameId) && norm(x.url) === target);
          if (!f) {
            try {
              const tu = new URL(target);
              f = frames.find(x => {
                if (x.frameId === 0 || used.has(x.frameId)) return false;
                try { const xu = new URL(x.url); return xu.origin === tu.origin && xu.pathname === tu.pathname; } catch (_) { return false; }
              });
            } catch (_) {}
          }
          if (f) { used.add(f.frameId); frameIds.push(f.frameId); }
        }
      } catch (err) {
        console.log('Frame order mapping note:', err?.message || err);
      }
      if (urls.length || players.length) {
        await chrome.runtime.sendMessage({ action: 'setPageMediaOrder', tabId, urls, frameIds, playerCount: players.length });
      }
    } catch (err) {
      console.log('Page order scan note:', err?.message || err);
    }

    try {
      const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: scrapeVideosFromDOM });
      const scraped = [];
      for (const res of results || []) {
        for (const v of res.result?.videos || []) {
          scraped.push({ ...v, pageUrl: v.pageUrl || res.result?.pageUrl || currentTab.url, frameId: res.frameId });
        }
      }
      if (scraped.length) {
        await chrome.runtime.sendMessage({ action: 'addScrapedVideos', tabId, videos: scraped, pageUrl: currentTab.url });
      }
    } catch (err) {
      console.log('Page scan note:', err?.message || err);
    }

    try {
      const refined = await chrome.runtime.sendMessage({ action: 'refreshDisplayVideos', tabId });
      const next = refined?.videos || [];
      const before = videoSignature(displayVideos);
      const after = videoSignature(next);
      displayVideos = next;
      if (before !== after) render();
    } catch (err) {
      console.log('Background grouping note:', err?.message || err);
    }
  })();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[JOBS_KEY]) {
      downloadJobs = changes[JOBS_KEY].newValue || {};
      // Progress changes must NOT rebuild the DOM. Replacing a button while the
      // mouse is down makes the click appear to blink and never fire.
      patchJobProgress();
    }
    if (changes[`tab_${tabId}`]) {
      // Network detections can be very noisy during HLS playback. Refresh gently,
      // and only redraw if the actual grouped video list changed.
      clearTimeout(window.__refreshTimer);
      window.__refreshTimer = setTimeout(() => refreshVideos(false), 900);
    }
  });

  async function refreshJobs() {
    const res = await chrome.runtime.sendMessage({ action: 'getDownloadJobs' });
    downloadJobs = res?.jobs || {};
  }

  function videoSignature(list) {
    return (list || []).map(v => [v.id || '', v.displayTitle || v.title || '', v.url || '', v.type || ''].join('\u001f')).join('\u001e');
  }

  async function refreshVideos(force = false) {
    if (refreshInFlight) { refreshQueued = true; return; }
    if (!force && Date.now() < interactionUntil) {
      clearTimeout(window.__refreshTimer);
      window.__refreshTimer = setTimeout(() => refreshVideos(false), Math.max(300, interactionUntil - Date.now() + 100));
      return;
    }
    refreshInFlight = true;
    const before = videoSignature(displayVideos);
    if (!videosLoadedOnce) {
      videoListDiv.innerHTML = `
        <div class="empty-state compact-state">
          <div class="spinner"></div>
          <p class="empty-title" style="margin-top: 12px;">Grouping video streams…</p>
          <p class="empty-desc">Quality variants are hidden automatically.</p>
        </div>`;
    }
    let nextVideos = displayVideos;
    try {
      const res = await chrome.runtime.sendMessage({ action: 'getCachedDisplayVideos', tabId });
      nextVideos = res?.videos || [];
    } catch (err) {
      console.error(err);
      const data = await chrome.storage.local.get(`tab_${tabId}`);
      nextVideos = data[`tab_${tabId}`] || [];
    } finally {
      refreshInFlight = false;
    }
    const after = videoSignature(nextVideos);
    displayVideos = nextVideos;
    if (!videosLoadedOnce || force || before !== after) render();
    videosLoadedOnce = true;
    if (refreshQueued) { refreshQueued = false; setTimeout(() => refreshVideos(false), 250); }
  }

  function findJob(video) {
    return Object.values(downloadJobs)
      .filter(j => j.videoId === video.id && ['running','complete','error','cancelled'].includes(j.state))
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0];
  }

  function patchJobProgress() {
    document.querySelectorAll('.video-card[data-video-id]').forEach(card => {
      const videoId = card.dataset.videoId;
      const video = displayVideos.find(v => String(v.id) === videoId);
      if (!video) return;
      const job = findJob(video);
      const state = job?.state || 'idle';
      const pct = Math.max(0, Math.min(100, Number(job?.progress || 0)));
      const status = job?.status || (state === 'complete' ? 'Complete' : state === 'error' ? 'Download failed' : '');
      const actions = card.querySelector('.card-actions');
      const progressBox = card.querySelector('.download-progress-container');
      const statusEl = card.querySelector('.progress-status');
      const fill = card.querySelector('.progress-fill');
      const dl = card.querySelector('.btn-dl-action');
      const cancel = card.querySelector('.btn-cancel');
      if (fill) fill.style.width = `${pct}%`;
      if (statusEl) {
        statusEl.textContent = status || 'Starting…';
        statusEl.classList.toggle('status-error', state === 'error');
        statusEl.classList.toggle('status-complete', state === 'complete');
      }
      if (actions) actions.style.display = state === 'running' ? 'none' : '';
      if (progressBox) progressBox.style.display = ['running','error','complete'].includes(state) ? 'block' : 'none';
      if (dl) {
        dl.disabled = false;
        dl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>${state === 'complete' ? 'Download Again' : 'Download Video'}`;
      }
      // A running card rendered from scratch already has its Cancel button.
      // For state transitions, a redraw is unnecessary; hide stale cancel controls.
      if (cancel && state !== 'running') cancel.style.display = 'none';
    });
  }

  function render() {
    countBadge.textContent = displayVideos.length;
    if (!displayVideos.length) {
      videoListDiv.innerHTML = `
        <div class="empty-state">
          <svg class="empty-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          <p class="empty-title">No downloadable videos found</p>
          <p class="empty-desc">Play a video for a few seconds, then reopen the extension.</p>
        </div>`;
      return;
    }

    videoListDiv.innerHTML = '';
    displayVideos.forEach((video, index) => {
      const isHls = video.type?.includes('HLS');
      const ext = isHls ? 'ts' : (video.type?.toLowerCase().includes('webm') ? 'webm' : 'mp4');
      const title = video.displayTitle || video.title || `Video ${index + 1}`;
      const domain = domainOf(video.url);
      const job = findJob(video);
      const state = job?.state || 'idle';
      const pct = Number(job?.progress || 0);
      const status = job?.status || '';

      const card = document.createElement('div');
      card.className = 'video-card';
      card.dataset.videoId = String(video.id ?? '');
      card.innerHTML = `
        <div class="card-header">
          <div class="video-title" title="${esc(title)}">${esc(title)}</div>
          <span class="tag ${isHls ? 'tag-hls' : 'tag-mp4'}">${isHls ? 'HLS Stream' : esc(ext)}</span>
        </div>
        <div class="card-info">
          <div class="info-item" title="Source domain">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" /></svg>
            <span>${esc(domain)}</span>
          </div>
          <div class="info-item" title="${esc(video.url)}">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
            <span>${isHls ? 'Best quality selected automatically' : 'Direct video file'}</span>
          </div>
        </div>
        <div class="card-actions" ${state === 'running' ? 'style="display:none"' : ''}>
          <button class="btn btn-primary btn-dl-action" ${state === 'complete' ? 'data-redownload="1"' : ''}>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            ${state === 'complete' ? 'Download Again' : 'Download Video'}
          </button>
        </div>
        <div class="download-progress-container" style="display:${state === 'running' || state === 'error' || state === 'complete' ? 'block' : 'none'}">
          <div class="progress-header">
            <span class="progress-status ${state === 'error' ? 'status-error' : state === 'complete' ? 'status-complete' : ''}">${esc(status || (state === 'complete' ? 'Complete' : 'Starting…'))}</span>
            ${state === 'running' ? '<button class="btn-cancel">Cancel</button>' : ''}
          </div>
          <div class="progress-track"><div class="progress-fill" style="width:${Math.max(0, Math.min(100, pct))}%"></div></div>
          ${state === 'running' ? '<div class="background-note">You can close this popup or switch tabs. Download will continue.</div>' : ''}
        </div>`;

      videoListDiv.appendChild(card);
      const dlBtn = card.querySelector('.btn-dl-action');
      dlBtn?.addEventListener('click', async () => {
        let cleanName = String(title).replace(/[\\/*?:"<>|]/g, '_').trim();
        if (!cleanName) cleanName = `video_${index + 1}`;
        const filename = `${cleanName}.${ext}`;
        if (!isHls) {
          await chrome.downloads.download({ url: video.url, filename, saveAs: false });
          return;
        }
        dlBtn.disabled = true;
        dlBtn.textContent = 'Starting…';
        const jobId = `job_${video.id || index}_${Date.now()}`;
        const res = await chrome.runtime.sendMessage({
          action: 'startHlsDownload', jobId, tabId,
          video, filename, pageUrl: currentTab.url
        });
        if (res?.success === false) {
          alert(`Could not start download: ${res.error || 'Unknown error'}`);
          dlBtn.disabled = false;
          dlBtn.textContent = 'Download Video';
        } else {
          await refreshJobs();
          render();
        }
      });

      card.querySelector('.btn-cancel')?.addEventListener('click', async () => {
        if (job?.id) await chrome.runtime.sendMessage({ action: 'cancelHlsDownload', jobId: job.id });
      });
    });
  }
});


function scrapePageMediaOrder() {
  const urls = [];
  const players = [];
  const seen = new Set();
  const normalize = (value) => {
    if (!value || String(value).startsWith('blob:') || String(value).startsWith('data:')) return '';
    try { return new URL(value, location.href).href.split('#')[0]; } catch (_) { return ''; }
  };
  const addUrl = (value) => {
    const key = normalize(value);
    if (key && !seen.has(key)) { seen.add(key); urls.push(key); }
    return key;
  };

  // Preserve the exact top-to-bottom player order visible on the main page.
  document.querySelectorAll('video, iframe').forEach(el => {
    if (el.tagName === 'IFRAME') {
      const src = normalize(el.src || el.getAttribute('src'));
      // Ignore empty utility iframes; visible embedded players have a real URL.
      if (src) { players.push({ kind: 'iframe', url: src }); addUrl(src); }
      return;
    }
    const src = addUrl(el.currentSrc || el.src);
    const sources = [...el.querySelectorAll('source')].map(x => addUrl(x.src)).filter(Boolean);
    players.push({ kind: 'video', url: src || sources[0] || '' });
  });
  return { urls, players };
}

function scrapeVideosFromDOM() {
  const videos = [];
  const pageTitle = document.title;
  const elements = document.querySelectorAll('video');
  elements.forEach(video => {
    const src = video.currentSrc || video.src;
    if (!src) {
      video.querySelectorAll('source').forEach(source => {
        if (source.src && !source.src.startsWith('blob:') && !source.src.startsWith('data:')) {
          videos.push({ url: source.src, type: source.src.toLowerCase().includes('.m3u8') ? 'HLS (m3u8)' : 'MP4', title: pageTitle || 'Video Source' });
        }
      });
    } else if (!src.startsWith('blob:') && !src.startsWith('data:')) {
      videos.push({ url: src, type: src.toLowerCase().includes('.m3u8') ? 'HLS (m3u8)' : 'MP4', title: pageTitle || 'Video Tag' });
    }
  });
  document.querySelectorAll('a').forEach(a => {
    const href = a.href; if (!href) return;
    const lower = href.toLowerCase().split('?')[0];
    if (!/\.(mp4|webm|ogg|m3u8)$/.test(lower)) return;
    const type = lower.endsWith('.m3u8') ? 'HLS (m3u8)' : lower.endsWith('.webm') ? 'WEBM' : lower.endsWith('.ogg') ? 'OGG' : 'MP4';
    videos.push({ url: href, type, title: a.textContent.trim().substring(0, 50) || pageTitle || 'Video Link' });
  });
  return { title: pageTitle, pageUrl: location.href, videoElementCount: elements.length, videos: videos.map(v => ({ ...v, pageUrl: location.href })) };
}
