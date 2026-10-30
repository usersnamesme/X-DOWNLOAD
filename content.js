/* =========================================================
 * X 媒体下载器 — 内容脚本
 *
 * 关键设计：角标不再是 position:fixed 的全局浮层，
 * 而是插进视频/图片所在的容器里用 absolute 定位。
 * 这样滚动由浏览器合成线程原生完成，不会出现"跟不上"。
 * ========================================================= */

(() => {
  if (window.__xmdLoaded) return; // popup 兜底注入时会重复执行，这里挡掉
  window.__xmdLoaded = true;

  const PANEL_W = 280;
  const MIN_IMG = 220; // 小于这个宽度的图当头像/表情，不挂角标

  const ICON_DL =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" ' +
    'stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 3.6v10.2"/>' +
    '<path d="M7.8 9.7 12 13.9l4.2-4.2"/>' +
    '<path d="M4.6 15.8v2.4c0 .6.5 1.1 1.1 1.1h12.6c.6 0 1.1-.5 1.1-1.1v-2.4"/>' +
    '</svg>';

  const tracked = new Map(); // mediaEl -> { label, kind }
  let panel = null;
  let lastId = '';
  let scanTimer = 0;

  /* ---------------- 基础工具 ---------------- */

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function articleOf(node) {
    return node && node.closest ? node.closest('article[data-testid="tweet"], article') : null;
  }

  function tweetIdOf(node) {
    const art = articleOf(node);
    if (!art) return { id: '', art: null };
    const links = art.querySelectorAll('a[href*="/status/"]');
    for (const a of links) {
      const m = (a.getAttribute('href') || '').match(/\/status\/(\d{5,25})/);
      if (m) return { id: m[1], art };
    }
    return { id: '', art };
  }

  function authorOf(art) {
    if (!art) return '';
    const m = String(art.innerText || '').match(/@([A-Za-z0-9_]{2,20})/);
    return m ? m[1] : '';
  }

  // 把 X 的缩略图地址改成原图地址
  function origUrl(raw) {
    try {
      const u = new URL(raw, location.href);
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

  function extOf(url) {
    try {
      const f = new URL(url).searchParams.get('format');
      if (f) return f;
      const m = String(url).match(/\.(jpg|jpeg|png|webp|gif|avif)/i);
      return m ? m[1].toLowerCase() : 'jpg';
    } catch (e) {
      return 'jpg';
    }
  }

  /* ---------------- 容器定位（不卡的关键） ---------------- */

  function hostOf(media) {
    if (media.tagName === 'IMG') {
      return (
        media.closest('[data-testid="tweetPhoto"]') ||
        media.closest('[data-testid="card.layoutLarge.media"]') ||
        media.parentElement
      );
    }
    return (
      media.closest('[data-testid="videoComponent"]') ||
      media.closest('[data-testid="videoPlayer"]') ||
      media.parentElement
    );
  }

  function mount(media, label) {
    const host = hostOf(media);
    if (!host) return false;

    // 容器必须是定位上下文，否则 absolute 会跑到别处
    const pos = getComputedStyle(host).position;
    if (pos === 'static') {
      host.style.position = 'relative';
      host.dataset.xmdPatched = '1';
    }

    host.appendChild(label);
    return true;
  }

  /* ---------------- 角标 ---------------- */

  function createLabel(media, kind) {
    const label = el('button', 'xmd-label xmd-label--' + kind);
    label.type = 'button';
    label.innerHTML =
      '<span class="xmd-label-ico">' + ICON_DL + '</span>' +
      '<span class="xmd-label-txt">' + (kind === 'image' ? '存图' : '下载') + '</span>';

    const stop = (e) => {
      e.stopPropagation();
      e.preventDefault();
    };
    label.addEventListener('mousedown', stop, true);

    label.addEventListener(
      'click',
      (e) => {
        stop(e);
        if (kind === 'image') downloadImage(media, label);
        else openVariants(media, label);
      },
      true
    );

    label.addEventListener('mouseenter', () => {
      const { id } = tweetIdOf(media);
      if (id) lastId = id;
    });

    return label;
  }

  function ensure(media, kind) {
    const rec = tracked.get(media);
    if (rec) {
      // React 重渲染可能把我们的节点冲掉，冲掉就重新挂
      if (!rec.label.isConnected) {
        if (!mount(media, rec.label)) return;
      }
      return;
    }
    const label = createLabel(media, kind);
    if (!mount(media, label)) return;
    tracked.set(media, { label, kind });
  }

  /* ---------------- 扫描 ---------------- */

  function scan() {
    // 视频
    for (const v of document.querySelectorAll('video')) {
      ensure(v, 'video');
    }

    // 图片：只处理推文里的媒体图，排除头像/表情/卡片缩略图
    const imgs = document.querySelectorAll('img[src*="pbs.twimg.com/media/"]');
    for (const img of imgs) {
      if (img.closest('[data-testid="videoComponent"]')) continue;
      if (img.closest('[data-testid="tweetPhoto"]') === null && img.closest('article') === null) continue;
      const w = img.naturalWidth || img.width || 0;
      if (w && w < MIN_IMG) continue;
      if (!img.complete) {
        img.addEventListener('load', () => scan(), { once: true });
        continue;
      }
      ensure(img, 'image');
    }

    // 清理已移除的
    for (const [media, rec] of tracked) {
      if (!media.isConnected) {
        rec.label.remove();
        tracked.delete(media);
      }
    }
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = window.setTimeout(scan, 260);
  }

  /* ---------------- 面板 ---------------- */

  function closePanel() {
    if (panel && panel.isConnected) panel.remove();
    panel = null;
  }

  function openPanel(media, anchor) {
    closePanel();
    panel = el('div', 'xmd-panel');

    const head = el('div', 'xmd-head');
    head.appendChild(el('div', 'xmd-title', '@' + (media.author || 'x')));
    head.appendChild(el('div', 'xmd-sub', media.variants.length + ' 个清晰度 · 选一档下载'));
    if (media.text) head.appendChild(el('div', 'xmd-quote', media.text));
    panel.appendChild(head);

    const list = el('div', 'xmd-list');
    media.variants.forEach((v, i) => {
      const row = el('button', 'xmd-row');
      row.type = 'button';

      const info = el('span', 'xmd-info');
      info.appendChild(el('span', 'xmd-res', (v.width || '?') + '×' + (v.height || '?')));
      info.appendChild(
        el('span', 'xmd-meta', v.bitrate ? Math.round(v.bitrate / 1000) + ' kbps' : 'mp4')
      );

      row.appendChild(info);
      row.appendChild(el('span', 'xmd-badge' + (i === 0 ? ' top' : ''), i === 0 ? '最高清' : '下载'));

      row.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (row.classList.contains('busy')) return;
        row.classList.add('busy');
        try {
          const r = await chrome.runtime.sendMessage({
            type: 'DOWNLOAD',
            id: media.id,
            url: v.url,
            height: v.height,
            author: media.author
          });
          if (r && r.ok) {
            row.classList.add('done');
            row.querySelector('.xmd-badge').textContent = '已下载';
            toast('已加入下载 · ' + (v.label || ''));
            setTimeout(closePanel, 600);
          } else {
            row.classList.remove('busy');
            toast('失败：' + ((r && r.error) || '未知错误'));
          }
        } catch (err) {
          row.classList.remove('busy');
          toast('失败：' + String((err && err.message) || err));
        }
      });

      list.appendChild(row);
    });

    panel.appendChild(list);
    // 面板用 fixed：只是临时弹层，塞进容器会被 overflow:hidden 裁掉
    document.body.appendChild(panel);

    const ar = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - PANEL_W - 8, ar.right - PANEL_W));
    panel.style.left = left + 'px';
    panel.style.top = ar.bottom + 8 + 'px';

    const ph = panel.offsetHeight || 240;
    if (ar.bottom + 8 + ph > window.innerHeight - 8) {
      panel.style.top = Math.max(8, ar.top - ph - 8) + 'px';
    }
  }

  async function openVariants(video, label) {
    const { id } = tweetIdOf(video);
    if (!id) {
      toast('没识别出这条推文');
      return;
    }
    lastId = id;
    label.classList.add('busy');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_VARIANTS', id });
      if (!res || !res.ok) throw new Error((res && res.error) || '解析失败');
      openPanel(res.media, label);
    } catch (e) {
      toast('解析失败：' + String((e && e.message) || e));
    } finally {
      label.classList.remove('busy');
    }
  }

  async function downloadImage(img, label) {
    const { id, art } = tweetIdOf(img);
    if (!id) {
      toast('没识别出这条推文');
      return;
    }
    lastId = id;

    const src = img.currentSrc || img.src;
    const url = origUrl(src);

    // 同一条推文里这是第几张
    const all = Array.from(
      art.querySelectorAll('img[src*="pbs.twimg.com/media/"]')
    ).filter((x) => (x.naturalWidth || 0) >= MIN_IMG);
    const idx = Math.max(0, all.indexOf(img)) + 1;

    label.classList.add('busy');
    try {
      const r = await chrome.runtime.sendMessage({
        type: 'DOWNLOAD_IMAGE',
        url,
        id,
        index: idx,
        author: authorOf(art),
        ext: extOf(url)
      });
      if (r && r.ok) {
        toast('已保存原图' + (all.length > 1 ? ' ' + idx + '/' + all.length : ''));
      } else {
        toast('失败：' + ((r && r.error) || '未知错误'));
      }
    } catch (e) {
      toast('失败：' + String((e && e.message) || e));
    } finally {
      label.classList.remove('busy');
    }
  }

  /* ---------------- 提示 ---------------- */

  let toastTimer = 0;
  function toast(text) {
    let t = document.getElementById('__xmd_toast');
    if (!t) {
      t = el('div');
      t.id = '__xmd_toast';
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => t.classList.remove('on'), 2200);
  }

  /* ---------------- 供 popup / 右键菜单用 ---------------- */

  function scanItems() {
    const out = [];
    const seen = new Set();
    const arts = document.querySelectorAll('article[data-testid="tweet"], article');

    for (const art of arts) {
      const hasVideo = !!art.querySelector('video');
      const imgs = Array.from(art.querySelectorAll('img[src*="pbs.twimg.com/media/"]')).filter((i) => {
        if (i.closest('[data-testid="videoComponent"]')) return false;
        const w = i.naturalWidth || i.width || 0;
        return !w || w >= MIN_IMG;
      });

      if (!hasVideo && !imgs.length) continue;

      const { id } = tweetIdOf(art);
      if (!id || seen.has(id)) continue;
      seen.add(id);

      out.push({
        id,
        text: String(art.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 70),
        author: authorOf(art),
        hasVideo,
        images: imgs.slice(0, 4).map((i) => origUrl(i.currentSrc || i.src))
      });

      if (out.length >= 16) break;
    }
    return out;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'PING_CONTENT') {
      sendResponse({ ok: true, media: tracked.size });
      return;
    }
    if (msg.type === 'SCAN') {
      sendResponse({ ok: true, items: scanItems() });
      return;
    }
    if (msg.type === 'RESOLVE_LAST') {
      sendResponse({ id: lastId || '' });
      return;
    }
    if (msg.type === 'TOAST') {
      toast(msg.text || '');
      return;
    }
  });

  /* ---------------- 启动 ---------------- */

  scan();
  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  // 图片是懒加载的，尺寸变化/a 标签变化时补扫一次
  window.addEventListener('resize', scheduleScan, { passive: true });

  document.addEventListener(
    'mouseover',
    (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const media = t.closest('video, img[src*="pbs.twimg.com/media/"]');
      if (media) {
        const { id } = tweetIdOf(media);
        if (id) lastId = id;
      }
    },
    true
  );

  // 点面板外部关闭
  document.addEventListener(
    'mousedown',
    (e) => {
      if (!panel) return;
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (panel.contains(t) || t.closest('.xmd-label')) return;
      closePanel();
    },
    true
  );

  // 面板是 fixed 浮层，一滚就会脱离锚点，直接收起
  document.addEventListener(
    'scroll',
    () => {
      if (panel) closePanel();
    },
    { capture: true, passive: true }
  );

  // 路由切换（X 是 SPA）后重新扫
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      scheduleScan();
    }
  }, 800);
})();
