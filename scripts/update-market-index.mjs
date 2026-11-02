#!/usr/bin/env node
/**
 * Regenerate the plugin market index (format 1) served by GitHub Pages.
 *
 * The index pins one Git commit per version, so run this after committing a
 * plugin change and before publishing the docs/ folder:
 *
 *   npm run market:index
 *   git add docs && git commit -m "chore: refresh market index"
 *
 * The pinned commit must contain the plugin manifest the index describes; it
 * does not have to be the commit that adds this generated file.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DOCS = join(ROOT, 'docs')
const INDEX_URL = 'https://lizhijie429.github.io/dsh-task-notifier/index.json'

function git(...args) {
  return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim()
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const commit = git('rev-parse', 'HEAD')
const publishTimestamp = Number(git('log', '-1', '--format=%ct'))
const status = git('status', '--porcelain')
if (status !== '') {
  console.warn('warning: working tree is dirty; the index pins HEAD and ignores uncommitted files')
}
if (!/^[0-9a-f]{40}$/.test(commit)) {
  throw new Error(`unexpected commit id: ${commit}`)
}
const enginesDsh = manifest.engines?.dsh
if (typeof enginesDsh !== 'string' || enginesDsh.trim() === '') {
  throw new Error('package.json must declare engines.dsh')
}
if (manifest.dsh?.bundle?.patch === undefined) {
  throw new Error('package.json must declare dsh.bundle.patch for market installation')
}

const index = {
  format: 1,
  title: {
    en: 'lizhijie429 DSH plugins',
    zh: 'lizhijie429 的 DSH 插件',
  },
  description: {
    en: 'Bundles published by lizhijie429 for DeepSeek Harness.',
    zh: 'lizhijie429 发布的 DeepSeek Harness 插件。',
  },
  plugins: [
    {
      name: manifest.name,
      title: {
        en: 'DSH Task Notifier',
        zh: 'DSH 任务通知',
      },
      description: {
        en: 'Turns task status into desktop notifications (Windows toasts branded as DSH) and auto-continues after exhausted model-request retries.',
        zh: '任务状态转桌面通知（Windows Toast 使用 DSH 图标与名称）；模型请求重试耗尽时自动发送「继续」。',
      },
      icon: 'icons/task-notifier.png',
      author: 'lizhijie429',
      homepage: manifest.homepage,
      repository: {
        url: 'https://github.com/lizhijie429/dsh-task-notifier',
      },
      metadata: {
        keywords: manifest.keywords ?? [],
      },
      'dist-tags': {
        latest: manifest.version,
      },
      versions: [
        {
          version: manifest.version,
          publishTimestamp,
          source: {
            type: 'git',
            url: 'https://github.com/lizhijie429/dsh-task-notifier',
            commit,
          },
          engines: {
            dsh: enginesDsh,
          },
        },
      ],
    },
  ],
}

mkdirSync(join(DOCS, 'icons'), { recursive: true })
copyFileSync(join(ROOT, 'assets', 'icon.png'), join(DOCS, 'icons', 'task-notifier.png'))
writeFileSync(join(DOCS, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
writeFileSync(join(DOCS, '.nojekyll'), '', 'utf8')

console.log(`wrote docs/index.json (${manifest.name}@${manifest.version} -> ${commit})`)
console.log(`serve it over https and subscribe to ${INDEX_URL}`)
