const ACCOUNT_STATUS_URL = 'https://www.facebook.com/account_status';

function isCdpError(err) {
  const msg = String(err && (err.message || err) || '');
  return /CDP timeout/.test(msg) || /CDP not connected/.test(msg) || /CDP connection closed/.test(msg) ||
    /Cannot find context/.test(msg) || /Execution context was destroyed/.test(msg) || /session closed/i.test(msg);
}

function extractAccountStatusData() {
  const OUT = { mainProfileId: null, viewerActorId: null, routeProfileId: null, entities: [], pageIdMap: {}, pageStatusScreen: null, bizwebAssetId: null };
  const seen = new Set();
  const text = (node) => node && typeof node === 'object' && node.text != null ? String(node.text) : null;
  const entityId = (item) => {
    const test = typeof item.test_id === 'string' ? item.test_id : '';
    let m = /-(\d+)$/.exec(test);
    if (m) return m[1];
    const href = typeof item.href === 'string' ? item.href : '';
    m = /\/(\d+)\/?$/.exec(href);
    if (m) return m[1];
    const eligible = Array.isArray(item.eligible_profile_ids) ? item.eligible_profile_ids : [];
    for (const id of eligible) if (typeof id === 'string' && /^\d+$/.test(id)) return id;
    return null;
  };
  const collect = (list, kind) => {
    if (!list || typeof list !== 'object' || !Array.isArray(list.items)) return;
    for (const item of list.items) {
      if (!item || typeof item !== 'object') continue;
      const id = entityId(item);
      if (!id) continue;
      const key = kind + ':' + id;
      if (seen.has(key)) continue;
      seen.add(key);
      OUT.entities.push({
        kind,
        profileId: id,
        title: text(item.title),
        body: text(item.body),
        testId: typeof item.test_id === 'string' ? item.test_id : null,
        href: typeof item.href === 'string' ? item.href : null,
        icon: typeof item.icon === 'string' ? item.icon : null,
        typename: typeof item.__typename === 'string' ? item.__typename : null
      });
    }
  };
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 64) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) visit(node[i], depth + 1);
      return;
    }
    if (node.managed_entities && typeof node.managed_entities === 'object') collect(node.managed_entities, 'managed');
    if (node.managed_entities_other_entities && typeof node.managed_entities_other_entities === 'object') collect(node.managed_entities_other_entities, 'other');
    if (node.managed_entities_main_profile && typeof node.managed_entities_main_profile === 'object') collect(node.managed_entities_main_profile, 'main');
    if (node.main_profile_entity && typeof node.main_profile_entity === 'object' && typeof node.main_profile_entity.id === 'string' && !OUT.mainProfileId) {
      OUT.mainProfileId = node.main_profile_entity.id;
    }
    if (typeof node.delegate_page_id === 'string' && node.delegate_page_id && /^\d+$/.test(node.delegate_page_id)) {
      const candidate = (typeof node.id === 'string' && /^\d+$/.test(node.id)) ? node : (node.profile || (node.node && node.node.profile));
      if (candidate && typeof candidate.id === 'string' && /^\d+$/.test(candidate.id) && !OUT.pageIdMap[candidate.id]) {
        OUT.pageIdMap[candidate.id] = node.delegate_page_id;
      }
    }
    if (node.viewer && node.viewer.actor && typeof node.viewer.actor.id === 'string' && !OUT.viewerActorId) {
      OUT.viewerActorId = node.viewer.actor.id;
    }
    if (node.canonicalRouteName && /ProfileStatusRoute/.test(String(node.canonicalRouteName)) && !OUT.routeProfileId) {
      const pid = node.profile_id;
      if (typeof pid === 'number' || (typeof pid === 'string' && /^\d+$/.test(pid))) OUT.routeProfileId = String(pid);
    }
    if (node.cix_screen_profile_status && typeof node.cix_screen_profile_status === 'object' && !OUT.pageStatusScreen) {
      const vm = node.cix_screen_profile_status.view_model || node.cix_screen_profile_status;
      const integrity = vm && vm.integrity_status;
      const profileEntity = vm && vm.profile_entity;
      const pid = profileEntity && (typeof profileEntity.id === 'string' || typeof profileEntity.id === 'number') ? String(profileEntity.id) : null;
      OUT.pageStatusScreen = {
        header: text(vm && vm.header_title),
        title: text(integrity && integrity.title),
        body: text(integrity && integrity.body),
        icon: integrity && typeof integrity.icon === 'string' ? integrity.icon : null,
        profileId: pid
      };
    }
    if (typeof node.bizweb_home_link === 'string' && !OUT.bizwebAssetId) {
      const m = /asset_id=(\d+)/.exec(node.bizweb_home_link);
      if (m) OUT.bizwebAssetId = m[1];
    }
    if (typeof node.delegatePageID === 'string' && /^\d+$/.test(node.delegatePageID) && !OUT.bizwebAssetId) {
      OUT.bizwebAssetId = node.delegatePageID;
    }
    for (const key of Object.keys(node)) visit(node[key], depth + 1);
  };
  const scripts = [...document.querySelectorAll('script[type="application/json"]')];
  for (const script of scripts) {
    try { visit(JSON.parse(script.textContent || ''), 0); } catch (e) {}
  }
  return OUT;
}

function classifyAccountStatus(raw) {
  const mainIds = new Set();
  const pages = new Map();
  if (raw.mainProfileId) mainIds.add(raw.mainProfileId);
  for (const entity of raw.entities || []) {
    if (!entity.profileId) continue;
    if (entity.kind === 'main') { mainIds.add(entity.profileId); continue; }
    if (/^profile\s/i.test(String(entity.body || '').trim())) { mainIds.add(entity.profileId); continue; }
    pages.set(entity.profileId, entity);
  }
  for (const id of mainIds) pages.delete(id);
  const result = [];
  for (const entity of pages.values()) {
    const body = String(entity.body || '').trim();
    let status;
    if (/^page has no issues$/i.test(body)) status = 'ok';
    else if (/issues|warning|restrict|violation|error|review|disable|ban|against the rules/i.test(body)) status = 'warning';
    else status = 'unknown';
    const pageId = (raw.pageIdMap && raw.pageIdMap[entity.profileId]) || null;
    if (!pageId) status = 'unknown';
    result.push({
      name: entity.title || ('Page ' + entity.profileId),
      profileId: entity.profileId,
      pageId,
      status,
      body: entity.body,
      icon: entity.icon
    });
  }
  if (result.length === 0 && raw.pageStatusScreen) {
    const screen = raw.pageStatusScreen;
    const title = String(screen.title || '').trim();
    const body = String(screen.body || '').trim();
    const screenProfileId = screen.profileId || raw.routeProfileId || null;
    const actorMatch = !screenProfileId || !raw.viewerActorId || screenProfileId === raw.viewerActorId;
    const pageId = actorMatch ? (raw.bizwebAssetId || null) : null;
    let status;
    if (/^page has no issues$/i.test(body)) status = 'ok';
    else if (/issues|warning|restrict|violation|error|review|disable|ban|against the rules/i.test(body)) status = 'warning';
    else status = 'unknown';
    if (!pageId) status = 'unknown';
    if (title || body) {
      result.push({
        name: title || ('Page ' + screenProfileId),
        profileId: screenProfileId,
        pageId,
        status,
        body: screen.body,
        icon: screen.icon
      });
    }
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return {
    pages: result,
    mainProfileId: raw.mainProfileId,
    warningCount: result.filter((p) => p.status === 'warning').length,
    healthyCount: result.filter((p) => p.status === 'ok').length,
    unknownCount: result.filter((p) => p.status === 'unknown').length
  };
}

async function scanAccountStatus(page, job, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  await page.goto(ACCOUNT_STATUS_URL, { waitUntil: 'domcontentloaded', timeout: Math.min(60000, timeoutMs) });
  let lastRaw = null;
  let foundAt = 0;
  while (Date.now() < deadline) {
    let raw;
    try {
      raw = await page.evaluate(extractAccountStatusData, 30000);
    } catch (err) {
      if (!isCdpError(err)) throw err;
      await page.waitForTimeout(1000);
      continue;
    }
    lastRaw = raw;
    const hasData = !!raw.mainProfileId || (Array.isArray(raw.entities) && raw.entities.length > 0) || !!raw.pageStatusScreen;
    if (hasData && !foundAt) foundAt = Date.now();
    if (hasData) {
      const pageEntities = (raw.entities || []).filter((e) => !/^profile\s/i.test(String(e.body || '').trim()));
      let complete = false;
      if (pageEntities.length > 0) {
        complete = pageEntities.every((e) => raw.pageIdMap && raw.pageIdMap[e.profileId]);
      } else if (raw.pageStatusScreen) {
        const screenProfileId = raw.pageStatusScreen.profileId || raw.routeProfileId || null;
        const actorMatch = !screenProfileId || !raw.viewerActorId || screenProfileId === raw.viewerActorId;
        complete = actorMatch && !!raw.bizwebAssetId;
      } else {
        complete = true;
      }
      if (complete || Date.now() - foundAt > 5000) return { ...classifyAccountStatus(raw), scanFailed: false };
    }
    await page.waitForTimeout(1000);
  }
  const partial = lastRaw
    ? classifyAccountStatus(lastRaw)
    : { pages: [], mainProfileId: null, warningCount: 0, healthyCount: 0, unknownCount: 0 };
  partial.scanFailed = true;
  partial.error = 'Account Status data did not load. Check the Facebook login and try again.';
  return partial;
}

module.exports = { scanAccountStatus, classifyAccountStatus, extractAccountStatusData, ACCOUNT_STATUS_URL };
