import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshProfile, normalizeProfile, cardCandidates, scanText, generateTraits, buildPrompt } from '../core.js';
test('карточка V2: извлекает сведения, не импортирует весь текст', () => {
    assert.deepEqual(cardCandidates({ data: { description: 'Любит музыку. Аллергия на кошек. Носит пальто.' } }), ['Аллергия на кошек.']);
});
test('сканер даёт подсказку, не изменяет профиль', () => {
    const p = freshProfile(); assert.equal(scanText('Он закашлялся и заметил порез.').length, 2); assert.deepEqual(p, freshProfile()); assert.equal(scanText('Сидит у окна.').length, 0);
});
test('экспортированные данные нормализуются и ограничиваются', () => {
    const p = normalizeProfile({ age: -3, sex: 'invalid', conditions: 'x'.repeat(5000), injuries: [{ zone: 'invalid' }, { zone: 'head', text: 'царапина', id: '1', severity: 'wrong' }] });
    assert.equal(p.age, ''); assert.equal(p.sex, 'neutral'); assert.equal(p.conditions.length, 4000); assert.equal(p.injuries.length, 1); assert.equal(p.injuries[0].severity, 'mild');
});
test('сводка исключает зажившие травмы и соблюдает бюджет', () => {
    const p = freshProfile(); p.injuries = [{ zone: 'head', text: 'старый след', healed: true }, { zone: 'leftArm', text: 'свежий порез', healed: false }];
    const prompt = buildPrompt([{ name: 'Алекс', profile: p }]); assert.ok(prompt.includes('свежий порез')); assert.ok(!prompt.includes('старый след'));
    p.conditions = 'x'.repeat(4000); assert.equal(buildPrompt([{ name: 'Алекс', profile: p }], 300).length, 300);
});
test('пустые профили не расходуют контекст; возраст 0 сохраняется', () => {
    assert.equal(buildPrompt([{ name: 'Алекс', profile: freshProfile() }]), ''); assert.equal(normalizeProfile({ age: 0 }).age, '0');
});
test('генерация черт локальная и воспроизводима с заданным RNG', () => {
    assert.equal(generateTraits(() => 0).split('\n').length, 3); assert.match(generateTraits(() => 0), /не подтверждена/);
});
