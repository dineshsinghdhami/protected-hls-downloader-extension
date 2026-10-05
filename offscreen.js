// Persistent HLS worker. Offscreen documents survive popup/tab switching.
const active = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;
  if (message.action === 'runHlsDownload') {
    if (active.has(message.jobId)) { sendResponse({ success: true, alreadyRunning: true }); return false; }
    const d = new HLSDownloader(message.jobId, message.video, message.filename, message.fallbackPageUrl);
    active.set(message.jobId, d);
    d.start().finally(() => active.delete(message.jobId));
    sendResponse({ success: true });
    return false;
  }
  if (message.action === 'cancelHlsDownload') {
    active.get(message.jobId)?.cancel();
    sendResponse({ success: true });
    return false;
  }
  return false;
});

class HLSDownloader {
  constructor(jobId, video, filename, fallbackPageUrl) {
    this.jobId = jobId;
    this.video = video;
    this.url = video.url;
    this.filename = filename;
    this.pageUrl = video.pageUrl || fallbackPageUrl || '';
    this.requestHeaders = video.requestHeaders || {};
    this.browserHeaders = video.browserHeaders || {};
    this.isCancelled = false;
    this.activeFetches = new Set();
    this.preparedHosts = new Set();
    this.sessionId = `dl_${jobId}_${Date.now()}`;
    this.lastProgressSentAt = 0;
    this.pendingProgress = null;
  }

  progress(status, progress, state = 'running', error = '') {
    const payload = { action: 'downloadProgress', jobId: this.jobId, status, progress, state, error };
    const t = Date.now();
    const urgent = state !== 'running' || progress >= 97 || progress <= 12;
    if (urgent || t - this.lastProgressSentAt >= 200) {
      this.lastProgressSentAt = t;
      chrome.runtime.sendMessage(payload).catch(() => {});
    } else {
      this.pendingProgress = payload;
      clearTimeout(this.progressTimer);
      this.progressTimer = setTimeout(() => {
        if (!this.pendingProgress) return;
        this.lastProgressSentAt = Date.now();
        chrome.runtime.sendMessage(this.pendingProgress).catch(() => {});
        this.pendingProgress = null;
      }, 210);
    }
  }

  cancel() {
    this.isCancelled = true;
    for (const controller of this.activeFetches) controller.abort();
  }

  async start() {
    try {
      this.progress('Preparing stream…', 1);
      await chrome.runtime.sendMessage({ action: 'startDownloadSession', sessionId: this.sessionId, pageUrl: this.pageUrl, targetUrl: this.url, browserHeaders: this.browserHeaders });
      try { this.preparedHosts.add(new URL(this.url).hostname); } catch (_) {}

      this.progress('Fetching playlist…', 3);
      const playlistText = await this.fetchText(this.url, 'playlist');
      if (!playlistText.includes('#EXTM3U')) throw new Error('Not a valid HLS playlist.');

      let mediaPlaylistUrl = this.url;
      let mediaPlaylistText = playlistText;
      if (playlistText.includes('#EXT-X-STREAM-INF')) {
        this.progress('Selecting highest quality…', 6);
        const variant = this.selectBestVariant(playlistText);
        if (!variant) throw new Error('No playable stream variant found.');
        mediaPlaylistUrl = this.resolveUrl(this.url, variant.url);
        mediaPlaylistText = await this.fetchText(mediaPlaylistUrl, 'media playlist');
      }

      this.progress('Reading video segments…', 10);
      const { segments, initSegment } = this.parseMediaPlaylist(mediaPlaylistText, mediaPlaylistUrl);
      if (!segments.length) throw new Error('No media segments found.');
      for (const segment of segments) {
        if (segment.keyInfo && segment.keyInfo.method !== 'AES-128') throw new Error(`Unsupported HLS encryption method: ${segment.keyInfo.method}`);
      }

      const keyCache = new Map();
      const keyUris = [...new Set(segments.filter(s => s.keyInfo?.uri).map(s => s.keyInfo.uri))];
      for (const keyUri of keyUris) keyCache.set(keyUri, await this.fetchBuffer(keyUri, 'stream key'));
      for (const segment of segments) if (segment.keyInfo?.uri) segment.keyInfo.keyBuffer = keyCache.get(segment.keyInfo.uri);

      let initBuffer = null;
      if (initSegment) initBuffer = await this.fetchBuffer(initSegment.url, 'initialization segment', initSegment.range);

      const results = new Array(segments.length);
      let downloaded = 0;
      let nextIndex = 0;
      // More parallel workers than the old popup downloader, while keeping a sensible cap.
      const concurrency = Math.min(12, Math.max(4, segments.length));
      this.progress(`Downloading 0/${segments.length} • ${concurrency} parallel`, 12);

      const worker = async () => {
        while (!this.isCancelled) {
          const index = nextIndex++;
          if (index >= segments.length) return;
          const segment = segments[index];
          let lastError;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              let buffer = await this.fetchBuffer(segment.url, `segment #${index + 1}`, segment.range);
              if (segment.keyInfo?.keyBuffer) buffer = await this.decryptSegment(buffer, segment);
              results[index] = buffer;
              downloaded++;
              const pct = Math.floor(12 + (downloaded / segments.length) * 78);
              this.progress(`Downloading ${downloaded}/${segments.length} • ${concurrency} parallel`, pct);
              break;
            } catch (err) {
              lastError = err;
              if (this.isCancelled) return;
              if (attempt < 3) await new Promise(r => setTimeout(r, 200 * attempt));
            }
          }
          if (!results[index] && !this.isCancelled) throw new Error(`Segment #${index + 1} failed: ${lastError?.message || 'unknown error'}`);
        }
      };

      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      if (this.isCancelled) throw new Error('Cancelled');
      if (results.some(r => !r)) throw new Error('Download incomplete: missing media segments.');

      // Do NOT concatenate every segment into one giant Uint8Array here.
      // That duplicates the entire video in memory and can make long downloads appear
      // frozen at "Merging video…" (especially when several jobs finish together).
      // Blob accepts multiple ArrayBuffer parts directly, so Chrome can assemble the
      // final file without the extra full-size memory copy.
      this.progress('Preparing file…', 92);
      const buffers = initBuffer ? [initBuffer, ...results] : results;
      const isMp4 = Boolean(initSegment) || segments.some(s => /\.(m4s|mp4)(?:$|\?)/i.test(s.url));
      if (isMp4 && this.filename.toLowerCase().endsWith('.ts')) this.filename = this.filename.slice(0, -3) + '.mp4';

      const blob = new Blob(buffers, { type: isMp4 ? 'video/mp4' : 'video/mp2t' });
      // Drop the large per-segment references as soon as the Blob owns the parts.
      for (let i = 0; i < results.length; i++) results[i] = null;

      this.progress('Saving file…', 97);
      const blobUrl = URL.createObjectURL(blob);
      try {
        const result = await chrome.runtime.sendMessage({ action: 'saveCompletedBlob', jobId: this.jobId, blobUrl, filename: this.filename });
        if (result?.success === false) throw new Error(result.error || 'Could not save video.');
      } finally {
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      }
      this.progress('Complete', 100, 'complete');
    } catch (err) {
      if (this.isCancelled || err?.message === 'Cancelled') this.progress('Cancelled', 0, 'cancelled');
      else this.progress(`Error: ${err?.message || err}`, 0, 'error', err?.message || String(err));
    } finally {
      try { await chrome.runtime.sendMessage({ action: 'endDownloadSession', sessionId: this.sessionId }); } catch (_) {}
    }
  }

  selectBestVariant(text) {
    const lines = text.split(/\r?\n/); let best = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim(); if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
      const bw = Number(line.match(/(?:AVERAGE-)?BANDWIDTH=(\d+)/i)?.[1] || 0); let url = '';
      for (let j = i + 1; j < lines.length; j++) { const c = lines[j].trim(); if (c && !c.startsWith('#')) { url = c; break; } }
      if (url && (!best || bw > best.bandwidth)) best = { url, bandwidth: bw };
    }
    return best;
  }

  parseMediaPlaylist(text, baseUrl) {
    const lines = text.split(/\r?\n/), segments = [];
    let sequence = 0, currentKey = null, pendingRange = null, previousRangeEnd = 0, initSegment = null;
    for (const line of lines) if (line.trim().startsWith('#EXT-X-MEDIA-SEQUENCE:')) { sequence = Number(line.trim().split(':')[1]) || 0; break; }
    let currentSeq = sequence;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim(); if (!line) continue;
      if (line.startsWith('#EXT-X-KEY:')) {
        const method = line.match(/METHOD=([^,\s]+)/i)?.[1] || '';
        if (method === 'NONE') currentKey = null;
        else {
          const uriRaw = line.match(/URI="([^"]+)"/i)?.[1]; const ivHex = line.match(/IV=0x([0-9a-fA-F]+)/i)?.[1]; let iv = null;
          if (ivHex) { const padded = ivHex.padStart(32, '0').slice(-32); iv = new Uint8Array(padded.match(/.{2}/g).map(v => parseInt(v, 16))); }
          currentKey = { method, uri: uriRaw ? this.resolveUrl(baseUrl, uriRaw) : null, iv, keyBuffer: null };
        }
        continue;
      }
      if (line.startsWith('#EXT-X-MAP:')) {
        const uriRaw = line.match(/URI="([^"]+)"/i)?.[1]; const br = line.match(/BYTERANGE="?(\d+)(?:@(\d+))?"?/i);
        if (uriRaw) initSegment = { url: this.resolveUrl(baseUrl, uriRaw), range: br ? { length: Number(br[1]), offset: Number(br[2] || 0) } : null };
        continue;
      }
      if (line.startsWith('#EXT-X-BYTERANGE:')) {
        const m = line.match(/#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?/i);
        if (m) { const length = Number(m[1]); const offset = m[2] != null ? Number(m[2]) : previousRangeEnd; pendingRange = { length, offset }; previousRangeEnd = offset + length; }
        continue;
      }
      if (line.startsWith('#EXTINF:')) {
        let segmentLine = '';
        for (let j = i + 1; j < lines.length; j++) { const c = lines[j].trim(); if (c && !c.startsWith('#')) { segmentLine = c; break; } }
        if (segmentLine) {
          segments.push({ url: this.resolveUrl(baseUrl, segmentLine), sequence: currentSeq++, keyInfo: currentKey ? { ...currentKey, iv: currentKey.iv ? new Uint8Array(currentKey.iv) : null } : null, range: pendingRange });
          pendingRange = null;
        }
      }
    }
    return { segments, initSegment };
  }

  async ensureHost(url) {
    let host = ''; try { host = new URL(url).hostname; } catch (_) { return; }
    if (!host || this.preparedHosts.has(host)) return;
    const res = await chrome.runtime.sendMessage({ action: 'ensureDownloadHost', sessionId: this.sessionId, pageUrl: this.pageUrl, targetUrl: url, browserHeaders: this.browserHeaders });
    if (res?.success === false) throw new Error(res.error || 'Could not prepare media request.');
    this.preparedHosts.add(host);
  }

  buildHeaders(extra = {}) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(this.requestHeaders || {})) { try { if (value != null) headers.set(name, value); } catch (_) {} }
    for (const [name, value] of Object.entries(extra)) headers.set(name, value);
    return headers;
  }

  async fetchResponse(url, label, range = null) {
    if (this.isCancelled) throw new Error('Cancelled');
    await this.ensureHost(url);
    const controller = new AbortController(); this.activeFetches.add(controller);
    try {
      const extra = {}; if (range) extra.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
      const response = await fetch(url, { method: 'GET', headers: this.buildHeaders(extra), credentials: 'include', cache: 'no-store', signal: controller.signal });
      if (!response.ok && response.status !== 206) throw new Error(`${label} HTTP ${response.status}`);
      return response;
    } finally { this.activeFetches.delete(controller); }
  }
  async fetchText(url, label) { return (await this.fetchResponse(url, label)).text(); }
  async fetchBuffer(url, label, range = null) { return (await this.fetchResponse(url, label, range)).arrayBuffer(); }
  resolveUrl(base, relative) { try { return new URL(relative, base).href; } catch (_) { return relative; } }

  async decryptSegment(arrayBuffer, segment) {
    const keyInfo = segment.keyInfo;
    const cryptoKey = await crypto.subtle.importKey('raw', keyInfo.keyBuffer, { name: 'AES-CBC' }, false, ['decrypt']);
    let iv = keyInfo.iv;
    if (!iv) {
      iv = new Uint8Array(16); let seq = BigInt(segment.sequence >>> 0);
      for (let i = 15; i >= 0 && seq > 0n; i--) { iv[i] = Number(seq & 0xffn); seq >>= 8n; }
    }
    return crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, arrayBuffer);
  }
}
