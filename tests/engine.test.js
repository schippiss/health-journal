import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshProfile, normalize, ruleFrom, clone, advance, applyEvent, replay, cycleAt, pregnancyAt, summary, parseMarker, userSkip } from '../engine.js';
import { requestJSON, sources, validateCandidates } from '../integration.js';
const world = () => ({ day: 0, seed: 'stable-test', profiles: { alex: freshProfile() }, log: [] });
test('time subdivision and zero-time messages do not change chronic outcomes', () => {
    const a = world(); a.profiles.alex.rules = [ruleFrom('migraine', 'm')]; a.profiles.alex.rules[0].rate = .4;
    a.profiles.alex.factors.sleepLoss = 4;
    const b = clone(a); advance(a, 30); for (let n = 1; n <= 120; n++) advance(b, n / 4);
    assert.equal(a.profiles.alex.rules[0].episode, b.profiles.alex.rules[0].episode);
    assert.equal(a.profiles.alex.rules[0].active, b.profiles.alex.rules[0].active);
    assert.ok(Math.abs(a.profiles.alex.rules[0].hazard - b.profiles.alex.rules[0].hazard) < 1e-9);
    const before = clone(b); advance(b, 30); assert.deepEqual(b, before);
});
test('dangerous and fatal rules are disabled unless explicitly enabled', () => {
    const w = world(); w.profiles.alex.rules = [ruleFrom('stroke', 's'), ruleFrom('serious', 'f')]; w.profiles.alex.rules.forEach(r => r.rate = 1);
    advance(w, 100); assert.ok(w.profiles.alex.rules.every(r => !r.active && !r.episode)); advance(w, 110, { dangerous: true, fatal: true }); assert.ok(w.profiles.alex.rules.every(r => r.active));
});
test('long skip may include both an episode and recovery, chronic diagnosis persists', () => {
    const w = world(); const r = ruleFrom('migraine', 'm'); r.active = true; r.onset = 0; r.until = 1; r.enabled = false; w.profiles.alex.rules = [r];
    advance(w, 30); assert.equal(r.active, false); assert.equal(w.log[0].day, 1); assert.equal(w.profiles.alex.rules.length, 1);
});
test('injury persists then heals, severe injuries require manual resolution', () => {
    const w = world(); applyEvent(w, { type: 'injury', who: 'alex', id: 'bite', zone: 'buttocks', text: 'Укус', severity: 'mild' }); applyEvent(w, { type: 'injury', who: 'alex', id: 'cut', zone: 'back', text: 'Глубокий порез', severity: 'severe' });
    advance(w, 3); assert.equal(w.profiles.alex.injuries[0].healed, false); advance(w, 7); assert.equal(w.profiles.alex.injuries[0].healed, true); assert.equal(w.profiles.alex.injuries[1].healed, false);
});
test('pregnancy requires adult enabled profile and qualifying event; onset has no instant symptoms', () => {
    const w = world(), p = w.profiles.alex; p.age = '25'; p.cycle.enabled = true; p.cycle.startDay = -14; p.pregnancy.enabled = true; p.pregnancy.chance = 1;
    const e = { type: 'exposure', who: 'alex', id: 'once', unprotected: true, conceptionPossible: true };
    applyEvent(w, { ...e, unprotected: false }); assert.equal(p.pregnancy.active, false);
    applyEvent(w, e); assert.equal(p.pregnancy.active, true); assert.equal(pregnancyAt(p, 0).symptomsPossible, false);
    assert.equal(summary(w, { alex: 'Алекс' }).includes('Беременность'), false);
    assert.equal(pregnancyAt(p, 20).symptomsPossible, true);
    const before = clone(p); applyEvent(w, e); assert.deepEqual(p, before);
    const young = world(); young.profiles.alex = normalize({ ...p, age: '16', pregnancy: { ...p.pregnancy, active: false }, exposureIds: [] }); applyEvent(young, e); assert.equal(young.profiles.alex.pregnancy.active, false);
});
test('cycle phases are modular and paused during pregnancy', () => {
    const p = freshProfile(); p.cycle.enabled = true; assert.equal(cycleAt(p, 28).day, 1); assert.equal(cycleAt(p, 14).fertile, true); p.pregnancy.active = true; assert.equal(cycleAt(p, 14), null);
});
test('replay deduplicates user skip, supports edits, deletion and manual override', () => {
    const record = { seed: 'x', base: { alex: freshProfile() }, manual: [{ anchor: 'm', event: { type: 'patch', who: 'alex', value: { notes: 'Правка игрока' } } }] };
    const messages = [{ id: 'u', user: true, text: 'прошло 3 дня' }, { id: 'm', text: '<!--QH:{"day":3,"events":[{"type":"injury","who":"alex","zone":"head","text":"Порез"}]}-->' }];
    const a = replay(record, messages, { autoEvents: true }); assert.equal(a.day, 3); assert.equal(a.profiles.alex.injuries.length, 1); assert.deepEqual(a, replay(record, messages, { autoEvents: true })); assert.equal(a.profiles.alex.notes, 'Правка игрока');
    const b = replay(record, messages.slice(0, 1), { autoEvents: true }); assert.equal(b.profiles.alex.injuries.length, 0); assert.equal(b.profiles.alex.notes, ''); assert.equal(b.warnings.length, 1);
    messages[1].text = '<!--QH:{"day":4,"events":[]}-->'; const c = replay(record, messages, { autoEvents: true }); assert.equal(c.day, 4); assert.equal(c.profiles.alex.injuries.length, 0);
});
test('reject malformed markers and ambiguous natural language time', () => {
    assert.equal(parseMarker('<!--QH:{bad}-->'), null); assert.equal(parseMarker('<!--QH:{"day":"3","events":[]}-->'), null); assert.equal(userSkip('Он подумал: прошло 3 дня?'), 0); assert.equal(userSkip('таймскип: 2 недели'), 14);
});
test('manual normalized patches cannot write arbitrary properties', () => {
    const p = normalize(JSON.parse('{"__proto__":{"polluted":true},"age":-5,"rules":[{"kind":"__proto__"}]}')); assert.equal(p.age, '0'); assert.equal(p.rules.length, 0); assert.equal({}.polluted, undefined);
});
test('profile request uses selected id without switching chat and validates JSON', async () => {
    let args; const c = { extensionSettings: { connectionManager: { profiles: [{ id: 'chosen', name: 'AI' }], selectedProfile: 'chat' } }, ConnectionManagerRequestService: { async sendRequest(...a) { args = a; return { content: '{"items":[]}' }; } } };
    assert.deepEqual(await requestJSON(c, 'chosen', 'scan', {}), { items: [] }); assert.equal(args[0], 'chosen'); assert.equal(c.extensionSettings.connectionManager.selectedProfile, 'chat'); assert.equal(args[3].stream, false);
    await assert.rejects(requestJSON(c, 'missing', 'scan', {}));
});
test('sources include selected books and omit disabled entries; source references checked', async () => {
    const s = await sources({ loadWorldInfo: async () => ({ entries: { a: { content: 'Астма', comment: 'История' }, b: { disable: true, content: 'Скрыто' } } }) }, { data: { description: 'Мигрень', extensions: { world: 'Книга' } } }); assert.equal(s.length, 2);
    const items = validateCandidates({ items: [{ field: 'conditions', text: 'Астма', source: 'invented' }] }, s); assert.match(items[0].source, /не подтверждён/);
});
