/* =========================================================
 * X 视频/动图下载器 — Service Worker (MV3)
 * 职责：
 *   1. 解析推文 ID -> 拿到全部清晰度（variant）与码率
 *   2. 按用户偏好挑最高清 / 720p / 最小体积
 *   3. 调 chrome.downloads 原样下载（不转码、不重编码）
 *   4. 右键菜单、图标绘制
 * ========================================================= */

const FX_API = 'https://api.fxtwitter.com/i/status/';
const SYND_API = 'https://cdn.syndication.twimg.com/tweet-result';
const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map(); // id -> { t, v }

/* ---------------- 基础工具 ---------------- */

function isMp4(v) {
  const ct = String(v.content_type || '').toLowerCase();
  const url = String(v.url || '');
  return ct === 'video/mp4' || /\.mp4(\?|$)/i.test(url);
}

function normalize(v) {
  const url = String(v.url || '');
  let w = Number(v.width) || 0;
  let h = Number(v.height) || 0;
  if (!w || !h) {
    // X 的 CDN 路径里带 /1280x720/，可以兜底解析
    const m = url.match(/\/(\d{2,4})x(\d{2,4})\//);
    if (m) {
      w = Number(m[1]);
      h = Number(m[2]);
    }
  }
  return {
    url,
    bitrate: Number(v.bitrate) || 0,
    width: w,
    height: h,
    label: w && h ? Math.min(w, h) + 'p' : 'mp4'
  };
}

function dedupeSort(list) {
  const seen = new Set();
  const out = [];
  for (const v of list) {
    if (!v.url || seen.has(v.url)) continue;
    seen.add(v.url);
    out.push(v);
  }
  out.sort((a, b) => (b.bitrate - a.bitrate) || (b.width - a.width));
  return out;
}

// X 自家 syndication 接口的 token 算法（已知公开实现）
function syndToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

async function fetchJson(url) {
  const res = await fetch(url, {
    credentials: 'omit',
    headers: { Accept: 'application/json' }
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

/* ---------------- 解析：主接口 ---------------- */

async function fromFxtwitter(id) {
  const j = await fetchJson(FX_API + id);
  const t = j && j.tweet;
  if (!t) throw new Error('推文不存在或不可见');

  const m = t.media || {};
  let items = [];
  if (Array.isArray(m.videos) && m.videos.length) {
    items = m.videos;
  } else if (Array.isArray(m.all)) {
    items = m.all.filter((x) => x && (x.type === 'video' || x.type === 'gif'));
  }

  const list = [];
  for (const it of items) {
    const variants = it.variants || [];
    for (const v of variants) {
      if (isMp4(v)) list.push(normalize(v));
    }
  }

  return {
    id,
    author: (t.author && t.author.screen_name) || '',
    text: String(t.text || '').replace(/\s+/g, ' ').slice(0, 80),
    thumb: (items[0] && (items[0].thumbnail_url || items[0].url)) || '',
    variants: dedupeSort(list)
  };
}

/* ---------------- 解析：兜底接口 ---------------- */

async function fromSyndication(id) {
  const url =
    SYND_API + '?id=' + encodeURIComponent(id) + '&lang=en&token=' + syndToken(id);
  const j = await fetchJson(url);
  const details = j.mediaDetails || [];

  const list = [];
  for (const d of details) {
    const vi = d.video_info || {};
    const variants = vi.variants || [];
    for (const v of variants) {
      if (isMp4(v)) list.push(normalize(v));
    }
  }

  return {
    id,
    author: (j.user && j.user.screen_name) || '',
    text: String(j.text || '').replace(/\s+/g, ' ').slice(0, 80),
    thumb: (details[0] && details[0].media_url_https) || '',
    variants: dedupeSort(list)
  };
}

/* ---------------- 合并入口 ---------------- */

async function getMedia(id) {
  if (!/^\d{5,25}$/.test(String(id))) throw new Error('推文 ID 不合法');

  const hit = cache.get(id);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.v;

  let data = null;
  let lastErr = null;

  try {
    data = await fromFxtwitter(id);
  } catch (e) {
    lastErr = e;
  }

  if (!data || !data.variants.length) {
    try {
      const alt = await fromSyndication(id);
      if (alt.variants.length) data = alt;
    } catch (e) {
      lastErr = e;
    }
  }

  if (!data || !data.variants.length) {
    throw new Error((lastErr && lastErr.message) || '没找到可下载的视频');
  }

  cache.set(id, { t: Date.now(), v: data });
  return data;
}

/* ---------------- 选择清晰度 ---------------- */

async function getQuality() {
  const r = await chrome.storage.local.get('quality');
  return r.quality || 'best';
}

function pickVariant(list, quality) {
  if (!list || !list.length) return null;
  if (quality === 'small') return list[list.length - 1];
  if (quality === 'hd') {
    const hd = list.filter((v) => Math.max(v.width, v.height) >= 720);
    return hd.length ? hd[0] : list[0];
  }
  return list[0]; // best：码率最高
}

/* ---------------- 下载 ---------------- */

function safeName(s) {
  return (
    String(s || '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/[. ]+$/g, '')
      .slice(0, 90) || 'x-video'
  );
}

function buildFilename(media, variant) {
  const h = variant.height || 0;
  const name =
    safeName(media.author || 'x') +
    '_' +
    media.id +
    (h ? '_' + h + 'p' : '') +
    '.mp4';
  return 'X视频/' + name;
}

async function downloadVariant(media, variant) {
  if (!variant || !variant.url) throw new Error('没有可用的下载地址');
  return chrome.downloads.download({
    url: variant.url,
    filename: buildFilename(media, variant),
    saveAs: false,
    conflictAction: 'uniquify'
  });
}

/* ---------------- 图片 ---------------- */

// pbs.twimg.com/media/<file>?format=jpg&name=small
//   -> pbs.twimg.com/media/<file>?format=jpg&name=orig
function toOrigUrl(raw) {
  try {
    const u = new URL(raw);
    if (!/(^|\.)pbs\.twimg\.com$/.test(u.hostname)) return raw;
    const m = u.pathname.match(/^\/media\/(.+)$/);
    if (!m) return raw;
    let file = m[1];
    let fmt = u.searchParams.get('format') || '';
    const ext = (file.match(/\.([a-z0-9]{2,5})$/i) || [])[1];
    if (!fmt) fmt = ext || 'jpg';
    file = file.replace(/\.[a-z0-9]{2,5}$/i, '');
    return 'https://pbs.twimg.com/media/' + file + '?format=' + fmt + '&name=orig';
  } catch (e) {
    return raw;
  }
}

function imageExt(url, fallback) {
  const f = String(fallback || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (f) return f === 'jpeg' ? 'jpg' : f;
  try {
    const q = new URL(url).searchParams.get('format');
    if (q) return q === 'jpeg' ? 'jpg' : q;
  } catch (e) {
    /* ignore */
  }
  const m = String(url).match(/\.(jpg|jpeg|png|webp|gif|avif)/i);
  return m ? (m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase()) : 'jpg';
}

async function downloadImage({ url, id, index, author, ext }) {
  if (!url) throw new Error('没有图片地址');
  const e = imageExt(url, ext);
  const name =
    safeName(author || 'x') + '_' + safeName(id || 'img') + '_' + (index || 1) + '.' + e;
  return chrome.downloads.download({
    url: toOrigUrl(url),
    filename: 'X图片/' + name,
    saveAs: false,
    conflictAction: 'uniquify'
  });
}

/* ---------------- 消息通道 ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!msg || !msg.type) {
        sendResponse({ ok: false, error: 'bad message' });
        return;
      }

      if (msg.type === 'GET_VARIANTS') {
        const media = await getMedia(msg.id);
        sendResponse({ ok: true, media });
        return;
      }

      if (msg.type === 'DOWNLOAD') {
        // 允许直接指定 url（用户点某一档），否则按偏好挑
        let variant = null;
        if (msg.url) {
          variant = { url: msg.url, height: msg.height || 0 };
        }
        const media = {
          id: msg.id,
          author: msg.author || 'x'
        };
        if (!variant) {
          const full = await getMedia(msg.id);
          variant = pickVariant(full.variants, await getQuality());
          media.author = full.author || 'x';
        }
        const dlId = await downloadVariant(media, variant);
        sendResponse({ ok: true, downloadId: dlId });
        return;
      }

      if (msg.type === 'DOWNLOAD_BEST') {
        const media = await getMedia(msg.id);
        const v = pickVariant(media.variants, await getQuality());
        const dlId = await downloadVariant(media, v);
        sendResponse({ ok: true, downloadId: dlId, variant: v });
        return;
      }

      if (msg.type === 'DOWNLOAD_IMAGE') {
        const dlId = await downloadImage(msg);
        sendResponse({ ok: true, downloadId: dlId });
        return;
      }

      if (msg.type === 'PING') {
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: 'unknown type: ' + msg.type });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true; // 异步响应，保持通道打开
});

/* ---------------- 右键菜单 ---------------- */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'xmd-video',
      title: '下载此视频/动图（最高清）',
      contexts: ['video']
    });
    chrome.contextMenus.create({
      id: 'xmd-link',
      title: '下载这条推文的视频',
      contexts: ['link'],
      targetUrlPatterns: ['*://x.com/*/status/*', '*://twitter.com/*/status/*']
    });
    chrome.contextMenus.create({
      id: 'xmd-image',
      title: '下载该图片（原图）',
      contexts: ['image']
    });
  });
});

async function resolveIdFromTab(tab) {
  if (!tab || !tab.id) return '';
  // 1) 推文详情页：URL 里直接有 id
  const m = String(tab.url || '').match(/\/status\/(\d{5,25})/);
  if (m) return m[1];
  // 2) 信息流：问内容脚本“最后鼠标停在哪条视频上”
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'RESOLVE_LAST' });
    if (r && r.id) return r.id;
  } catch (e) {
    /* 内容脚本未注入，忽略 */
  }
  return '';
}

function toastTab(tabId, text) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { type: 'TOAST', text }).catch(() => {});
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  // 图片：直接用浏览器给出的 srcUrl，最可靠
  if (info.menuItemId === 'xmd-image') {
    try {
      const page = String(info.pageUrl || '');
      const idm = page.match(/\/status\/(\d{5,25})/);
      const am = page.match(/x\.com\/([A-Za-z0-9_]{2,20})\/status\//);
      await downloadImage({
        url: info.srcUrl,
        id: idm ? idm[1] : 'img',
        index: 1,
        author: am ? am[1] : 'x'
      });
      toastTab(tab && tab.id, '已保存原图');
    } catch (e) {
      toastTab(tab && tab.id, '保存失败：' + String((e && e.message) || e));
    }
    return;
  }

  if (info.menuItemId !== 'xmd-video' && info.menuItemId !== 'xmd-link') return;

  let id = String(info.pageUrl || '').match(/\/status\/(\d{5,25})/);
  id = id ? id[1] : await resolveIdFromTab(tab);
  if (id && info.linkUrl) {
    const m = String(info.linkUrl).match(/\/status\/(\d{5,25})/);
    if (m) id = m[1];
  }

  if (!id) {
    toastTab(tab && tab.id, '没识别出推文，点开这条推文再试');
    return;
  }

  try {
    const media = await getMedia(id);
    const q = await getQuality();
    await downloadVariant(media, pickVariant(media.variants, q));
    toastTab(tab && tab.id, '已开始下载');
  } catch (e) {
    toastTab(tab && tab.id, '下载失败：' + String((e && e.message) || e));
  }
});

