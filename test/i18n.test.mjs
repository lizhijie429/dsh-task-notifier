import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveLocale, messagesFor, LOCALES } from '../lib/i18n.mjs'

test('explicit locales win over the environment', () => {
  assert.equal(resolveLocale('zh', { LANG: 'en_US.UTF-8' }), 'zh')
  assert.equal(resolveLocale('en', { LANG: 'zh_CN.UTF-8' }), 'en')
  assert.deepEqual([...LOCALES], ['auto', 'zh', 'en'])
})

test('auto follows the host language variables', () => {
  assert.equal(resolveLocale('auto', { LANG: 'zh_CN.UTF-8' }), 'zh')
  assert.equal(resolveLocale('auto', { LANG: 'zh-TW' }), 'zh')
  assert.equal(resolveLocale('auto', { LANG: 'ja_JP.UTF-8' }), 'en')
  assert.equal(resolveLocale('auto', { LC_ALL: 'en_GB.UTF-8' }), 'en')
  assert.equal(resolveLocale('auto', { DSH_LOCALE: 'zh' }), 'zh')
})

test('unknown or missing configuration falls back to Chinese', () => {
  assert.equal(resolveLocale(undefined, {}), 'zh')
  assert.equal(resolveLocale('fr', { LANG: 'en_US.UTF-8' }), 'zh')
  assert.equal(messagesFor('fr').session, '会话')
  assert.equal(messagesFor('en').session, 'Session')
  assert.equal(messagesFor('zh').session, '会话')
})