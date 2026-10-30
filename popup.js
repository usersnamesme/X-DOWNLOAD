/* X 媒体下载器 — 弹窗 */

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let items = [];
let tabId = null;
let quality = 'best';

init();

/* ---------------- 启动 ---------------- */

async function init() {
  bindQuality();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id;

  if (!/^https:\/\/(x|twitter)\.com\//.test((tab && tab.url) || '')) {
    setSub('当前不是 X 页面');
    renderEmpty('打开 <b>x.com</b> 或 <b>twitter.com</b>，再点这个按钮。');
    return;
  }

  $('#rescan').addEventListener('click', scan);
  $('#all').addEventListener('click', downloadAll);

  await scan();
}

function bindQuality() {
  chrome.storage.local.get('quality').then((r) => {
    quality = r.quality || 'best';
    const el = document.querySelector(`input[name="q"][value="${quality}"]`);
    if (el) el.checked = true;
  });

  document.querySelectorAll('input[name="q"]').forEach((el) => {
    el.addEventListener('change', () => {
      if (!el.checked) return;
      quality = el.value;
      chrome.storage.local.set({ quality });
      markBest();
    });
  });
}

/* ---------------- 内容脚本兜底注入 ---------------- */

async function ensureContent() {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'PING_CONTENT' });
    if (r && r.ok) return true;
  } catch (e) {
    /* 未注入，走下面的补注入 */
  }

  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
  } catch (e) {
    /* 重复插入会报错，忽略 */
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (e) {
    return false;
  }

  await sleep(160);

  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'PING_CONTENT' });
    return !!(r && r.ok);
  } catch (e) {
    return false;
  }
}

/* ---------------- 扫描 ---------------- */

async function scan() {
  setSub('正在扫描当前页面…');
  renderEmpty('<span class="spin"></span> 扫描中…');

  const ready = await ensureContent();
  if (!ready) {
    setSub('需要刷新一次');
    renderEmpty(
      '扩展刚更新过，这个标签页里还是旧脚本，没法接上。<br>' +
        '按 <b>F5</b> 刷新一下 X 页面，再点这个按钮就好了。'
    );
    return;
  }

  let res = null;
  try {
    res = await chrome.tabs.sendMessage(tabId, { type: 'SCAN' });
  } catch (e) {
    setSub('读取页面失败');
    renderEmpty('刷新一下 X 页面再试。');
    return;
  }

  const list = (res && res.items) || [];
  if (!list.length) {
    setSub('本页没有媒体');
    renderEmpty(
      '这一屏没有视频或图片。<br>往下滚动让内容加载出来，或者直接点开某条推文。'
    );
    return;
  }

  setSub(`发现 ${list.length} 条媒体，正在解析…`);
  items = list.slice(0, 12).map((x) => ({ ...x }));

  const grid = $('#list');
  grid.innerHTML = '';

  for (const it of items) {
    const card = renderCard(it);
    grid.appendChild(card);

    if (it.hasVideo) {
      try {
        const r = await chrome.runtime.sendMessage({ type: 'GET_VARIANTS', id: it.id });
        if (!r || !r.ok) throw new Error((r && r.error) || '解析失败');
        it.media = r.media;
      } catch (e) {
        it.error = String((e && e.message) || e);
      }
    }
    fillChips(card, it);
  }

  const ok = items.filter((x) => (x.media && x.media.variants.length) || (x.images || []).length).length;
  setSub(`发现 ${items.length} 条，可用 ${ok} 条`);
  $('#all').disabled = ok === 0;
  markBest();
}

/* ---------------- 渲染 ---------------- */

function renderCard(it) {
  const card = document.createElement('div');
  card.className = 'item';

  const head = document.createElement('div');
  head.className = 'item-head';
  head.textContent = it.author ? '@' + it.author : '@…';

  const txt = document.createElement('div');
  txt.className = 'item-txt';
  txt.textContent = it.text || '（无正文）';

  const chips = document.createElement('div');
  chips.className = 'chips';
  chips.innerHTML = '<span class="chip more"><span class="spin"></span></span>';

  card.appendChild(head);
  card.appendChild(txt);
  card.appendChild(chips);
  return card;
}

function fillChips(card, it) {
  const wrap = card.querySelector('.chips');
  wrap.innerHTML = '';

  const variants = (it.media && it.media.variants) || [];

  // ---- 视频清晰度 ----
  if (variants.length) {
    variants.slice(0, 4).forEach((v) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.dataset.kind = 'video';
      b.dataset.label = v.label || '';
      b.innerHTML =
        '<b>' + escapeHtml(v.label || 'mp4') + '</b>' +
        '<small>' + escapeHtml(v.bitrate ? Math.round(v.bitrate / 1000) + 'k' : '') + '</small>';

      b.addEventListener('click', async () => {
        b.disabled = true;
        const old = b.innerHTML;
        b.innerHTML = '<span class="spin"></span>';
        try {
          const r = await chrome.runtime.sendMessage({
            type: 'DOWNLOAD',
            id: it.id,
            url: v.url,
            height: v.height,
            author: it.author || (it.media && it.media.author) || 'x'
          });
          if (r && r.ok) {
            b.classList.add('done');
            b.innerHTML = '✓ 已下载';
          } else {
            b.disabled = false;
            b.innerHTML = old;
            setSub('下载失败：' + ((r && r.error) || '未知错误'));
          }
        } catch (e) {
          b.disabled = false;
          b.innerHTML = old;
          setSub('下载失败：' + String((e && e.message) || e));
        }
      });

      wrap.appendChild(b);
    });

    if (variants.length > 4) {
      const more = document.createElement('span');
      more.className = 'chip more';
      more.textContent = '+' + (variants.length - 4);
      wrap.appendChild(more);
    }
  } else if (it.error) {
    const err = document.createElement('span');
    err.className = 'chip more';
    err.textContent = '视频解析失败';
    wrap.appendChild(err);
  }

  // ---- 图片 ----
  const images = it.images || [];
  if (images.length) {
    const b = document.createElement('button');
    b.className = 'chip chip-img';
    b.type = 'button';
    b.innerHTML =
      '<b>图片</b><small>' + images.length + ' 张</small>';
    b.addEventListener('click', async () => {
      b.disabled = true;
      const old = b.innerHTML;
      b.innerHTML = '<span class="spin"></span>';
      let n = 0;
      for (let i = 0; i < images.length; i += 1) {
        try {
          const r = await chrome.runtime.sendMessage({
            type: 'DOWNLOAD_IMAGE',
            url: images[i],
            id: it.id,
            index: i + 1,
            author: it.author || 'x'
          });
          if (r && r.ok) n += 1;
        } catch (e) {
          /* 单张失败不阻塞 */
        }
        await sleep(220);
      }
      b.classList.add('done');
      b.innerHTML = n === images.length ? '✓ 已保存' : '✓ ' + n + '/' + images.length;
    });
    wrap.appendChild(b);
  }

  if (!variants.length && !images.length && !it.error) {
    wrap.innerHTML = '<span class="chip more">没有可下载内容</span>';
  }
}

function markBest() {
  const cards = document.querySelectorAll('.item');
  cards.forEach((card, i) => {
    const it = items[i];
    if (!it || !it.media) return;
    const vs = it.media.variants;
    if (!vs || !vs.length) return;

    let target = vs[0];
    if (quality === 'small') target = vs[vs.length - 1];
    if (quality === 'hd') {
      const hd = vs.filter((v) => Math.max(v.width, v.height) >= 720);
      target = hd.length ? hd[0] : vs[0];
    }

    card.querySelectorAll('.chip').forEach((c) => c.classList.remove('best'));
    Array.from(card.querySelectorAll('.chip')).forEach((c) => {
      if (c.dataset && c.dataset.kind === 'video' && c.dataset.label === target.label) {
        c.classList.add('best');
      }
    });
  });
}

/* ---------------- 全部下载 ---------------- */

async function downloadAll() {
  const btn = $('#all');
  btn.disabled = true;

  const list = items.filter(
    (x) => (x.media && x.media.variants.length) || (x.images || []).length
  );
  let n = 0;

  for (const it of list) {
    n += 1;
    setSub(`正在处理 ${n}/${list.length}…`);

    if (it.media && it.media.variants.length) {
      try {
        await chrome.runtime.sendMessage({ type: 'DOWNLOAD_BEST', id: it.id });
      } catch (e) {
        /* 跳过 */
      }
      await sleep(300);
    }

    const imgs = it.images || [];
    for (let i = 0; i < imgs.length; i += 1) {
      try {
        await chrome.runtime.sendMessage({
          type: 'DOWNLOAD_IMAGE',
          url: imgs[i],
          id: it.id,
          index: i + 1,
          author: it.author || 'x'
        });
      } catch (e) {
        /* 跳过 */
      }
      await sleep(220);
    }
  }

  btn.disabled = false;
  setSub(`已提交 ${list.length} 条`);
}

/* ---------------- 辅助 ---------------- */

function setSub(text) {
  $('#sub').textContent = text;
}

function renderEmpty(html) {
  $('#list').innerHTML = '<div class="empty">' + html + '</div>';
  $('#all').disabled = true;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
