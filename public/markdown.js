// Small, safe Markdown renderer for task notes: everything is escaped first, then a handful of
// constructs are re-introduced. Shared by the board and node tests (test/markdown.test.js).

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function markdown(src) {
  if (!src || !src.trim()) return '';
  const blocks = [];
  const withoutFences = src.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  let html = '';
  let list = null;
  let para = [];
  const flush = () => {
    if (para.length) html += `<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`;
    para = [];
  };
  const closeList = () => {
    if (list) html += `</${list}>`;
    list = null;
  };
  const openList = (tag) => {
    if (list !== tag) {
      closeList();
      html += `<${tag}>`;
      list = tag;
    }
  };
  for (const line of esc(withoutFences).split('\n')) {
    let m;
    if ((m = line.trim().match(/^\u0000(\d+)\u0000$/))) {
      flush();
      closeList();
      html += blocks[Number(m[1])];
    } else if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flush();
      closeList();
      const level = m[1].length + 2;
      html += `<h${level}>${inline(m[2])}</h${level}>`;
    } else if ((m = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/))) {
      flush();
      openList('ul');
      html += `<li class="check"><input type="checkbox" disabled ${m[1] === ' ' ? '' : 'checked'}>${inline(m[2])}</li>`;
    } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      flush();
      openList('ul');
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flush();
      openList('ol');
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^&gt;\s?(.*)$/))) {
      flush();
      closeList();
      html += `<blockquote>${inline(m[1])}</blockquote>`;
    } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flush();
      closeList();
      html += '<hr>';
    } else if (!line.trim()) {
      flush();
      closeList();
    } else {
      closeList();
      para.push(line);
    }
  }
  flush();
  closeList();
  return html;
}

// Inline constructs on already-escaped text: `code`, **bold**, *italic*, _italic_, links, bare URLs
// and task keys. _italic_ only opens after a space, the start or an opening bracket, and only closes
// before a non-word character, so snake_case, claim_next_task and paths are left alone.
export function inline(s) {
  const codes = [];
  return s
    .replace(/`([^`]+)`/g, (_, c) => `\u0001${codes.push(c) - 1}\u0001`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[\s([{])_(?=[^\s_])(.*?[^\s_])_(?![\w])/g, '$1<em>$2</em>')
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<]+)|(?<![\w-])([A-Z][A-Z0-9]{1,9}-\d+)\b/g,
      (match, text, href, bare, key) => {
        if (href) return `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
        if (bare) return `<a href="${bare}" target="_blank" rel="noopener">${bare}</a>`;
        return `<a class="task-link" href="#/${key}">${key}</a>`;
      },
    )
    .replace(/\u0001(\d+)\u0001/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}
