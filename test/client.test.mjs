import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const CLIENT_PATH = new URL('../lib/client.js', import.meta.url)
const PACKAGE_NAME = '@lizhijie429/dsh-task-notifier'

function makeForm() {
  const state = {
    status: 'ready',
    value: {
      notifyOnStart: false,
      titlePrefix: 'DSH',
      clickUrl: 'dsh://open',
      autoContinue: { enabled: true, message: '继续', maxAttempts: 3, cooldownMs: 5000 },
    },
    user: {},
    revision: 3,
    writable: true,
  }
  return {
    getSnapshot: () => state,
    subscribe: () => () => {},
    mutate: async () => true,
  }
}

function loadClientBundle() {
  let definition
  const localeRegistrations = []
  const slotRegistrations = []
  const form = makeForm()
  const ctx = {
    effect: (callback) => {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    locale: {
      bind: () => (key) => key,
      register: (ns, dictionaries) => {
        localeRegistrations.push({ ns, dictionaries })
        return () => {}
      },
    },
    configForms: { get: () => form },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => {
        slotRegistrations.push({ options, component })
        return () => {}
      },
    },
  }
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (value) => {
          definition = value
        },
      },
    },
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(CLIENT_PATH, 'utf8'), sandbox, { filename: 'client.js' })
  assert.ok(definition, 'the bundle registers a module definition')
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useCallback: (callback) => callback,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }
  const exported = definition.factory((id) => {
    assert.equal(id, 'react')
    return react
  })
  exported.apply(ctx)
  return { definition, exported, localeRegistrations, slotRegistrations }
}

test('client bundle registers the settings section and row config page', () => {
  const { definition, exported, localeRegistrations, slotRegistrations } = loadClientBundle()
  assert.equal(definition.id, PACKAGE_NAME)
  assert.deepEqual([...exported.inject], ['slots', 'locale', 'configForms'])
  assert.equal(localeRegistrations.length, 1)
  assert.equal(localeRegistrations[0].ns, 'task-notifier.settings')
  assert.ok(localeRegistrations[0].dictionaries.zh.nav)
  assert.ok(localeRegistrations[0].dictionaries.en.nav)

  const section = slotRegistrations.find((entry) => entry.options.name === 'settings.section')
  assert.ok(section, 'Settings section is registered')
  assert.equal(section.options.id, 'task-notifier')
  assert.equal(typeof section.options.label, 'function')
  assert.equal(section.options.label(), '任务通知')

  const row = slotRegistrations.find((entry) => entry.options.name === 'plugins.row.config')
  assert.ok(row, 'Plugin-manager row page is registered')
  assert.equal(row.options.key, `${PACKAGE_NAME}#task-notifier`)
})