/*
 * 随机点名 —— 抽取逻辑、名单导入与进度显示。零依赖。
 *
 * 注意：本文件必须保持为**经典脚本**（不能用 type="module" / import / export）。
 * 页面常常是直接用 file:// 打开的，module 脚本会被 CORS 拦掉；同理不要用
 * fetch / XHR（读不到本地文件）和 Web Worker。
 *
 * 状态以内存为唯一真相，localStorage 只是"能存就存"的便利缓存 —— file:// 下
 * 的 origin 是 opaque ('null')，存储可用性不保证。
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'random-picker:v1';
  var ROLL_START_MS = 45;      // 滚动起始间隔
  var ROLL_MAX_MS = 190;       // 滚动最大间隔
  var ROLL_MIN_TOTAL = 1300;   // 滚动总时长下限
  var ROLL_MAX_TOTAL = 1900;   // 滚动总时长上限

  var state = {
    entries: [],     // [{ id, name }]  同名的人各占一条，不做去重
    drawn: [],       // [id] 按抽取顺序
    currentId: null,
    nextId: 1,
    spinning: false,
    source: ''
  };

  /* ---------- DOM ---------- */

  function $(id) { return document.getElementById(id); }

  var nameEl     = $('name-display');
  var hintEl     = $('hint');
  var drawBtn    = $('draw-btn');
  var undoBtn    = $('undo-btn');
  var resetBtn   = $('reset-btn');
  var editBtn    = $('edit-btn');
  var remainEl   = $('stat-remaining');
  var totalEl    = $('stat-total');
  var drawnList  = $('drawn-list');
  var drawnEmpty = $('drawn-empty');
  var drawnCount = $('drawn-count');
  var fileInput  = $('file-input');
  var toastEl    = $('toast');
  var srStatus   = $('sr-status');
  var editDialog = $('edit-dialog');
  var editArea   = $('edit-textarea');
  var dropOverlay = $('drop-overlay');
  var sourceNote = $('source-note');

  /* ---------- 存储（尽力而为） ---------- */

  var storage = (function () {
    var available = false;
    try {
      localStorage.setItem('__rp_probe__', '1');
      localStorage.removeItem('__rp_probe__');
      available = true;
    } catch (e) { available = false; }

    return {
      available: available,
      read: function () {
        if (!available) return null;
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { return null; }
      },
      write: function (data) {
        if (!available) return;
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { /* 配额或隐私模式，忽略 */ }
      }
    };
  })();

  function persist() {
    storage.write({
      v: 1,
      entries: state.entries,
      drawn: state.drawn,
      currentId: state.currentId,
      nextId: state.nextId,
      source: state.source
    });
  }

  function restore() {
    var saved = storage.read();
    if (!saved || !Array.isArray(saved.entries) || !saved.entries.length) return false;

    state.entries = saved.entries
      .filter(function (e) { return e && typeof e.name === 'string' && e.name; })
      .map(function (e) { return { id: e.id, name: e.name }; });
    if (!state.entries.length) return false;

    var known = {};
    state.entries.forEach(function (e) { known[e.id] = true; });
    state.drawn = (Array.isArray(saved.drawn) ? saved.drawn : []).filter(function (id) { return known[id]; });
    state.currentId = known[saved.currentId] ? saved.currentId : null;
    state.nextId = typeof saved.nextId === 'number'
      ? saved.nextId
      : state.entries.reduce(function (m, e) { return Math.max(m, e.id); }, 0) + 1;
    state.source = typeof saved.source === 'string' ? saved.source : '';
    return true;
  }

  /* ---------- 小工具 ---------- */

  function entryById(id) {
    for (var i = 0; i < state.entries.length; i++) if (state.entries[i].id === id) return state.entries[i];
    return null;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* 无偏随机整数 [0, max)：拒绝采样，避免取模偏差 */
  function randomInt(max) {
    if (max <= 1) return 0;
    var limit = Math.floor(4294967296 / max) * max;
    var buf = new Uint32Array(1);
    var v;
    do { crypto.getRandomValues(buf); v = buf[0]; } while (v >= limit);
    return v % max;
  }

  var toastTimer = null;
  function toast(msg, kind) {
    toastEl.textContent = msg;
    toastEl.dataset.kind = kind || '';
    toastEl.classList.add('is-visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-visible'); }, 3800);
  }

  function srSay(msg) { srStatus.textContent = msg; }

  /* ---------- 姓名识别 ---------- */

  var HEADER_WORDS = ['姓名', '名字', '名称', '学生', '学生姓名', 'name', 'fullname', '名单'];
  var BAD_HEADERS = ['学号', '序号', '编号', '学籍', '性别', '专业', '班级', '学院', '电话', '手机',
                     '联系', '备注', '宿舍', '邮箱', '住址', '民族', '政治', '身份证',
                     'id', 'no', 'num', 'phone', 'tel', 'class', 'major', 'email'];

  /* 去编号前缀、全角空格、零宽字符 —— 从 Word/Excel 粘出来的名单常带这些 */
  function tidyName(value) {
    return String(value == null ? '' : value)
      .replace(/[\u200b\ufeff]/g, '')       // 零宽空格 / BOM
      .replace(/\u3000/g, ' ')              // 全角空格
      .replace(/^\s*\d+\s*[.、)．]\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function looksLikeName(value) {
    var t = tidyName(value).replace(/ /g, '');
    if (!t) return false;
    if (/^[\d\s\-.+()（）]+$/.test(t)) return false;          // 学号、电话、序号

    var lower = t.toLowerCase();
    for (var i = 0; i < HEADER_WORDS.length; i++) {
      if (lower === HEADER_WORDS[i]) return false;
    }

    var han = (t.match(/[一-龥]/g) || []).length;
    if (han > 0) {
      // 2–6 个汉字，允许少数民族姓名的间隔号
      return han >= 2 && han <= 6 && t.replace(/[一-龥·]/g, '').length === 0;
    }
    return /^[A-Za-z][A-Za-z.'\-]{1,29}$/.test(t);            // 英文名
  }

  function scoreColumn(header, values) {
    var head = String(header == null ? '' : header).replace(/\s/g, '').toLowerCase();
    var score = 0;
    if (/^(姓名|名字|名称|名单|学生姓名|name|fullname)$/.test(head)) score += 100;
    if (BAD_HEADERS.some(function (bad) { return head.indexOf(bad) >= 0; })) score -= 100;

    var filled = values.filter(function (v) { return tidyName(v) !== ''; });
    if (!filled.length) return -1000;

    var nameish = filled.filter(looksLikeName).length;
    score += (nameish / filled.length) * 50;

    var uniq = {};
    filled.forEach(function (v) { uniq[tidyName(v)] = true; });
    score += (Object.keys(uniq).length / filled.length) * 15;   // 姓名列基本不重复，"专业"列会重复
    return score;
  }

  /* 从二维表里取出姓名列 */
  function namesFromTable(rows) {
    if (!rows || !rows.length) return [];

    // 1) 先找表头行（前 12 行内有没有「姓名」这类单元格）
    //    注意要收集该行里**所有**姓名列：有的名单把班级排成左右两块，
    //    表头重复出现（学号/姓名/… | 学号/姓名/…），只取第一列会漏掉一半人。
    var scan = Math.min(rows.length, 12);
    var NAME_HEADER = /^(姓名|名字|学生姓名|名称|名单|name|fullname)$/i;

    for (var r = 0; r < scan; r++) {
      var row = rows[r] || [];
      var cols = [];
      for (var c = 0; c < row.length; c++) {
        if (NAME_HEADER.test(String(row[c] == null ? '' : row[c]).replace(/\s/g, ''))) cols.push(c);
      }
      if (!cols.length) continue;

      var picked = [];
      cols.forEach(function (col) {
        for (var i = r + 1; i < rows.length; i++) {
          var v = tidyName((rows[i] || [])[col]);
          if (v && looksLikeName(v)) picked.push(v);
        }
      });
      if (picked.length) return picked;
    }

    // 2) 没有表头：逐列打分，平分时取更靠左的列（姓名一般排在专业/电话前面）
    var width = 0;
    for (var k = 0; k < rows.length; k++) width = Math.max(width, (rows[k] || []).length);
    if (!width) return [];

    var bestScore = -Infinity;
    var bestCol = -1;
    for (var col = 0; col < width; col++) {
      var values = rows.map(function (line) { return line[col]; });
      var s = scoreColumn(rows[0] ? rows[0][col] : '', values);
      if (s > bestScore + 1e-9) { bestScore = s; bestCol = col; }
    }
    if (bestCol < 0) return [];

    var out = [];
    for (var m = 0; m < rows.length; m++) {
      var name = tidyName((rows[m] || [])[bestCol]);
      if (name && looksLikeName(name)) out.push(name);
    }
    return out;
  }

  function splitNames(text) {
    var out = [];
    String(text == null ? '' : text).split(/\r\n|\n|\r/).forEach(function (line) {
      line.split(/[,，、;；\t|]+/).forEach(function (piece) {
        var name = tidyName(piece);
        if (name) out.push(name);
      });
    });
    return out;
  }

  /* ---------- 文件解码 ---------- */

  /*
   * 编码探测顺序很关键：utf-8 必须用 fatal:true 试，否则非法字节会被静默
   * 替换成 U+FFFD，gbk 分支永远不会执行 —— 那正是"乱码但不报错"的成因。
   */
  function decodeBytes(buf) {
    var bytes = new Uint8Array(buf);

    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return new TextDecoder('utf-8').decode(bytes.subarray(3));     // UTF-8 BOM 必须剥掉
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder('utf-16le').decode(bytes.subarray(2));  // Excel 的「Unicode 文本」
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      try { return new TextDecoder('gbk').decode(bytes); }           // WPS/Windows 导出常见
      catch (e2) { return new TextDecoder('utf-8').decode(bytes); }
    }
  }

  function parseCsvLine(line) {
    var out = [];
    var cur = '';
    var quoted = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (quoted) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; } else { quoted = false; }
        } else { cur += ch; }
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ',') {
        out.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  }

  async function importFile(file) {
    var lower = file.name.toLowerCase();
    var buf = await file.arrayBuffer();

    if (/\.xls$/.test(lower)) {
      throw new Error('不支持旧版 .xls，请在 Excel/WPS 中另存为 .xlsx 或 .csv 再导入');
    }
    if (/\.xlsx$/.test(lower) || /\.xlsm$/.test(lower)) {
      var names = namesFromTable(await XLSXLite.read(buf));
      if (!names.length) throw new Error('这个 xlsx 里没找到姓名列，检查一下表头，或另存为 CSV 再导入');
      return names;
    }

    var text = decodeBytes(buf);
    if (/\.csv$/.test(lower)) {
      var rows = text.split(/\r\n|\n|\r/)
        .filter(function (line) { return line.trim() !== ''; })
        .map(parseCsvLine);
      var isTable = rows.some(function (row) {
        var filled = row.filter(function (cell) { return String(cell).trim() !== ''; });
        return filled.length > 1;
      });
      if (isTable) {
        var fromCsv = namesFromTable(rows);
        if (fromCsv.length) return fromCsv;
      }
    }
    return splitNames(text);
  }

  async function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;

    for (var i = 0; i < files.length; i++) {
      try {
        var names = await importFile(files[i]);
        if (applyNames(names, files[i].name)) {
          toast('已从「' + files[i].name + '」载入 ' + names.length + ' 人', 'ok');
          return;
        }
        toast('「' + files[i].name + '」里没解析出名字', 'error');
      } catch (err) {
        toast(err && err.message ? err.message : '导入失败', 'error');
      }
    }
  }

  /* ---------- 状态变更 ---------- */

  function applyNames(names, label) {
    var cleaned = [];
    (names || []).forEach(function (n) {
      var name = tidyName(n);
      if (name) cleaned.push(name);
    });
    if (!cleaned.length) return false;

    state.entries = cleaned.map(function (name) { return { id: state.nextId++, name: name }; });
    state.drawn = [];
    state.currentId = null;
    state.source = label || '';
    persist();
    render();
    return true;
  }

  function remainingIds() {
    var taken = {};
    state.drawn.forEach(function (id) { taken[id] = true; });
    return state.entries
      .filter(function (e) { return !taken[e.id]; })
      .map(function (e) { return e.id; });
  }

  async function draw() {
    if (state.spinning) return;

    if (!state.entries.length) { toast('还没有名单，先导入一份或粘贴一份', 'error'); return; }
    var pool = remainingIds();
    if (!pool.length) { toast('名单已经抽完了，点「重置进度」重新开始', 'error'); return; }

    state.spinning = true;
    render();

    var winnerId = pool[randomInt(pool.length)];
    var winner = entryById(winnerId);

    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      nameEl.dataset.state = 'rolling';
      var startedAt = performance.now();
      var total = ROLL_MIN_TOTAL + randomInt(ROLL_MAX_TOTAL - ROLL_MIN_TOTAL);
      var delay = ROLL_START_MS;
      while (performance.now() - startedAt < total) {
        nameEl.textContent = state.entries[pool[randomInt(pool.length)]].name;
        await sleep(delay);
        delay = Math.min(Math.round(delay * 1.13) + 1, ROLL_MAX_MS);
      }
    }

    state.drawn.push(winnerId);
    state.currentId = winnerId;
    state.spinning = false;
    persist();
    render();
    srSay('抽中 ' + winner.name + '，还剩 ' + (state.entries.length - state.drawn.length) + ' 人');
  }

  function undo() {
    if (state.spinning || !state.drawn.length) return;
    state.drawn.pop();
    state.currentId = state.drawn.length ? state.drawn[state.drawn.length - 1] : null;
    persist();
    render();
    toast('已撤销上一次抽取', 'ok');
  }

  function reset() {
    if (state.spinning || !state.drawn.length) { toast('还没有抽取记录'); return; }
    if (!window.confirm('清空已抽记录，重新开始？名单会保留。')) return;
    state.drawn = [];
    state.currentId = null;
    persist();
    render();
    toast('已重置，可以重新开始', 'ok');
  }

  /* ---------- 渲染 ---------- */

  function render() {
    var total = state.entries.length;
    var remaining = total - state.drawn.length;

    remainEl.textContent = remaining;
    totalEl.textContent = total;
    drawnCount.textContent = state.drawn.length;

    var current = state.currentId == null ? null : entryById(state.currentId);
    if (!state.spinning) {
      if (current) {
        nameEl.textContent = current.name;
        nameEl.dataset.state = 'win';
      } else if (!total) {
        nameEl.textContent = '还没有名单';
        nameEl.dataset.state = 'empty';
      } else {
        nameEl.textContent = '准备就绪';
        nameEl.dataset.state = 'idle';
      }
    }

    if (!total) {
      hintEl.innerHTML = '点「导入名单」，或把 .txt / .csv / .xlsx 文件直接拖进来';
    } else if (!remaining) {
      hintEl.innerHTML = '名单已抽完，点「重置进度」重新开始';
    } else if (!current) {
      hintEl.innerHTML = '按 <kbd>空格</kbd> 或点下方按钮开始抽取';
    } else {
      hintEl.innerHTML = '按 <kbd>空格</kbd> 抽下一位 · <kbd>Ctrl</kbd>+<kbd>Z</kbd> 撤销';
    }

    var busy = state.spinning;
    drawBtn.disabled = busy || !total || !remaining;
    drawBtn.textContent = total && !remaining ? '已 抽 完' : '开 始 抽 取';
    undoBtn.disabled = busy || !state.drawn.length;
    resetBtn.disabled = busy || !state.drawn.length;
    editBtn.disabled = busy;

    drawnList.textContent = '';
    drawnEmpty.hidden = state.drawn.length > 0;
    state.drawn.forEach(function (id, index) {
      var entry = entryById(id);
      if (!entry) return;
      var li = document.createElement('li');
      li.textContent = entry.name;
      if (index === state.drawn.length - 1) li.className = 'is-latest';
      drawnList.appendChild(li);
    });
    drawnList.scrollTop = drawnList.scrollHeight;

    sourceNote.textContent = total
      ? (state.source ? '名单来源：' + state.source : '共 ' + total + ' 人')
      : '支持 .txt / .csv / .xlsx，也可以直接把文件拖进来';
  }

  /* ---------- 事件绑定 ---------- */

  drawBtn.addEventListener('click', draw);
  undoBtn.addEventListener('click', undo);
  resetBtn.addEventListener('click', reset);

  $('import-btn').addEventListener('click', function () { fileInput.click(); });

  fileInput.addEventListener('change', function () {
    handleFiles(fileInput.files);
    fileInput.value = '';       // 允许重复选同一个文件
  });

  editBtn.addEventListener('click', function () {
    editArea.value = state.entries.map(function (e) { return e.name; }).join('\n');
    editDialog.showModal();
  });

  editDialog.addEventListener('close', function () {
    if (editDialog.returnValue !== 'save') return;
    var names = splitNames(editArea.value);
    if (!names.length) { toast('名单是空的，没有改动', 'error'); return; }
    if (applyNames(names, '手动编辑')) toast('已保存 ' + names.length + ' 人', 'ok');
  });

  document.addEventListener('keydown', function (ev) {
    var tag = ev.target && ev.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || editDialog.open) return;

    if (ev.code === 'Space' || ev.key === ' ') {
      ev.preventDefault();
      if (!drawBtn.disabled) draw();
    } else if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'z' || ev.key === 'Z')) {
      ev.preventDefault();
      undo();
    }
  });

  /* 拖拽导入 —— dragenter/dragleave 会冒泡到子元素，用计数器避免闪烁 */
  var dragDepth = 0;

  function hasFiles(ev) {
    var types = ev.dataTransfer && ev.dataTransfer.types;
    return !!types && Array.prototype.indexOf.call(types, 'Files') >= 0;
  }

  window.addEventListener('dragenter', function (ev) {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    dragDepth++;
    dropOverlay.classList.add('is-active');
  });

  window.addEventListener('dragover', function (ev) {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', function () {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropOverlay.classList.remove('is-active');
  });

  window.addEventListener('drop', function (ev) {
    ev.preventDefault();
    dragDepth = 0;
    dropOverlay.classList.remove('is-active');
    if (ev.dataTransfer && ev.dataTransfer.files) handleFiles(ev.dataTransfer.files);
  });

  /* ---------- 启动 ---------- */

  function boot() {
    if (!restore()) {
      var preload = window.__PRELOAD_NAMES__;
      if (Array.isArray(preload) && preload.length) applyNames(preload, '启动时预载');
    }
    render();

    if (!storage.available) {
      setTimeout(function () {
        toast('以本地文件方式打开时浏览器可能不保存进度，刷新后会回到初始名单', 'error');
      }, 700);
    }
  }

  boot();
})();
