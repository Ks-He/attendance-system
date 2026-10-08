/*
 * xlsx-lite.js —— 零依赖读取 .xlsx 的第一张工作表，返回二维文本数组。
 *
 * 定位：这是「尽力而为」的浏览器端解析器，服务于「把文件直接拖进页面」这条路径。
 * 更可靠的解析在 scripts/launch.py（Python 的 zipfile 自动处理 deflate / stored /
 * 数据描述符 / ZIP64），用 --roster 预载时走的是那一侧。这里解析失败时，页面会
 * 提示「请另存为 CSV 后导入」，而不是给出看不懂的错误。
 *
 * 覆盖的真实世界情况（都踩过）：
 *   - 中央目录驱动解析：数据描述符（flag bit 3）下 local header 的 size 是 0，
 *     只有中央目录是权威的
 *   - 严格按中央目录的 compressedSize 切片再解压：Firefox / Safari 在输入尾部
 *     有多余字节时会抛错，Chrome 则容忍
 *   - t="inlineStr"（WPS、Google Sheets 导出大量使用）—— 漏了它就整列读成空
 *   - 富文本 run <is><r><t>张</t></r><r><t>三</t></r></is> —— 直接取 textContent
 *     才能拼出「张三」，只读第一个 <t> 会得到「张」
 *   - t="s" 共享串 / t="str" 公式结果 / 无 t 的数字 / 自闭合空单元格
 *   - xl/sharedStrings.xml 可能整个不存在（全 inline 的文件）
 *   - method 0（stored）与 method 8（deflate）都要支持
 *   - 稀疏单元格：必须按 r="B3" 的列号定位，不能按下标当列号
 *   - 旧版 .xls / 加密文件的 magic 是 D0 CF 11 E0，要明确报错而不是抛解压错误
 */
(function (global) {
  'use strict';

  var SIG_EOCD = 0x06054b50;
  var SIG_CEN  = 0x02014b50;
  var SIG_LOC  = 0x04034b50;
  var SIG_OLE  = 0xd0cf11e0;

  function u16(dv, o) { return dv.getUint16(o, true); }
  function u32(dv, o) { return dv.getUint32(o, true); }

  function findEOCD(dv, len) {
    var floor = Math.max(0, len - (0xffff + 22));
    for (var i = len - 22; i >= floor; i--) {
      if (u32(dv, i) === SIG_EOCD) return i;
    }
    return -1;
  }

  /* 遍历中央目录，得到 { 路径 -> {method, compSize, localOffset} } */
  function readCentralDirectory(buf) {
    var len = buf.byteLength;
    if (len < 22) throw new Error('文件太小，不是有效的 xlsx');

    var dv = new DataView(buf);
    if (u32(dv, 0) === SIG_OLE) {
      throw new Error('这是旧版 .xls 或已加密的文件，请在 Excel/WPS 中另存为 .xlsx 或 .csv 再导入');
    }

    var eocd = findEOCD(dv, len);
    if (eocd < 0) throw new Error('不是有效的 xlsx（没找到 ZIP 结尾标记）');

    var count = u16(dv, eocd + 10);
    var cdOffset = u32(dv, eocd + 16);
    if (count === 0xffff || cdOffset === 0xffffffff) {
      throw new Error('暂不支持 ZIP64 格式，请在 Excel/WPS 中另存为 .csv 后导入');
    }

    var map = {};
    var p = cdOffset;
    for (var i = 0; i < count; i++) {
      if (p + 46 > len || u32(dv, p) !== SIG_CEN) break;
      var nameLen = u16(dv, p + 28);
      var extraLen = u16(dv, p + 30);
      var commentLen = u16(dv, p + 32);
      map[new TextDecoder('utf-8').decode(new Uint8Array(buf, p + 46, nameLen))] = {
        method: u16(dv, p + 10),
        compSize: u32(dv, p + 20),
        localOffset: u32(dv, p + 42)
      };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return map;
  }

  /* 按中央目录给出的精确长度切出压缩数据 */
  function rawSlice(buf, entry) {
    var dv = new DataView(buf);
    var off = entry.localOffset;
    if (u32(dv, off) !== SIG_LOC) throw new Error('xlsx 内部结构损坏（local header 对不上）');
    var start = off + 30 + u16(dv, off + 26) + u16(dv, off + 28);
    return new Uint8Array(buf, start, entry.compSize);
  }

  async function inflate(bytes, method) {
    if (method === 0) return bytes;
    if (method !== 8) throw new Error('不支持的压缩方式（method ' + method + '），请另存为 CSV 后导入');
    if (typeof global.DecompressionStream !== 'function') {
      throw new Error('当前浏览器不支持 DecompressionStream，无法读取 xlsx，请另存为 CSV 后导入');
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new global.DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function textOf(buf, map, path) {
    var entry = map[path];
    if (!entry) return null;
    return new TextDecoder('utf-8').decode(await inflate(rawSlice(buf, entry), entry.method));
  }

  function parseXML(text) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('xlsx 内部的 XML 解析失败');
    return doc;
  }

  function parseSharedStrings(text) {
    if (!text) return [];                       // 全 inlineStr 的文件没有这个部件
    var nodes = parseXML(text).getElementsByTagName('si');
    var out = [];
    for (var i = 0; i < nodes.length; i++) out.push(nodes[i].textContent);  // 自动拼接富文本 run
    return out;
  }

  function colIndex(ref) {
    var m = /^([A-Z]+)/.exec(ref || '');
    if (!m) return -1;
    var n = 0;
    for (var i = 0; i < m[1].length; i++) n = n * 26 + (m[1].charCodeAt(i) - 64);
    return n - 1;
  }

  function cellText(cell, shared) {
    var type = cell.getAttribute('t');

    if (type === 'inlineStr') {
      var is = cell.getElementsByTagName('is')[0];
      return is ? is.textContent : '';
    }
    var v = cell.getElementsByTagName('v')[0];
    if (!v) return '';                          // 自闭合的空单元格
    if (type === 's') {
      var idx = parseInt(v.textContent, 10);
      return shared[idx] == null ? '' : shared[idx];
    }
    return v.textContent;                       // 数字 / t="str" 公式结果
  }

  function parseSheet(text, shared) {
    var rows = parseXML(text).getElementsByTagName('row');
    var table = [];
    for (var i = 0; i < rows.length; i++) {
      var cells = rows[i].getElementsByTagName('c');
      var line = [];
      for (var j = 0; j < cells.length; j++) {
        var at = colIndex(cells[j].getAttribute('r'));
        line[at < 0 ? line.length : at] = cellText(cells[j], shared);
      }
      for (var k = 0; k < line.length; k++) if (line[k] === undefined) line[k] = '';
      table.push(line);
    }
    return table;
  }

  /* 定位第一张工作表：优先 workbook.xml + 它的 rels，失败则退化为 sheet1.xml 启发式 */
  async function firstSheetPath(buf, map) {
    try {
      var wbText = await textOf(buf, map, 'xl/workbook.xml');
      var relText = await textOf(buf, map, 'xl/_rels/workbook.xml.rels');
      if (wbText && relText) {
        var sheets = parseXML(wbText).getElementsByTagName('sheet');
        if (sheets.length) {
          var rid = sheets[0].getAttribute('r:id') ||
                    sheets[0].getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
          var rels = parseXML(relText).getElementsByTagName('Relationship');
          for (var i = 0; i < rels.length; i++) {
            if (rels[i].getAttribute('Id') !== rid) continue;
            var target = (rels[i].getAttribute('Target') || '').replace(/^\.\//, '');
            var full = target.charAt(0) === '/' ? target.slice(1)
                     : /^xl\//.test(target) ? target : 'xl/' + target;
            if (map[full]) return full;
          }
        }
      }
    } catch (e) { /* 静默退化 */ }

    var candidates = Object.keys(map).filter(function (n) {
      return /^xl\/worksheets\/sheet\d+\.xml$/.test(n);
    });
    candidates.sort(function (a, b) {
      return parseInt(/(\d+)\.xml$/.exec(a)[1], 10) - parseInt(/(\d+)\.xml$/.exec(b)[1], 10);
    });
    return candidates[0] || null;
  }

  async function read(buf) {
    var map = readCentralDirectory(buf);
    var sheetPath = await firstSheetPath(buf, map);
    if (!sheetPath) throw new Error('这个 xlsx 里没找到工作表');
    var shared = parseSharedStrings(await textOf(buf, map, 'xl/sharedStrings.xml'));
    return parseSheet(await textOf(buf, map, sheetPath), shared);
  }

  global.XLSXLite = { read: read };
})(window);
