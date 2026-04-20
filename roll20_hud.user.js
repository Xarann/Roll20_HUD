// ==UserScript==
// @name         Roll20 HUD Next (Full)
// @namespace    http://tampermonkey.net/
// @version      8.00
// @match        https://app.roll20.net/editor/
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

/* ================= STATE ================= */

const BASE = 'https://raw.githubusercontent.com/Xarann/Roll20_HUD/main/icons/';
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
  let HUD_DRAG_X = parseFloat(localStorage.getItem('tm_hud_drag_x') || '0');
  let HUD_DRAG_Y = parseFloat(localStorage.getItem('tm_hud_drag_y') || '0');
  if (!Number.isFinite(HUD_DRAG_X)) HUD_DRAG_X = 0;
  if (!Number.isFinite(HUD_DRAG_Y)) HUD_DRAG_Y = 0;
  const HUD_DRAG_STATE = {
    active: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
  };
  const TRAIT_SOURCE_OPEN = Object.create(null);
  const SPELL_LEVEL_OPEN = Object.create(null);
  let SELECTED_TRAIT_KEY = '';
  let SELECTED_SPELL_KEY = '';
  let SELECTED_EQUIPMENT_CATEGORY = '';
  let SPELL_SHOW_ALL = localStorage.getItem('tm_spell_show_all') === '1';
  const PREFETCHED_CHAR_IDS = new Set();
  const PREFETCH_PENDING_CHAR_IDS = new Set();

/* ================= CHARACTER ================= */

  function getPlayerId() {
    return window.currentPlayer?.id;
  }

  function getCharacterId(char) {
    return String(char?.id || char?.get?.('_id') || '').trim();
  }

  function getCharacterDisplayName(char) {
    const name = String(char?.get?.('name') || '').trim();
    if (name) return name;
    return 'Fiche sans nom';
  }

  function normalizeSheetTypeToken(raw) {
    return String(raw || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
  }

  function getCharacterSheetType(char) {
    const attrs = char?.attribs?.models || [];
    const npcAttr = attrs.find((attr) => String(attr.get('name') || '').toLowerCase() === 'npc');
    const raw = npcAttr ? String(npcAttr.get('current') || '').trim() : String(char?.get?.('npc') || '').trim();
    const token = normalizeSheetTypeToken(raw);
    if (
      token === '1' ||
      token === 'true' ||
      token === 'on' ||
      token === 'yes' ||
      token === 'oui' ||
      token === 'npc'
    ) {
      return 'npc';
    }
    return 'pc';
  }

  function getCharacterSheetTypeUi(char) {
    const type = getCharacterSheetType(char);
    if (type === 'npc') {
      return { label: 'PNJ', className: 'tm-sheet-type-npc' };
    }
    return { label: 'PJ', className: 'tm-sheet-type-pc' };
  }

  function getAvailableCharacters() {
    const chars = window.Campaign?.characters?.models || [];
    if (!chars.length) return [];

    const playerId = getPlayerId();
    const isGm = Boolean(window.currentPlayer?.get?.('is_gm') || window.currentPlayer?.is_gm || window.is_gm);

    const controlled = chars.filter((char) => {
      if (!char) return false;
      if (isGm) return true;

      const controlledBy = String(char.get('controlledby') || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

      if (!controlledBy.length) return false;
      if (controlledBy.includes('all')) return true;
      return Boolean(playerId && controlledBy.includes(playerId));
    });

    return controlled.length ? controlled : chars;
  }

  function autoDetectCharacter() {
    const chars = getAvailableCharacters();
    return chars[0] || null;
  }

  function getSelectedChar() {
    const chars = getAvailableCharacters();
    if (!chars.length) {
      LOCKED_CHAR = null;
      return null;
    }

    if (!LOCKED_CHAR) {
      LOCKED_CHAR = autoDetectCharacter();
      return LOCKED_CHAR;
    }

    const lockedId = getCharacterId(LOCKED_CHAR);
    const updated = chars.find((char) => getCharacterId(char) === lockedId);
    if (updated) {
      LOCKED_CHAR = updated;
      return LOCKED_CHAR;
    }

    LOCKED_CHAR = autoDetectCharacter();
    return LOCKED_CHAR;
  }

  function getCharacterAttrCount(char) {
    const models = char?.attribs?.models;
    return Array.isArray(models) ? models.length : 0;
  }

  function markCharacterPrefetched(char) {
    const id = getCharacterId(char);
    if (!id) return;
    PREFETCH_PENDING_CHAR_IDS.delete(id);
    if (getCharacterAttrCount(char) > 0) {
      PREFETCHED_CHAR_IDS.add(id);
    }
  }

  function prefetchCharacterAttributes(char, onLoaded = null) {
    const id = getCharacterId(char);
    if (!id) return;

    if (getCharacterAttrCount(char) > 0 || PREFETCHED_CHAR_IDS.has(id)) {
      markCharacterPrefetched(char);
      if (typeof onLoaded === 'function') onLoaded();
      return;
    }

    if (PREFETCH_PENDING_CHAR_IDS.has(id)) return;

    const collection = char?.attribs;
    const fetchFn = collection?.fetch;
    if (typeof fetchFn !== 'function') {
      if (typeof onLoaded === 'function') onLoaded();
      return;
    }

    PREFETCH_PENDING_CHAR_IDS.add(id);

    try {
      fetchFn.call(collection, {
        success: () => {
          markCharacterPrefetched(char);
          if (typeof onLoaded === 'function') onLoaded();
        },
        error: () => {
          PREFETCH_PENDING_CHAR_IDS.delete(id);
        },
      });
    } catch (_error) {
      PREFETCH_PENDING_CHAR_IDS.delete(id);
    }
  }

  function prefetchAvailableCharacterAttributes() {
    const chars = getAvailableCharacters();
    chars.forEach((char) => prefetchCharacterAttributes(char));
  }

  function updateCharacterSwitchButton() {
    if (!root) return;

    const toggle = root.querySelector('.toggle[data-sec="characters"]');
    if (!toggle) return;

    const chars = getAvailableCharacters();
    const current = getSelectedChar();
    const name = getCharacterDisplayName(current);
    const typeInfo = getCharacterSheetTypeUi(current);
    const count = chars.length;

    const tooltip =
      count > 1
        ? `Fiche active : ${name} [${typeInfo.label}] (${count} fiches, clic pour choisir)`
        : `Fiche active : ${name} [${typeInfo.label}]`;
    toggle.dataset.label = tooltip;
    toggle.setAttribute('aria-label', tooltip);
  }

  function refreshHudForCurrentCharacter(resetSelections = false) {
    updateCharacterSwitchButton();

    if (resetSelections) {
      SELECTED_TRAIT_KEY = '';
      SELECTED_SPELL_KEY = '';
      SELECTED_EQUIPMENT_CATEGORY = '';
    }

    renderHpState();
    syncGlobalMasterFlags();
    recomputeGlobalModifierDerivedAttrs();

    const fromChar = detectRollModeFromCharacterAttr();
    if (fromChar) {
      setRollMode(fromChar, false);
    } else {
      syncRollModeFromSheet();
    }

    if (!currentSection || !currentPopup || !root) return;
    const sec = currentSection;
    const anchor = root.querySelector(`.toggle[data-sec="${sec}"]`);
    closePopup();
    if (anchor) open(sec, anchor);
  }

  function refreshHudAfterCharacterSwitch() {
    refreshHudForCurrentCharacter(true);
  }

  function switchHudCharacter(step = 1) {
    const chars = getAvailableCharacters();
    if (!chars.length) {
      LOCKED_CHAR = null;
      updateCharacterSwitchButton();
      return;
    }

    const current = getSelectedChar();
    const currentId = getCharacterId(current);
    const currentIndex = chars.findIndex((char) => getCharacterId(char) === currentId);
    const baseIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = ((baseIndex + step) % chars.length + chars.length) % chars.length;

    LOCKED_CHAR = chars[nextIndex];
    refreshHudAfterCharacterSwitch();
    const selected = LOCKED_CHAR;
    prefetchCharacterAttributes(selected, () => {
      if (getCharacterId(getSelectedChar()) !== getCharacterId(selected)) return;
      refreshHudForCurrentCharacter(false);
    });
  }

  function selectHudCharacterById(charId) {
    const wantedId = String(charId || '').trim();
    if (!wantedId) return false;

    const chars = getAvailableCharacters();
    if (!chars.length) return false;

    const found = chars.find((char) => getCharacterId(char) === wantedId);
    if (!found) return false;

    LOCKED_CHAR = found;
    refreshHudAfterCharacterSwitch();
    const selected = LOCKED_CHAR;
    prefetchCharacterAttributes(selected, () => {
      if (getCharacterId(getSelectedChar()) !== getCharacterId(selected)) return;
      refreshHudForCurrentCharacter(false);
    });
    return true;
  }

  function buildCharacterPickerContent() {
    const chars = getAvailableCharacters();
    const active = getSelectedChar();
    const activeId = getCharacterId(active);
    const activeName = getCharacterDisplayName(active);
    const activeType = getCharacterSheetTypeUi(active);

    if (!chars.length) {
      return `
        <div class="tm-hud-wrap tm-char-picker-wrap">
          <div class="tm-detail-empty">Aucune fiche disponible.</div>
        </div>
      `;
    }

    const list = chars
      .map((char, index) => {
        const id = getCharacterId(char);
        const name = getCharacterDisplayName(char);
        const typeInfo = getCharacterSheetTypeUi(char);
        const isActive = id === activeId;
        const activeBadge = isActive ? '<span class="tm-char-item-badge">ACTIF</span>' : '';
        return `
          <button class="tm-list-item tm-char-item ${isActive ? 'is-active' : ''}"
                  data-char-select="${escapeHtml(id)}"
                  data-label="Choisir la fiche ${escapeHtml(name)}">
            <span class="tm-char-item-namewrap">
              <span class="tm-char-item-name">${index + 1}. ${escapeHtml(name)}</span>
              <span class="tm-sheet-type-badge ${typeInfo.className}">${typeInfo.label}</span>
            </span>
            ${activeBadge}
          </button>
        `;
      })
      .reverse()
      .join('');

    return `
      <div class="tm-hud-wrap tm-char-picker-wrap">
        <div class="tm-char-active">
          Fiche active :
          <span class="tm-char-active-name">${escapeHtml(activeName)}</span>
          <span class="tm-sheet-type-badge ${activeType.className}">${activeType.label}</span>
        </div>
        <div class="tm-char-list">${list}</div>
      </div>
    `;
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

  function compactText(value) {
    return String(value || '')
      .replace(/\r/g, '')
      .replace(/\n+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function asMultilineHtml(value) {
    const text = String(value || '').replace(/\r/g, '').trim();
    if (!text) return '<span class="tm-detail-empty">Aucune description.</span>';
    return escapeHtml(text).replace(/\n/g, '<br>');
  }

  function shortSummary(value, maxLen = 140) {
    const text = compactText(value);
    if (!text) return '';
    if (text.length <= maxLen) return text;
    return `${text.slice(0, Math.max(0, maxLen - 3)).trim()}...`;
  }

  function hasTemplateFlag(raw, flagToken) {
    const text = String(raw || '').trim();
    if (!text) return false;
    if (isExplicitYesValue(text)) return true;
    const safeToken = String(flagToken || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!safeToken) return false;
    const re = new RegExp(`\\b${safeToken}\\s*=\\s*1\\b`, 'i');
    return re.test(text);
  }

  function isDisabledSpellFlagValue(raw) {
    const token = normalizeTextToken(raw);
    return (
      token === '' ||
      token === '0' ||
      token === 'false' ||
      token === 'off' ||
      token === 'none' ||
      token === 'no' ||
      token === 'non' ||
      token === 'null'
    );
  }

  function isEnabledSpellFlagValue(raw, token) {
    if (isDisabledSpellFlagValue(raw)) return false;
    return hasTemplateFlag(raw, token) || isExplicitYesValue(raw);
  }

  function parseSpellFlagRaw(raw, token) {
    const text = String(raw || '').trim();
    if (!text) return null;
    return isEnabledSpellFlagValue(text, token);
  }

  function spellComponentFlagsFromFields(fields, durationValue = '') {
    const allFields = fields || {};
    const readExactField = (targetNames) => {
      const names = (targetNames || []).map((n) => String(n || '').toLowerCase().trim()).filter(Boolean);
      if (!names.length) return '';
      for (const [rawKey, rawVal] of Object.entries(allFields)) {
        const key = String(rawKey || '').toLowerCase().trim();
        if (!names.includes(key)) continue;
        return String(rawVal || '').trim();
      }
      return '';
    };

    const vRaw = readExactField(['spellcomp_v', 'spellcompv']);
    const sRaw = readExactField(['spellcomp_s', 'spellcomps']);
    const mRaw = readExactField(['spellcomp_m', 'spellcompm']);
    const cRaw = readExactField(['spellconcentration', 'concentration', 'spell_concentration']);
    const rRaw = readExactField(['spellritual', 'ritual', 'spell_ritual']);
    const durationToken = normalizeTextToken(durationValue);

    // Strict V/S/M detection based on spellcomp_v/s/m values:
    // 0 => absent, {{x=1}} (or explicit yes) => present.
    const v = isEnabledSpellFlagValue(vRaw, 'v');
    const s = isEnabledSpellFlagValue(sRaw, 's');
    const m = isEnabledSpellFlagValue(mRaw, 'm');
    const c = isEnabledSpellFlagValue(cRaw, 'concentration') || isEnabledSpellFlagValue(cRaw, 'c') || /\bconcentration\b/.test(durationToken);
    const r = isEnabledSpellFlagValue(rRaw, 'ritual') || isEnabledSpellFlagValue(rRaw, 'r');

    return { v, s, m, c, r };
  }

  function spellMaterialFromFields(fields) {
    return pickRowFieldValue(fields, [
      'spellcomp_materials',
      'spellcompmaterials',
      'materials',
      'material',
      'spell_material',
    ]);
  }

  function spellComponentsFromFields(fields, componentFlags = null) {
    const flags = componentFlags || spellComponentFlagsFromFields(fields);

    const parts = [];
    if (flags.v) parts.push('V');
    if (flags.s) parts.push('S');
    if (flags.m) parts.push('M');

    const material = spellMaterialFromFields(fields);
    if (material) {
      if (!parts.includes('M')) parts.push('M');
      return `${parts.join(', ')} (${material})`;
    }

    return parts.join(', ');
  }

  function buildSpellBadgesHtml(flags, options = null) {
    const f = flags || {};
    const opts = {
      v: true,
      s: true,
      m: true,
      c: true,
      r: true,
      ...(options || {}),
    };
    const badges = [];

    if (f.v && opts.v) {
      badges.push('<span class="tm-spell-badge tm-spell-badge-v" data-label="Composante verbale">V</span>');
    }
    if (f.s && opts.s) {
      badges.push('<span class="tm-spell-badge tm-spell-badge-s" data-label="Composante somatique">S</span>');
    }
    if (f.m && opts.m) {
      badges.push('<span class="tm-spell-badge tm-spell-badge-m" data-label="Composante matérielle">M</span>');
    }
    if (f.c && opts.c) {
      badges.push('<span class="tm-spell-badge tm-spell-badge-c" data-label="Concentration">C</span>');
    }
    if (f.r && opts.r) {
      badges.push('<span class="tm-spell-badge tm-spell-badge-r" data-label="Rituel">R</span>');
    }

    return badges.length ? `<span class="tm-spell-badges">${badges.join('')}</span>` : '';
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

  function escapeAttrSelectorValue(value) {
    return String(value ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');
  }

  function triggerTraitRollFromSheet(rowId, rollAttrName = '') {
    const rid = String(rowId || '').trim();
    if (!rid) return false;
    const char = getSelectedChar();
    if (!char) return false;

    const esc = escapeAttrSelectorValue(rid);
    const looksLikeRollPayload = (value) => {
      const v = String(value || '').trim();
      if (!v) return false;
      return (
        v.includes('&{template:') ||
        v.includes('/roll') ||
        v.includes('/r ') ||
        v.includes('[[') ||
        v.includes('%{') ||
        v.includes('@{')
      );
    };

    const preferredAttr = String(rollAttrName || '').trim();
    const attrCandidates = [
      preferredAttr,
      `repeating_traits_${rid}_rollTrait`,
      `repeating_traits_${rid}_rolltrait`,
      `repeating_traits_${rid}_roll_trait`,
      `repeating_traits_${rid}_trait`,
    ].filter(Boolean);

    for (const attrName of attrCandidates) {
      const model = getCharAttrModel(char, attrName);
      if (!model) continue;

      const raw = String(model.get('current') || '').trim();
      if (looksLikeRollPayload(raw)) {
        sendCommand(raw);
        return true;
      }

      if (!raw) continue;
      sendCommand(`@{${char.get('name')}|${attrName}}`);
      return true;
    }

    const buttonSelectors = [
      `button[name="roll_repeating_traits_${esc}_rollTrait"]`,
      `button[name="roll_repeating_traits_${esc}_rolltrait"]`,
      `button[name="roll_repeating_traits_${esc}_roll_trait"]`,
      `button[name="roll_repeating_traits_${esc}_trait"]`,
      `button[name*="repeating_traits_${esc}"][name*="roll"]`,
      `[data-reprowid="${esc}"] button[name*="rollTrait"]`,
      `[data-reprowid="${esc}"] button[type="roll"]`,
      `[data-itemid="${esc}"] button[name*="rollTrait"]`,
      `[data-itemid="${esc}"] button[type="roll"]`,
      `.repitem[data-reprowid="${esc}"] button[type="roll"]`,
      `button[name*="${esc}"][name*="rollTrait"]`,
    ];

    for (const selector of buttonSelectors) {
      const btn = document.querySelector(selector);
      if (!(btn instanceof HTMLElement)) continue;
      btn.click();
      return true;
    }

    // Fallback: some sheets render the roll action payload into an input/textarea field.
    const inputSelectors = [
      `[name="attr_repeating_traits_${esc}_rollTrait"]`,
      `[name="attr_repeating_traits_${esc}_rolltrait"]`,
      `[name*="repeating_traits_${esc}"][name*="rollTrait"]`,
      `[name*="repeating_traits_${esc}"][name*="roll"]`,
    ];
    for (const selector of inputSelectors) {
      const input = document.querySelector(selector);
      if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) continue;
      const payload = String(input.value || '').trim();
      if (!payload) continue;
      sendCommand(payload);
      return true;
    }

    // Last fallback: try explicit repeating_traits abilities on the character.
    const abilityNames = new Set(
      (char?.abilities?.models || [])
        .map((model) => String(model?.get?.('name') || '').trim())
        .filter(Boolean)
    );
    const abilityCandidates = [
      preferredAttr,
      `repeating_traits_${rid}_rollTrait`,
      `repeating_traits_${rid}_rolltrait`,
      `repeating_traits_${rid}_roll_trait`,
      `repeating_traits_${rid}_trait`,
    ].filter(Boolean);

    for (const abilityName of abilityCandidates) {
      if (!abilityNames.has(abilityName)) continue;
      const cmd = buildCustomSheetActionCommand(abilityName);
      if (!cmd) continue;
      sendCommand(cmd);
      return true;
    }

    return false;
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
    const models = char?.attribs?.models || [];
    const exact = models.find((a) => a.get('name') === name);
    if (exact) return exact;

    const needle = String(name || '').toLowerCase();
    if (!needle) return null;
    return models.find((a) => String(a.get('name') || '').toLowerCase() === needle) || null;
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
    const b = normalizeResourceBaseKey(base);
    if (!b || !/resource/i.test(b)) return false;
    if (
      /(?:_|^)(?:name|max|total|maximum|current|value|count|qty|amount|reset|recharge|recovery|recover|rest|refresh|uses|enabled|active|flag|mod|type)$/i.test(
        b
      )
    ) return false;
    return true;
  }

  const RESOURCE_VALUE_TOKENS = [
    'value',
    'current',
    'uses',
    'qty',
    'count',
    'amount',
  ];

  const RESOURCE_MAX_TOKENS = ['max', 'total', 'maximum'];

  const RESOURCE_META_TOKENS = [
    ...RESOURCE_VALUE_TOKENS,
    ...RESOURCE_MAX_TOKENS,
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
    'short',
    'long',
    'sr',
    'lr',
  ];

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function normalizeResourceBaseKey(base) {
    const raw = String(base || '').trim();
    if (!raw) return '';
    return raw
      .replace(/((?:^|_)resource)_?(\d+)$/i, '$1_$2')
      .replace(/_{2,}/g, '_');
  }

  function parseResourceAttrParts(attrName) {
    const name = String(attrName || '').trim();
    if (!name || !/resource/i.test(name)) return null;

    for (const token of RESOURCE_META_TOKENS) {
      const tokenRx = escapeRegExp(token);

      let m = name.match(new RegExp(`^(.*)_${tokenRx}$`, 'i'));
      if (m && isLikelyResourceBase(m[1])) {
        return { base: normalizeResourceBaseKey(m[1]), token, attr: name };
      }

      m = name.match(new RegExp(`^(.*)_${tokenRx}_(.+)$`, 'i'));
      if (m) {
        const candidate = `${m[1]}_${m[2]}`;
        if (isLikelyResourceBase(candidate)) {
          return { base: normalizeResourceBaseKey(candidate), token, attr: name };
        }
      }

      m = name.match(new RegExp(`^(.*)_${tokenRx}(\\d+)$`, 'i'));
      if (m) {
        const candidate = `${m[1]}_${m[2]}`;
        if (isLikelyResourceBase(candidate)) {
          return { base: normalizeResourceBaseKey(candidate), token, attr: name };
        }
      }
    }

    if (isLikelyResourceBase(name)) {
      return { base: normalizeResourceBaseKey(name), token: 'value', attr: name };
    }
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
      const normalized = normalizeResourceBaseKey(base);
      if (!normalized) return null;
      if (!defMap.has(normalized)) {
        defMap.set(normalized, {
          key: normalized,
          fallbackName: makeResourceFallbackName(normalized),
          valueAttr: normalized,
          maxAttr: `${normalized}_max`,
          nameAttr: `${normalized}_name`,
        });
      }
      return defMap.get(normalized);
    }

    ensureDef('class_resource');
    ensureDef('other_resource');

    names.forEach((name) => {
      const m = name.match(/^(class_resource|other_resource)_?(\d+)(?:_|$)/i);
      if (!m) return;
      ensureDef(`${m[1]}_${m[2]}`);
    });

    names.forEach((name) => {
      const parsed = parseResourceAttrParts(name);
      if (!parsed) return;

      const def = ensureDef(parsed.base);
      if (parsed.token === 'name') def.nameAttr = name;
      if (RESOURCE_MAX_TOKENS.includes(parsed.token)) def.maxAttr = name;
      if (RESOURCE_VALUE_TOKENS.includes(parsed.token)) def.valueAttr = name;
    });

    // Explicit support for DD5e Legacy repeating_resource left/right rows.
    names.forEach((name) => {
      const m = name.match(/^repeating_resource_([^_]+)_resource_(left|right)(?:_(.+))?$/i);
      if (!m) return;
      const rowId = m[1];
      const side = m[2].toLowerCase();
      const field = String(m[3] || '').toLowerCase();
      const def = ensureDef(`repeating_resource_${rowId}_resource_${side}`);
      if (!def) return;

      if (!field) {
        def.valueAttr = name;
        return;
      }

      if (field === 'name') {
        def.nameAttr = name;
        return;
      }

      if (RESOURCE_MAX_TOKENS.includes(field)) {
        def.maxAttr = name;
        return;
      }

      if (RESOURCE_VALUE_TOKENS.includes(field) || field === side) {
        def.valueAttr = name;
      }
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
    const items = [];

    defs.forEach((def) => {
      const valueRaw = getAttrCurrentValue(char, def.valueAttr);
      const maxRaw = getAttrCurrentValue(char, def.maxAttr);
      const nameRaw = getAttrCurrentValue(char, def.nameAttr);
      if (!nameRaw) return;

      const sortMeta = getResourceSortMeta(def.key);
      items.push({
        key: def.key,
        label: nameRaw,
        value: valueRaw ? formatHpValue(valueRaw) : '0',
        max: formatHpValue(maxRaw),
        valueAttr: def.valueAttr,
        maxAttr: def.maxAttr,
        resetType: detectResourceResetType(char, def.key),
        sortRank: sortMeta.group * 1000 + sortMeta.index,
      });
    });

    // Explicit pass for DD5e repeating_resource rows (left/right blocks).
    const repRows = getRepeatingSectionRows(char, 'repeating_resource');
    repRows.forEach((row, rowIndex) => {
      ['left', 'right'].forEach((side, sideIndex) => {
        const nameField =
          pickRowFieldKey(row.fields, [
            `resource_${side}_name`,
            `${side}_name`,
            `resource${side}_name`,
          ]) || '';
        const valueField =
          pickRowFieldKey(row.fields, [
            `resource_${side}`,
            `${side}`,
            `resource${side}`,
          ]) || `resource_${side}`;
        const maxField =
          pickRowFieldKey(row.fields, [
            `resource_${side}_max`,
            `${side}_max`,
            `resource_${side}_total`,
            `${side}_total`,
            `resource${side}_max`,
          ]) || '';
        const resetField =
          pickRowFieldKey(row.fields, [
            `resource_${side}_reset`,
            `${side}_reset`,
            `resource_${side}_recovery`,
            `${side}_recovery`,
            `resource_${side}_recharge`,
            `${side}_recharge`,
          ]) || '';

        const label = String(nameField ? row.fields[nameField] : '').trim();
        if (!label) return;

        const valueRaw = String(valueField ? row.fields[valueField] : '').trim();
        const maxRaw = String(maxField ? row.fields[maxField] : '').trim();
        const resetRaw = String(resetField ? row.fields[resetField] : '').trim();
        const resetPrefix = `repeating_resource_${row.rowId}_resource_${side}`;

        items.push({
          key: `${resetPrefix}_item`,
          label,
          value: valueRaw ? formatHpValue(valueRaw) : '0',
          max: formatHpValue(maxRaw),
          valueAttr: `repeating_resource_${row.rowId}_${valueField}`,
          maxAttr: maxField ? `repeating_resource_${row.rowId}_${maxField}` : '',
          resetType: inferResetTypeFromText(resetRaw) || detectResourceResetType(char, resetPrefix),
          sortRank: 5000 + rowIndex * 2 + sideIndex,
        });
      });
    });

    const dedupByValueAttr = new Map();
    items.forEach((item) => {
      const key = item.valueAttr || item.key;
      if (!key) return;
      dedupByValueAttr.set(key, item);
    });

    return Array.from(dedupByValueAttr.values())
      .sort((a, b) => (a.sortRank || 999999) - (b.sortRank || 999999))
      .map((item) => ({
        key: item.key,
        label: item.label,
        value: item.value,
        max: item.max,
        valueAttr: item.valueAttr,
        maxAttr: item.maxAttr,
        resetType: item.resetType,
      }));
  }

  const CURRENCY_FIELDS = [
    { key: 'gp', label: 'PO', attrs: ['po', 'gp'] },
    { key: 'sp', label: 'PA', attrs: ['pa', 'sp'] },
    { key: 'ep', label: 'PE', attrs: ['pe', 'ep'] },
    { key: 'cp', label: 'PC', attrs: ['pc', 'cp'] },
    { key: 'pp', label: 'PP', attrs: ['pp'] },
  ];

  function resolveCurrencyAttrName(char, key) {
    const field = CURRENCY_FIELDS.find((f) => f.key === key);
    if (!field) return key;

    for (const attrName of field.attrs) {
      if (getCharAttrModel(char, attrName)) return attrName;
    }

    return field.attrs[0] || key;
  }

  function getCurrencyValue(char, key) {
    const field = CURRENCY_FIELDS.find((f) => f.key === key);
    if (!field || !char) return 0;

    for (const attrName of field.attrs) {
      const model = getCharAttrModel(char, attrName);
      if (!model) continue;
      const parsed = parseIntSafe(model.get('current'), 0);
      return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    }

    return 0;
  }

  function getCurrencyState() {
    const char = getSelectedChar();
    const items = CURRENCY_FIELDS.map((field) => {
      const value = char ? getCurrencyValue(char, field.key) : 0;
      const writeAttr = char ? resolveCurrencyAttrName(char, field.key) : field.attrs[0];
      return { ...field, value, writeAttr };
    });

    const values = Object.fromEntries(items.map((item) => [item.key, item.value]));
    const totalPo = values.gp + values.sp / 10 + values.ep / 2 + values.cp / 100 + values.pp * 10;

    return { items, totalPo };
  }

  function formatPoTotal(value) {
    const rounded = Math.round((Number(value) || 0) * 100) / 100;
    return Number.isInteger(rounded)
      ? String(rounded)
      : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  }

  function buildCurrencyContent() {
    const state = getCurrencyState();
    const rows = state.items
      .map(
        (item) => `
          <label class="tm-currency-row" data-label="Argent ${escapeHtml(item.label)}">
            <span class="tm-currency-code">${escapeHtml(item.label)}</span>
            <input
              class="tm-currency-input"
              data-currency-key="${escapeHtml(item.key)}"
              data-currency-attr="${escapeHtml(item.writeAttr)}"
              value="${escapeHtml(item.value)}"
              inputmode="numeric"
              autocomplete="off"
              spellcheck="false">
          </label>
        `
      )
      .join('');

    return `
      <div class="tm-mod-cat tm-currency-cat">
        <div class="tm-mod-title">Argent</div>
        <div class="tm-currency-grid">${rows}</div>
        <div class="tm-currency-total">Total PO : ${escapeHtml(formatPoTotal(state.totalPo))}</div>
      </div>
    `;
  }

  function buildCurrencyPanelContent() {
    return `
      <div class="tm-mods-wrap">
        ${buildCurrencyContent()}
      </div>
    `;
  }

  function commitCurrencyInput(input) {
    const key = String(input?.dataset?.currencyKey || '').trim();
    if (!key) return;

    const parsed = parseIntSafe(input.value, 0);
    const next = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    input.value = String(next);

    const char = getSelectedChar();
    if (!char) return;
    const targetAttr = resolveCurrencyAttrName(char, key);
    setCharAttrValue(char, targetAttr, String(next));

    const field = CURRENCY_FIELDS.find((f) => f.key === key);
    if (field) {
      field.attrs.forEach((attrName) => {
        if (attrName === targetAttr) return;
        if (!getCharAttrModel(char, attrName)) return;
        setCharAttrValue(char, attrName, String(next));
      });
    }

    if (currentSection === 'currency' && currentPopup) {
      currentPopup.innerHTML = buildCurrencyPanelContent();
    }
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

  const RESOURCE_PANEL_MIN_WIDTH = 200;
  const RESOURCE_PANEL_MAX_WIDTH = 320;
  const RESOURCE_PANEL_BASE_WIDTH = 122;
  const RESOURCE_PANEL_CHAR_WIDTH = 6.2;

  function updateResourcePanelWidth(items = []) {
    if (!root || !root.style || typeof root.style.setProperty !== 'function') return;

    const maxLabelLength = (items || []).reduce((max, item) => {
      const len = String(item?.label || '').trim().length;
      return Math.max(max, len);
    }, 0);

    const targetWidth = RESOURCE_PANEL_BASE_WIDTH + maxLabelLength * RESOURCE_PANEL_CHAR_WIDTH;
    const clampedWidth = Math.max(
      RESOURCE_PANEL_MIN_WIDTH,
      Math.min(RESOURCE_PANEL_MAX_WIDTH, Math.round(targetWidth))
    );

    root.style.setProperty('--tm-accordion-resource-width', `${clampedWidth}px`);
  }

  function buildResourcesContent() {
    const items = getResourcesState();
    updateResourcePanelWidth(items);

    const resourcesHtml = items.length
      ? items
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
          .join('')
      : '<div class="tm-mod-empty">Aucune ressource détectée</div>';

    return `
      <div class="tm-mods-wrap">
        <div class="tm-mod-cat">
          <div class="tm-mod-title">Ressources</div>
          ${resourcesHtml}
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

  function getRepeatingSectionRows(char, section) {
    const attrs = char?.attribs?.models || [];
    const repOrderAttr = `_reporder_${section}`;
    const rowRegex = new RegExp(`^${escapeRegExp(section)}_([^_]+)_(.+)$`);
    const byRowId = new Map();
    let orderedRowIds = [];

    attrs.forEach((attr) => {
      const name = String(attr.get('name') || '').trim();
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
      const field = match[2];
      const value = String(attr.get('current') || '').trim();

      if (!byRowId.has(rowId)) {
        byRowId.set(rowId, { rowId, fields: Object.create(null) });
      }
      byRowId.get(rowId).fields[field] = value;
    });

    const rows = [];

    orderedRowIds.forEach((rowId) => {
      if (!byRowId.has(rowId)) return;
      rows.push(byRowId.get(rowId));
      byRowId.delete(rowId);
    });

    Array.from(byRowId.values())
      .sort((a, b) => a.rowId.localeCompare(b.rowId))
      .forEach((row) => rows.push(row));

    return rows;
  }

  function getRepeatingRows(char, section, nameField, actionField) {
    return getRepeatingSectionRows(char, section)
      .map((row) => {
        const label = String(row.fields[nameField] || '').trim();
        if (!label) return null;
        return {
          label,
          sheetAction: `${section}_${row.rowId}_${actionField}`,
        };
      })
      .filter(Boolean);
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

/* ================= TRAITS ================= */

  function pickRowFieldValue(fields, candidates) {
    const normalized = candidates.map((c) => String(c).toLowerCase());
    const keys = Object.keys(fields || {});

    for (const key of keys) {
      const lower = key.toLowerCase();
      const value = String(fields[key] || '').trim();
      if (!value) continue;
      if (normalized.includes(lower)) return value;
    }

    for (const key of keys) {
      const lower = key.toLowerCase();
      const value = String(fields[key] || '').trim();
      if (!value) continue;
      if (normalized.some((needle) => lower.includes(needle))) return value;
    }

    return '';
  }

  function pickRowFieldKey(fields, candidates) {
    const normalized = candidates.map((c) => String(c).toLowerCase());
    const keys = Object.keys(fields || {});

    for (const key of keys) {
      if (normalized.includes(key.toLowerCase())) return key;
    }
    for (const key of keys) {
      if (normalized.some((needle) => key.toLowerCase().includes(needle))) return key;
    }
    return '';
  }

  function isUnknownTraitSourceType(raw) {
    const token = normalizeTextToken(raw);
    return (
      !token ||
      token === '0' ||
      token === 'choose' ||
      token === 'choisir' ||
      token.includes('choose') ||
      token.includes('choisir')
    );
  }

  function parseTraitSourceCategory(raw) {
    const token = normalizeTextToken(raw);
    if (!token) return '';
    if (token.includes('class') || token.includes('classe')) return 'Classe';
    if (token.includes('racial') || token.includes('race')) return 'Racial';
    if (token.includes('don') || token.includes('feat')) return 'Don';
    if (token.includes('historique') || token.includes('background')) return 'Historique';
    if (token.includes('objet') || token.includes('item')) return 'Objet';
    if (token.includes('autre') || token.includes('other')) return 'Autre';
    return '';
  }

  function normalizeTraitSource(raw) {
    return parseTraitSourceCategory(raw) || 'Autre';
  }

  function getTraitSource(fields) {
    const sourceType = pickRowFieldValue(fields, [
      'source_type',
      'source-type',
      'sourcetype',
      'trait_source_type',
      'traitsource_type',
    ]);
    if (!isUnknownTraitSourceType(sourceType)) {
      const fromType = parseTraitSourceCategory(sourceType);
      if (fromType) return fromType;
    }

    const source = pickRowFieldValue(fields, ['source', 'traitsource']);
    const fromSource = parseTraitSourceCategory(source);
    if (fromSource) return fromSource;

    return 'Autre';
  }

  function traitSourceClass(source) {
    const key = normalizeTextToken(source);
    if (key === 'classe') return 'tm-trait-classe';
    if (key === 'racial') return 'tm-trait-racial';
    if (key === 'don') return 'tm-trait-don';
    if (key === 'historique') return 'tm-trait-historique';
    if (key === 'objet') return 'tm-trait-objet';
    return 'tm-trait-autre';
  }

  function getTraitsState() {
    const char = getSelectedChar();
    if (!char) return { groups: [], selected: null };

    const sourceOrder = ['Classe', 'Racial', 'Don', 'Historique', 'Objet', 'Autre'];
    const groupsMap = new Map(sourceOrder.map((source) => [source, []]));
    const rows = getRepeatingSectionRows(char, 'repeating_traits');

    rows.forEach((row) => {
      const name = pickRowFieldValue(row.fields, ['name', 'traitname', 'trait_name', 'title']);
      if (!name) return;

      const source = normalizeTraitSource(getTraitSource(row.fields));
      const description = pickRowFieldValue(row.fields, [
        'description',
        'desc',
        'content',
        'details',
        'text',
      ]);
      const key = `trait:${row.rowId}`;
      const rollFieldKey =
        pickRowFieldKey(row.fields, ['rollTrait', 'rolltrait', 'roll_trait', 'trait']) ||
        'rollTrait';
      const rollAttr = `repeating_traits_${row.rowId}_${rollFieldKey}`;

      groupsMap.get(source).push({
        key,
        rowId: row.rowId,
        name,
        source,
        description,
        summary: shortSummary(description, 120),
        rollAttr,
      });
    });

    const groups = sourceOrder
      .map((source) => ({ source, items: groupsMap.get(source) || [] }))
      .filter((group) => group.items.length > 0);

    if (!groups.length) return { groups: [], selected: null };

    groups.forEach((group, idx) => {
      if (typeof TRAIT_SOURCE_OPEN[group.source] !== 'boolean') {
        TRAIT_SOURCE_OPEN[group.source] = idx === 0;
      }
    });

    const allItems = groups.flatMap((group) => group.items);
    const selected = allItems.find((item) => item.key === SELECTED_TRAIT_KEY) || null;

    return { groups, selected };
  }

  function buildTraitsContent() {
    const state = getTraitsState();
    if (!state.groups.length) {
      return `
        <div class="tm-hud-wrap">
          <div class="tm-mod-title">Capacités</div>
          <div class="tm-mod-empty">Aucune capacité détectée</div>
        </div>
      `;
    }

    const groupsHtml = state.groups
      .map((group) => {
        const isOpen = Boolean(TRAIT_SOURCE_OPEN[group.source]);
        const marker = isOpen ? '-' : '+';
        const sourceClass = traitSourceClass(group.source);

        const itemsHtml = isOpen
          ? `
            <div class="tm-fold-list">
              ${group.items
                .map((item) => {
                  const activeClass = state.selected?.key === item.key ? 'is-active' : '';
                  const tooltip = escapeHtml(
                    item.summary ? `${item.name} : ${item.summary}` : `Capacité : ${item.name}`
                  );
                  return `
                    <button
                      class="tm-list-item ${sourceClass} ${activeClass}"
                      data-trait-item="${escapeHtml(item.key)}"
                      data-label="${tooltip}">
                      ${escapeHtml(item.name)}
                    </button>
                  `;
                })
                .join('')}
            </div>
          `
          : '';

        return `
          <div class="tm-fold-block ${sourceClass}">
            <button
              class="tm-fold-toggle ${sourceClass} ${isOpen ? 'is-open' : 'is-closed'}"
              data-trait-source="${escapeHtml(group.source)}"
              aria-expanded="${isOpen ? 'true' : 'false'}"
              data-label="Source : ${escapeHtml(group.source)}">
              <span class="tm-fold-title">${escapeHtml(group.source)}</span>
              <span class="tm-fold-chevron" aria-hidden="true">${marker}</span>
            </button>
            ${itemsHtml}
          </div>
        `;
      })
      .join('');

    const selected = state.selected;
    const detailTitle = selected ? escapeHtml(selected.name) : 'Aucune capacité sélectionnée';
    const detailBody = selected
      ? asMultilineHtml(selected.description)
      : '<span class="tm-detail-empty">Clique sur une capacité pour afficher sa description.</span>';
    const detailAction = selected
      ? `
        <button
          class="tm-detail-chat"
          data-trait-rowid="${escapeHtml(selected.rowId)}"
          data-trait-rollattr="${escapeHtml(selected.rollAttr || '')}"
          data-label="Envoyer ${escapeHtml(selected.name)} dans le chat">
          Envoyer au chat
        </button>
      `
      : '';

    return `
      <div class="tm-hud-wrap tm-hud-wrap-split">
        <div class="tm-hud-split-left">
          <div class="tm-mod-title">Capacités</div>
          ${groupsHtml}
        </div>
        <div class="tm-hud-split-right">
          <div class="tm-detail-panel">
            <div class="tm-detail-title">${detailTitle}</div>
            ${detailAction}
            <div class="tm-detail-body">${detailBody}</div>
          </div>
        </div>
      </div>
    `;
  }

/* ================= EQUIPMENT ================= */

  function sheetCheckboxValue(raw) {
    const token = normalizeTextToken(raw);
    return (
      token === '1' ||
      token === 'true' ||
      token === 'on' ||
      token === 'yes' ||
      token === 'oui' ||
      token === 'checked' ||
      token === 'active'
    );
  }

  function normalizeEquipmentCategory(raw) {
    const value = String(raw || '').trim();
    if (!value) return 'INVENTAIRE';
    return value.toUpperCase();
  }

  function getEquipmentState() {
    const char = getSelectedChar();
    if (!char) return { groups: [], selected: null };

    const rows = getRepeatingSectionRows(char, 'repeating_inventory');
    const groups = new Map();
    let currentCategory = 'INVENTAIRE';

    function ensureCategory(name) {
      if (!groups.has(name)) groups.set(name, []);
      return groups.get(name);
    }

    ensureCategory(currentCategory);

    rows.forEach((row) => {
      const name = pickRowFieldValue(row.fields, ['itemname', 'name', 'item', 'item_name']);
      if (!name) return;

      const marker = name.match(/^\s*\[CAT\]\s*(.+)\s*$/i);
      if (marker) {
        currentCategory = normalizeEquipmentCategory(marker[1]);
        ensureCategory(currentCategory);
        return;
      }

      const equipField = pickRowFieldKey(row.fields, [
        'equipped',
        'itemequipped',
        'is_equipped',
        'isequipped',
        'equip',
      ]);

      const equipAttr = `repeating_inventory_${row.rowId}_${equipField || 'equipped'}`;
      const equipped = equipField ? sheetCheckboxValue(row.fields[equipField]) : false;

      ensureCategory(currentCategory).push({
        key: `equip:${row.rowId}`,
        name,
        equipAttr,
        equipped,
      });
    });

    const result = Array.from(groups.entries())
      .map(([category, items]) => ({ category, items }))
      .filter((group) => group.items.length > 0);

    if (!result.length) {
      SELECTED_EQUIPMENT_CATEGORY = '';
      return { groups: [], selected: null };
    }

    const hasSelection = result.some((group) => group.category === SELECTED_EQUIPMENT_CATEGORY);
    if (!hasSelection) {
      SELECTED_EQUIPMENT_CATEGORY = result[0].category;
    }

    const selected =
      result.find((group) => group.category === SELECTED_EQUIPMENT_CATEGORY) || result[0];

    return { groups: result, selected };
  }

  function buildEquipmentContent() {
    const state = getEquipmentState();
    if (!state.groups.length) {
      return `
        <div class="tm-hud-wrap">
          <div class="tm-mod-title">Équipement</div>
          <div class="tm-mod-empty">Aucun item détecté</div>
        </div>
      `;
    }

    const categoriesHtml = state.groups
      .map((group) => {
        const isActive = state.selected?.category === group.category;
        const activeClass = isActive ? ' is-active' : '';
        const tooltip = escapeHtml(`Catégorie : ${group.category} (${group.items.length})`);

        return `
          <button
            class="tm-fold-toggle tm-equip-category-btn${activeClass}"
            data-equip-category="${escapeHtml(group.category)}"
            data-label="${tooltip}">
            ${escapeHtml(group.category)} (${group.items.length})
          </button>
        `;
      })
      .join('');

    const selected = state.selected;
    const selectedTitle = selected ? escapeHtml(selected.category) : 'Aucune catégorie';
    const itemsHtml = selected?.items?.length
      ? selected.items
          .map((item) => {
            const tooltip = escapeHtml(`Objet : ${item.name}`);
            return `
              <label class="tm-equip-item" data-label="${tooltip}">
                <input
                  type="checkbox"
                  data-equip-attr="${escapeHtml(item.equipAttr)}"
                  ${item.equipped ? 'checked' : ''}>
                <span class="tm-equip-name">${escapeHtml(item.name)}</span>
              </label>
            `;
          })
          .join('')
      : '<div class="tm-mod-empty">Aucun item dans cette catégorie</div>';

    return `
      <div class="tm-hud-wrap tm-hud-wrap-split">
        <div class="tm-hud-split-left">
          <div class="tm-mod-title">Équipement</div>
          <div class="tm-fold-block tm-fold-up">
            <div class="tm-fold-toggle tm-equip-static-toggle">Catégories</div>
            <div class="tm-fold-list tm-equip-cat-list">${categoriesHtml}</div>
          </div>
        </div>
        <div class="tm-hud-split-right">
          <div class="tm-detail-panel tm-equip-detail-panel">
            <div class="tm-detail-title">${selectedTitle}</div>
            <div class="tm-fold-list tm-equip-detail-list">${itemsHtml}</div>
          </div>
        </div>
      </div>
    `;
  }

/* ================= SPELLS ================= */

  function getSpellMemAttrName(rowId) {
    return `hud_spell_memorized_${String(rowId || '').trim()}`;
  }

  function getSpellPreparedAttrName(char, section, rowId, fields) {
    const sec = String(section || '').trim();
    const rid = String(rowId || '').trim();
    if (!char || !sec || !rid) return '';

    const preferredKey = pickRowFieldKey(fields || {}, [
      'spellprepared',
      'prepared',
      'isprepared',
      'prep',
      'spell_prepared',
      'prepared_flag',
      'memorized',
      'memorised',
    ]);
    if (preferredKey) {
      return `${sec}_${rid}_${preferredKey}`;
    }

    const candidates = [
      `${sec}_${rid}_spellprepared`,
      `${sec}_${rid}_prepared`,
      `${sec}_${rid}_isprepared`,
      `${sec}_${rid}_prep`,
      `${sec}_${rid}_spell_prepared`,
      `${sec}_${rid}_prepared_flag`,
      `${sec}_${rid}_memorized`,
      `${sec}_${rid}_memorised`,
    ];

    for (const name of candidates) {
      if (getCharAttrModel(char, name)) return name;
    }

    return '';
  }

  function getSpellPreparedState(char, section, rowId, fields) {
    const preparedAttr = getSpellPreparedAttrName(char, section, rowId, fields);
    if (preparedAttr) {
      const raw = getAttrCurrentValue(char, preparedAttr);
      return { memorized: isExplicitYesValue(raw), preparedAttr };
    }

    const fallbackAttr = getSpellMemAttrName(rowId);
    const rawFallback = getAttrCurrentValue(char, fallbackAttr);
    return { memorized: isExplicitYesValue(rawFallback), preparedAttr: '' };
  }

  function setSpellMemorized(rowId, preparedAttr, memorized) {
    const char = getSelectedChar();
    if (!char) return;

    const nextValue = memorized ? '1' : '0';

    if (preparedAttr) {
      setCharAttrValue(char, preparedAttr, nextValue);
      setSheetInputValueByAttrName(preparedAttr, nextValue);
      setSheetCheckboxByAttrName(preparedAttr, memorized);
    }

    // Keep HUD fallback attr for sheets that do not expose a prepared flag.
    setCharAttrValue(char, getSpellMemAttrName(rowId), nextValue);
  }

  function readSpellSlotAttrNumber(char, attrName) {
    const model = getCharAttrModel(char, attrName);
    if (!model) return NaN;
    const parsed = parseIntSafe(model.get('current'), NaN);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : NaN;
  }

  function findSpellSlotAttrByCandidates(char, candidates, options = null) {
    const opts = { preferPositive: true, preferLargestPositive: false, ...(options || {}) };
    const uniqueNames = Array.from(new Set((candidates || []).map((n) => String(n || '').trim()).filter(Boolean)));
    if (!uniqueNames.length) return '';

    const existing = uniqueNames
      .filter((name) => Boolean(getCharAttrModel(char, name)))
      .map((name) => ({ name, value: readSpellSlotAttrNumber(char, name) }));

    if (!existing.length) return '';

    if (opts.preferPositive) {
      const positives = existing.filter((entry) => Number.isFinite(entry.value) && entry.value > 0);
      if (positives.length) {
        if (opts.preferLargestPositive) {
          const best = positives.reduce((maxEntry, entry) =>
            entry.value > maxEntry.value ? entry : maxEntry
          );
          return best.name;
        }
        return positives[0].name;
      }
    }

    const numeric = existing.find((entry) => Number.isFinite(entry.value) && entry.value >= 0);
    if (numeric) return numeric.name;

    return existing[0].name;
  }

  function detectSpellSlotAttrs(char, level) {
    if (!char || level <= 0) return { maxAttr: '', remainingAttr: '', usedAttr: '' };

    const l = String(level);

    const maxCandidates = [
      `spell_slots_l${l}`,
      `spell_slots_lvl${l}`,
      `spell_slots_level${l}`,
      `lvl${l}_slots_total`,
      `level${l}_slots_total`,
      `l${l}_slots_total`,
      `spellslots_l${l}_total`,
      `spellslots_lvl${l}_total`,
    ];
    const remainingCandidates = [
      `spell_slots_l${l}_remaining`,
      `spell_slots_l${l}_remain`,
      `spell_slots_l${l}_rest`,
      `spell_slots_l${l}_left`,
      `lvl${l}_slots_remaining`,
      `level${l}_slots_remaining`,
      `l${l}_slots_remaining`,
      `spellslots_l${l}_remaining`,
      `spellslots_lvl${l}_remaining`,
      // On some sheets, "current" stores remaining slots, not expended.
      `spell_slots_l${l}_current`,
      `spell_slots_lvl${l}_current`,
      `spell_slots_level${l}_current`,
      `lvl${l}_slots_current`,
      `level${l}_slots_current`,
      `l${l}_slots_current`,
      `spellslots_l${l}_current`,
      `spellslots_lvl${l}_current`,
    ];
    const usedCandidates = [
      `spell_slots_l${l}_used`,
      `spell_slots_l${l}_expended`,
      `spell_slots_l${l}_spent`,
      `lvl${l}_slots_expended`,
      `level${l}_slots_expended`,
      `l${l}_slots_expended`,
      `spellslots_l${l}_used`,
      `spellslots_lvl${l}_used`,
    ];
    const currentCandidates = [
      `spell_slots_l${l}_current`,
      `spell_slots_lvl${l}_current`,
      `spell_slots_level${l}_current`,
      `lvl${l}_slots_current`,
      `level${l}_slots_current`,
      `l${l}_slots_current`,
      `spellslots_l${l}_current`,
      `spellslots_lvl${l}_current`,
    ];

    let maxAttr = findSpellSlotAttrByCandidates(char, maxCandidates, { preferPositive: true, preferLargestPositive: true });
    let remainingAttr = findSpellSlotAttrByCandidates(char, remainingCandidates, { preferPositive: true, preferLargestPositive: true });
    let usedAttr = findSpellSlotAttrByCandidates(char, usedCandidates, { preferPositive: true });
    if (!usedAttr) {
      const currentAsUsed = findSpellSlotAttrByCandidates(char, currentCandidates, { preferPositive: true });
      if (currentAsUsed && currentAsUsed !== remainingAttr) usedAttr = currentAsUsed;
    }

    if (!maxAttr || (!remainingAttr && !usedAttr)) {
      const allAttrNames = (char.attribs?.models || [])
        .map((attr) => String(attr.get('name') || '').trim())
        .filter(Boolean);
      const levelRegex = new RegExp(`(?:^|_|-)(?:l|lvl|level)?${l}(?:_|-|$)`, 'i');
      const pool = allAttrNames.filter(
        (name) => /(slot|slots|spellslot|emplacement|emplacements)/i.test(name) && levelRegex.test(name)
      );
      const pickFromPool = (pattern, options = null) =>
        findSpellSlotAttrByCandidates(
          char,
          pool.filter((name) => pattern.test(name)),
          options
        );

      if (!maxAttr) {
        maxAttr =
          pickFromPool(/(total|max|maximum|totaux)/i, { preferPositive: true, preferLargestPositive: true }) ||
          pickFromPool(/spell_slots_l\d+$/i, { preferPositive: true, preferLargestPositive: true }) ||
          maxAttr;
      }
      if (!remainingAttr) {
        remainingAttr =
          pickFromPool(/(remaining|remain|left|restant|restants)/i, { preferPositive: true, preferLargestPositive: true }) ||
          pickFromPool(/(current|courant)/i, { preferPositive: true, preferLargestPositive: true }) ||
          remainingAttr;
      }
      if (!usedAttr) {
        usedAttr =
          pickFromPool(/(used|expended|spent|consume|utilis|depens)/i, { preferPositive: true }) ||
          usedAttr;
        if (!usedAttr) {
          const currentFromPool = pickFromPool(/(current|courant)/i, { preferPositive: true });
          if (currentFromPool && currentFromPool !== remainingAttr) usedAttr = currentFromPool;
        }
      }
    }

    return { maxAttr: maxAttr || '', remainingAttr: remainingAttr || '', usedAttr: usedAttr || '' };
  }

  function getSpellSlotsState(char, level) {
    if (!char || level <= 0) return null;

    const attrs = detectSpellSlotAttrs(char, level);
    if (!attrs.maxAttr && !attrs.remainingAttr && !attrs.usedAttr) return null;

    const maxRaw = attrs.maxAttr ? getAttrCurrentValue(char, attrs.maxAttr) : '';
    const remainingRaw = attrs.remainingAttr ? getAttrCurrentValue(char, attrs.remainingAttr) : '';
    const usedRaw = attrs.usedAttr ? getAttrCurrentValue(char, attrs.usedAttr) : '';

    const maxParsed = parseIntSafe(maxRaw, NaN);
    const remainingParsed = parseIntSafe(remainingRaw, NaN);
    const usedParsed = parseIntSafe(usedRaw, NaN);

    let max = Number.isFinite(maxParsed) ? Math.max(0, maxParsed) : NaN;
    let remaining = Number.isFinite(remainingParsed) ? Math.max(0, remainingParsed) : NaN;
    let used = Number.isFinite(usedParsed) ? Math.max(0, usedParsed) : NaN;

    if (!Number.isFinite(remaining) && Number.isFinite(max) && Number.isFinite(used)) {
      remaining = Math.max(0, max - used);
    }

    if (!Number.isFinite(used) && Number.isFinite(max) && Number.isFinite(remaining)) {
      used = Math.max(0, max - remaining);
    }

    if (!Number.isFinite(max) && Number.isFinite(remaining) && Number.isFinite(used)) {
      max = Math.max(0, remaining + used);
    }

    if (!Number.isFinite(max) && Number.isFinite(remaining)) {
      max = remaining;
    }

    if (!Number.isFinite(remaining)) remaining = 0;
    if (!Number.isFinite(used)) used = Number.isFinite(max) ? Math.max(0, max - remaining) : 0;
    if (!Number.isFinite(max)) max = Math.max(remaining, used);

    // Some sheets expose duplicate slot attrs where one stays at 0.
    // Normalize obviously incoherent states to keep HUD aligned with sheet values.
    if (max > 0 && remaining === 0 && used === 0) {
      remaining = max;
      used = 0;
    } else if (max > 0 && remaining + used !== max) {
      const remainingName = String(attrs.remainingAttr || '').toLowerCase();
      const usedName = String(attrs.usedAttr || '').toLowerCase();
      const remainingLooksExplicit = /(remaining|remain|left|restant|restants)/i.test(remainingName);
      const usedLooksExplicit = /(used|expended|spent|consume|utilis|depens|current|courant)/i.test(usedName);

      if (usedLooksExplicit && !remainingLooksExplicit) {
        remaining = Math.max(0, max - used);
      } else if (remainingLooksExplicit && !usedLooksExplicit) {
        used = Math.max(0, max - remaining);
      } else if (remaining === used) {
        // When both attrs mirror the same counter, prefer displaying remaining slots.
        remaining = Math.max(0, max - used);
      } else if (remaining === 0 && used >= 0) {
        remaining = Math.max(0, max - used);
      } else if (used === 0 && remaining >= 0) {
        used = Math.max(0, max - remaining);
      }
    }

    if (max > 0) {
      remaining = Math.min(max, remaining);
      used = Math.min(max, used);
    }

    return {
      level,
      max,
      used,
      remaining,
      maxAttr: attrs.maxAttr,
      remainingAttr: attrs.remainingAttr,
      usedAttr: attrs.usedAttr,
    };
  }

  function consumeSpellSlot(levelRaw) {
    const level = parseIntSafe(levelRaw, 0);
    if (!Number.isFinite(level) || level <= 0) return;

    const char = getSelectedChar();
    if (!char) return;
    const slots = getSpellSlotsState(char, level);
    if (!slots) return;

    if (slots.remainingAttr) {
      const nextRemaining = Math.max(0, slots.remaining - 1);
      setCharAttrValue(char, slots.remainingAttr, String(nextRemaining));
      if (slots.usedAttr && slots.max > 0) {
        const nextUsed = Math.max(0, slots.max - nextRemaining);
        setCharAttrValue(char, slots.usedAttr, String(nextUsed));
      }
    } else if (slots.usedAttr) {
      const nextUsed = slots.max > 0 ? Math.min(slots.max, slots.used + 1) : slots.used + 1;
      setCharAttrValue(char, slots.usedAttr, String(nextUsed));
    }

    if (currentSection === 'spells' && currentPopup) {
      currentPopup.innerHTML = buildSpellsContent();
    }
  }

  function parseSpellSectionLevel(sectionName) {
    const section = String(sectionName || '').trim();
    if (!section) return 0;

    const match = section.match(/^repeating_spell-([^_]+)$/i);
    const rawToken = String(match?.[1] || '').trim();
    if (!rawToken) return 0;

    const token = rawToken
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[_\s-]+/g, '');

    const numeric = parseIntSafe(token, NaN);
    if (Number.isFinite(numeric)) return Math.max(0, numeric);

    if (
      token === 'cantrip' ||
      token === 'cantrips' ||
      token === 'tourdemagie' ||
      token === 'toursdemagie'
    ) {
      return 0;
    }

    const digits = token.match(/\d+/);
    if (digits?.[0]) return Math.max(0, parseIntSafe(digits[0], 0));

    return 0;
  }

  function getSpellSections(char) {

    const attrs = char?.attribs?.models || [];
    const sections = new Set();

    attrs.forEach((attr) => {
      const name = String(attr.get('name') || '').trim();
      const match = name.match(/^(repeating_spell-[^_]+)_/i);
      if (!match) return;
      sections.add(match[1]);
    });

    return Array.from(sections).sort((a, b) => {
      const la = parseSpellSectionLevel(a);
      const lb = parseSpellSectionLevel(b);
      return lb - la;
    });
  }

  function triggerSpellRollFromSheet(section, rowId, rollAttrName = '') {
    const sec = String(section || '').trim();
    const rid = String(rowId || '').trim();
    if (!sec || !rid) return false;

    const char = getSelectedChar();
    if (!char) return false;

    const looksLikeRollPayload = (value) => {
      const v = String(value || '').trim();
      if (!v) return false;
      return (
        v.includes('&{template:') ||
        v.includes('/roll') ||
        v.includes('/r ') ||
        v.includes('[[') ||
        v.includes('%{') ||
        v.includes('@{')
      );
    };

    const preferredAttr = String(rollAttrName || '').trim();
    const attrCandidates = [
      preferredAttr,
      `${sec}_${rid}_roll`,
      `${sec}_${rid}_spell_roll`,
      `${sec}_${rid}_rollspell`,
      `${sec}_${rid}_roll_spell`,
      `${sec}_${rid}_spellattack`,
      `${sec}_${rid}_attack`,
    ].filter(Boolean);

    const escSec = escapeAttrSelectorValue(sec);
    const escRid = escapeAttrSelectorValue(rid);

    const rowRoots = Array.from(
      document.querySelectorAll(`[data-reprowid="${escRid}"], [data-itemid="${escRid}"], .repitem[data-reprowid="${escRid}"]`)
    );
    for (const rowEl of rowRoots) {
      const rollBtn =
        rowEl.querySelector('button[type="roll"]') ||
        rowEl.querySelector('button[name^="roll_"]') ||
        rowEl.querySelector('button[name*="roll"]');
      if (rollBtn instanceof HTMLElement) {
        rollBtn.click();
        return true;
      }
    }

    const buttonSelectors = [
      `button[name^="roll_${escSec}_${escRid}_"]`,
      `button[name^="roll_repeating_spell-"][name*="${escRid}"]`,
      `button[name="roll_${escSec}_${escRid}_spell"]`,
      `button[name="roll_${escSec}_${escRid}_rollspell"]`,
      `button[name="roll_${escSec}_${escRid}_roll_spell"]`,
      `button[name*="roll_${escSec}_${escRid}"]`,
      `[data-reprowid="${escRid}"] button[type="roll"]`,
      `[data-itemid="${escRid}"] button[type="roll"]`,
      `.repitem[data-reprowid="${escRid}"] button[type="roll"]`,
    ];

    for (const selector of buttonSelectors) {
      const btn = document.querySelector(selector);
      if (!(btn instanceof HTMLElement)) continue;
      btn.click();
      return true;
    }

    for (const attrName of attrCandidates) {
      const model = getCharAttrModel(char, attrName);
      if (!model) continue;
      const raw = String(model.get('current') || '').trim();
      if (!looksLikeRollPayload(raw)) continue;
      sendCommand(raw);
      return true;
    }

    const abilityCandidates = [
      `${sec}_${rid}_rollspell`,
      `${sec}_${rid}_roll_spell`,
      `${sec}_${rid}_spell_roll`,
      `${sec}_${rid}_roll`,
    ];
    for (const ability of abilityCandidates) {
      const cmd = buildCustomSheetActionCommand(ability);
      if (!cmd) continue;
      sendCommand(cmd);
      return true;
    }

    return false;
  }

  function readFormControlCurrentValue(control) {
    if (control instanceof HTMLInputElement) {
      const type = String(control.type || '').toLowerCase();
      if (type === 'hidden') {
        const rawAttrValue = control.getAttribute('value');
        if (rawAttrValue != null && String(rawAttrValue).trim() !== '') {
          return String(rawAttrValue).trim();
        }
        return String(control.value || '').trim();
      }
      if (type === 'checkbox') {
        return control.checked ? String(control.value || '1').trim() : '0';
      }
      return String(control.value || '').trim();
    }
    if (control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) {
      return String(control.value || '').trim();
    }
    return '';
  }

  function findSpellRowElementByName(sectionName, spellName, rowIdHint = '') {
    const section = String(sectionName || '').trim();
    const label = normalizeTextToken(spellName);
    if (!section || !label) return null;

    const escSection = escapeAttrSelectorValue(section);
    const container = document.querySelector(`.repcontainer[data-groupname="${escSection}"]`);
    if (!(container instanceof Element)) return null;

    const hint = String(rowIdHint || '').trim();
    const rows = Array.from(container.querySelectorAll('.repitem[data-reprowid], .repitem[data-itemid]'));
    let fallback = null;
    for (const rowEl of rows) {
      const nameEl =
        rowEl.querySelector('.display .spellname[name="attr_spellname"]') ||
        rowEl.querySelector('.display .spellname') ||
        rowEl.querySelector('button.spellcard .spellname') ||
        rowEl.querySelector('.details span[name="attr_spellname"]');
      const rowName = normalizeTextToken(nameEl?.textContent || '');
      if (!rowName || rowName !== label) continue;

      const rid = String(rowEl.getAttribute('data-reprowid') || rowEl.getAttribute('data-itemid') || '').trim();
      if (hint && rid && rid === hint) return rowEl;
      if (!fallback) fallback = rowEl;
    }

    return fallback;
  }

  function getRepeatingRowElementFromDom(sectionName, rowId, spellName = '') {
    const rid = String(rowId || '').trim();
    if (!rid && !spellName) return null;

    const escRid = escapeAttrSelectorValue(rid);
    const section = String(sectionName || '').trim();
    if (section && rid) {
      const escSection = escapeAttrSelectorValue(section);
      const inSection =
        document.querySelector(`.repcontainer[data-groupname="${escSection}"] .repitem[data-reprowid="${escRid}"]`) ||
        document.querySelector(`.repcontainer[data-groupname="${escSection}"] [data-reprowid="${escRid}"]`) ||
        document.querySelector(`.repcontainer[data-groupname="${escSection}"] [data-itemid="${escRid}"]`);
      if (inSection instanceof Element) return inSection;
    }

    if (rid) {
      const globalMatch =
        document.querySelector(`.repitem[data-reprowid="${escRid}"]`) ||
        document.querySelector(`[data-reprowid="${escRid}"]`) ||
        document.querySelector(`[data-itemid="${escRid}"]`);
      if (globalMatch instanceof Element) return globalMatch;
    }

    return findSpellRowElementByName(section, spellName, rid);
  }

  function getRepeatingRowFieldFromDom(sectionName, rowId, attrName, options = null) {
    const rid = String(rowId || '').trim();
    const name = String(attrName || '').trim();
    if (!rid || !name) return '';

    const opts = { preferDisplay: false, ...(options || {}) };
    const escName = escapeAttrSelectorValue(name);

    const rowEl = getRepeatingRowElementFromDom(sectionName, rid);
    if (!(rowEl instanceof Element)) return '';

    const pickValue = (controls) => {
      let fallback = '';
      for (const control of controls) {
        const value = readFormControlCurrentValue(control);
        if (!value) continue;
        if (!fallback) fallback = value;
        if (value !== '0') return value;
      }
      return fallback;
    };

    if (opts.preferDisplay) {
      // For spell components, always prefer hidden values from the compact display header.
      const compMatch = name.match(/^attr_spellcomp_([vsm])$/i);
      if (compMatch) {
        const letter = String(compMatch[1] || '').toLowerCase();
        const displayHidden = rowEl.querySelector(`.display input.${letter}[name="${escName}"]`);
        if (displayHidden) {
          const displayValue = readFormControlCurrentValue(displayHidden);
          if (displayValue) return displayValue;
          return '0';
        }
      }

      const displayControls = Array.from(
        rowEl.querySelectorAll(`.display input[name="${escName}"], .display textarea[name="${escName}"], .display select[name="${escName}"]`)
      );
      if (displayControls.length) {
        return pickValue(displayControls);
      }
    }

    const allControls = Array.from(
      rowEl.querySelectorAll(`input[name="${escName}"], textarea[name="${escName}"], select[name="${escName}"]`)
    );
    return pickValue(allControls);
  }

  function withSpellDomFieldOverrides(sectionName, rowId, fields) {
    const merged = { ...(fields || {}) };
    const overrides = [
      ['spellcomp', getRepeatingRowFieldFromDom(sectionName, rowId, 'attr_spellcomp')],
      ['spellcomp_v', getRepeatingRowFieldFromDom(sectionName, rowId, 'attr_spellcomp_v', { preferDisplay: true })],
      ['spellcomp_s', getRepeatingRowFieldFromDom(sectionName, rowId, 'attr_spellcomp_s', { preferDisplay: true })],
      ['spellcomp_m', getRepeatingRowFieldFromDom(sectionName, rowId, 'attr_spellcomp_m', { preferDisplay: true })],
      ['spellconcentration', getRepeatingRowFieldFromDom(sectionName, rowId, 'attr_spellconcentration', { preferDisplay: true })],
      ['spellcomp_materials', getRepeatingRowFieldFromDom(sectionName, rowId, 'attr_spellcomp_materials')],
    ];

    overrides.forEach(([key, value]) => {
      if (value === '') return;
      merged[key] = value;
    });

    return merged;
  }

  function readSpellRowStateFromDom(rowEl) {
    if (!(rowEl instanceof Element)) return null;

    const gatherControlsByName = (attrName, preferClass = '') => {
      const escName = escapeAttrSelectorValue(attrName);
      const cls = String(preferClass || '').trim();
      const parts = [];
      if (cls) {
        parts.push(Array.from(rowEl.querySelectorAll(`.display input[type="hidden"].${cls}[name="${escName}"]`)));
      }
      parts.push(Array.from(rowEl.querySelectorAll(`.display input[type="hidden"][name="${escName}"]`)));
      parts.push(Array.from(rowEl.querySelectorAll(`input[type="hidden"][name="${escName}"]`)));
      if (cls) {
        parts.push(Array.from(rowEl.querySelectorAll(`.display input.${cls}[name="${escName}"], .display textarea.${cls}[name="${escName}"], .display select.${cls}[name="${escName}"]`)));
      }
      parts.push(Array.from(rowEl.querySelectorAll(`.display input[name="${escName}"], .display textarea[name="${escName}"], .display select[name="${escName}"]`)));
      parts.push(Array.from(rowEl.querySelectorAll(`input[name="${escName}"], textarea[name="${escName}"], select[name="${escName}"]`)));

      const seen = new Set();
      const merged = [];
      parts.forEach((group) => {
        group.forEach((ctrl) => {
          if (seen.has(ctrl)) return;
          seen.add(ctrl);
          merged.push(ctrl);
        });
      });
      return merged;
    };

    const pickRawNamedValue = (attrName, options = null) => {
      const opts = { token: '', preferClass: '', ...(options || {}) };
      const controls = gatherControlsByName(attrName, opts.preferClass);
      if (!controls.length) return '';

      const values = controls
        .map((control) => readFormControlCurrentValue(control))
        .map((v) => String(v || '').trim())
        .filter(Boolean);
      if (!values.length) return '';

      if (opts.token) {
        const recognized = values.find((raw) => isDisabledSpellFlagValue(raw) || isEnabledSpellFlagValue(raw, opts.token));
        if (recognized) return recognized;
      }
      return values[0];
    };

    const vRaw = pickRawNamedValue('attr_spellcomp_v', { token: 'v', preferClass: 'v' });
    const sRaw = pickRawNamedValue('attr_spellcomp_s', { token: 's', preferClass: 's' });
    const mRaw = pickRawNamedValue('attr_spellcomp_m', { token: 'm', preferClass: 'm' });
    const cRaw = pickRawNamedValue('attr_spellconcentration', { token: 'concentration', preferClass: 'spellconcentration' });
    const rRaw = pickRawNamedValue('attr_spellritual', { token: 'ritual', preferClass: 'spellritual' });
    const material = pickRawNamedValue('attr_spellcomp_materials');

    const cConc = parseSpellFlagRaw(cRaw, 'concentration');
    const cShort = parseSpellFlagRaw(cRaw, 'c');
    const rRitual = parseSpellFlagRaw(rRaw, 'ritual');
    const rShort = parseSpellFlagRaw(rRaw, 'r');
    const componentFlags = {
      v: parseSpellFlagRaw(vRaw, 'v'),
      s: parseSpellFlagRaw(sRaw, 's'),
      m: parseSpellFlagRaw(mRaw, 'm'),
      c: cConc != null ? cConc : cShort,
      r: rRitual != null ? rRitual : rShort,
    };

    return { componentFlags, material };
  }

  function getSpellDomRowStateMap(sectionName) {
    const map = new Map();
    const section = String(sectionName || '').trim();
    if (!section) return map;

    const escSection = escapeAttrSelectorValue(section);
    const container = document.querySelector(`.repcontainer[data-groupname="${escSection}"]`);
    if (!(container instanceof Element)) return map;

    const rowElements = Array.from(container.querySelectorAll('.repitem[data-reprowid], .repitem[data-itemid]'));
    rowElements.forEach((rowEl) => {
      const rowId = String(rowEl.getAttribute('data-reprowid') || rowEl.getAttribute('data-itemid') || '').trim();
      if (!rowId) return;
      const state = readSpellRowStateFromDom(rowEl);
      if (!state) return;
      map.set(rowId, state);
      map.set(rowId.toLowerCase(), state);
    });

    return map;
  }

  function getSpellDomRowState(map, rowId) {
    if (!(map instanceof Map)) return null;
    const rid = String(rowId || '').trim();
    if (!rid) return null;
    return map.get(rid) || map.get(rid.toLowerCase()) || null;
  }

  function getSpellsState() {
    const char = getSelectedChar();
    if (!char) return { levels: [], selected: null, hasMemorized: false, filterMemOnly: false };

    const sections = getSpellSections(char);
    const byLevel = new Map();
    let hasMemorized = false;

    sections.forEach((section) => {
      const level = parseSpellSectionLevel(section);

      if (!byLevel.has(level)) byLevel.set(level, []);
      const spellDomStateMap = getSpellDomRowStateMap(section);

      const rows = getRepeatingSectionRows(char, section);
      rows.forEach((row) => {
        const spellFields = withSpellDomFieldOverrides(section, row.rowId, row.fields);
        const name = pickRowFieldValue(spellFields, ['spellname', 'name']);
        if (!name) return;

        const description = pickRowFieldValue(spellFields, [
          'spelldescription',
          'spell_description',
          'description',
          'spellcontent',
          'content',
          'desc',
        ]);
        const castingTime = pickRowFieldValue(spellFields, [
          'spellcastingtime',
          'castingtime',
          'casting_time',
          'spellcasting_time',
        ]);
        const range = pickRowFieldValue(spellFields, ['spellrange', 'range']);
        const target = pickRowFieldValue(spellFields, [
          'spelltarget',
          'target',
          'targets',
          'spell_target',
        ]);
        const duration = pickRowFieldValue(spellFields, [
          'spellduration',
          'duration',
          'spell_duration',
          'duration_text',
        ]);
        const fieldComponentFlags = spellComponentFlagsFromFields(spellFields, duration);
        const fieldMaterial = spellMaterialFromFields(spellFields);
        const domRowState =
          getSpellDomRowState(spellDomStateMap, row.rowId) ||
          readSpellRowStateFromDom(getRepeatingRowElementFromDom(section, row.rowId, name));
        const mergeFlag = (domFlag, fieldFlag) => (domFlag == null ? Boolean(fieldFlag) : Boolean(domFlag));
        const componentFlags = {
          v: mergeFlag(domRowState?.componentFlags?.v, fieldComponentFlags.v),
          s: mergeFlag(domRowState?.componentFlags?.s, fieldComponentFlags.s),
          m: mergeFlag(domRowState?.componentFlags?.m, fieldComponentFlags.m),
          c: mergeFlag(domRowState?.componentFlags?.c, fieldComponentFlags.c),
          r: mergeFlag(domRowState?.componentFlags?.r, fieldComponentFlags.r),
        };
        const material = domRowState?.material ? domRowState.material : fieldMaterial;
        const rollField =
          pickRowFieldKey(spellFields, ['spell', 'rollspell', 'roll_spell', 'attack', 'roll']) ||
          'spell';
        const rollAttr = `${section}_${row.rowId}_${rollField}`;
        const preparedState = getSpellPreparedState(char, section, row.rowId, spellFields);
        const memorized = preparedState.memorized;
        if (memorized) hasMemorized = true;

        byLevel.get(level).push({
          key: `spell:${section}:${row.rowId}`,
          section,
          rowId: row.rowId,
          rollAttr,
          preparedAttr: preparedState.preparedAttr,
          name,
          level,
          memorized,
          description,
          castingTime,
          range,
          target,
            material,
          componentFlags,
          duration,
          summary: shortSummary(description, 120),
        });
      });
    });

    const levelsAll = Array.from(byLevel.keys())
      .sort((a, b) => b - a)
      .map((level) => {
        const items = byLevel.get(level) || [];
        items.sort((a, b) => {
          const byMem = Number(b.memorized) - Number(a.memorized);
          if (byMem !== 0) return byMem;
          return a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' });
        });

        return {
          level,
          slots: getSpellSlotsState(char, level),
          items,
        };
      })
      .filter((group) => group.items.length > 0);

    if (!levelsAll.length) {
      return { levels: [], selected: null, hasMemorized: false, filterMemOnly: false };
    }

    levelsAll.forEach((group, idx) => {
      if (typeof SPELL_LEVEL_OPEN[group.level] !== 'boolean') {
        SPELL_LEVEL_OPEN[group.level] = idx === 0;
      }
    });

    const filterMemOnly = hasMemorized && !SPELL_SHOW_ALL;
    const levels = levelsAll
      .map((group) => ({
        ...group,
        items: filterMemOnly ? group.items.filter((item) => item.memorized) : group.items,
      }))
      .filter((group) => group.items.length > 0);

    const allItems = levels.flatMap((group) => group.items);
    let selected = allItems.find((item) => item.key === SELECTED_SPELL_KEY) || null;
    if (!selected && allItems.length) {
      selected = allItems[0];
      SELECTED_SPELL_KEY = selected.key;
    }

    return { levels, selected, hasMemorized, filterMemOnly };
  }

  function buildSpellsContent() {
    const state = getSpellsState();
    if (!state.levels.length) {
      return `
        <div class="tm-hud-wrap">
          <div class="tm-mod-title">Sorts</div>
          <div class="tm-mod-empty">Aucun sort détecté</div>
        </div>
      `;
    }

    const filterToggle = state.hasMemorized
      ? `
        <button class="tm-spell-filter-toggle" data-spell-toggle-all="1" data-label="Filtre de sorts">
          ${state.filterMemOnly ? 'Afficher tous les sorts' : 'Réduire aux mémorisés'}
        </button>
      `
      : '';

    const levelsHtml = state.levels
      .map((group) => {
        const isOpen = Boolean(SPELL_LEVEL_OPEN[group.level]);
        const marker = isOpen ? '-' : '+';

        const spellsHtml = isOpen
          ? `
            <div class="tm-fold-list">
              ${group.items
                .map((spell) => {
                  const activeClass = state.selected?.key === spell.key ? 'is-active' : '';
                  const tooltip = escapeHtml(
                    spell.summary ? `${spell.name} : ${spell.summary}` : `Sort : ${spell.name}`
                  );
                  const leftBadge = buildSpellBadgesHtml(spell.componentFlags, {
                    v: false,
                    s: false,
                    m: false,
                    c: true,
                    r: true,
                  });
                  return `
                    <div class="tm-spell-row ${spell.memorized ? 'is-memorized' : ''}" data-label="${tooltip}">
                      <input
                        class="tm-spell-mem"
                        type="checkbox"
                        data-spell-mem-rowid="${escapeHtml(spell.rowId)}"
                        data-spell-mem-attr="${escapeHtml(spell.preparedAttr || '')}"
                        ${spell.memorized ? 'checked' : ''}>
                      <button
                        class="tm-list-item tm-spell-item ${activeClass} ${spell.memorized ? 'is-memorized' : 'is-unmemorized'}"
                        data-spell-item="${escapeHtml(spell.key)}"
                        data-spell-rowid="${escapeHtml(spell.rowId)}"
                        data-spell-section="${escapeHtml(spell.section)}"
                        data-spell-rollattr="${escapeHtml(spell.rollAttr)}"
                        data-label="${tooltip}">
                        <span class="tm-spell-item-name">${escapeHtml(spell.name)}</span>
                        ${leftBadge}
                      </button>
                    </div>
                  `;
                })
                .join('')}
            </div>
          `
          : '';

        const slotsHtml =
          group.slots
            ? `
              <div class="tm-spell-slot-wrap">
                <span class="tm-spell-slot-count ${group.slots.remaining <= 0 ? 'is-empty' : ''}">
                  ${escapeHtml(group.slots.remaining)}/${escapeHtml(group.slots.max)}
                </span>
                <button
                  class="tm-spell-slot-use"
                  data-spell-slot-use="${escapeHtml(group.level)}"
                  data-label="Utiliser 1 emplacement de niveau ${escapeHtml(group.level)}">-</button>
              </div>
            `
            : '';

        return `
          <div class="tm-fold-block">
            <div class="tm-spell-level-head">
              <button
                class="tm-fold-toggle tm-spell-level-toggle ${isOpen ? 'is-open' : 'is-closed'}"
                data-spell-level="${escapeHtml(group.level)}"
                aria-expanded="${isOpen ? 'true' : 'false'}"
                data-label="Niveau ${escapeHtml(group.level)}">
                <span class="tm-fold-title">Niv ${escapeHtml(group.level)}</span>
                <span class="tm-fold-chevron" aria-hidden="true">${marker}</span>
              </button>
              ${slotsHtml}
            </div>
            ${spellsHtml}
          </div>
        `;
      })
      .join('');

    const selected = state.selected;
    const detailTitle = selected ? escapeHtml(selected.name) : 'Détail';
    const selectedDomState = selected
      ? readSpellRowStateFromDom(getRepeatingRowElementFromDom(selected.section, selected.rowId, selected.name))
      : null;
    const selectedFlags = selected
      ? {
          v: selectedDomState?.componentFlags?.v == null ? Boolean(selected.componentFlags?.v) : Boolean(selectedDomState.componentFlags.v),
          s: selectedDomState?.componentFlags?.s == null ? Boolean(selected.componentFlags?.s) : Boolean(selectedDomState.componentFlags.s),
          m: selectedDomState?.componentFlags?.m == null ? Boolean(selected.componentFlags?.m) : Boolean(selectedDomState.componentFlags.m),
          c: selectedDomState?.componentFlags?.c == null ? Boolean(selected.componentFlags?.c) : Boolean(selectedDomState.componentFlags.c),
          r: selectedDomState?.componentFlags?.r == null ? Boolean(selected.componentFlags?.r) : Boolean(selectedDomState.componentFlags.r),
        }
      : null;
    const selectedMaterial = selected ? (selectedDomState?.material ? selectedDomState.material : selected.material) : '';
    const detailBadges = selected
      ? buildSpellBadgesHtml(selectedFlags, {
          v: true,
          s: true,
          m: true,
          c: false,
          r: true,
        })
      : '';
    const detailMeta = selected
      ? `
        <div class="tm-spell-meta">
          <div><span class="tm-spell-key">Incantation :</span> ${escapeHtml(selected.castingTime || '—')}</div>
          <div><span class="tm-spell-key">Portée :</span> ${escapeHtml(selected.range || '—')}</div>
          <div><span class="tm-spell-key">Cible :</span> ${escapeHtml(selected.target || '—')}</div>
          <div><span class="tm-spell-key">Composante :</span> ${escapeHtml(selectedMaterial || '—')}</div>
          <div><span class="tm-spell-key">Durée :</span> ${escapeHtml(selected.duration || '—')}</div>
        </div>
      `
      : '';
    const detailBody = selected ? asMultilineHtml(selected.description) : '<span class="tm-detail-empty">Aucun sort.</span>';

    return `
      <div class="tm-hud-wrap tm-hud-wrap-split">
        <div class="tm-hud-split-left">
          <div class="tm-mod-title">Sorts</div>
          ${filterToggle}
          ${levelsHtml}
        </div>
        <div class="tm-hud-split-right">
          <div class="tm-detail-panel">
            <div class="tm-detail-head">
              <div class="tm-detail-title">${detailTitle}</div>
              ${detailBadges}
            </div>
            ${detailMeta}
            <div class="tm-detail-body">${detailBody}</div>
          </div>
        </div>
      </div>
    `;
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
      <div id="tm-left-tools">
        <div class="toggle icon-only" data-sec="characters" data-label="Fiches">
          <img src="${icon('Fiches')}">
        </div>
        <div class="toggle icon-only" data-sec="currency" data-label="Bourse">
          <img src="${icon('coins')}">
        </div>
        <div class="toggle settings" data-sec="settings" data-label="Réglages">⚙️</div>
      </div>
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
          <div class="toggle" data-sec="skill" data-label="Compétences"><img src="${icon('Skills')}"></div>
          <div class="toggle" data-sec="jds" data-label="Jet de Sauvegarde"><img src="${icon('Saves')}"></div>
          <div class="toggle" data-sec="attr" data-label="Attribut"><img src="${icon('Attributs')}"></div>
        </div>
        <div id="tm-mid-col">
          <div class="toggle" data-sec="resource" data-label="Ressources"><img src="${icon('Ressources')}"></div>
          <div class="toggle" data-sec="traits" data-label="Capacité et dons Raciaux"><img src="${icon('Capacity')}"></div>
          <div class="toggle" data-sec="equipment" data-label="Equipement"><img src="${icon('Equipements')}"></div>
        </div>
        <div id="tm-extra-col">
          <div class="toggle" data-sec="combat" data-label="Combats"><img src="${icon('Fight')}"></div>
          <div class="toggle" data-sec="spells" data-label="Sorts"><img src="${icon('Spells')}"></div>
          <div class="toggle" data-sec="mods" data-label="Modificateurs Globaux"><img src="${icon('Mods')}"></div>
        </div>
      </div>
      <div id="tm-popup-zone" data-label="Zone accordéon"></div>
    </div>
  `;

  document.body.appendChild(root);
  const popupHost = root.querySelector('#tm-popup-zone');
  applyHudTransform();

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
      --tm-accordion-resource-width:220px;
      --tm-accordion-xwide-width:calc(var(--tm-accordion-width) * 2.1);
      --tm-main-toggle-width:40px;
      --tm-cell-size:40px;
      --tm-cell-gap:4px;
      position:fixed;
      bottom:40px;
      left:50%;
      transform-origin:bottom center;
      z-index:9999999;
    }

    #tm-bar{display:flex;gap:8px;align-items:flex-end}

    #tm-left-tools{
      display:flex;
      flex-direction:column;
      gap:4px;
      align-self:flex-end;
    }

    #tm-right-big-wrap{
      display:flex;
      gap:8px;
      align-items:flex-end;
    }

    #tm-left-col,
    #tm-mid-col,
    #tm-extra-col{
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
      padding:0;
    }

    .toggle.icon-only{
      width:var(--tm-cell-size);
      min-width:var(--tm-cell-size);
      padding:0;
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

    .tm-popup.tm-popup-resource.is-wide .tm-mods-wrap,
    .tm-popup.tm-popup-resource.is-wide .tm-mod-cat{
      width:var(--tm-accordion-resource-width);
    }

    .tm-popup.is-xwide .tm-cell-wide{
      width:var(--tm-accordion-xwide-width);
    }

    .tm-popup.is-xwide .combat-action{
      width:var(--tm-accordion-xwide-width);
    }

    .tm-popup.is-xwide .tm-empty-combat{
      width:var(--tm-accordion-xwide-width);
    }

    .tm-popup.is-xwide .tm-mods-wrap,
    .tm-popup.is-xwide .tm-mod-cat,
    .tm-popup.is-xwide .tm-hud-wrap{
      width:var(--tm-accordion-xwide-width);
    }

    .tm-popup.is-detail-right .tm-hud-wrap{
      width:calc(var(--tm-accordion-width) * 3.2);
    }

    .tm-popup.tm-popup-settings{
      left:calc(-100% - var(--tm-cell-gap));
      bottom:0;
      transform:none;
    }

    .tm-popup.tm-popup-currency{
      left:auto;
      right:calc(100% + var(--tm-cell-gap));
      bottom:0;
      transform:none;
    }

    .tm-popup.tm-popup-characters{
      left:0;
      bottom:calc(100% + var(--tm-cell-gap));
      transform:none;
    }

    .tm-row{display:flex;gap:4px}
    .tm-cell{display:flex}
    .tm-cell-wide{width:var(--tm-accordion-width)}
    .tm-settings-col{display:flex;flex-direction:column;gap:4px}

    .tm-hud-wrap{
      width:var(--tm-accordion-wide-width);
      background:rgba(0,0,0,0.92);
      border:1px solid rgba(255,165,0,0.65);
      border-radius:8px;
      padding:6px;
      box-sizing:border-box;
      display:flex;
      flex-direction:column;
      gap:5px;
    }

    .tm-hud-wrap.tm-hud-wrap-split{
      display:grid;
      grid-template-columns:minmax(0,1.05fr) minmax(0,0.95fr);
      align-items:stretch;
      gap:6px;
    }

    .tm-hud-split-left{
      display:flex;
      flex-direction:column;
      gap:5px;
      min-width:0;
    }

    .tm-hud-split-right{
      display:flex;
      min-width:0;
    }

    .tm-hud-wrap-split .tm-detail-panel{
      margin-top:0;
      flex:1 1 auto;
    }

    .tm-hud-wrap-split .tm-detail-body{
      max-height:280px;
    }

    .tm-fold-block{
      display:flex;
      flex-direction:column;
      gap:3px;
    }

    .tm-fold-block.tm-fold-up{
      flex-direction:column;
    }

    .tm-fold-toggle{
      width:100%;
      height:28px;
      min-height:28px;
      display:flex;
      align-items:center;
      justify-content:flex-start;
      gap:8px;
      padding:0 8px;
      font-size:11px;
      font-weight:700;
      border-radius:7px;
    }

    .tm-fold-title{
      flex:1 1 auto;
      min-width:0;
      text-align:left;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }

    .tm-fold-chevron{
      flex:0 0 auto;
      width:22px;
      height:18px;
      border-radius:999px;
      display:inline-flex;
      align-items:center;
      justify-content:center;
      border:1px solid rgba(255,255,255,0.45);
      background:rgba(255,255,255,0.08);
      color:#fff;
      font-size:13px;
      font-weight:900;
      line-height:1;
      text-shadow:none;
    }

    .tm-fold-toggle.is-open .tm-fold-chevron{
      border-color:rgba(141,224,168,0.85);
      background:rgba(32,112,56,0.5);
      color:#d9ffe5;
    }

    .tm-fold-toggle.is-closed .tm-fold-chevron{
      border-color:rgba(255,255,255,0.45);
      background:rgba(255,255,255,0.08);
      color:#fff;
    }

    .tm-fold-list{
      display:flex;
      flex-direction:column;
      gap:3px;
      max-height:150px;
      overflow:auto;
      padding-right:2px;
    }

    .tm-list-item{
      width:100%;
      height:28px;
      min-height:28px;
      justify-content:flex-start;
      padding:0 8px;
      font-size:11px;
      border-radius:7px;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }

    .tm-list-item.is-active{
      background:rgba(28,130,58,0.28);
      outline:1px solid rgba(126,255,170,0.55);
    }

    .tm-fold-toggle.is-active{
      background:rgba(28,130,58,0.28);
      outline:1px solid rgba(126,255,170,0.55);
    }

    .tm-char-picker-wrap{
      gap:6px;
    }

    .tm-char-active{
      color:#d9d9d9;
      font-size:10px;
      line-height:1.3;
      padding:0 2px;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }

    .tm-char-active-name{
      color:#fff;
      font-weight:700;
    }

    .tm-char-list{
      display:flex;
      flex-direction:column;
      gap:3px;
      max-height:240px;
      overflow:auto;
      padding-right:2px;
    }

    .tm-char-item{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:6px;
      border-color:rgba(120,193,255,0.65);
      color:#e9f6ff;
    }

    .tm-char-item.is-active{
      background:rgba(31,74,124,0.35);
      outline-color:rgba(120,193,255,0.85);
    }

    .tm-char-item-namewrap{
      flex:1 1 auto;
      min-width:0;
      display:flex;
      align-items:center;
      gap:6px;
    }

    .tm-char-item-name{
      flex:1 1 auto;
      min-width:0;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
      text-align:left;
    }

    .tm-sheet-type-badge{
      flex:0 0 auto;
      font-size:9px;
      font-weight:700;
      border-radius:999px;
      padding:1px 5px 0;
      line-height:1.25;
      letter-spacing:0.2px;
      border:1px solid transparent;
      text-shadow:none;
    }

    .tm-sheet-type-pc{
      color:#cfe4ff;
      border-color:rgba(113,170,255,0.7);
      background:rgba(40,98,188,0.38);
    }

    .tm-sheet-type-npc{
      color:#d8f7df;
      border-color:rgba(101,196,124,0.7);
      background:rgba(36,132,64,0.36);
    }

    .tm-char-item-badge{
      flex:0 0 auto;
      font-size:9px;
      font-weight:700;
      color:#8de0a8;
      border:1px solid rgba(141,224,168,0.55);
      border-radius:999px;
      padding:1px 5px 0;
      line-height:1.25;
    }

    .tm-equip-static-toggle{
      cursor:default;
      opacity:0.9;
    }

    .tm-equip-cat-list{
      max-height:260px;
    }

    .tm-equip-detail-panel{
      gap:6px;
    }

    .tm-equip-detail-list{
      max-height:300px;
      overflow:auto;
      padding-right:2px;
    }

    .tm-fold-toggle.tm-trait-classe,
    .tm-list-item.tm-trait-classe{ border-color:rgba(74,201,126,0.85); }
    .tm-list-item.tm-trait-classe.is-active{ background:rgba(36,122,72,0.42); outline-color:rgba(98,232,159,0.85); }

    .tm-fold-toggle.tm-trait-racial,
    .tm-list-item.tm-trait-racial{ border-color:rgba(88,171,255,0.85); }
    .tm-list-item.tm-trait-racial.is-active{ background:rgba(35,84,137,0.42); outline-color:rgba(120,193,255,0.85); }

    .tm-fold-toggle.tm-trait-don,
    .tm-list-item.tm-trait-don{ border-color:rgba(191,132,255,0.9); }
    .tm-list-item.tm-trait-don.is-active{ background:rgba(99,51,147,0.4); outline-color:rgba(206,162,255,0.85); }

    .tm-fold-toggle.tm-trait-objet,
    .tm-list-item.tm-trait-objet{ border-color:rgba(255,179,92,0.9); }
    .tm-list-item.tm-trait-objet.is-active{ background:rgba(120,74,28,0.45); outline-color:rgba(255,201,136,0.85); }

    .tm-fold-toggle.tm-trait-autre,
    .tm-list-item.tm-trait-autre{ border-color:rgba(185,185,185,0.8); }
    .tm-list-item.tm-trait-autre.is-active{ background:rgba(86,86,86,0.42); outline-color:rgba(230,230,230,0.8); }

    .tm-detail-panel{
      margin-top:2px;
      border:1px solid rgba(255,165,0,0.45);
      border-radius:7px;
      padding:6px;
      background:rgba(10,10,10,0.75);
      display:flex;
      flex-direction:column;
      gap:4px;
    }

    .tm-detail-title{
      color:#fff;
      font-size:12px;
      font-weight:700;
      line-height:1.2;
    }

    .tm-detail-chat{
      width:100%;
      height:28px;
      min-height:28px;
      justify-content:center;
      font-size:11px;
      font-weight:700;
      border-radius:7px;
      border-color:rgba(120,193,255,0.85);
      color:#b9ddff;
    }

    .tm-detail-body{
      color:#ddd;
      font-size:11px;
      line-height:1.35;
      max-height:160px;
      overflow:auto;
      white-space:normal;
      word-break:break-word;
      padding-right:2px;
    }

    .tm-detail-empty{
      color:#aaa;
      font-style:italic;
    }

    .tm-spell-meta{
      color:#ddd;
      font-size:10px;
      line-height:1.25;
      display:flex;
      flex-direction:column;
      gap:2px;
    }

    .tm-spell-key{
      color:#ffc05f;
      font-weight:700;
    }

    .tm-spell-filter-toggle{
      width:100%;
      height:28px;
      min-height:28px;
      justify-content:center;
      padding:0 8px;
      font-size:11px;
      font-weight:700;
      border-radius:7px;
      border-color:rgba(120,193,255,0.85);
      color:#b9ddff;
    }

    .tm-spell-level-head{
      display:flex;
      align-items:center;
      gap:4px;
    }

    .tm-spell-level-toggle{
      flex:1 1 auto;
      min-width:0;
    }

    .tm-spell-slot-wrap{
      display:flex;
      align-items:center;
      gap:4px;
      flex:0 0 auto;
    }

    .tm-spell-slot-count{
      min-width:40px;
      height:28px;
      display:flex;
      align-items:center;
      justify-content:center;
      border:1px solid rgba(255,165,0,0.6);
      border-radius:7px;
      color:#d6d6d6;
      font-size:10px;
      font-weight:700;
      background:rgba(0,0,0,0.45);
      box-sizing:border-box;
      padding:0 5px;
    }

    .tm-spell-slot-count.is-empty{
      color:#888;
      border-color:rgba(140,140,140,0.55);
    }

    .tm-spell-slot-use{
      width:28px;
      height:28px;
      min-width:28px;
      border-radius:7px;
      font-size:16px;
      font-weight:700;
      line-height:1;
      padding:0;
    }

    .tm-spell-row{
      display:flex;
      align-items:center;
      gap:4px;
    }

    .tm-spell-mem{
      width:13px;
      height:13px;
      margin:0;
      flex:0 0 auto;
    }

    .tm-spell-item{
      flex:1 1 auto;
      min-width:0;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:6px;
    }

    .tm-spell-item.is-memorized{
      border-color:rgba(88,171,255,0.85);
      background:rgba(31,74,124,0.25);
    }

    .tm-spell-item.is-unmemorized{
      opacity:0.88;
    }

    .tm-detail-head{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:8px;
    }

    .tm-spell-item-name{
      flex:1 1 auto;
      min-width:0;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }

    .tm-spell-badges{
      display:flex;
      align-items:center;
      gap:4px;
      flex:0 0 auto;
    }

    .tm-detail-head .tm-spell-badges{
      margin-left:auto;
    }

    .tm-spell-badge{
      width:16px;
      height:16px;
      border-radius:999px;
      display:inline-flex;
      align-items:center;
      justify-content:center;
      color:#fff;
      font-size:9px;
      font-weight:700;
      line-height:1;
      border:1px solid rgba(255,255,255,0.2);
      box-sizing:border-box;
      text-shadow:0 1px 0 rgba(0,0,0,0.4);
    }

    .tm-detail-head .tm-spell-badge{
      width:18px;
      height:18px;
      font-size:10px;
    }

    .tm-spell-badge-v{ background:#1f9e44; }
    .tm-spell-badge-s{ background:#2f6dff; }
    .tm-spell-badge-m{ background:#c66f00; }
    .tm-spell-badge-c{ background:#c62828; }
    .tm-spell-badge-r{
      background:#cfd3d8;
      color:#1f1f1f;
      border-color:rgba(255,255,255,0.5);
      text-shadow:none;
    }

    .tm-equip-item{
      display:flex;
      align-items:center;
      gap:6px;
      min-height:24px;
      border:1px solid rgba(255,165,0,0.35);
      border-radius:7px;
      padding:3px 6px;
      background:rgba(0,0,0,0.35);
      color:#fff;
      font-size:11px;
      box-sizing:border-box;
    }

    .tm-equip-item input{
      width:12px;
      height:12px;
      margin:0;
      flex:0 0 auto;
    }

    .tm-equip-name{
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }

    .tm-currency-cat{
      display:flex;
      flex-direction:column;
      gap:5px;
    }

    .tm-currency-grid{
      display:flex;
      flex-direction:column;
      gap:4px;
    }

    .tm-currency-row{
      display:grid;
      grid-template-columns:24px 1fr;
      align-items:center;
      gap:6px;
      color:#fff;
      font-size:11px;
    }

    .tm-currency-code{
      color:#ffc05f;
      font-weight:700;
      text-align:left;
    }

    .tm-currency-input{
      width:100%;
      height:24px;
      border:1px solid rgba(255,165,0,0.6);
      border-radius:6px;
      background:#000;
      color:#fff;
      padding:0 6px;
      box-sizing:border-box;
      font-size:11px;
    }

    .tm-currency-input:focus{
      outline:none;
      border-color:rgba(120,193,255,0.85);
      box-shadow:0 0 0 1px rgba(120,193,255,0.35);
    }

    .tm-currency-total{
      color:#ddd;
      font-size:10px;
      text-align:right;
    }

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

    .tm-move-btn{
      font-size:21px;
      font-weight:700;
      border-color:rgba(120,193,255,0.85);
      color:#b9ddff;
      cursor:grab;
    }

    .tm-move-btn:active{
      cursor:grabbing;
    }

    #tm-root.tm-hud-dragging,
    #tm-root.tm-hud-dragging *{
      cursor:grabbing !important;
      user-select:none;
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

  function buildSettingsContent() {
    return `
      <div class="tm-settings-col">
        <div class="tm-cell"><button class="tm-scale-btn" data-scale="up" data-label="Augmenter la taille">+</button></div>
        <div class="tm-cell"><button class="tm-scale-btn" data-scale="down" data-label="Réduire la taille">-</button></div>
        <div class="tm-cell">
          <button
            class="tm-scale-btn tm-move-btn"
            data-hud-drag-handle="1"
            data-label="Maintenir et glisser pour déplacer le HUD">⌖</button>
        </div>
      </div>
    `;
  }

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

    if (sec === 'currency') {
      content = buildCurrencyPanelContent();
    }

    if (sec === 'characters') {
      content = buildCharacterPickerContent();
    }

    if (sec === 'mods') {
      content = buildGlobalModsContent();
    }

    if (sec === 'traits') {
      content = buildTraitsContent();
    }

    if (sec === 'equipment') {
      content = buildEquipmentContent();
    }

    if (sec === 'spells') {
      content = buildSpellsContent();
    }

    if (sec === 'settings') {
      content = buildSettingsContent();
    }

    popup.innerHTML = content;
    if (sec === 'settings') {
      popup.classList.add('tm-popup-settings');
      el.appendChild(popup);
    } else if (sec === 'characters') {
      popup.classList.add('is-wide', 'tm-popup-characters');
      el.appendChild(popup);
    } else if (sec === 'currency') {
      popup.classList.add('is-wide', 'tm-popup-currency');
      el.appendChild(popup);
    } else {
      if (sec === 'spells' || sec === 'traits' || sec === 'equipment') {
        popup.classList.add('is-xwide', 'is-detail-right');
      } else if (sec === 'resource') {
        popup.classList.add('is-wide', 'tm-popup-resource');
      } else if (sec === 'combat' || sec === 'mods') {
        popup.classList.add('is-wide');
      }
      (popupHost || el).appendChild(popup);
    }

    currentPopup = popup;
    currentSection = sec;
  }

/* ================= VISUAL ================= */

  function applyHudTransform() {
    root.style.transform = `translate(calc(-50% + ${HUD_SHIFT_RIGHT_PERCENT}% + ${HUD_DRAG_X}px), ${HUD_DRAG_Y}px) scale(${SCALE})`;
  }

  function persistHudTransform() {
    localStorage.setItem('tm_hud_scale', String(SCALE));
    localStorage.setItem('tm_hud_drag_x', String(HUD_DRAG_X));
    localStorage.setItem('tm_hud_drag_y', String(HUD_DRAG_Y));
  }

  function updateScale(delta) {
    SCALE = Math.max(0.6, Math.min(1.6, SCALE + delta));
    applyHudTransform();
    persistHudTransform();
  }

  function startHudDrag(event, handle) {
    if (!root || !handle) return;
    if (event.button !== 0) return;

    HUD_DRAG_STATE.active = true;
    HUD_DRAG_STATE.pointerId = event.pointerId;
    HUD_DRAG_STATE.startX = event.clientX;
    HUD_DRAG_STATE.startY = event.clientY;
    HUD_DRAG_STATE.originX = HUD_DRAG_X;
    HUD_DRAG_STATE.originY = HUD_DRAG_Y;

    root.classList.add('tm-hud-dragging');
    if (typeof handle.setPointerCapture === 'function') {
      try {
        handle.setPointerCapture(event.pointerId);
      } catch (_error) {}
    }
  }

  function moveHudDrag(event) {
    if (!HUD_DRAG_STATE.active) return;
    if (HUD_DRAG_STATE.pointerId !== event.pointerId) return;

    const dx = event.clientX - HUD_DRAG_STATE.startX;
    const dy = event.clientY - HUD_DRAG_STATE.startY;
    HUD_DRAG_X = HUD_DRAG_STATE.originX + dx;
    HUD_DRAG_Y = HUD_DRAG_STATE.originY + dy;
    applyHudTransform();
  }

  function stopHudDrag(event = null) {
    if (!HUD_DRAG_STATE.active) return;
    if (event && HUD_DRAG_STATE.pointerId !== event.pointerId) return;

    HUD_DRAG_STATE.active = false;
    HUD_DRAG_STATE.pointerId = null;
    root.classList.remove('tm-hud-dragging');
    persistHudTransform();
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

  root.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('button[data-hud-drag-handle]');
    if (!handle || !root.contains(handle)) return;
    e.preventDefault();
    e.stopPropagation();
    startHudDrag(e, handle);
  });

  window.addEventListener('pointermove', (e) => {
    moveHudDrag(e);
  });

  window.addEventListener('pointerup', (e) => {
    stopHudDrag(e);
  });

  window.addEventListener('pointercancel', (e) => {
    stopHudDrag(e);
  });

  root.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn && root.contains(btn)) {
      if (btn.dataset.hudDragHandle) {
        return;
      }

      if (btn.dataset.charSelect) {
        selectHudCharacterById(btn.dataset.charSelect);
        return;
      }

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

      if (btn.dataset.traitSource) {
        const key = btn.dataset.traitSource;
        TRAIT_SOURCE_OPEN[key] = !TRAIT_SOURCE_OPEN[key];
        if (currentSection === 'traits' && currentPopup) {
          currentPopup.innerHTML = buildTraitsContent();
        }
        return;
      }

      if (btn.dataset.traitItem) {
        SELECTED_TRAIT_KEY = btn.dataset.traitItem;
        if (currentSection === 'traits' && currentPopup) {
          currentPopup.innerHTML = buildTraitsContent();
        }
        return;
      }

      if (btn.dataset.equipCategory) {
        const key = btn.dataset.equipCategory;
        SELECTED_EQUIPMENT_CATEGORY = key;
        if (currentSection === 'equipment' && currentPopup) {
          currentPopup.innerHTML = buildEquipmentContent();
        }
        return;
      }

      if (btn.dataset.spellLevel) {
        const level = btn.dataset.spellLevel;
        SPELL_LEVEL_OPEN[level] = !SPELL_LEVEL_OPEN[level];
        if (currentSection === 'spells' && currentPopup) {
          currentPopup.innerHTML = buildSpellsContent();
        }
        return;
      }

      if (btn.dataset.spellToggleAll) {
        SPELL_SHOW_ALL = !SPELL_SHOW_ALL;
        localStorage.setItem('tm_spell_show_all', SPELL_SHOW_ALL ? '1' : '0');
        if (currentSection === 'spells' && currentPopup) {
          currentPopup.innerHTML = buildSpellsContent();
        }
        return;
      }

      if (btn.dataset.spellSlotUse) {
        consumeSpellSlot(btn.dataset.spellSlotUse);
        return;
      }

      if (btn.dataset.spellItem) {
        SELECTED_SPELL_KEY = btn.dataset.spellItem;
        if (currentSection === 'spells' && currentPopup) {
          currentPopup.innerHTML = buildSpellsContent();
        }
        return;
      }

      if (btn.classList.contains('dv-value')) {
        adjustHpValue('dv', -1);
      }

      if (btn.dataset.traitRowid) {
        triggerTraitRollFromSheet(btn.dataset.traitRowid, btn.dataset.traitRollattr || '');
        return;
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
    if (e.target.closest('.tm-popup')) return;

    const toggle = e.target.closest('.toggle');
    if (!toggle || !root.contains(toggle)) return;

    open(toggle.dataset.sec, toggle);
  });

  root.addEventListener('change', (e) => {
    const spellMemInput = e.target.closest('input[type="checkbox"][data-spell-mem-rowid]');
    if (spellMemInput && root.contains(spellMemInput)) {
      setSpellMemorized(
        spellMemInput.dataset.spellMemRowid,
        spellMemInput.dataset.spellMemAttr || '',
        spellMemInput.checked
      );
      if (currentSection === 'spells' && currentPopup) {
        currentPopup.innerHTML = buildSpellsContent();
      }
      return;
    }

    const equipInput = e.target.closest('input[type="checkbox"][data-equip-attr]');
    if (equipInput && root.contains(equipInput)) {
      const char = getSelectedChar();
      if (char) {
        setCharAttrValue(char, equipInput.dataset.equipAttr, equipInput.checked ? '1' : '0');
      }
      return;
    }

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

  root.addEventListener('keydown', (e) => {
    const input = e.target.closest('input[data-currency-attr]');
    if (!input || !root.contains(input)) return;
    if (e.key !== 'Enter') return;
    e.preventDefault();
    commitCurrencyInput(input);
    input.blur();
  });

  root.addEventListener('focusout', (e) => {
    const input = e.target.closest('input[data-currency-attr]');
    if (!input || !root.contains(input)) return;
    commitCurrencyInput(input);
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

  prefetchAvailableCharacterAttributes();
  prefetchCharacterAttributes(getSelectedChar(), () => {
    refreshHudForCurrentCharacter(false);
  });
  updateCharacterSwitchButton();
  renderHpState();
  syncGlobalMasterFlags();
  recomputeGlobalModifierDerivedAttrs();
  setRollMode(detectRollMode(), false);
  setTimeout(syncRollModeFromSheet, 1000);
  setInterval(() => {
    prefetchAvailableCharacterAttributes();
    updateCharacterSwitchButton();
    renderHpState();
    syncGlobalMasterFlags();
    recomputeGlobalModifierDerivedAttrs();
  }, 2000);
})();
