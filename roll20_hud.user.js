// ==UserScript==
// @name         Roll20 HUD
// @namespace    http://tampermonkey.net/
// @version      6.82
// @match        https://app.roll20.net/editor/
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const BASE = 'https://raw.githubusercontent.com/Xarann/roll20_icons/main/';
  const icon = (name) => `${BASE}${name}%20(96x96).png`;

  let LOCKED_CHAR = null;
  let currentPopup = null;
  let currentSection = null;
  let SCALE = parseFloat(localStorage.getItem('tm_hud_scale') || '1');
  let ROLL_MODE = localStorage.getItem('tm_roll_mode') || 'normal';
  const HUD_AC_BASE_ATTR = 'tm_hud_ac_base';
  const HUD_AC_PREV_MOD_ATTR = 'tm_hud_ac_prev_mod';
  const TOOLTIP_OFFSET_Y = 24;
  const HUD_SHIFT_RIGHT_PERCENT = 15;

  /* ================= CHARACTER ================= */

  function getPlayerId() {
    return window.currentPlayer?.id;
  }

  function autoDetectCharacter() {
    const playerId = getPlayerId();
    const chars = window.Campaign?.characters?.models || [];
    return (
      chars.find((c) => (c.get('controlledby') || '').includes(playerId)) ||
      chars[0] ||
      null
    );
  }

  function getSelectedChar() {
    if (!LOCKED_CHAR) LOCKED_CHAR = autoDetectCharacter();
    return LOCKED_CHAR;
  }

  /* ================= COMMAND ================= */

  const CMD = {
    strength: 'strength',
    dexterity: 'dexterity',
    constitution: 'constitution',
    intelligence: 'intelligence',
    wisdom: 'wisdom',
    charisma: 'charisma',

    save_strength: 'strength_save',
    save_dexterity: 'dexterity_save',
    save_constitution: 'constitution_save',
    save_intelligence: 'intelligence_save',
    save_wisdom: 'wisdom_save',
    save_charisma: 'charisma_save',

    athletics: 'athletics',
    acrobatics: 'acrobatics',
    stealth: 'stealth',
    animal_handling: 'animal_handling',
    sleight_of_hand: 'sleight_of_hand',
    deception: 'deception',
    arcana: 'arcana',
    investigation: 'investigation',
    performance: 'performance',
    history: 'history',
    medicine: 'medicine',
    persuasion: 'persuasion',
    insight: 'insight',
    nature: 'nature',
    religion: 'religion',
    perception: 'perception',
    survival: 'survival',
    intimidation: 'intimidation',

    initiative: 'initiative',
    death: 'death_save',
    dv: 'hit_dice',
    rest_long: 'long_rest',
    rest_short: 'short_rest',
  };

  const LABELS = {
    strength: 'Force',
    dexterity: 'Dextérité',
    constitution: 'Constitution',
    intelligence: 'Intelligence',
    wisdom: 'Sagesse',
    charisma: 'Charisme',

    save_strength: 'JDS Force',
    save_dexterity: 'JDS Dextérité',
    save_constitution: 'JDS Constitution',
    save_intelligence: 'JDS Intelligence',
    save_wisdom: 'JDS Sagesse',
    save_charisma: 'JDS Charisme',

    athletics: 'Athlétisme',
    acrobatics: 'Acrobaties',
    stealth: 'Discrétion',
    animal_handling: 'Dressage',
    sleight_of_hand: 'Escamotage',
    deception: 'Tromperie',
    arcana: 'Arcanes',
    investigation: 'Investigation',
    performance: 'Performance',
    history: 'Histoire',
    medicine: 'Médecine',
    persuasion: 'Persuasion',
    insight: 'Intuition',
    nature: 'Nature',
    religion: 'Religion',
    perception: 'Perception',
    survival: 'Survie',
    intimidation: 'Intimidation',

    initiative: 'Initiative',
    death: 'Mort',
    dv: 'DV',
    rest_long: 'Repos Long',
    rest_short: 'Repos Court',
  };

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function button(cmd) {
    const label = LABELS[cmd];

    if (cmd === 'dv' || cmd === 'death' || cmd === 'rest_long' || cmd === 'rest_short') {
      let className = 'txt';
      if (cmd === 'rest_long') className = 'txt rest-btn rest-long';
      if (cmd === 'rest_short') className = 'txt rest-btn rest-short';
      return `<button data-cmd="${cmd}" data-label="${label}" class="${className}">${label}</button>`;
    }

    return `<button data-cmd="${cmd}" data-label="${label}">
      <img src="${icon(cmd)}">
    </button>`;
  }

  function combatActionButton(label, sheetAction) {
    const safeLabel = escapeHtml(label);
    const safeAction = escapeHtml(sheetAction);
    const tooltip = escapeHtml(`Arme : ${label}`);

    return `<button class="combat-action" data-sheet-action="${safeAction}" data-label="${tooltip}" title="${safeLabel}">${safeLabel}</button>`;
  }

  function sendCommand(command) {
    const ta = document.querySelector('#textchat-input textarea');
    const send = document.querySelector('#textchat-input button');
    if (!ta || !send) return;

    // Keep global modifiers consistent right before any HUD-triggered roll.
    syncGlobalMasterFlags();
    recomputeGlobalModifierDerivedAttrs();

    // On DD5e Legacy, some damage formulas are baked in attack rows and need a native refresh.
    const isAttackAction = /\|repeating_attack_[^|]+_attack}/i.test(command);
    if (isAttackAction && hasAnyActiveGlobalModifierByKey('damage')) {
      triggerNativeRecalc('damage');
      setTimeout(() => {
        ta.value = command;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        send.click();
      }, 90);
      return;
    }

    ta.value = command;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    send.click();
  }

  function buildSheetActionCommand(cmd) {
    const action = CMD[cmd];
    if (!action) return null;

    const char = getSelectedChar();
    if (!char) return null;

    return `%{${char.get('name')}|${action}}`;
  }

  function buildCustomSheetActionCommand(sheetAction) {
    if (!sheetAction) return null;

    const char = getSelectedChar();
    if (!char) return null;

    return `%{${char.get('name')}|${sheetAction}}`;
  }

  /* ================= ROLL MODE ================= */

  function normalizeRollMode(raw) {
    const value = String(raw || '').toLowerCase().trim();
    if (!value) return null;

    if (value === 'disadvantage' || value === 'dis' || value === '-1') {
      return 'disadvantage';
    }

    if (value === 'advantage' || value === 'adv' || value === '1') {
      return 'advantage';
    }

    if (value === 'normal' || value === 'n' || value === '0') {
      return 'normal';
    }

    if (
      value.includes('{{disadvantage=1}}') ||
      value.includes('2d20kl1') ||
      /\bdisadvantage\b/.test(value)
    ) {
      return 'disadvantage';
    }

    if (
      value.includes('{{advantage=1}}') ||
      value.includes('2d20kh1') ||
      /\badvantage\b/.test(value)
    ) {
      return 'advantage';
    }

    if (value.includes('{{normal=1}}') || /\bnormal\b/.test(value)) {
      return 'normal';
    }

    return null;
  }

  function modeFromToggleClass(el) {
    if (!el) return null;

    if (el.classList.contains('toggle-left')) return 'advantage';
    if (el.classList.contains('toggle-center')) return 'normal';
    if (el.classList.contains('toggle-right')) return 'disadvantage';

    const holder = el.closest('.toggle-left, .toggle-center, .toggle-right');
    if (!holder) return null;
    if (holder.classList.contains('toggle-left')) return 'advantage';
    if (holder.classList.contains('toggle-center')) return 'normal';
    if (holder.classList.contains('toggle-right')) return 'disadvantage';

    return null;
  }

  function isToggleSelected(el) {
    if (!el) return false;
    if (el.checked) return true;
    if (el.getAttribute('aria-checked') === 'true') return true;
    if (el.classList.contains('active') || el.classList.contains('checked')) return true;
    if (el.classList.contains('is-active') || el.classList.contains('selected')) return true;
    if (el.closest('.active, .checked, .is-active, .selected')) return true;
    return false;
  }

  function detectRollModeFromSheetDom() {
    const toggles = Array.from(document.querySelectorAll('[name="attr_advantagetoggle"]'));
    if (!toggles.length) return null;

    for (const el of toggles) {
      if (!isToggleSelected(el)) continue;

      const classMode = modeFromToggleClass(el);
      if (classMode) return classMode;

      const selectedValueMode = normalizeRollMode(
        el.value ||
          el.getAttribute('value') ||
          el.getAttribute('data-value') ||
          el.getAttribute('data-state')
      );
      if (selectedValueMode) return selectedValueMode;
    }

    return null;
  }

  function detectRollModeFromCharacterAttr() {
    const char = getSelectedChar();
    const attrs = char?.attribs?.models || [];
    const advAttr = attrs.find((a) => a.get('name') === 'advantagetoggle');
    const rtypeAttr = attrs.find((a) => a.get('name') === 'rtype');

    const advValue = advAttr ? String(advAttr.get('current') || '') : '';
    const rtypeValue = rtypeAttr ? String(rtypeAttr.get('current') || '') : '';

    if (rtypeValue.includes('@{advantagetoggle}')) {
      return normalizeRollMode(advValue) || 'normal';
    }

    return normalizeRollMode(rtypeValue) || normalizeRollMode(advValue);
  }

  function detectRollMode() {
    return detectRollModeFromSheetDom() || detectRollModeFromCharacterAttr() || normalizeRollMode(ROLL_MODE) || 'normal';
  }

  function updateRollModeVisual() {
    const buttons = document.querySelectorAll('#tm-stats-grid .mode-btn');
    buttons.forEach((btn) => {
      const active = btn.dataset.rollMode === ROLL_MODE;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function setAdvantageMode(mode) {
    const toggles = Array.from(document.querySelectorAll('[name="attr_advantagetoggle"]'));
    if (!toggles.length) return setRollModeByCharacterAttrs(mode);

    const className =
      mode === 'advantage'
        ? 'toggle-left'
        : mode === 'normal'
          ? 'toggle-center'
          : 'toggle-right';

    let changed = false;

    for (const el of toggles) {
      if (el.classList.contains(className)) {
        el.click();
        changed = true;
        continue;
      }

      const holder = el.closest(`.${className}`);
      if (holder) {
        holder.click();
        changed = true;
      }
    }

    if (changed) return true;

    for (const el of toggles) {
      const valueMode = normalizeRollMode(
        el.value ||
          el.getAttribute('value') ||
          el.getAttribute('data-value') ||
          el.getAttribute('data-state')
      );

      if (valueMode === mode) {
        el.click();
        changed = true;
      }
    }

    if (changed) return true;

    const fallbackIndex = mode === 'advantage' ? 0 : mode === 'normal' ? 1 : 2;
    if (toggles[fallbackIndex]) {
      toggles[fallbackIndex].click();
      return true;
    }

    return setRollModeByCharacterAttrs(mode);
  }

  function setRollMode(mode, syncSheet) {
    const normalized = normalizeRollMode(mode) || 'normal';
    ROLL_MODE = normalized;
    localStorage.setItem('tm_roll_mode', ROLL_MODE);
    updateRollModeVisual();

    if (syncSheet) {
      const changedDom = setAdvantageMode(ROLL_MODE);
      if (!changedDom) {
        setRollModeByCharacterAttrs(ROLL_MODE);
      }
      setTimeout(syncRollModeFromSheet, 700);
    }
  }

  function syncRollModeFromSheet() {
    const detected = detectRollModeFromSheetDom() || detectRollModeFromCharacterAttr();
    if (!detected) return;
    if (detected !== ROLL_MODE) {
      ROLL_MODE = detected;
      localStorage.setItem('tm_roll_mode', ROLL_MODE);
    }
    updateRollModeVisual();
  }

  function getCharAttrModel(char, name) {
    return (char?.attribs?.models || []).find((a) => a.get('name') === name) || null;
  }

  function setCharAttrValue(char, name, value) {
    if (!char) return false;

    const attr = getCharAttrModel(char, name);
    if (attr) {
      attr.set('current', value);
      if (typeof attr.save === 'function') attr.save();
      return true;
    }

    if (char.attribs && typeof char.attribs.create === 'function') {
      char.attribs.create({ name, current: value });
      return true;
    }

    return false;
  }

  function buildAdvantageFormula(mode, currentRaw) {
    let formula = String(currentRaw || '').trim();
    if (!formula) formula = '{{query=1}} {{normal=1}} {{r2=[[0d20';

    const modeToken =
      mode === 'advantage'
        ? '{{advantage=1}}'
        : mode === 'disadvantage'
          ? '{{disadvantage=1}}'
          : '{{normal=1}}';

    formula = formula.replace(
      /\{\{advantage=1\}\}|\{\{normal=1\}\}|\{\{disadvantage=1\}\}/g,
      modeToken
    );

    if (mode === 'normal') {
      formula = formula.replace(/\{\{r2=\[\[\s*(?:@\{d20\}|1d20|2d20)[^}]*/i, '{{r2=[[0d20');
      if (!/\{\{r2=\[\[0d20/i.test(formula)) {
        formula += ' {{r2=[[0d20';
      }
    } else {
      formula = formula.replace(/\{\{r2=\[\[\s*0d20[^}]*/i, '{{r2=[[@{d20}');
      if (!/\{\{r2=\[\[@\{d20\}/i.test(formula)) {
        formula += ' {{r2=[[@{d20}';
      }
    }

    return formula.replace(/\s{2,}/g, ' ').trim();
  }

  function setRollModeByCharacterAttrs(mode) {
    const char = getSelectedChar();
    if (!char) return false;

    const advAttr = getCharAttrModel(char, 'advantagetoggle');
    const rtypeAttr = getCharAttrModel(char, 'rtype');
    const seed = advAttr?.get('current') || rtypeAttr?.get('current') || '';
    const nextAdv = buildAdvantageFormula(mode, seed);

    const okAdv = setCharAttrValue(char, 'advantagetoggle', nextAdv);
    const okRtype = setCharAttrValue(char, 'rtype', '@{advantagetoggle}');

    return Boolean(okAdv || okRtype);
  }

  /* ================= HP ================= */

  function parseIntSafe(value, fallback) {
    const n = Number.parseInt(String(value ?? '').trim(), 10);
    return Number.isFinite(n) ? n : fallback;
  }

  function formatHpValue(value) {
    if (value === null || value === undefined) return '--';
    const raw = String(value).trim();
    if (!raw) return '--';
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? String(parsed) : '--';
  }

  function getHpState() {
    const char = getSelectedChar();
    if (!char) {
      return { max: '--', current: '--', temp: '--', ca: '--', dv: '--' };
    }

    const hpAttr = getCharAttrModel(char, 'hp');
    const hpMaxAttr = getCharAttrModel(char, 'hp_max');
    const hpTempAttr = getCharAttrModel(char, 'hp_temp');
    const acAttr = getCharAttrModel(char, 'ac') || getCharAttrModel(char, 'npc_ac');
    const hitDiceAttr = getHitDiceAttrModel(char);

    const maxRaw = hpAttr ? hpAttr.get('max') : hpMaxAttr?.get('current');
    const currentRaw = hpAttr ? hpAttr.get('current') : null;
    const tempRaw = hpTempAttr ? hpTempAttr.get('current') : null;
    const caRaw = acAttr ? acAttr.get('current') : null;
    const dvRaw = hitDiceAttr ? hitDiceAttr.get('current') : null;

    return {
      max: formatHpValue(maxRaw),
      current: formatHpValue(currentRaw),
      temp: formatHpValue(tempRaw),
      ca: formatHpValue(caRaw),
      dv: formatHpValue(dvRaw),
    };
  }

  function getHitDiceAttrModel(char) {
    return (
      getCharAttrModel(char, 'hit_dice') ||
      getCharAttrModel(char, 'hitdice') ||
      getCharAttrModel(char, 'hit_dice_current')
    );
  }

  function enforceCurrentHpCap() {
    const char = getSelectedChar();
    if (!char) return;

    const hpAttr = getCharAttrModel(char, 'hp');
    const hpMaxAttr = getCharAttrModel(char, 'hp_max');
    const maxValue = parseIntSafe(hpAttr?.get('max') ?? hpMaxAttr?.get('current'), NaN);
    if (!Number.isFinite(maxValue)) return;

    const currentValue = parseIntSafe(hpAttr?.get('current'), NaN);
    if (!Number.isFinite(currentValue)) return;
    if (currentValue <= maxValue) return;

    if (hpAttr) {
      hpAttr.set('current', String(maxValue));
      if (typeof hpAttr.save === 'function') hpAttr.save();
    } else if (char.attribs && typeof char.attribs.create === 'function') {
      char.attribs.create({ name: 'hp', current: String(maxValue), max: String(maxValue) });
    }
  }

  function updateVitalCell(type, label, value) {
    const cell = root.querySelector(`[data-hp-value="${type}"], [data-vital-value="${type}"]`);
    if (!cell) return;
    const numberEl = cell.querySelector('.hp-number');
    if (numberEl) {
      numberEl.textContent = value;
    } else {
      cell.textContent = value;
    }
    cell.dataset.label = `${label} : ${value}`;
  }

  function renderHpState() {
    enforceCurrentHpCap();
    const hp = getHpState();
    updateVitalCell('max', 'HP Max', hp.max);
    updateVitalCell('current', 'HP Current', hp.current);
    updateVitalCell('temp', 'HP Temp', hp.temp);
    updateVitalCell('ca', 'CA', hp.ca);
    updateVitalCell('dv', 'DV', hp.dv);
  }

  function adjustHpValue(target, delta) {
    const char = getSelectedChar();
    if (!char) return;

    let attrName = 'hp';
    let attr = null;

    if (target === 'temp') {
      attrName = 'hp_temp';
      attr = getCharAttrModel(char, attrName);
    } else if (target === 'dv') {
      attrName = 'hit_dice';
      attr = getHitDiceAttrModel(char);
    } else {
      attr = getCharAttrModel(char, attrName);
    }

    const current = parseIntSafe(attr?.get('current'), 0);
    let next = Math.max(0, current + delta);

    if (target === 'current') {
      const hpAttr = getCharAttrModel(char, 'hp');
      const hpMaxAttr = getCharAttrModel(char, 'hp_max');
      const maxValue = parseIntSafe(hpAttr?.get('max') ?? hpMaxAttr?.get('current'), NaN);
      if (Number.isFinite(maxValue)) {
        next = Math.min(next, maxValue);
      }
    }

    if (target === 'dv') {
      const maxValue = parseIntSafe(attr?.get('max'), NaN);
      if (Number.isFinite(maxValue)) {
        next = Math.min(next, maxValue);
      }
    }

    if (attr) {
      attr.set('current', String(next));
      if (typeof attr.save === 'function') attr.save();
    } else if (char.attribs && typeof char.attribs.create === 'function') {
      char.attribs.create({ name: attrName, current: String(next) });
    }

    renderHpState();
  }

  /* ================= RESOURCES ================= */

  function getAttrCurrentValue(char, name) {
    const model = getCharAttrModel(char, name);
    return model ? String(model.get('current') || '').trim() : '';
  }

  function normalizeTextToken(raw) {
    return String(raw || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function inferResetTypeFromText(raw) {
    const v = normalizeTextToken(raw);
    if (!v) return '';

    const compact = v.replace(/\s+/g, '');
    const shortTokens = new Set(['short', 'shortrest', 'reposcourt', 'court', 'sr', 's', '1']);
    const longTokens = new Set(['long', 'longrest', 'reposlong', 'lr', 'l', '2']);

    if (shortTokens.has(v) || shortTokens.has(compact)) return 'short';
    if (longTokens.has(v) || longTokens.has(compact)) return 'long';

    if (/\bshort\b/.test(v) || /\bcourt\b/.test(v)) return 'short';
    if (/\blong\b/.test(v)) return 'long';

    return '';
  }

  function isExplicitNoResetValue(raw) {
    const v = normalizeTextToken(raw);
    return (
      v === '0' ||
      v === 'false' ||
      v === 'off' ||
      v === 'none' ||
      v === 'no' ||
      v === 'aucun' ||
      v === 'aucune' ||
      v === 'n/a' ||
      v === 'na' ||
      v === '-' ||
      v === 'null'
    );
  }

  function isExplicitYesValue(raw) {
    const v = normalizeTextToken(raw);
    return (
      v === '1' ||
      v === 'true' ||
      v === 'on' ||
      v === 'yes' ||
      v === 'oui' ||
      v === 'enabled' ||
      v === 'active' ||
      v === 'checked'
    );
  }

  function isLikelyResourceBase(base) {
    const b = String(base || '').trim();
    if (!b || !/resource/i.test(b)) return false;
    if (/^repeating_/i.test(b)) return false;
    if (
      /(?:_|^)(?:name|max|reset|recharge|recovery|recover|rest|refresh|uses|enabled|active|flag|mod|type)$/i.test(
        b
      )
    ) return false;
    return true;
  }

  const RESOURCE_META_TOKENS = [
    'recovery_period',
    'uses_recovery',
    'uses_reset',
    'short_rest',
    'long_rest',
    'recharge',
    'recovery',
    'recover',
    'refresh',
    'reset',
    'rest',
    'name',
    'max',
    'short',
    'long',
    'sr',
    'lr',
  ];

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function parseResourceAttrParts(attrName) {
    const name = String(attrName || '').trim();
    if (!name || !/resource/i.test(name)) return null;

    for (const token of RESOURCE_META_TOKENS) {
      const tokenRx = escapeRegExp(token);

      let m = name.match(new RegExp(`^(.*)_${tokenRx}$`, 'i'));
      if (m && isLikelyResourceBase(m[1])) {
        return { base: m[1], token, attr: name };
      }

      m = name.match(new RegExp(`^(.*)_${tokenRx}_(.+)$`, 'i'));
      if (m) {
        const candidate = `${m[1]}_${m[2]}`;
        if (isLikelyResourceBase(candidate)) {
          return { base: candidate, token, attr: name };
        }
      }
    }

    if (isLikelyResourceBase(name)) return { base: name, token: 'value', attr: name };
    return null;
  }

  function extractResourceBaseFromAttrName(attrName) {
    return parseResourceAttrParts(attrName)?.base || '';
  }

  function getResourceSortMeta(base) {
    const lower = String(base || '').toLowerCase();
    let group = 2;
    if (lower.startsWith('class_resource')) group = 0;
    else if (lower.startsWith('other_resource')) group = 1;

    const m = lower.match(/(?:_|)(\d+)$/);
    const index = m ? parseIntSafe(m[1], 1) : 1;
    return { group, index, lower };
  }

  function makeResourceFallbackName(base) {
    const lower = String(base || '').toLowerCase();
    if (lower === 'class_resource') return 'Ressource de Classe';
    if (lower === 'other_resource') return 'Autres Ressources';

    const classMatch = lower.match(/^class_resource_?(\d+)$/);
    if (classMatch) return `Ressource de Classe ${classMatch[1]}`;

    const otherMatch = lower.match(/^other_resource_?(\d+)$/);
    if (otherMatch) return `Autres Ressources ${otherMatch[1]}`;

    return String(base || '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (m) => m.toUpperCase());
  }

  function discoverResourceDefs(char) {
    const attrs = char?.attribs?.models || [];
    const names = attrs
      .map((attr) => String(attr.get('name') || '').trim())
      .filter(Boolean);
    const defMap = new Map();

    function ensureDef(base) {
      if (!defMap.has(base)) {
        defMap.set(base, {
          key: base,
          fallbackName: makeResourceFallbackName(base),
          valueAttr: base,
          maxAttr: `${base}_max`,
          nameAttr: `${base}_name`,
        });
      }
      return defMap.get(base);
    }

    ensureDef('class_resource');
    ensureDef('other_resource');

    names.forEach((name) => {
      const parsed = parseResourceAttrParts(name);
      if (!parsed) return;

      const def = ensureDef(parsed.base);
      if (parsed.token === 'name') def.nameAttr = name;
      if (parsed.token === 'max') def.maxAttr = name;
      if (parsed.token === 'value') def.valueAttr = name;
    });

    return Array.from(defMap.values())
      .filter((def) => isLikelyResourceBase(def.key))
      .filter(
        (def) =>
          names.includes(def.valueAttr) ||
          names.includes(def.nameAttr) ||
          names.includes(def.maxAttr) ||
          names.some((name) => extractResourceBaseFromAttrName(name) === def.key)
      )
      .sort((a, b) => {
        const sa = getResourceSortMeta(a.key);
        const sb = getResourceSortMeta(b.key);
        if (sa.group !== sb.group) return sa.group - sb.group;
        if (sa.index !== sb.index) return sa.index - sb.index;
        return sa.lower.localeCompare(sb.lower);
      });
  }

  function detectResourceResetType(char, prefix) {
    const staticCandidates = [
      `${prefix}_reset`,
      `${prefix}_recharge`,
      `${prefix}_recovery`,
      `${prefix}_recovery_period`,
      `${prefix}_recover`,
      `${prefix}_rest`,
      `${prefix}_refresh`,
      `${prefix}_uses_reset`,
      `${prefix}_uses_recovery`,
      `${prefix}_short_rest`,
      `${prefix}_shortrest`,
      `${prefix}_short`,
      `${prefix}_sr`,
      `${prefix}_long_rest`,
      `${prefix}_longrest`,
      `${prefix}_long`,
      `${prefix}_lr`,
    ];

    const dynamicCandidates = (char?.attribs?.models || [])
      .map((attr) => String(attr.get('name') || '').trim())
      .filter(Boolean)
      .filter((name) => extractResourceBaseFromAttrName(name) === prefix)
      .filter((name) => /(reset|recharge|recover|recovery|rest|refresh|uses|short|long|sr|lr)/i.test(name));

    const candidates = [...new Set([...staticCandidates, ...dynamicCandidates])];

    for (const name of candidates) {
      const model = getCharAttrModel(char, name);
      if (!model) continue;

      const raw = String(model.get('current') || '').trim();
      if (!raw) continue;

      const loweredName = name.toLowerCase();

      if (/(?:^|_)(?:short|court|sr)(?:_|$)/.test(loweredName)) {
        if (isExplicitYesValue(raw)) return 'short';
      }

      if (/(?:^|_)(?:long|lr)(?:_|$)/.test(loweredName)) {
        if (isExplicitYesValue(raw)) return 'long';
      }

      if (isExplicitNoResetValue(raw)) continue;

      const type = inferResetTypeFromText(raw);
      if (type) return type;
    }

    return '';
  }

  function getResourcesState() {
    const char = getSelectedChar();
    if (!char) return [];

    const defs = discoverResourceDefs(char);

    return defs
      .map((def) => {
        const valueRaw = getAttrCurrentValue(char, def.valueAttr);
        const maxRaw = getAttrCurrentValue(char, def.maxAttr);
        const nameRaw = getAttrCurrentValue(char, def.nameAttr);
        if (!nameRaw) return null;
        const value = formatHpValue(valueRaw);
        const max = formatHpValue(maxRaw);

        const hasAny = Boolean(
          valueRaw ||
            maxRaw ||
            getCharAttrModel(char, def.valueAttr) ||
            getCharAttrModel(char, def.maxAttr)
        );
        if (!hasAny) return null;

        const label = nameRaw;
        const resetType = detectResourceResetType(char, def.key);

        return {
          key: def.key,
          label,
          value,
          max,
          valueAttr: def.valueAttr,
          maxAttr: def.maxAttr,
          resetType,
        };
      })
      .filter(Boolean);
  }

  function adjustResourceValue(valueAttr, maxAttr, delta) {
    const char = getSelectedChar();
    if (!char || !valueAttr) return;

    const valueModel = getCharAttrModel(char, valueAttr);
    const current = parseIntSafe(valueModel?.get('current'), 0);
    let next = Math.max(0, current + delta);

    const maxModel = maxAttr ? getCharAttrModel(char, maxAttr) : null;
    const maxValue = parseIntSafe(maxModel?.get('current'), NaN);
    if (Number.isFinite(maxValue)) {
      next = Math.min(next, maxValue);
    }

    if (valueModel) {
      valueModel.set('current', String(next));
      if (typeof valueModel.save === 'function') valueModel.save();
    } else if (char.attribs && typeof char.attribs.create === 'function') {
      char.attribs.create({ name: valueAttr, current: String(next) });
    }

    if (currentSection === 'resource' && currentPopup) {
      currentPopup.innerHTML = buildResourcesContent();
    }
  }

  function buildResourcesContent() {
    const items = getResourcesState();

    if (!items.length) {
      return `
        <div class="tm-mods-wrap">
          <div class="tm-mod-cat">
            <div class="tm-mod-title">Ressources</div>
            <div class="tm-mod-empty">Aucune ressource détectée</div>
          </div>
        </div>
      `;
    }

    return `
      <div class="tm-mods-wrap">
        <div class="tm-mod-cat">
          <div class="tm-mod-title">Ressources</div>
          ${items
            .map((item) => {
              const nameClass =
                item.resetType === 'long'
                  ? 'tm-resource-name is-long'
                  : item.resetType === 'short'
                    ? 'tm-resource-name is-short'
                    : 'tm-resource-name';
              const qtyDisplay = item.max !== '--' ? `${item.value}/${item.max}` : item.value;
              const tooltip = escapeHtml(`${item.label} : ${qtyDisplay}`);

              return `
                <div class="tm-resource-item" data-label="${tooltip}">
                  <span class="${nameClass}">${escapeHtml(item.label)}</span>
                  <span class="tm-resource-qty">${escapeHtml(qtyDisplay)}</span>
                  <button
                    class="tm-resource-step"
                    data-resource-attr="${escapeHtml(item.valueAttr)}"
                    data-resource-max="${escapeHtml(item.maxAttr || '')}"
                    data-resource-delta="1"
                    data-label="+1 ${escapeHtml(item.label)}">+</button>
                  <button
                    class="tm-resource-step"
                    data-resource-attr="${escapeHtml(item.valueAttr)}"
                    data-resource-max="${escapeHtml(item.maxAttr || '')}"
                    data-resource-delta="-1"
                    data-label="-1 ${escapeHtml(item.label)}">-</button>
                </div>
              `;
            })
            .join('')}
        </div>
      </div>
    `;
  }

  /* ================= GLOBAL MODIFIERS ================= */

  const GLOBAL_MOD_CONFIG = [
    {
      key: 'save',
      title: 'Sauvegarde Global',
      section: 'repeating_savemod',
      nameField: 'global_save_name',
      valueField: 'global_save_roll',
      activeField: 'global_save_active_flag',
      masterFlag: 'global_save_mod_flag',
    },
    {
      key: 'attack',
      title: 'Attaque Global',
      section: 'repeating_tohitmod',
      nameField: 'global_attack_name',
      valueField: 'global_attack_roll',
      activeField: 'global_attack_active_flag',
      masterFlag: 'global_attack_mod_flag',
    },
    {
      key: 'damage',
      title: 'Dégâts Global',
      section: 'repeating_damagemod',
      nameField: 'global_damage_name',
      valueField: 'global_damage_damage',
      extraFields: ['global_damage_type'],
      activeField: 'global_damage_active_flag',
      masterFlag: 'global_damage_mod_flag',
    },
    {
      key: 'ac',
      title: 'CA Global',
      section: 'repeating_acmod',
      nameField: 'global_ac_name',
      valueField: 'global_ac_val',
      activeField: 'global_ac_active_flag',
      masterFlag: 'global_ac_mod_flag',
    },
  ];

  function isActiveFlagValue(value) {
    const v = String(value ?? '').trim().toLowerCase();
    // Mirror DD5E Legacy sheetworker logic: active when value is not explicitly "0".
    return v !== '0';
  }

  function readRepeatingModifierRows(char, cfg) {
    const attrs = char?.attribs?.models || [];
    const repOrderAttr = `_reporder_${cfg.section}`;
    const prefix = `${cfg.section}_`;
    const rows = new Map();
    let orderedRowIds = [];

    attrs.forEach((attr) => {
      const name = attr.get('name');
      if (!name) return;

      if (name === repOrderAttr) {
        const raw = String(attr.get('current') || '');
        orderedRowIds = raw
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean);
        return;
      }

      if (!name.startsWith(prefix)) return;
      const tail = name.slice(prefix.length);
      const sep = tail.indexOf('_');
      if (sep === -1) return;

      const rowId = tail.slice(0, sep);
      const field = tail.slice(sep + 1);
      if (!field) return;

      if (!rows.has(rowId)) {
        rows.set(rowId, {
          rowId,
          label: '',
          value: '',
          extras: {},
          active: false,
          section: cfg.section,
          activeField: cfg.activeField,
          key: cfg.key,
          activeAttrName: `${cfg.section}_${rowId}_${cfg.activeField}`,
          masterFlag: cfg.masterFlag,
        });
      }

      const row = rows.get(rowId);
      const current = String(attr.get('current') || '').trim();

      if (field === cfg.nameField) row.label = current;
      if (field === cfg.valueField) row.value = current;
      if (field === cfg.activeField) row.active = isActiveFlagValue(current);
      if (Array.isArray(cfg.extraFields) && cfg.extraFields.includes(field)) row.extras[field] = current;
    });

    const ordered = [];
    orderedRowIds.forEach((rowId) => {
      if (!rows.has(rowId)) return;
      ordered.push(rows.get(rowId));
      rows.delete(rowId);
    });
    rows.forEach((row) => ordered.push(row));

    return ordered
      .map((row) => {
        const label = row.label || row.value || `Mod ${row.rowId.slice(0, 4)}`;
        return {
          ...row,
          label,
        };
      })
      .filter((row) => row.label);
  }

  function getGlobalModifiersState() {
    const char = getSelectedChar();
    if (!char) {
      return GLOBAL_MOD_CONFIG.map((cfg) => ({ ...cfg, items: [] }));
    }

    return GLOBAL_MOD_CONFIG.map((cfg) => ({
      ...cfg,
      items: readRepeatingModifierRows(char, cfg),
    }));
  }

  function buildGlobalModsContent() {
    const categories = getGlobalModifiersState();

    return `
      <div class="tm-mods-wrap">
        ${categories
          .map((cat) => {
            if (!cat.items.length) {
              return `
                <div class="tm-mod-cat">
                  <div class="tm-mod-title">${escapeHtml(cat.title)}</div>
                  <div class="tm-mod-empty">Aucun modificateur</div>
                </div>
              `;
            }

            return `
              <div class="tm-mod-cat">
                <div class="tm-mod-title">${escapeHtml(cat.title)}</div>
                ${cat.items
                  .map((item) => {
                    const label = escapeHtml(item.label);
                    const valueText = item.value ? escapeHtml(item.value) : '';
                    const detail = valueText ? ` (${valueText})` : '';
                    const checked = item.active ? 'checked' : '';
                    const tooltip = escapeHtml(`${cat.title} : ${item.label}`);
                    return `
                      <label class="tm-mod-item" data-label="${tooltip}" title="${label}${detail}">
                        <input type="checkbox"
                          data-mod-attr="${escapeHtml(item.activeAttrName)}"
                          data-mod-master="${escapeHtml(item.masterFlag || '')}"
                          data-mod-section="${escapeHtml(item.section || '')}"
                          data-mod-rowid="${escapeHtml(item.rowId || '')}"
                          data-mod-field="${escapeHtml(item.activeField || '')}"
                          data-mod-key="${escapeHtml(item.key || '')}"
                          ${checked}>
                        <span class="tm-mod-name">${label}</span>
                        <span class="tm-mod-value">${valueText}</span>
                      </label>
                    `;
                  })
                  .join('')}
              </div>
            `;
          })
          .join('')}
      </div>
    `;
  }

  function setGlobalModifierActive(activeAttrName, masterFlag, active, section, rowId, field, key) {
    const char = getSelectedChar();
    if (!char || !activeAttrName) return;

    // Prefer real repeating checkbox click to trigger Roll20 sheetworkers.
    if (section && rowId && field) {
      setSheetRepeatingCheckbox(section, rowId, field, active);
    } else {
      setSheetCheckboxByAttrName(activeAttrName, active);
    }

    setCharAttrValue(char, activeAttrName, active ? '1' : '0');
    setSheetInputValueByAttrName(activeAttrName, active ? '1' : '0');

    if (masterFlag) {
      syncGlobalMasterFlags(masterFlag);
    }

    recomputeGlobalModifierDerivedAttrs(key);
    triggerNativeRecalc(key);

    // Re-apply once async updates settled (Roll20 sheet/UI latency).
    setTimeout(() => {
      if (masterFlag) syncGlobalMasterFlags(masterFlag);
      recomputeGlobalModifierDerivedAttrs(key);
      triggerNativeRecalc(key);
      if (key === 'ac') syncArmorClassFromGlobalMods();
    }, 120);
  }

  function setSheetCheckboxByAttrName(attrName, checked) {
    if (!attrName) return false;

    const inputs = Array.from(document.querySelectorAll(`[name="attr_${attrName}"]`));
    if (!inputs.length) return false;

    let changed = false;

    inputs.forEach((input) => {
      if (!(input instanceof HTMLInputElement)) return;
      if (input.type !== 'checkbox' && input.type !== 'radio') return;
      if (input.checked === checked) return;
      input.click();
      changed = true;
    });

    return changed;
  }

  function setSheetInputValueByAttrName(attrName, value) {
    if (!attrName) return false;
    const inputs = Array.from(document.querySelectorAll(`[name="attr_${attrName}"]`));
    if (!inputs.length) return false;

    const rawValue = String(value ?? '');
    let changed = false;

    inputs.forEach((input) => {
      if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement || input instanceof HTMLSelectElement)) return;

      if (input instanceof HTMLInputElement && (input.type === 'checkbox' || input.type === 'radio')) {
        const shouldCheck = rawValue !== '0' && rawValue !== '' && rawValue !== 'false';
        if (input.checked !== shouldCheck) {
          input.checked = shouldCheck;
          changed = true;
        }
      } else if (input.value !== rawValue) {
        input.value = rawValue;
        changed = true;
      }

      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    return changed;
  }

  function setSheetRepeatingCheckbox(section, rowId, field, checked) {
    if (!section || !rowId || !field) return false;

    const sectionShort = section.replace(/^repeating_/, '');
    const fullAttrName = `repeating_${sectionShort}_${rowId}_${field}`;
    const targetValue = checked ? '1' : '0';
    const rowSelectors = [
      `fieldset.${section} .repitem[data-reprowid="${rowId}"]`,
      `.repitem[data-reprowid="${rowId}"]`,
      `[data-reprowid="${rowId}"]`,
      `.repitem[data-itemid="${rowId}"]`,
      `[data-itemid="${rowId}"]`,
    ];
    let changed = false;

    rowSelectors.forEach((rowSelector) => {
      const rows = Array.from(document.querySelectorAll(rowSelector));
      rows.forEach((rowEl) => {
        const inputs = Array.from(
          rowEl.querySelectorAll(`input[name="attr_${field}"], input[name$="_${field}"]`)
        );
        inputs.forEach((input) => {
          if (!(input instanceof HTMLInputElement)) return;
          if (input.type === 'checkbox' || input.type === 'radio') {
            if (input.checked !== checked) {
              input.checked = checked;
              changed = true;
            }
          }
          if (input.type !== 'checkbox' && input.type !== 'radio' && input.value !== targetValue) {
            input.value = targetValue;
            changed = true;
          }

          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        });
      });
    });

    // Fallback to explicit full attr name used by repeating rows in some DOM variants.
    const inputs = Array.from(document.querySelectorAll(`[name="attr_${fullAttrName}"], [name="attr_${field}"]`));
    inputs.forEach((input) => {
      if (!(input instanceof HTMLInputElement)) return;
      if (input.type === 'checkbox' || input.type === 'radio') {
        if (input.checked === checked) return;
        input.checked = checked;
        changed = true;
      } else if (input.value !== targetValue) {
        input.value = targetValue;
        changed = true;
      }

      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Final safety: update hidden/non-checkbox versions of the same repeating attribute.
    setSheetInputValueByAttrName(fullAttrName, targetValue);

    return changed;
  }

  function buildGlobalRollFormula(rows) {
    const parts = rows
      .filter((row) => row.active && row.value)
      .map((row) => `${row.value}[${row.label}]`);

    return parts.length ? `[[${parts.join('+')}]]` : '';
  }

  function getActiveGlobalAcModTotal() {
    const char = getSelectedChar();
    if (!char) return 0;
    const cfg = GLOBAL_MOD_CONFIG.find((c) => c.key === 'ac');
    if (!cfg) return 0;

    return readRepeatingModifierRows(char, cfg)
      .filter((row) => row.active)
      .reduce((acc, row) => acc + parseIntSafe(row.value, 0), 0);
  }

  function syncArmorClassFromGlobalMods() {
    const char = getSelectedChar();
    if (!char) return;

    const acAttr = getCharAttrModel(char, 'ac') || getCharAttrModel(char, 'npc_ac');
    if (!acAttr) return;

    const currentAc = parseIntSafe(acAttr.get('current'), NaN);
    if (!Number.isFinite(currentAc)) return;

    const activeMod = getActiveGlobalAcModTotal();
    const prevModAttr = getCharAttrModel(char, HUD_AC_PREV_MOD_ATTR);
    const baseAttr = getCharAttrModel(char, HUD_AC_BASE_ATTR);

    let prevMod = parseIntSafe(prevModAttr?.get('current'), NaN);
    if (!Number.isFinite(prevMod)) prevMod = activeMod;

    let baseAc = parseIntSafe(baseAttr?.get('current'), NaN);
    if (!Number.isFinite(baseAc)) {
      baseAc = currentAc - prevMod;
    }

    // If AC changed externally (equipment, buffs, sheet edit), re-anchor base.
    const expectedCurrent = baseAc + prevMod;
    if (currentAc !== expectedCurrent) {
      baseAc = currentAc - prevMod;
    }

    const nextAc = baseAc + activeMod;
    if (nextAc !== currentAc) {
      acAttr.set('current', String(nextAc));
      if (typeof acAttr.save === 'function') acAttr.save();
    }

    setCharAttrValue(char, HUD_AC_BASE_ATTR, String(baseAc));
    setCharAttrValue(char, HUD_AC_PREV_MOD_ATTR, String(activeMod));
  }

  function hasAnyActiveGlobalModifierByKey(key) {
    const cfg = GLOBAL_MOD_CONFIG.find((c) => c.key === key);
    if (!cfg) return false;
    const char = getSelectedChar();
    if (!char) return false;
    return readRepeatingModifierRows(char, cfg).some((row) => row.active);
  }

  function triggerNativeRecalc(key = null) {
    const call = (name, ...args) => {
      const fn = window?.[name];
      if (typeof fn !== 'function') return false;
      try {
        fn(...args);
        return true;
      } catch (err) {
        return false;
      }
    };

    if (!key || key === 'damage') {
      call('update_globaldamage');
      call('update_attacks', 'all');
    }

    if (!key || key === 'ac') {
      call('update_ac');
      setTimeout(syncArmorClassFromGlobalMods, 90);
    }
  }

  function buildGlobalDamageState(rows) {
    const activeRows = rows.filter((row) => row.active);
    const roll = activeRows
      .filter((row) => row.value && row.label)
      .map((row) => `${row.value}[${row.label}]`)
      .join('+');

    const type = activeRows
      .map((row) => row.extras?.global_damage_type || '')
      .filter(Boolean)
      .join('/');

    const crit = roll
      .replace(/(?:[+\-*\/%]|\*\*|^)\s*\d+(?:\[.*?])?(?!d\d+)/gi, '')
      .replace(/(?:^\+)/i, '');

    return {
      roll,
      type,
      crit,
    };
  }

  function recomputeGlobalModifierDerivedAttrs(onlyKey = null) {
    const char = getSelectedChar();
    if (!char) return;

    const categories = onlyKey
      ? GLOBAL_MOD_CONFIG.filter((cfg) => cfg.key === onlyKey)
      : GLOBAL_MOD_CONFIG;

    categories.forEach((cfg) => {
      const rows = readRepeatingModifierRows(char, cfg);

      if (cfg.key === 'save') {
        const roll = buildGlobalRollFormula(rows);
        setCharAttrValue(char, 'global_save_mod', roll);
        setCharAttrValue(char, 'npc_global_save_mod', roll);
      }

      if (cfg.key === 'attack') {
        const roll = buildGlobalRollFormula(rows);
        setCharAttrValue(char, 'global_attack_mod', roll);
        setCharAttrValue(char, 'npc_global_attack_mod', roll);
      }

      if (cfg.key === 'damage') {
        const dmg = buildGlobalDamageState(rows);
        setCharAttrValue(char, 'global_damage_mod_roll', dmg.roll);
        setCharAttrValue(char, 'global_damage_mod_type', dmg.type);
        setCharAttrValue(char, 'global_damage_mod_crit', dmg.crit);
        // Compatibility aliases seen across DD5E Legacy migrations/custom forks.
        setCharAttrValue(char, 'global_damage_mod', dmg.roll);
        setCharAttrValue(char, 'npc_global_damage_mod_roll', dmg.roll);
        setCharAttrValue(char, 'npc_global_damage_mod_type', dmg.type);
        setCharAttrValue(char, 'npc_global_damage_mod_crit', dmg.crit);
        setCharAttrValue(char, 'npc_global_damage_mod', dmg.roll);
      }

      if (cfg.key === 'ac') {
        const sum = rows
          .filter((row) => row.active)
          .reduce((acc, row) => acc + parseIntSafe(row.value, 0), 0);
        const ac = String(sum);
        setCharAttrValue(char, 'global_ac_mod', ac);
        // Compatibility alias used by older revisions.
        setCharAttrValue(char, 'globalacmod', ac);
        setCharAttrValue(char, 'npc_global_ac_mod', ac);
        syncArmorClassFromGlobalMods();
      }
    });
  }

  function syncGlobalMasterFlags(onlyMasterFlag = null) {
    const char = getSelectedChar();
    if (!char) return;

    const categories = onlyMasterFlag
      ? GLOBAL_MOD_CONFIG.filter((cfg) => cfg.masterFlag === onlyMasterFlag)
      : GLOBAL_MOD_CONFIG;

    categories.forEach((cfg) => {
      if (!cfg.masterFlag) return;

      const rows = readRepeatingModifierRows(char, cfg);
      const anyActive = rows.some((row) => row.active);
      // Non-destructive behavior: never force-hide sheet blocks when HUD toggles off.
      if (!anyActive) return;
      const next = '1';

      setCharAttrValue(char, cfg.masterFlag, next);

      // Some sheets expose master flags as checkboxes.
      setSheetCheckboxByAttrName(cfg.masterFlag, true);
      setSheetCheckboxByAttrName(`npc_${cfg.masterFlag}`, true);
      setSheetCheckboxByAttrName(`global_${cfg.key}_mod_flag`, true);
      setSheetInputValueByAttrName(cfg.masterFlag, next);
      setSheetInputValueByAttrName(`npc_${cfg.masterFlag}`, next);
      setSheetInputValueByAttrName(`global_${cfg.key}_mod_flag`, next);
    });
  }

  /* ================= REPEATING ATTACKS ================= */

  function getRepeatingRows(char, section, nameField, actionField) {
    const attrs = char?.attribs?.models || [];
    const rowRegex = new RegExp(`^${section}_([^_]+)_${nameField}$`);
    const repOrderAttr = `_reporder_${section}`;
    const byRowId = new Map();
    let orderedRowIds = [];

    attrs.forEach((attr) => {
      const name = attr.get('name');
      if (!name) return;

      if (name === repOrderAttr) {
        const raw = String(attr.get('current') || '');
        orderedRowIds = raw
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean);
        return;
      }

      const match = name.match(rowRegex);
      if (!match) return;

      const rowId = match[1];
      const label = String(attr.get('current') || '').trim();
      if (!label) return;

      byRowId.set(rowId, label);
    });

    const rows = [];

    orderedRowIds.forEach((rowId) => {
      if (!byRowId.has(rowId)) return;
      rows.push({
        label: byRowId.get(rowId),
        sheetAction: `${section}_${rowId}_${actionField}`,
      });
      byRowId.delete(rowId);
    });

    byRowId.forEach((label, rowId) => {
      rows.push({
        label,
        sheetAction: `${section}_${rowId}_${actionField}`,
      });
    });

    return rows;
  }

  function getCombatActions() {
    const char = getSelectedChar();
    if (!char) return [];

    const pcAttacks = getRepeatingRows(char, 'repeating_attack', 'atkname', 'attack');
    const npcActions = getRepeatingRows(char, 'repeating_npcaction', 'name', 'npc_action');

    if (pcAttacks.length) return pcAttacks;
    if (npcActions.length) return npcActions;
    return [];
  }

  /* ================= BUILD ================= */

  function build(cols) {
    const rows = [[], [], []];
    cols.forEach((col) => {
      for (let i = 0; i < 3; i++) {
        rows[i].push(`<div class="tm-cell">${col[i] || ''}</div>`);
      }
    });
    return rows.map((r) => `<div class="tm-row">${r.join('')}</div>`).join('');
  }

  function buildCombatContent() {
    const actions = getCombatActions();
    const rows = [];

    if (!actions.length) {
      rows.push(
        `<div class="tm-row">
          <div class="tm-cell tm-cell-wide">
            <div class="tm-empty-combat" data-label="Aucune attaque détectée">Aucune attaque détectée</div>
          </div>
        </div>`
      );
      return rows.join('');
    }

    actions.forEach((action) => {
      rows.push(
        `<div class="tm-row">
          <div class="tm-cell tm-cell-wide">${combatActionButton(action.label, action.sheetAction)}</div>
        </div>`
      );
    });

    return rows.join('');
  }

  const SKILLS = [
    'acrobatics',
    'arcana',
    'athletics',
    'stealth',
    'animal_handling',
    'sleight_of_hand',
    'history',
    'intimidation',
    'insight',
    'investigation',
    'medicine',
    'nature',
    'perception',
    'performance',
    'persuasion',
    'religion',
    'survival',
    'deception',
  ];

  /* ================= ROOT ================= */

  const root = document.createElement('div');
  root.id = 'tm-root';

  root.innerHTML = `
    <div id="tm-bar">
      <div class="toggle settings" data-sec="settings" data-label="Réglages">⚙️</div>
      <div id="tm-roll-hp-wrap">
        <div id="tm-stats-grid" data-label="Combat, points de vie et modes">
          <div class="tm-stats-col" data-col="1">
            <button class="hp-value" data-hp-value="max" data-label="HP Max : --">
              <span class="hp-number">--</span><span class="hp-caption">Max</span>
            </button>
            ${button('initiative')}
            <button class="hp-value" data-vital-value="ca" data-label="CA : --">
              <span class="hp-number">--</span><span class="hp-caption">CA</span>
            </button>
          </div>
          <div class="tm-stats-col" data-col="2">
            <button class="hp-value" data-hp-value="current" data-label="HP Current : --">
              <span class="hp-number">--</span><span class="hp-caption">Current</span>
            </button>
            <button class="hp-adjust hp-plus" data-hp-target="current" data-delta="1" data-label="+1 HP Current"><img src="${icon('Red_Heart_plus')}"></button>
            <button class="hp-adjust hp-minus" data-hp-target="current" data-delta="-1" data-label="-1 HP Current"><img src="${icon('Red_Heart_minus')}"></button>
          </div>
          <div class="tm-stats-col" data-col="3">
            <button class="hp-value" data-hp-value="temp" data-label="HP Temp : --">
              <span class="hp-number">--</span><span class="hp-caption">Temp</span>
            </button>
            <button class="hp-adjust hp-plus" data-hp-target="temp" data-delta="1" data-label="+1 HP Temp"><img src="${icon('Green_Heart_plus')}"></button>
            <button class="hp-adjust hp-minus" data-hp-target="temp" data-delta="-1" data-label="-1 HP Temp"><img src="${icon('Green_Heart_minus')}"></button>
          </div>
          <div class="tm-stats-col" data-col="4">
            <button class="hp-value dv-value" data-vital-value="dv" data-cmd="dv" data-label="DV : --">
              <span class="hp-number">--</span><span class="hp-caption">DV</span>
            </button>
            <button class="hp-adjust hp-plus" data-hp-target="dv" data-delta="1" data-label="+1 DV"><img src="${icon('Blue_Hearth_plus')}"></button>
            <button class="hp-adjust hp-minus" data-hp-target="dv" data-delta="-1" data-label="-1 DV"><img src="${icon('Blue_Hearth_minus')}"></button>
          </div>
          <div class="tm-stats-col" data-col="5">
            ${button('death')}
            ${button('rest_long')}
            ${button('rest_short')}
          </div>
          <div class="tm-stats-col" data-col="6">
            <button class="mode-btn mode-adv" data-roll-mode="advantage" data-label="Mode avantage"><img src="${icon('advantage')}"></button>
            <button class="mode-btn mode-normal" data-roll-mode="normal" data-label="Mode normal"><img src="${icon('normal')}"></button>
            <button class="mode-btn mode-dis" data-roll-mode="disadvantage" data-label="Mode désavantage"><img src="${icon('disadvantage')}"></button>
          </div>
        </div>
      </div>
      <div id="tm-right-big-wrap">
        <div id="tm-left-col">
          <div class="toggle" data-sec="skill" data-label="Compétences"><img src="${icon('skill')}"><span>Skill</span></div>
          <div class="toggle" data-sec="jds" data-label="Jets de sauvegarde"><img src="${icon('JDS')}"><span>JDS</span></div>
          <div class="toggle" data-sec="attr" data-label="Attributs"><img src="${icon('attribut')}"><span>Attributs</span></div>
        </div>
        <div id="tm-mid-col">
          <div class="toggle" data-sec="combat" data-label="Combat"><img src="${icon('weapons')}"><span>Combats</span></div>
          <div class="toggle" data-sec="resource" data-label="Ressources"><span>Ressources</span></div>
          <div class="toggle" data-sec="mods" data-label="Modificateurs globaux"><span>Mods</span></div>
        </div>
      </div>
      <div id="tm-popup-zone" data-label="Zone accordéon"></div>
    </div>
  `;

  document.body.appendChild(root);
  const popupHost = root.querySelector('#tm-popup-zone');
  root.style.transform = `translateX(calc(-50% + ${HUD_SHIFT_RIGHT_PERCENT}%)) scale(${SCALE})`;

  const tooltip = document.createElement('div');
  tooltip.id = 'tm-tooltip';
  document.body.appendChild(tooltip);

  /* ================= STYLE ================= */

  const style = document.createElement('style');
  style.innerHTML = `
    #tm-root{
      --tm-accordion-width:140px;
      --tm-popup-zone-width:calc(var(--tm-accordion-width) * 3);
      --tm-accordion-wide-width:calc(var(--tm-accordion-width) * 1.2);
      --tm-main-toggle-width:calc(var(--tm-accordion-width) * 0.9);
      --tm-cell-size:40px;
      --tm-cell-gap:4px;
      position:fixed;
      bottom:40px;
      left:50%;
      transform-origin:bottom center;
      z-index:9999999;
    }

    #tm-bar{display:flex;gap:8px;align-items:flex-end}

    #tm-right-big-wrap{
      display:flex;
      gap:8px;
      align-items:flex-end;
    }

    #tm-left-col,
    #tm-mid-col{
      display:flex;
      flex-direction:column;
      gap:4px;
      align-self:flex-end;
    }

    .toggle{
      position:relative;
      display:flex;align-items:center;gap:6px;
      width:var(--tm-main-toggle-width);
      height:var(--tm-cell-size);
      min-height:var(--tm-cell-size);
      justify-content:center;
      background:#000;
      border:1px solid orange;
      border-radius:8px;
      color:#fff;
      cursor:pointer;
      box-sizing:border-box;
    }

    .settings{
      width:var(--tm-cell-size);
      height:var(--tm-cell-size);
      min-width:var(--tm-cell-size);
      min-height:var(--tm-cell-size);
      box-sizing:border-box;
    }

    #tm-roll-hp-wrap{
      display:flex;
      align-items:center;
    }

    #tm-popup-zone{
      position:relative;
      width:var(--tm-popup-zone-width);
      height:var(--tm-cell-size);
      align-self:flex-end;
      pointer-events:none;
      overflow:visible;
    }

    #tm-popup-zone .tm-popup{
      pointer-events:auto;
    }

    #tm-stats-grid{
      display:flex;
      gap:4px;
      align-items:flex-start;
    }

    #tm-stats-grid .tm-stats-col{
      display:flex;
      flex-direction:column;
      gap:4px;
    }

    #tm-stats-grid .tm-slot-empty{
      width:40px;
      height:40px;
    }

    #tm-stats-grid .hp-value,
    #tm-stats-grid .hp-adjust{
      width:40px;
      height:40px;
      min-width:40px;
      border:1px solid rgba(255,165,0,0.65);
      border-radius:8px;
      background:#000;
      color:#fff;
      box-sizing:border-box;
      cursor:pointer;
    }

    #tm-stats-grid .hp-value{
      display:flex;
      flex-direction:column;
      justify-content:space-between;
      align-items:center;
      padding:3px 0 2px;
      line-height:1;
    }

    #tm-stats-grid .hp-value .hp-number{
      font-size:16px;
      font-weight:700;
      margin-top:1px;
    }

    #tm-stats-grid .hp-value .hp-caption{
      font-size:7px;
      color:#d7d7d7;
      letter-spacing:0.2px;
      text-transform:uppercase;
    }

    #tm-stats-grid .hp-adjust{
      padding:0;
    }

    #tm-stats-grid .hp-adjust img{
      width:36px;
      height:36px;
      display:block;
    }

    #tm-stats-grid .mode-btn{
      width:40px;
      height:40px;
      min-width:40px;
      border:1px solid rgba(255,255,255,0.35);
      border-radius:8px;
      background:#000;
      padding:0;
      cursor:pointer;
      box-sizing:border-box;
    }

    #tm-stats-grid .mode-btn img{
      width:36px;
      height:36px;
      display:block;
    }

    #tm-stats-grid .mode-btn.active{
      border:4px solid #ff2a2a;
      box-shadow:
        0 0 14px rgba(255,42,42,0.85),
        0 0 24px rgba(255,42,42,0.55),
        inset 0 0 0 1px rgba(255,120,120,0.65);
    }

    .tm-popup{
      position:absolute;
      bottom:0;
      left:0;
      transform:none;
      display:flex;
      flex-direction:column;
      gap:4px;
      z-index:99999999;
    }

    .tm-popup.is-wide .tm-cell-wide{
      width:var(--tm-accordion-wide-width);
    }

    .tm-popup.is-wide .combat-action{
      width:var(--tm-accordion-wide-width);
    }

    .tm-popup.is-wide .tm-empty-combat{
      width:var(--tm-accordion-wide-width);
    }

    .tm-popup.is-wide .tm-mods-wrap,
    .tm-popup.is-wide .tm-mod-cat{
      width:var(--tm-accordion-wide-width);
    }

    .tm-popup.tm-popup-settings{
      left:50%;
      bottom:calc(100% + var(--tm-cell-gap));
      transform:translateX(-50%);
    }

    .tm-row{display:flex;gap:4px}
    .tm-cell{display:flex}
    .tm-cell-wide{width:var(--tm-accordion-width)}
    .tm-settings-col{display:flex;flex-direction:column;gap:4px}

    button{
      width:40px;height:40px;
      background:#000;
      border:1px solid orange;
      border-radius:8px;
      display:flex;align-items:center;justify-content:center;
      color:#fff;
      cursor:pointer;
      box-sizing:border-box;
    }

    img{width:36px;height:36px}
    .txt{font-size:11px}
    #tm-stats-grid .rest-btn{
      width:40px;
      height:40px;
      min-width:40px;
      box-sizing:border-box;
      font-size:8px;
      line-height:1.05;
      text-align:center;
      white-space:normal;
      padding:0 2px;
      overflow:hidden;
    }
    #tm-stats-grid .rest-btn.rest-long{color:#ffb347}
    #tm-stats-grid .rest-btn.rest-short{color:#74d7ff}

    .tm-scale-btn{
      width:var(--tm-cell-size);
      height:var(--tm-cell-size);
      min-width:var(--tm-cell-size);
      min-height:var(--tm-cell-size);
      font-size:24px;
      font-weight:bold;
      line-height:1;
      padding:0;
    }

    .combat-action{
      width:var(--tm-accordion-width);
      height:34px;
      justify-content:flex-start;
      padding:0 10px;
      font-size:12px;
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
    }

    .tm-empty-combat{
      width:var(--tm-accordion-width);
      height:34px;
      display:flex;
      align-items:center;
      justify-content:center;
      background:rgba(0,0,0,0.9);
      border:1px solid rgba(255,165,0,0.6);
      border-radius:8px;
      color:#ddd;
      font-size:11px;
    }

    .tm-mods-wrap{
      width:var(--tm-accordion-width);
      display:flex;
      flex-direction:column;
      gap:6px;
    }

    .tm-mod-cat{
      width:var(--tm-accordion-width);
      background:rgba(0,0,0,0.92);
      border:1px solid rgba(255,165,0,0.65);
      border-radius:8px;
      padding:6px 6px 5px;
      box-sizing:border-box;
    }

    .tm-mod-title{
      color:#fff;
      font-size:10px;
      font-weight:700;
      margin-bottom:4px;
      text-transform:uppercase;
    }

    .tm-mod-item{
      display:flex;
      align-items:center;
      gap:6px;
      min-height:20px;
      cursor:pointer;
      margin:2px 0;
      color:#fff;
      user-select:none;
      border-radius:5px;
      padding:1px 2px;
    }

    .tm-mod-item input{
      width:12px;
      height:12px;
      margin:0;
    }

    .tm-mod-name{
      flex:1 1 auto;
      font-size:11px;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }

    .tm-mod-value{
      flex:0 0 auto;
      font-size:10px;
      color:#ffc05f;
      max-width:42px;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
      text-align:right;
    }

    .tm-mod-item:has(input:checked){
      background:rgba(28,130,58,0.28);
      outline:1px solid rgba(126,255,170,0.55);
    }

    .tm-mod-empty{
      font-size:10px;
      color:#aaa;
      padding:2px 0;
    }

    .tm-resource-item{
      display:grid;
      grid-template-columns:minmax(0,1fr) 44px 20px 20px;
      align-items:center;
      gap:4px;
      min-height:22px;
      color:#fff;
      margin:2px 0;
      border-radius:5px;
      padding:1px 2px;
    }

    .tm-resource-name{
      font-size:11px;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
      color:#fff;
    }

    .tm-resource-name.is-long{color:#ffb347 !important}
    .tm-resource-name.is-short{color:#74d7ff !important}

    .tm-resource-qty{
      font-size:10px;
      text-align:center;
      color:#fff;
      white-space:nowrap;
    }

    .tm-resource-step{
      width:20px;
      height:20px;
      min-width:20px;
      border:1px solid rgba(255,165,0,0.65);
      border-radius:5px;
      background:#000;
      color:#fff;
      font-size:13px;
      font-weight:700;
      line-height:1;
      padding:0;
    }

    #tm-tooltip{
      position:fixed;
      left:0;
      top:0;
      transform:translate(-50%, -100%);
      padding:6px 10px;
      border-radius:6px;
      border:1px solid rgba(255,165,0,0.7);
      background:rgba(0,0,0,0.95);
      color:#fff;
      font-size:12px;
      white-space:nowrap;
      pointer-events:none;
      z-index:2147483647;
      opacity:0;
      transition:opacity 0.12s ease;
    }
  `;
  document.head.appendChild(style);

  /* ================= POPUP ================= */

  function closePopup() {
    if (!currentPopup) return;
    currentPopup.remove();
    currentPopup = null;
    currentSection = null;
  }

  function open(sec, el) {
    if (currentPopup && currentSection === sec) {
      closePopup();
      return;
    }

    closePopup();

    const popup = document.createElement('div');
    popup.className = 'tm-popup';

    let content = '';

    if (sec === 'attr') {
      content = build([
        [button('strength'), button('dexterity'), button('constitution')],
        [button('intelligence'), button('wisdom'), button('charisma')],
      ]);
    }

    if (sec === 'jds') {
      content = build([
        [button('save_strength'), button('save_dexterity'), button('save_constitution')],
        [button('save_intelligence'), button('save_wisdom'), button('save_charisma')],
      ]);
    }

    if (sec === 'skill') {
      content = build([
        [button(SKILLS[0]), button(SKILLS[6]), button(SKILLS[12])],
        [button(SKILLS[1]), button(SKILLS[7]), button(SKILLS[13])],
        [button(SKILLS[2]), button(SKILLS[8]), button(SKILLS[14])],
        [button(SKILLS[3]), button(SKILLS[9]), button(SKILLS[15])],
        [button(SKILLS[4]), button(SKILLS[10]), button(SKILLS[16])],
        [button(SKILLS[5]), button(SKILLS[11]), button(SKILLS[17])],
      ]);
    }

    if (sec === 'combat') {
      content = buildCombatContent();
    }

    if (sec === 'resource') {
      content = buildResourcesContent();
    }

    if (sec === 'mods') {
      content = buildGlobalModsContent();
    }

    if (sec === 'settings') {
      content = `
        <div class="tm-settings-col">
          <div class="tm-cell"><button class="tm-scale-btn" data-scale="up" data-label="Augmenter la taille">+</button></div>
          <div class="tm-cell"><button class="tm-scale-btn" data-scale="down" data-label="Réduire la taille">-</button></div>
        </div>
      `;
    }

    popup.innerHTML = content;
    if (sec === 'settings') {
      popup.classList.add('tm-popup-settings');
      el.appendChild(popup);
    } else {
      if (sec === 'combat' || sec === 'resource' || sec === 'mods') {
        popup.classList.add('is-wide');
      }
      (popupHost || el).appendChild(popup);
    }

    currentPopup = popup;
    currentSection = sec;
  }

  /* ================= VISUAL ================= */

  function updateScale(delta) {
    SCALE = Math.max(0.6, Math.min(1.6, SCALE + delta));
    root.style.transform = `translateX(calc(-50% + ${HUD_SHIFT_RIGHT_PERCENT}%)) scale(${SCALE})`;
    localStorage.setItem('tm_hud_scale', SCALE);
  }

  function showTooltip(label, x, y) {
    tooltip.textContent = label;
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y - TOOLTIP_OFFSET_Y}px`;
    tooltip.style.opacity = '1';
  }

  function hideTooltip() {
    tooltip.style.opacity = '0';
  }

  /* ================= EVENTS ================= */

  root.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn && root.contains(btn)) {
      if (btn.dataset.hpTarget) {
        const delta = parseIntSafe(btn.dataset.delta, 0);
        if (delta !== 0) adjustHpValue(btn.dataset.hpTarget, delta);
        return;
      }

      if (btn.dataset.resourceAttr) {
        const delta = parseIntSafe(btn.dataset.resourceDelta, 0);
        if (delta !== 0) adjustResourceValue(btn.dataset.resourceAttr, btn.dataset.resourceMax || '', delta);
        return;
      }

      if (btn.dataset.rollMode) {
        setRollMode(btn.dataset.rollMode, true);
        return;
      }

      if (btn.dataset.scale === 'up') {
        updateScale(0.1);
        return;
      }

      if (btn.dataset.scale === 'down') {
        updateScale(-0.1);
        return;
      }

      if (btn.classList.contains('dv-value')) {
        adjustHpValue('dv', -1);
      }

      if (btn.dataset.sheetAction) {
        const customRoll = buildCustomSheetActionCommand(btn.dataset.sheetAction);
        if (customRoll) sendCommand(customRoll);
        return;
      }

      const roll = buildSheetActionCommand(btn.dataset.cmd);
      if (roll) sendCommand(roll);
      return;
    }

    const modInput = e.target.closest('input[type="checkbox"][data-mod-attr]');
    if (modInput && root.contains(modInput)) return;
    if (e.target.closest('.tm-mod-item')) return;
    if (e.target.closest('.tm-resource-item')) return;

    const toggle = e.target.closest('.toggle');
    if (!toggle || !root.contains(toggle)) return;

    open(toggle.dataset.sec, toggle);
  });

  root.addEventListener('change', (e) => {
    const modInput = e.target.closest('input[type="checkbox"][data-mod-attr]');
    if (!modInput || !root.contains(modInput)) return;
    setGlobalModifierActive(
      modInput.dataset.modAttr,
      modInput.dataset.modMaster,
      modInput.checked,
      modInput.dataset.modSection,
      modInput.dataset.modRowid,
      modInput.dataset.modField,
      modInput.dataset.modKey
    );
  });

  root.addEventListener('mousemove', (e) => {
    const target = e.target.closest('[data-label]');
    if (!target || !root.contains(target)) {
      hideTooltip();
      return;
    }

    showTooltip(target.dataset.label, e.clientX, e.clientY);
  });

  root.addEventListener('mouseleave', hideTooltip);

  /* ================= INIT ================= */

  renderHpState();
  syncGlobalMasterFlags();
  recomputeGlobalModifierDerivedAttrs();
  setRollMode(detectRollMode(), false);
  setTimeout(syncRollModeFromSheet, 1000);
  setInterval(() => {
    renderHpState();
    syncGlobalMasterFlags();
    recomputeGlobalModifierDerivedAttrs();
  }, 2000);
})();
