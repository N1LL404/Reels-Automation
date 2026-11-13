// These functions run inside the composer tab via Page.evaluate.
function fillFields(text, expected, metadata, title = text) {
  // Facebook editors may reformat the entered text (line breaks, zero-width
  // markers, trailing spaces). Compare normalized values so a visually filled
  // field is never reported as unfilled.
  const norm = s => String(s ?? '').normalize('NFC').replace(/[\u200b\ufeff]/g, '').replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  function matches(el, wanted) {
    if (!el.isContentEditable) return norm(el.value) === wanted;
    if (norm(el.innerText) === wanted) return true;
    // Preserve block/BR line breaks, but recover a link's actual URL when
    // Facebook renders a shortened label or a redirect through l.facebook.com.
    const copy = el.cloneNode(true);
    for (const link of copy.querySelectorAll('a[href]')) {
      try {
        const url = new URL(link.href);
        const target = /^(l|lm)\.facebook\.com$/.test(url.hostname) && url.pathname === '/l.php' ? url.searchParams.get('u') : link.getAttribute('href');
        if (target && /^https?:\/\//i.test(target) && wanted.includes(target) && /^(?:https?:\/\/|www\.)|[…]|\.\.\.$/.test(link.textContent)) link.textContent = target;
      } catch {}
    }
    for (const br of copy.querySelectorAll('br')) br.replaceWith('\n');
    for (const block of copy.querySelectorAll('div,p')) if (block.nextSibling) block.append('\n');
    return norm(copy.textContent) === wanted;
  }
  const normText = norm(text);
  const visible = el => !el.closest('[inert],[aria-hidden="true"]') && el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const editable = el => visible(el) && !el.closest('[aria-disabled="true"]') && !el.disabled && !el.readOnly;
  const label = el => [el.placeholder,el.getAttribute('aria-label'),...(el.labels || [])].map(x=>typeof x==='string'?x:x?.textContent || '').join(' ');
  const native = [...document.querySelectorAll('textarea,input[type="text"],input:not([type])')];
  // Detect the field types each account actually provides, including fields
  // that are currently disabled or read-only, so absence and "locked" states
  // can be told apart instead of being lumped into one false failure.
  const titleCandidates = metadata ? native.filter(el=>/\btitle\b/i.test(label(el))) : [];
  const descriptionCandidates = [];
  if (metadata) {
    for (const el of document.querySelectorAll('[contenteditable="true"][role="textbox"]')) {
      if (!el.isContentEditable) continue;
      const hint = [el.getAttribute('aria-label'),document.getElementById(el.getAttribute('aria-describedby'))?.textContent].filter(Boolean).join(' ');
      if (!hint || /describ|description|caption|text with your post/i.test(hint)) descriptionCandidates.push(el);
    }
    for (const el of native) {
      if (/description|caption|describe your reel/i.test(label(el)) && !titleCandidates.includes(el)) descriptionCandidates.push(el);
    }
  } else {
    for (const el of document.querySelectorAll('[contenteditable="true"][role="textbox"]')) {
      if (el.isContentEditable) descriptionCandidates.push(el);
    }
  }
  const titles = titleCandidates.filter(editable);
  const editors = descriptionCandidates.filter(editable);
  const descriptionLocked = descriptionCandidates.filter(el=>visible(el) && !editable(el)).length;
  const titleLocked = titleCandidates.filter(el=>visible(el) && !editable(el)).length;
  let filled = 0, titleFilled = 0, changed = false, reason = '';
  const result = () => {
    if (!metadata) return { total:editors.length, filled };
    const samples = [];
    for (const el of editors) {
      if (!el.isConnected) continue;
      const got = el.isContentEditable ? (el.innerText || el.textContent || '') : el.value;
      if (!matches(el, normText)) {
        const actual = norm(got);
        let offset = 0;
        while (offset < actual.length && actual[offset] === normText[offset]) offset++;
        const start = Math.max(0, offset - 12);
        samples.push({ offset, want: normText.slice(start,offset+24), got: actual.slice(start,offset+24) });
      }
    }
    return {
      total:editors.length, filled:editors.filter(el=>el.isConnected && matches(el,normText)).length, titles:titles.length, titleFilled, changed, reason,
      hasDescription:descriptionCandidates.some(visible), hasTitle:titleCandidates.some(visible),
      descriptionLocked, titleLocked, samples
    };
  };
  const setValue = (el, value) => {
    if (norm(el.value) !== norm(value)) {
      if (el.maxLength >= 0 && value.length > el.maxLength) {
        reason = `The ${titles.includes(el) ? 'Reel title' : 'description'} allows ${el.maxLength} characters. Shorten the supplied text before publishing.`;
        return false;
      }
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      changed = true;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(el,value);
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
    }
    return el.isConnected && (el.value === value || norm(el.value) === norm(value));
  };
  for (const el of titles) if (setValue(el, title)) titleFilled++;
  if (titleFilled !== titles.length || (metadata && !text)) return result();
  for (const el of editors) {
    if (!el.isConnected) continue;
    if (!el.isContentEditable) { if (setValue(el, text)) filled++; continue; }
    const value = () => (el.innerText || el.textContent || '');
    if (matches(el, normText) || (!metadata && value().trim())) { filled++; continue; }
    const selection = window.getSelection();
    try {
      el.focus();
      if (!el.isConnected || document.activeElement !== el || !el.isContentEditable) continue;
      const range = document.createRange(); range.selectNodeContents(el);
      selection.removeAllRanges(); selection.addRange(range);
      changed = true;
      document.execCommand('insertText', false, text);
      if (el.isConnected && matches(el, normText)) filled++;
    } finally {
      if (el.contains(selection?.anchorNode)) selection.removeAllRanges();
      if (metadata && document.activeElement === el) el.blur();
    }
  }
  return result();
}

function uploadProgress(files) {
  const visible = el => el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) && !el.closest('[data-is-placeholder="true"],[aria-hidden="true"]');
  const bars = [...document.querySelectorAll('[role="progressbar"][aria-valuenow]')].filter(visible);
  const value = b => Number(b.getAttribute('aria-valuenow')) / (Number(b.getAttribute('aria-valuemax')) || 100) * 100;
  const names = Array.isArray(files) ? new Set(files) : new Set();
  const leaves = [...document.querySelectorAll('div,span,td,strong')].filter(el=>!el.childElementCount && names.has(el.textContent.trim()) && visible(el));
  const percentages = [...document.querySelectorAll('span,div,small')].filter(el=>!el.childElementCount && /^\d{1,3}\s*%$/.test(el.textContent.trim()) && visible(el));
  const completed = [], seen = new Map();
  for (const leaf of leaves) {
    const name = leaf.textContent.trim(), occurrence = seen.get(name) || 0;
    seen.set(name, occurrence + 1);
    for (let row=leaf.parentElement; row && row!==document.body; row=row.parentElement) {
      if (leaves.some(other=>other!==leaf && row.contains(other))) break;
      const bar = bars.find(b=>row.contains(b));
      const percent = percentages.find(el=>row.contains(el));
      if (!bar && !percent) continue;
      if ((bar ? value(bar) : parseInt(percent.textContent,10)) >= 100) completed.push(JSON.stringify([name,occurrence]));
      break;
    }
  }
  const values = bars.length ? bars.map(value) : percentages.map(el=>parseInt(el.textContent,10));
  return { completed, namedRows:leaves.length, bars:values.length, at100:values.filter(v=>v>=100).length, inProgress:values.filter(v=>v<100).length };
}

function sessionView() {
  const path = location.pathname;
  const visible = el => el?.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const password = [...document.querySelectorAll('input[type=password]')].some(visible);
  const challenge = /\/(?:checkpoint|two_step_verification|two_factor)(?:\/|$)/i.test(path);
  const loggedOut = /\/(?:login(?:\.php)?|login_form)(?:\/|$)/i.test(path) || password;
  const marker = /"DTSGInitialData"\s*,\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*"[^"\s]+"/;
  const requestError = location.hostname === 'business.facebook.com' &&
    [...document.querySelectorAll('[role="heading"],h1,h2,h3')].some(el => visible(el) &&
      /^we[’']re having trouble completing your request[.]?$/i.test(el.textContent.trim().replace(/\s+/g, ' ')));
  return { href:location.href, challenge, loggedOut, requestError, marker:[...document.scripts].some(s=>marker.test(s.textContent)), file:!!document.querySelector('input[type=file]') };
}

function publishFeedback() {
  const nodes = [...document.querySelectorAll('[role="alert"],[role="status"],[aria-live="polite"],[aria-live="assertive"],[role="dialog"]')];
  const text = nodes.filter(el=>el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})).map(el=>(el.innerText || '').trim());
  const accepted = [...document.querySelectorAll('[role="dialog"]')].some(dialog => {
    if (!dialog.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return false;
    const heading = dialog.querySelector('[role="heading"],h1,h2,h3');
    return /^your bulk upload is processing!$/i.test(heading?.textContent.trim() || '') &&
      /your reels will be shared based on your selected publishing options/i.test(dialog.innerText);
  });
  return { accepted, busy:text.some(s=>/^(?:publishing|submitting)(?:$|\s|[.…])/i.test(s)) || [...document.querySelectorAll('[aria-busy="true"]')].some(el=>el.checkVisibility() && /publish|submit/i.test(el.getAttribute('aria-label') || el.innerText)), success:text.filter(s=>/successfully published|published successfully|(?:reels?|videos?|posts?|content).{0,60}(?:has been|have been|were|was|is|are) published/i.test(s)), error:text.filter(s=>/something went wrong|publish(?:ing)? failed|(?:failed to|unable to|couldn.t) publish/i.test(s)) };
}
module.exports = { fillFields, uploadProgress, sessionView, publishFeedback };
