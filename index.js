import { freshProfile, normalize, ruleFrom, clone, clamp, replay, pregnancyAt, ageAt, summary, FACTORS } from './engine.js';
import { sources, requestJSON, validateCandidates } from './integration.js';
import { cardCandidates, generateTraits } from './core.js';
import { view } from './views.js';

const KEY = 'quietHealthJournal', PROMPT = 'quiet_health_journal', CLOCK = 'quiet_health_clock';
const demo = !globalThis.SillyTavern && new URLSearchParams(location.search).has('demo');
let demoData = {}; try { if (demo) demoData = JSON.parse(localStorage.getItem('qh-demo-v2') || '{}'); } catch {}
function persistDemo() { localStorage.setItem('qh-demo-v2', JSON.stringify(demoData)); }
const demoCtx = { extensionSettings: demoData.settings ||= {}, chatMetadata: demoData.metadata ||= {}, chat: demoData.chat ||= [], chatId: 'demo', characterId: 0, name1: 'Ваша персона', characters: [{ name: 'Алекс', avatar: 'alex.png', data: { description: 'Алексу 28 лет. У него мигрень, особенно после недосыпа.', personality: 'Спокойный, любит ботанику.', character_book: { entries: [{ name: 'Аллергии Алекса', content: 'Алекс реагирует на пыльцу берёзы: слезятся глаза и появляется насморк.' }] } } }], getWorldInfoNames: () => ['Демонстрационный лорбук'], loadWorldInfo: async () => ({ entries: { 1: { comment: 'Заметки о персонаже', content: 'После недосыпа у Алекса иногда болит голова.' } } }), extensionPrompts: {}, setExtensionPrompt(key, value) { this.extensionPrompts[key] = { value }; }, saveSettingsDebounced: persistDemo, saveMetadataDebounced: persistDemo, saveChat: persistDemo };
const ctx = () => demo ? demoCtx : globalThis.SillyTavern?.getContext();
let scriptModule, settings, record, world, panel, launch, target = '', tab = 'dossier', zone = 'chest', back = false, busy = false, notice = '', sourceList = [], chosenSources = new Set(), proposals = [], candidatesOwner = '', bookChoice = '', editor = null, saveTimer;
const uid = () => crypto.randomUUID();
function people() {
    const c = ctx(), group = c.groups?.find(g => String(g.id) === String(c.groupId));
    const chars = group ? (c.characters || []).filter(ch => group.members?.includes(ch.avatar)) : c.characters?.[c.characterId] ? [c.characters[c.characterId]] : [];
    return [...chars.map(ch => ({ key: `char:${ch.avatar || ch.name}`, name: ch.name, card: ch })), { key: `user:${scriptModule?.user_avatar || c.name1 || 'User'}`, name: c.name1 || 'Вы', user: true }, ...(c.chatMetadata?.[KEY]?.customPeople || []).map(p => ({ ...p, custom: true }))];
}
const person = () => people().find(p => p.key === target);
const current = () => world?.profiles[target];
const names = () => Object.fromEntries(people().map(p => [p.key, p.name]));
function messages() { return (ctx().chat || []).map((m, i) => ({ id: m.extra?.quietHealthId || `old-${i}`, text: m.mes || '', user: !!m.is_user, skip: record?.baselineIds?.includes(m.extra?.quietHealthId) || !!m.is_system })); }
function saveChatLater() {
    clearTimeout(saveTimer); const c = ctx(), id = c.chatId;
    saveTimer = setTimeout(() => { if (ctx().chatId !== id) return; Promise.resolve(c.saveChat?.()).catch(e => notify(`Не удалось сохранить чат: ${e.message}`)); }, 600);
}
function assignIds() {
    let changed = false;
    for (const m of ctx().chat || []) { m.extra ||= {}; if (!m.extra.quietHealthId) { m.extra.quietHealthId = uid(); changed = true; } }
    if (changed) saveChatLater();
}
function loadStory() {
    const c = ctx(); if (!c?.chatMetadata) return false;
    assignIds(); record = c.chatMetadata[KEY];
    if (!record || record.version !== 2) record = c.chatMetadata[KEY] = { version: 2, seed: uid(), startDay: 0, base: {}, manual: [], baselineIds: (c.chat || []).map(m => m.extra.quietHealthId), options: { autoTime: false, autoEvents: false, ordinary: true, chronic: true, dangerous: false, fatal: false, intensity: 1 } };
    for (const p of people()) if (!Object.hasOwn(record.base, p.key)) {
        const legacy = settings.profiles?.[p.key] || (p.user && settings.profiles?.[`user:${c.name1}`]);
        record.base[p.key] = normalize(legacy || freshProfile());
        if (demo && !legacy && !p.user) { record.base[p.key].age = '28'; record.base[p.key].conditions = 'Мигрень после недосыпа.'; record.base[p.key].allergies = 'Пыльца берёзы'; record.base[p.key].rules = [ruleFrom('migraine', 'demo-migraine')]; }
    }
    if (!people().some(p => p.key === target)) target = people()[0]?.key || '';
    recalc(); return true;
}
function recalc() { world = replay(record, messages(), record.options); syncPrompt(); }
function save() { ctx().saveSettingsDebounced?.(); ctx().saveMetadataDebounced?.(); saveChatLater(); }
function addOperation(event, label = 'Ручная правка', merge = '') {
    const anchor = messages().at(-1)?.id || 'start', last = record.manual.at(-1);
    if (merge && last?.merge === merge && last.anchor === anchor && !last.disabled) last.event = clone(event);
    else record.manual.push({ id: uid(), anchor, event: clone(event), label, merge, disabled: false });
    recalc(); save();
}
function patch(value, label, merge = '') { addOperation({ type: 'patch', who: target, value }, label, merge); }
function syncPrompt() {
    if (!world) return;
    const visible = { ...world, profiles: Object.fromEntries(people().map(p => [p.key, world.profiles[p.key]]).filter(([, p]) => p)) };
    ctx().setExtensionPrompt?.(PROMPT, settings.enabled ? summary(visible, names(), settings.limit) : '', 1, 1, false, 0);
    const instruction = record.options.autoTime ? `Health journal: current absolute story day=${world.day.toFixed(3)}. At the END of your normal reply add one HTML comment <!--QH:{"day":${world.day.toFixed(3)},"events":[]}-->. day is absolute, may be fractional (1 hour=1/24 day), never add a user timeskip twice. Advance only if story time passes. Character keys: ${JSON.stringify(names())}. ${record.options.autoEvents ? 'Only explicit NEW events, not guesses/plans/negations/memories/repetitions: {"type":"injury","who":"key","zone":"head|chest|abdomen|back|buttocks|leftArm|rightArm|leftLeg|rightLeg","text":"short Russian description","severity":"mild|medium|severe","duration":5}; {"type":"factor","who":"key","factor":"stress|sleepLoss|exertion|allergen|infection|rest","days":1}; {"type":"exposure","who":"key","unprotected":true,"conceptionPossible":true} only for explicitly established conception-capable unprotected intercourse between adults. No diagnoses, pregnancies or random disease events in this marker.' : 'Keep events empty.'}` : '';
    ctx().setExtensionPrompt?.(CLOCK, instruction, 1, 0, false, 0);
}
function render() {
    if (!panel || !world) return;
    const scroll = panel.querySelector('.qh-content')?.scrollTop || 0;
    panel.dataset.theme = settings.theme; panel.dataset.density = settings.density;
    panel.style.setProperty('--qh-size', `${clamp(settings.fontSize, 13, 20, 14)}px`);
    if (/^#[a-f\d]{6}$/i.test(settings.accent || '')) panel.style.setProperty('--qh-accent', settings.accent); else panel.style.removeProperty('--qh-accent');
    panel.innerHTML = view({ p: current(), world, people: people(), target, tab, zone, back, notice, editor, ctx: ctx(), settings, record, sourceList, chosenSources, proposals, busy, bookChoice, names: names(), messages: messages() });
    panel.querySelector('.qh-content').scrollTop = scroll;
    if (busy) panel.querySelectorAll('[data-action="ai-scan"],[data-action="ai-genetics"],[data-action="sources"]').forEach(el => el.disabled = true);
}
function notify(text) { notice = text; const el = panel?.querySelector('.qh-status'); if (el) el.textContent = text; }
async function ai(generated) {
    if (busy) return;
    const owner = target, story = record, selected = sourceList.filter((_, i) => chosenSources.has(i));
    if (!selected.length && !generated) throw new Error('Загрузите и выберите источники.');
    const size = selected.reduce((n, s) => n + s.text.length, 0);
    if (size > settings.sourceLimit) throw new Error(`Выбрано ${size} символов. Снимите часть источников или увеличьте бюджет.`);
    busy = true; notify('Запрос через выбранный профиль…'); render();
    try {
        const instruction = generated ? `Создай 2–4 мягкие игровые предрасположенности персонажа, совместимые с фактами. Не выдавай их за диагнозы или научный генетический расчёт. ${record.options.dangerous || record.options.fatal ? 'Тяжёлые варианты допускаются только в рамках разрешённых категорий.' : 'Исключи инсульт, смертельные и тяжёлые болезни.'}` : 'Извлеки явно указанные факты здоровья выбранного персонажа. Не приписывай ему сведения других лиц, отрицания или гипотезы. Если фактов нет, верни пустой список. Сохраняй ссылки на id источника.';
        const data = await requestJSON(ctx(), settings.connection, instruction + ' Формат {"items":[{"field":"conditions|allergies|traits|notes","text":"русский текст","source":"id источника","rule":"migraine|asthma|allergy|cold|stroke|serious или пустая строка"}]}. rule — необязательное предложение игрового правила.', { character: person()?.name, profile: current(), sources: selected, allowDangerous: !!record.options.dangerous, allowFatal: !!record.options.fatal });
        settings.requests = (settings.requests || 0) + 1;
        if (target !== owner || record !== story) { notify('Досье изменилось во время запроса. Ответ не применён.'); return; }
        proposals = validateCandidates(data, selected, generated); candidatesOwner = owner;
        notify(proposals.length ? 'Результаты готовы. Проверьте и добавьте нужное.' : 'Подтверждённых сведений не найдено.'); save();
    } finally { busy = false; render(); }
}
async function click(e) {
    const el = e.target.closest('button,[data-zone]'); if (!el) return;
    try {
        if (el.dataset.tab) { tab = el.dataset.tab; editor = null; render(); panel.querySelector('.qh-content').scrollTop = 0; return; }
        if (el.dataset.person) { target = el.dataset.person; sourceList = []; proposals = []; editor = null; notice = ''; render(); return; }
        if (el.dataset.zone) { zone = el.dataset.zone; render(); return; }
        if (el.dataset.theme) { settings.theme = el.dataset.theme; settings.accent = ''; save(); render(); return; }
        const p = current(); if (!p) return;
        if (el.dataset.heal) { const list = clone(p.injuries), i = list.find(x => x.id === el.dataset.heal); i.healed = !i.healed; if (!i.healed) i.start = world.day; patch({ injuries: list }, 'Изменено заживление'); }
        if (el.dataset.removeInjury) patch({ injuries: p.injuries.filter(i => i.id !== el.dataset.removeInjury) }, 'Удалено повреждение');
        if (el.dataset.editInjury) editor = { kind: 'injury', value: clone(p.injuries.find(i => i.id === el.dataset.editInjury)) };
        if (el.dataset.ruleEdit) editor = { kind: 'rule', value: clone(p.rules.find(r => r.id === el.dataset.ruleEdit)) };
        if (el.dataset.ruleDelete) patch({ rules: p.rules.filter(r => r.id !== el.dataset.ruleDelete) }, 'Удалено правило');
        if (el.dataset.ruleToggle) { const rules = clone(p.rules), r = rules.find(r => r.id === el.dataset.ruleToggle); r.active = !r.active; if (r.active) { r.onset = world.day; r.until = r.duration === null ? null : world.day + r.duration; } else { r.recovered = world.day; r.hazard = 0; r.episode++; } patch({ rules }, `Ручной эпизод: ${r.name}`); }
        if (el.dataset.factor) addOperation({ type: 'factor', who: target, factor: el.dataset.factor, days: clamp(panel.querySelector('#qh-factor-days').value, .05, 30, 1) }, FACTORS[el.dataset.factor]);
        if (el.dataset.op) { const op = record.manual.find(o => o.id === el.dataset.op); op.disabled = !op.disabled; recalc(); save(); }
        if (el.dataset.ignoreMessage) { record.ignoredMessages ||= []; const id = el.dataset.ignoreMessage; record.ignoredMessages = record.ignoredMessages.includes(id) ? record.ignoredMessages.filter(v => v !== id) : [...record.ignoredMessages, id]; recalc(); save(); }
        if (el.dataset.dismiss !== undefined) proposals.splice(Number(el.dataset.dismiss), 1);
        if (el.dataset.accept !== undefined) { if (candidatesOwner !== target) throw new Error('Результат относится к другому досье.'); const item = proposals[Number(el.dataset.accept)]; patch({ [item.field]: `${p[item.field]}\n${item.text}`.trim().slice(0, 4000) }, 'Добавлено из скана / генерации'); proposals.splice(Number(el.dataset.accept), 1); }
        if (el.dataset.acceptRule !== undefined) { const item = proposals[Number(el.dataset.acceptRule)]; if (p.rules.length >= 30) throw new Error('Лимит 30 правил.'); editor = { kind: 'rule', value: ruleFrom(item.rule, uid()), isNew: true }; }
        switch (el.dataset.action) {
            case 'person-add': editor = { kind: 'person', name: '', age: '' }; break;
            case 'person-edit': editor = { kind: 'person', name: person().name, age: ageAt(p, world.day), key: target }; break;
            case 'person-remove': if (person()?.custom && confirm('Убрать вкладку этой RP-персоны? Записи сохранятся в истории, но не будут передаваться в чат.')) { record.customPeople = record.customPeople.filter(x => x.key !== target); target = people()[0].key; editor = null; recalc(); save(); } break;
            case 'close': panel.hidden = true; launch.focus(); return;
            case 'flip': back = !back; break;
            case 'injury': { const text = panel.querySelector('#qh-injury').value.trim(); if (!text) throw new Error('Опишите повреждение.'); if (p.injuries.length >= 60) throw new Error('Лимит 60 повреждений.'); addOperation({ type: 'injury', who: target, id: uid(), zone, text, severity: panel.querySelector('#qh-severity').value }, 'Добавлено повреждение'); break; }
            case 'rule-add': { if (p.rules.length >= 30) throw new Error('Лимит 30 правил.'); const kind = panel.querySelector('#qh-rule-kind').value; editor = { kind: 'rule', value: kind === 'custom' ? { ...ruleFrom('migraine', uid()), kind: 'custom', name: 'Моё заболевание', symptom: '', triggers: [], rate: .01 } : ruleFrom(kind, uid()), isNew: true }; break; }
            case 'editor-cancel': editor = null; break;
            case 'editor-save': saveEditor(); break;
            case 'advance': { const days = clamp(panel.querySelector('[data-draft="advance"]').value, .01, 3650, 1); addOperation({ type: 'time', day: world.day + days }, `Прошло ${days} дней`); break; }
            case 'undo': { const last = record.manual.findLast(o => !o.disabled); if (last) { last.disabled = true; recalc(); save(); } break; }
            case 'pregnancy-manual': { if (!(ageAt(p, world.day) >= 18)) throw new Error('Укажите взрослый возраст персонажа.'); const g = pregnancyAt(p, world.day); editor = { kind: 'pregnancy', weeks: g?.week || 4, days: g?.remainder || 0 }; break; }
            case 'pregnancy-end': if (confirm('Убрать беременность из текущего состояния? Запись можно отменить в журнале.')) patch({ pregnancy: { ...p.pregnancy, active: false, known: false } }, 'Завершена беременность вручную'); break;
            case 'exposure': if (!p.cycle.enabled || !p.pregnancy.enabled || !(ageAt(p, world.day) >= 18)) throw new Error('Включите цикл и игровой шанс; укажите взрослый возраст.'); else if (confirm('Учесть новый незащищённый эпизод с возможностью зачатия? Один эпизод добавляйте только один раз.')) addOperation({ type: 'exposure', who: target, id: uid(), unprotected: true, conceptionPossible: true }, 'Репродуктивный эпизод'); break;
            case 'template': { const base = normalize(p); base.injuries = []; base.factors = {}; base.age = p.age === '' ? '' : String(ageAt(p, world.day)); base.ageDay = 0; base.pregnancy.active = false; base.pregnancy.known = false; base.exposureIds = []; base.cycle.startDay = 0; base.rules.forEach(r => { r.active = false; r.hazard = 0; r.episode = 0; r.recovered = 0; }); settings.profiles[target] = base; save(); notify('Постоянная база сохранена для новых чатов.'); break; }
            case 'sources': { const owner = target, story = record; busy = true; render(); try { const list = await sources(ctx(), person()?.card, bookChoice ? [bookChoice] : []); if (owner === target && story === record) { sourceList = list; chosenSources = new Set(list.map((_, i) => i)); proposals = []; candidatesOwner = owner; notify(`Источников: ${list.length}. Исключите записи о других персонажах.`); } } finally { busy = false; } break; }
            case 'ai-scan': await ai(false); return;
            case 'ai-genetics': await ai(true); return;
            case 'local-scan': proposals = sourceList.filter((_, i) => chosenSources.has(i)).flatMap(s => cardCandidates({ description: s.text }).map(text => ({ text, field: 'notes', source: s.label }))); candidatesOwner = target; notify(`Найдено ${proposals.length} фрагментов. Локальный поиск не понимает отрицания.`); break;
            case 'local-genetics': proposals = generateTraits().split('\n').map(text => ({ text, field: 'traits', source: 'Случайная мягкая черта · вымысел' })); candidatesOwner = target; break;
            case 'reset-look': settings.theme = 'botanical'; settings.accent = ''; settings.fontSize = 14; settings.density = 'airy'; settings.position = null; positionLaunch(); save(); break;
            case 'export': { const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 2, name: person()?.name, day: world.day, profile: p }, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'health-profile.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); break; }
            case 'import': panel.querySelector('#qh-file').click(); return;
        }
        render();
    } catch (error) { busy = false; notify(error.message); render(); }
}
function saveEditor() {
    const p = current(), value = id => panel.querySelector(id).value;
    if (editor.kind === 'person') {
        const name = value('#qh-new-name').trim().slice(0, 80), age = value('#qh-new-age');
        if (!name) throw new Error('Укажите имя.');
        record.customPeople ||= [];
        if (editor.key) { record.customPeople.find(x => x.key === editor.key).name = name; patch({ age, ageDay: world.day }, 'Изменена RP-персона'); }
        else { if (record.customPeople.length >= 30) throw new Error('Можно добавить до 30 RP-персон.'); const key = `rp:${uid()}`; record.customPeople.push({ key, name }); record.base[key] = normalize({ age, ageDay: world.day }); target = key; recalc(); save(); }
        editor = null; return;
    }
    if (editor.kind === 'pregnancy') { const days = clamp(value('#qh-weeks'), 0, 49) * 7 + clamp(value('#qh-extra-days'), 0, 6); patch({ pregnancy: { ...p.pregnancy, active: true, gestationDays: days, atDay: world.day } }, 'Беременность указана вручную'); }
    else {
        const r = clone(editor.value), duration = value('#qe-duration'); r.duration = duration === '' ? null : clamp(duration, .05, 3650, 7);
        if (editor.kind === 'injury') { r.text = value('#qe-name').slice(0, 500); r.zone = value('#qe-zone'); patch({ injuries: p.injuries.map(i => i.id === r.id ? r : i) }, 'Исправлено повреждение'); }
        else { r.name = value('#qe-name').slice(0, 120); r.symptom = value('#qe-symptom').slice(0, 500); r.category = value('#qe-category'); r.rate = clamp(value('#qe-rate'), 0, 1, .01); r.enabled = panel.querySelector('#qe-enabled').checked; r.triggers = [...panel.querySelectorAll('[data-trigger]:checked')].map(el => el.dataset.trigger); if (r.active) r.until = r.duration === null ? null : r.onset + r.duration; patch({ rules: editor.isNew ? [...p.rules, r] : p.rules.map(i => i.id === r.id ? r : i) }, 'Настроено правило заболевания'); }
    }
    editor = null;
}
function editField(el) {
    const path = el.dataset.field, p = current(); if (!path || !p) return;
    const value = el.type === 'checkbox' ? el.checked : el.type === 'number' && el.value !== '' ? Number(el.value) : el.value;
    const [top, child] = path.split('.'), partial = child ? { [top]: { ...p[top], [child]: value } } : { [top]: value };
    if (top === 'age') partial.ageDay = world.day;
    patch(partial, `Правка: ${path}`, `field:${target}:${path}`);
}
async function change(e) {
    const el = e.target;
    try {
        if (el.id === 'qh-person') { target = el.value; sourceList = []; proposals = []; editor = null; notice = ''; }
        else if (el.id === 'qh-zone') zone = el.value;
        else if (el.id === 'qh-book') { bookChoice = el.value; return; }
        else if (el.dataset.source !== undefined) { const i = Number(el.dataset.source); if (el.checked) chosenSources.add(i); else chosenSources.delete(i); return; }
        else if (el.dataset.proposalField !== undefined) { proposals[Number(el.dataset.proposalField)].field = el.value; return; }
        else if (el.dataset.field) { editField(el); if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type !== 'checkbox')) { notify('Сохранено'); return; } }
        else if (el.dataset.setting) { settings[el.dataset.setting] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value; settings.limit = clamp(settings.limit, 300, 6000, 1400); settings.sourceLimit = clamp(settings.sourceLimit, 1000, 30000, 12000); save(); syncPrompt(); }
        else if (el.dataset.option) { record.options[el.dataset.option] = el.type === 'checkbox' ? el.checked : clamp(el.value, .1, 3, 1); if (el.dataset.option === 'autoEvents' && el.checked) record.options.autoTime = true; recalc(); save(); }
        else if (el.id === 'qh-file') {
            const file = el.files[0], owner = target, story = record; if (!file) return;
            if (file.size > 200000) throw new Error('Лимит файла 200 КБ.');
            const data = JSON.parse(await file.text()); if (![1, 2].includes(data.version) || !data.profile) throw new Error('Нужен экспорт досье версии 1 или 2.');
            if (owner !== target || story !== record) throw new Error('Досье изменилось во время чтения файла.');
            if (!confirm(`Заменить состояние «${person()?.name}»? Отменить можно в журнале.`)) return;
            const p = normalize(data.profile), delta = world.day - (Number(data.day) || 0);
            p.ageDay += delta; p.cycle.startDay += delta; p.pregnancy.atDay += delta; p.injuries.forEach(i => i.start += delta); p.rules.forEach(r => { r.onset += delta; if (r.until !== null) r.until += delta; r.recovered += delta; }); for (const k of Object.keys(p.factors)) p.factors[k] += delta;
            patch(p, 'Импортировано досье'); notify('Импортировано.');
        } else return;
        render();
    } catch (error) { notify(error.message); }
}
function positionLaunch() {
    const pos = settings.position || { x: innerWidth - 72, y: innerHeight - 88 };
    launch.style.left = `${clamp(pos.x, 8, Math.max(8, innerWidth - 56))}px`; launch.style.top = `${clamp(pos.y, 8, Math.max(8, innerHeight - 56))}px`;
}
function setupDrag() {
    let start, moved = false;
    launch.addEventListener('pointerdown', e => { if (e.button !== 0) return; const r = launch.getBoundingClientRect(); start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top }; moved = false; launch.setPointerCapture(e.pointerId); });
    launch.addEventListener('pointermove', e => { if (!start) return; const dx = e.clientX - start.x, dy = e.clientY - start.y; if (Math.hypot(dx, dy) > 6) moved = true; if (moved) { settings.position = { x: start.left + dx, y: start.top + dy }; positionLaunch(); } });
    launch.addEventListener('pointerup', () => { if (moved) save(); start = null; });
    launch.addEventListener('pointercancel', () => { start = null; moved = true; });
    launch.addEventListener('click', () => { if (moved) { moved = false; return; } loadStory(); panel.hidden = false; render(); panel.querySelector('.qh-close').focus(); });
    launch.addEventListener('keydown', e => { if (e.altKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); const r = launch.getBoundingClientRect(); settings.position = { x: r.left + (e.key === 'ArrowRight' ? 20 : e.key === 'ArrowLeft' ? -20 : 0), y: r.top + (e.key === 'ArrowDown' ? 20 : e.key === 'ArrowUp' ? -20 : 0) }; positionLaunch(); save(); } });
    addEventListener('resize', positionLaunch);
}
async function init() {
    if (!ctx()?.extensionSettings || document.getElementById('qh-panel')) return;
    if (!demo) { try { scriptModule = await import('../../../../script.js'); } catch { /* Fallback to persona name on older versions. */ } }
    settings = ctx().extensionSettings[KEY] ||= {};
    for (const [k, v] of Object.entries({ profiles: {}, theme: 'botanical', accent: '', fontSize: 14, density: 'airy', connection: '', enabled: false, limit: 1400, sourceLimit: 12000, position: null })) if (settings[k] === undefined) settings[k] = v;
    if (!loadStory()) return;
    panel = document.createElement('section'); panel.id = 'qh-panel'; panel.hidden = true; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Досье здоровья'); document.body.append(panel);
    panel.addEventListener('click', click); panel.addEventListener('change', change);
    panel.addEventListener('input', e => { if (e.target.dataset.proposal !== undefined) proposals[Number(e.target.dataset.proposal)].text = e.target.value; if (e.target.dataset.field && e.target.tagName === 'TEXTAREA') editField(e.target); });
    panel.addEventListener('keydown', e => { if (e.key === 'Escape') { panel.hidden = true; launch.focus(); } if (e.target.dataset.zone && ['Enter', ' '].includes(e.key)) { e.preventDefault(); zone = e.target.dataset.zone; render(); panel.querySelector(`[data-zone="${zone}"]`)?.focus(); } });
    launch = document.createElement('button'); launch.id = 'qh-launch'; launch.title = 'Досье здоровья · перемещение мышью, пальцем или Alt + стрелки'; launch.setAttribute('aria-label', 'Открыть досье здоровья'); launch.innerHTML = '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M20 33C15 29 5 22 5 14C5 5 16 4 20 11C24 4 35 5 35 14C35 22 25 29 20 33Z" fill="currentColor"/><g transform="rotate(-35 20 20)"><rect x="9" y="15" width="23" height="10" rx="3" fill="#f3ead7" stroke="#43554a"/><path d="M17 16v8m7-8v8" stroke="#788576"/><circle cx="13" cy="20" r="1" fill="#788576"/><circle cx="28" cy="20" r="1" fill="#788576"/></g></svg>'; document.body.append(launch); positionLaunch(); setupDrag();
    const c = ctx(), events = c.eventTypes || c.event_types || {};
    for (const name of ['CHAT_CHANGED', 'CHARACTER_EDITED', 'USER_NAME_CHANGED', 'PERSONA_CHANGED']) if (events[name]) c.eventSource?.on(events[name], () => { sourceList = []; proposals = []; editor = null; notice = ''; loadStory(); if (!panel.hidden) render(); });
    for (const name of ['CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED']) if (events[name]) c.eventSource?.on(events[name], () => { loadStory(); save(); if (!panel.hidden) render(); });
    if (events.GENERATION_AFTER_COMMANDS) c.eventSource?.on(events.GENERATION_AFTER_COMMANDS, () => loadStory());
    save(); if (demo) { panel.hidden = false; render(); }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
