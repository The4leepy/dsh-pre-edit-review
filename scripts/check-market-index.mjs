#!/usr/bin/env node
/**
 * Validate a DSH plugin-market index (format 1) against the rules the Host
 * validator enforces for the fields this repository uses.
 *
 * Usage: node scripts/check-market-index.mjs [market/index.json]
 */
import { readFileSync } from 'node:fs'

const file = process.argv[2] ?? 'market/index.json'
const errors = []

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
// DSH validates with the semver package; this is a permissive shape check so
// prerelease ranges such as ">=0.2.1-rc.5 <0.3.0" pass.
const RANGE = /^[0-9A-Za-z.+<>=~^*\s|-]+$/
const COMMIT = /^[0-9a-f]{40}$/
const LANGUAGE_ID = /^[a-z]{2,3}(?:-[a-z0-9]+)*$/

function fail(path, message) {
  errors.push(`${path}: ${message}`)
}

function localized(value, path, required) {
  if (value === undefined) {
    if (required) fail(path, 'is required')
    return
  }
  if (typeof value === 'string') {
    if (!isNonEmptyString(value)) fail(path, 'must be a non-empty string')
    return
  }
  if (!isObject(value)) {
    fail(path, 'must be a string or a language map')
    return
  }
  let hasEn = false
  for (const [language, text] of Object.entries(value)) {
    if (!LANGUAGE_ID.test(language)) fail(`${path}.${language}`, 'must be a lowercase language id')
    if (!isNonEmptyString(text)) fail(`${path}.${language}`, 'must be a non-empty string')
    if (language === 'en') hasEn = true
  }
  if (required && !hasEn) fail(path, 'must contain "en"')
}

function httpUrl(value, path, allowFragment = false) {
  if (!isNonEmptyString(value)) {
    fail(path, 'must be a non-empty URL string')
    return
  }
  let url
  try {
    url = new URL(value)
  } catch {
    fail(path, 'must be an absolute URL')
    return
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail(path, 'must use https: or http:')
  if (url.username !== '' || url.password !== '') fail(path, 'must not contain credentials')
  if (!allowFragment && (url.search !== '' || url.hash !== '')) fail(path, 'must not contain a query or fragment')
}

const index = JSON.parse(readFileSync(file, 'utf8'))
if (!isObject(index)) {
  console.error('index must be a JSON object')
  process.exit(1)
}
if (index.format !== 1) fail('$.format', 'must be 1')
localized(index.title, '$.title', true)
localized(index.description, '$.description', false)

const categories = isObject(index.metadata?.categories) ? Object.keys(index.metadata.categories) : []
const labels = isObject(index.metadata?.labels) ? Object.keys(index.metadata.labels) : []

if (!Array.isArray(index.plugins) || index.plugins.length === 0) {
  fail('$.plugins', 'must be a non-empty array')
}

const names = new Set()
for (const [i, plugin] of (index.plugins ?? []).entries()) {
  const at = `$.plugins[${i}]`
  if (!isObject(plugin)) {
    fail(at, 'must be an object')
    continue
  }
  if (!isNonEmptyString(plugin.name)) fail(`${at}.name`, 'must be a non-empty string')
  else if (names.has(plugin.name)) fail(`${at}.name`, `duplicates ${plugin.name}`)
  else names.add(plugin.name)

  localized(plugin.title, `${at}.title`, true)
  localized(plugin.description, `${at}.description`, false)
  if (plugin.author !== undefined && !isNonEmptyString(plugin.author)) fail(`${at}.author`, 'must be a non-empty string')
  if (plugin.homepage !== undefined) httpUrl(plugin.homepage, `${at}.homepage`, true)
  if (plugin.repository !== undefined) {
    if (!isObject(plugin.repository)) fail(`${at}.repository`, 'must be an object')
    else httpUrl(plugin.repository.url, `${at}.repository.url`)
  }
  if (plugin.icon !== undefined) {
    if (typeof plugin.icon !== 'string') fail(`${at}.icon`, 'must be a URL or data URL string')
    else if (!plugin.icon.startsWith('data:image/')) httpUrl(plugin.icon, `${at}.icon`)
  }
  const meta = plugin.metadata
  if (meta !== undefined) {
    if (!isObject(meta)) fail(`${at}.metadata`, 'must be an object')
    else {
      if (meta.category !== undefined && !categories.includes(meta.category)) {
        fail(`${at}.metadata.category`, `references undeclared category ${JSON.stringify(meta.category)}`)
      }
      if (meta.labels !== undefined) {
        if (!Array.isArray(meta.labels)) fail(`${at}.metadata.labels`, 'must be an array')
        else
          for (const label of meta.labels) {
            if (!labels.includes(label)) fail(`${at}.metadata.labels`, `references undeclared label ${JSON.stringify(label)}`)
          }
      }
      if (meta.keywords !== undefined && !Array.isArray(meta.keywords)) fail(`${at}.metadata.keywords`, 'must be an array')
    }
  }

  if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) {
    fail(`${at}.versions`, 'must be a non-empty array')
    continue
  }
  for (const [j, version] of plugin.versions.entries()) {
    const vat = `${at}.versions[${j}]`
    if (!isObject(version)) {
      fail(vat, 'must be an object')
      continue
    }
    if (!isNonEmptyString(version.version) || !SEMVER.test(version.version)) fail(`${vat}.version`, 'must be exact semver')
    if (!Number.isInteger(version.publishTimestamp) || version.publishTimestamp <= 0) {
      fail(`${vat}.publishTimestamp`, 'must be a positive Unix timestamp in seconds')
    }
    const source = version.source
    if (!isObject(source)) fail(`${vat}.source`, 'must be an object')
    else if (source.type === 'npm') {
      /* registry optional */
    } else if (source.type === 'git') {
      httpUrl(source.url, `${vat}.source.url`)
      if (typeof source.commit !== 'string' || !COMMIT.test(source.commit)) {
        fail(`${vat}.source.commit`, 'must be a lowercase 40-hex commit SHA')
      }
    } else {
      fail(`${vat}.source.type`, 'must be "npm" or "git"')
    }
    if (version.engines !== undefined) {
      if (!isObject(version.engines)) fail(`${vat}.engines`, 'must be an object')
      else if (version.engines.dsh !== undefined && !RANGE.test(version.engines.dsh)) {
        fail(`${vat}.engines.dsh`, 'must be a semver range')
      }
    }
  }
}

if (errors.length > 0) {
  console.error(`market index INVALID (${file})`)
  for (const message of errors) console.error(`  - ${message}`)
  process.exit(1)
}
console.log(`market index OK: ${file} (${index.plugins.length} plugin(s))`)
