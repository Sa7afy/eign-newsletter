import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  assertInsightsAreClean,
  buildCrunchbaseInsights,
} from './lib/crunchbase-insights'

const DEFAULT_URL =
  'https://www.crunchbase.com/organization/axiom-biosciences'
const WAIT_PREFIX = '__CRUNCHBASE_WAIT__:'
const ERROR_PREFIX = '__CRUNCHBASE_ERROR__:'

type CliOptions = {
  failedPath: string
  help: boolean
  inputPath?: string
  keepOpen: boolean
  limit?: number
  manifestPath: string
  maxAttempts: number
  outputPath?: string
  outputDir: string
  rateLimitDelayMs: number
  requestedUrl: string
  requestDelayMs: number
  retryDelayMs: number
  start: number
  timeoutMs: number
}

type ScrapeOptions = {
  keepOpen: boolean
  outputPath: string
  slug: string
  timeoutMs: number
  url: string
}

type ManifestStatus = 'failed' | 'in_progress' | 'pending' | 'success'

type ManifestEntry = {
  attempts: number
  canonicalSlug?: string
  completedAt?: string
  error?: string
  failedAt?: string
  index: number
  insightsPath?: string
  lastAttemptAt?: string
  outputPath?: string
  recoveredAt?: string
  requestedSlug: string
  requestedUrl: string
  status: ManifestStatus
}

type ScrapeManifest = {
  createdAt: string
  entries: ManifestEntry[]
  inputPath: string
  totalLinks: number
  updatedAt: string
  version: 1
}

type FailedScrapes = {
  entries: Array<{
    attempts: number
    error: string
    failedAt: string
    index: number
    lastAttemptAt?: string
    requestedSlug: string
    requestedUrl: string
  }>
  generatedAt: string
  total: number
  version: 1
}

type ScrapeResult = {
  extraction: {
    authenticated: boolean
    method: string
  }
  organization: {
    cards?: Record<string, unknown>
    properties?: {
      identifier?: {
        permalink?: string
        uuid?: string
        value?: string
      }
    }
  }
  pageTitle: string
  scrapedAt: string
  sourceUrl: string
}

function usage() {
  return `Usage:
  pnpm scrape:crunchbase [organization-url] [options]
  pnpm scrape:crunchbase --input <links.json> [batch-options]

Options:
  -o, --output <path>   JSON output path
      --input <path>    Ordered JSON array of Crunchbase organization URLs
      --output-dir <path> Directory for batch raw/insights files (default: outputs/crunchbase)
      --manifest <path> Batch checkpoint path (default: outputs/crunchbase/manifest.json)
      --failed <path>   Retry queue path (default: outputs/crunchbase/failed.json)
      --max-attempts <n> Attempts per company per run (default: 3)
      --rate-limit-delay <ms> Cooldown after Cloudflare 1015 (default: 300000)
      --request-delay <ms> Minimum pause between companies (default: 10000)
      --retry-delay <ms> Delay between attempts (default: 5000)
      --start <number>  First 1-based input index to process (default: 1)
      --limit <number>  Maximum number of input entries to consider
      --keep-open       Deprecated; GUI-free mode never opens a browser tab
      --timeout <ms>    Page timeout in milliseconds (default: 90000)
  -h, --help            Show this help

Examples:
  pnpm scrape:crunchbase
  pnpm scrape:crunchbase https://www.crunchbase.com/organization/axiom-biosciences
  pnpm scrape:crunchbase https://www.crunchbase.com/organization/stripe -o outputs/crunchbase/stripe.json
  pnpm scrape:crunchbase --input "valid links.json" --limit 10

The script uses a GUI-free Chrome-compatible HTTP session authenticated from the
local Brave cookie store. It never opens, navigates, or focuses a browser tab.`
}

function requireValue(args: string[], index: number, flag: string) {
  const value = args[index + 1]
  if (!value || value.startsWith('-')) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

function parseArgs(args: string[]): CliOptions {
  let requestedUrl = DEFAULT_URL
  let outputPath: string | undefined
  let inputPath: string | undefined
  let outputDir = 'outputs/crunchbase'
  let manifestPath = 'outputs/crunchbase/manifest.json'
  let failedPath = 'outputs/crunchbase/failed.json'
  let maxAttempts = 3
  let rateLimitDelayMs = 300_000
  let requestDelayMs = 10_000
  let retryDelayMs = 5_000
  let start = 1
  let limit: number | undefined
  let timeoutMs = 90_000
  let keepOpen = false
  let help = false
  let hasUrlArgument = false

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]

    if (argument === '-h' || argument === '--help') {
      help = true
      continue
    }

    if (argument === '--keep-open') {
      keepOpen = true
      continue
    }

    if (argument === '-o' || argument === '--output') {
      outputPath = requireValue(args, index, argument)
      index += 1
      continue
    }

    if (argument === '--input') {
      inputPath = requireValue(args, index, argument)
      index += 1
      continue
    }

    if (argument === '--output-dir') {
      outputDir = requireValue(args, index, argument)
      index += 1
      continue
    }

    if (argument === '--manifest') {
      manifestPath = requireValue(args, index, argument)
      index += 1
      continue
    }

    if (argument === '--failed') {
      failedPath = requireValue(args, index, argument)
      index += 1
      continue
    }

    if (
      argument === '--start' ||
      argument === '--limit' ||
      argument === '--max-attempts'
    ) {
      const value = Number(requireValue(args, index, argument))
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${argument} must be a positive integer`)
      }
      if (argument === '--start') start = value
      else if (argument === '--limit') limit = value
      else maxAttempts = value
      index += 1
      continue
    }


    if (
      argument === '--rate-limit-delay' ||
      argument === '--request-delay' ||
      argument === '--retry-delay'
    ) {
      const value = Number(requireValue(args, index, argument))
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${argument} must be a non-negative integer`)
      }
      if (argument === '--rate-limit-delay') rateLimitDelayMs = value
      else if (argument === '--request-delay') requestDelayMs = value
      else retryDelayMs = value
      index += 1
      continue
    }

    if (argument === '--timeout') {
      const value = requireValue(args, index, argument)
      timeoutMs = Number(value)
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
        throw new Error('--timeout must be a number of at least 1000 milliseconds')
      }
      index += 1
      continue
    }

    if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`)
    }

    if (hasUrlArgument) {
      throw new Error(`Unexpected argument: ${argument}`)
    }

    requestedUrl = argument
    hasUrlArgument = true
  }

  if (inputPath && hasUrlArgument) {
    throw new Error('Use either an organization URL or --input, not both')
  }
  if (inputPath && outputPath) {
    throw new Error('--output is available only for a single organization URL')
  }

  if (!inputPath) parseTarget(requestedUrl, outputPath)

  return {
    failedPath: resolve(failedPath),
    help,
    inputPath: inputPath ? resolve(inputPath) : undefined,
    keepOpen,
    limit,
    manifestPath: resolve(manifestPath),
    maxAttempts,
    outputPath,
    outputDir: resolve(outputDir),
    rateLimitDelayMs,
    requestedUrl,
    requestDelayMs,
    retryDelayMs,
    start,
    timeoutMs,
  }
}

function parseTarget(
  requestedUrl: string,
  outputPath?: string,
  keepOpen = false,
  timeoutMs = 90_000,
  outputDir = 'outputs/crunchbase',
): ScrapeOptions {
  const parsedUrl = new URL(requestedUrl)
  if (
    parsedUrl.protocol !== 'https:' ||
    !['crunchbase.com', 'www.crunchbase.com'].includes(parsedUrl.hostname)
  ) {
    throw new Error('The URL must be an HTTPS Crunchbase organization page')
  }

  const match = parsedUrl.pathname.match(/^\/organization\/([^/]+)\/?$/)
  if (!match) {
    throw new Error('The URL must have the form https://www.crunchbase.com/organization/<slug>')
  }

  const slug = decodeURIComponent(match[1])
  const normalizedUrl = `https://www.crunchbase.com/organization/${encodeURIComponent(slug)}`
  const safeFilename = slug.replace(/[^a-zA-Z0-9._-]+/g, '-')

  return {
    keepOpen,
    outputPath: resolve(
      outputPath ?? `${outputDir}/${safeFilename}.json`,
    ),
    slug,
    timeoutMs,
    url: normalizedUrl,
  }
}

function buildExtractor(slug: string) {
  const expectedSlug = JSON.stringify(slug)

  return `(() => {
    const waitPrefix = ${JSON.stringify(WAIT_PREFIX)};
    const errorPrefix = ${JSON.stringify(ERROR_PREFIX)};
    const expectedSlug = ${expectedSlug};
    const pageText = document.body?.innerText || '';

    if (
      /error\\s*1015/i.test(pageText) ||
      /you are being rate limited/i.test(pageText)
    ) {
      return errorPrefix + 'Crunchbase rate limit detected (Cloudflare Error 1015)';
    }

    const stateElement = document.querySelector('script#ng-state[type="application/json"]');

    if (!stateElement || !stateElement.textContent) {
      return waitPrefix + 'Crunchbase page state is not available yet';
    }

    let state;
    try {
      state = JSON.parse(stateElement.textContent);
    } catch (error) {
      return errorPrefix + 'Crunchbase page state is not valid JSON: ' + String(error);
    }

    const loggedInState = state.InitialAuthState && state.InitialAuthState.loggedInState;
    if (loggedInState !== 'logged-in') {
      return errorPrefix + 'The active Brave profile is not logged in to Crunchbase';
    }

    const httpState = state.HttpState && typeof state.HttpState === 'object'
      ? Object.values(state.HttpState)
      : [];
    const currentSlugMatch = location.pathname.match(/^\\/organization\\/([^/]+)\\/?$/);
    const currentSlug = currentSlugMatch
      ? decodeURIComponent(currentSlugMatch[1])
      : undefined;
    const acceptedSlugs = new Set([expectedSlug, currentSlug].filter(Boolean));
    const responses = httpState
      .filter((candidate) =>
        candidate &&
        candidate.status === 200 &&
        candidate.data &&
        candidate.data.properties &&
        candidate.data.properties.identifier &&
        acceptedSlugs.has(candidate.data.properties.identifier.permalink)
      )
      .sort((left, right) =>
        Object.keys(right.data.cards || {}).length -
        Object.keys(left.data.cards || {}).length
      );
    const response = responses[0];
    let organization = response && response.data;
    let extractionMethod = 'brave-apple-events-ng-state';

    // Client-only pages expose the same authenticated entity request in the
    // resource list even when Angular does not copy its result into ng-state.
    if (!organization) {
      const entityResource = performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((url) => url.includes(
          '/v4/data/entities/organizations/' + encodeURIComponent(currentSlug || expectedSlug) + '?',
        ));
      if (!entityResource) {
        return waitPrefix + 'Organization entity request is not available yet';
      }

      const request = new XMLHttpRequest();
      request.open('GET', entityResource, false);
      request.send();
      if (request.status === 429) {
        return errorPrefix + 'Crunchbase rate limit detected while loading organization data';
      }
      if (request.status !== 200) {
        return errorPrefix + 'Organization data request failed with HTTP ' + request.status;
      }
      organization = JSON.parse(request.responseText);
      extractionMethod = 'brave-apple-events-entity-fetch';
    }

    if (!organization.cards || Object.keys(organization.cards).length === 0) {
      return waitPrefix + 'Organization payload is incomplete';
    }

    return JSON.stringify({
      sourceUrl: location.href,
      pageTitle: document.title,
      scrapedAt: new Date().toISOString(),
      extraction: {
        method: extractionMethod,
        authenticated: loggedInState === 'logged-in',
      },
      organization,
    });
  })()`
}

function organizationEndpoint(slug: string) {
  const fieldIds = [
    'identifier',
    'layout_id',
    'facet_ids',
    'title',
    'short_description',
    'is_locked',
    'category_groups',
    'rank_delta_d90',
    'investor_identifiers',
  ]
  const cardIds = [
    'competitors_list',
    'product_similarity_target_org_list',
    'org_similarity_org_list',
    'current_employees_summary',
    'advisors_summary',
    'alumni_summary',
    'recommended_search',
    'current_valuation',
  ]
  return (
    `/v4/data/entities/organizations/${encodeURIComponent(slug)}` +
    `?field_ids=${encodeURIComponent(JSON.stringify(fieldIds))}` +
    `&card_ids=${encodeURIComponent(JSON.stringify(cardIds))}` +
    '&layout_mode=view_v3'
  )
}

function buildDirectExtractor(slug: string) {
  const endpoint = organizationEndpoint(slug)

  return `(() => {
    const errorPrefix = ${JSON.stringify(ERROR_PREFIX)};
    const endpoint = ${JSON.stringify(endpoint)};
    const stateElement = document.querySelector('script#ng-state[type="application/json"]');
    if (!stateElement?.textContent) {
      return errorPrefix + 'Stationary Crunchbase page state is unavailable';
    }
    const state = JSON.parse(stateElement.textContent);
    const loggedInState = state.InitialAuthState?.loggedInState;
    if (loggedInState !== 'logged-in') {
      return errorPrefix + 'The stationary Brave tab is not logged in to Crunchbase';
    }

    const request = new XMLHttpRequest();
    request.open('GET', endpoint, false);
    request.send();
    if (
      request.status === 429 ||
      (request.status === 403 && /error\\s*1015|you are being rate limited/i.test(request.responseText))
    ) {
      return errorPrefix + 'Crunchbase rate limit detected while loading organization data';
    }
    if (request.status !== 200) {
      return errorPrefix + 'Organization data request failed with HTTP ' + request.status;
    }

    const organization = JSON.parse(request.responseText);
    const canonicalSlug = organization.properties?.identifier?.permalink;
    return JSON.stringify({
      sourceUrl: 'https://www.crunchbase.com/organization/' + encodeURIComponent(canonicalSlug || ${JSON.stringify(slug)}),
      pageTitle: organization.properties?.identifier?.value || canonicalSlug || ${JSON.stringify(slug)},
      scrapedAt: new Date().toISOString(),
      extraction: {
        method: 'brave-apple-events-entity-fetch-no-navigation',
        authenticated: true,
      },
      organization,
    });
  })()`
}

const appleScript = String.raw`
on run argv
  set extractionJavascript to item 1 of argv
  set scraperMarker to "__CODEX_CRUNCHBASE_SCRAPER__"
  set targetTab to missing value

  tell application "Brave Browser"
    repeat with candidateWindow in windows
      repeat with candidateTab in tabs of candidateWindow
        set isScraperTab to false
        if title of candidateTab is scraperMarker then set isScraperTab to true
        if URL of candidateTab contains "#" & scraperMarker then set isScraperTab to true
        try
          if (execute candidateTab javascript "window.name") is scraperMarker then set isScraperTab to true
        end try
        if isScraperTab then
          set targetTab to candidateTab
          exit repeat
        end if
      end repeat
      if targetTab is not missing value then exit repeat
    end repeat

    if targetTab is missing value then
      repeat with candidateWindow in windows
        repeat with candidateTab in tabs of candidateWindow
          if URL of candidateTab starts with "https://www.crunchbase.com/" then
            set targetTab to candidateTab
            exit repeat
          end if
        end repeat
        if targetTab is not missing value then exit repeat
      end repeat
    end if

    if targetTab is missing value then error "No authenticated Crunchbase tab is available for focus-safe scraping"
    execute targetTab javascript "window.name='" & scraperMarker & "';'ok'"
    return execute targetTab javascript extractionJavascript
  end tell
end run
`

const HTTP_PYTHON =
  '/Users/sa7afy/.cache/eign-crunchbase-http-venv/bin/python'
const HTTP_HELPER = resolve('scripts/lib/crunchbase-http.py')
let httpWorker: ChildProcessWithoutNullStreams | undefined
let httpBuffer = ''
let pendingHttpResponse:
  | { reject: (error: Error) => void; resolve: (value: string) => void }
  | undefined

function getHttpWorker() {
  if (httpWorker && !httpWorker.killed) return httpWorker
  httpWorker = spawn(HTTP_PYTHON, [HTTP_HELPER, '--worker'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  httpWorker.stdout.setEncoding('utf8')
  httpWorker.stdout.on('data', (chunk: string) => {
    httpBuffer += chunk
    const newline = httpBuffer.indexOf('\n')
    if (newline === -1) return
    const line = httpBuffer.slice(0, newline)
    httpBuffer = httpBuffer.slice(newline + 1)
    const pending = pendingHttpResponse
    pendingHttpResponse = undefined
    pending?.resolve(line)
  })
  httpWorker.once('exit', (code) => {
    const pending = pendingHttpResponse
    pendingHttpResponse = undefined
    httpWorker = undefined
    pending?.reject(new Error(`GUI-free Crunchbase worker exited with code ${code}`))
  })
  return httpWorker
}

function requestThroughHttpWorker(endpoint: string) {
  if (pendingHttpResponse) {
    throw new Error('GUI-free Crunchbase worker already has an active request')
  }
  const worker = getHttpWorker()
  return new Promise<string>((resolvePromise, rejectPromise) => {
    pendingHttpResponse = { reject: rejectPromise, resolve: resolvePromise }
    worker.stdin.write(`${endpoint}\n`)
  })
}

function closeHttpWorker() {
  httpWorker?.stdin.end()
}

async function runAuthenticatedHttp(options: ScrapeOptions) {
  const rawResponse = await requestThroughHttpWorker(
    organizationEndpoint(options.slug),
  )
  const response = JSON.parse(rawResponse) as { body: string; status: number }
  const isCloudflareRateLimit =
    response.status === 403 &&
    /error\s*1015|you are being rate limited/i.test(response.body)
  if (response.status === 429 || isCloudflareRateLimit) {
    throw new Error('Crunchbase rate limit detected while loading organization data')
  }
  if (response.status !== 200) {
    throw new Error(`Organization data request failed with HTTP ${response.status}`)
  }
  const organization = JSON.parse(response.body) as ScrapeResult['organization']
  const canonicalSlug = organization.properties?.identifier?.permalink
  return JSON.stringify({
    sourceUrl: `https://www.crunchbase.com/organization/${encodeURIComponent(canonicalSlug ?? options.slug)}`,
    pageTitle: canonicalSlug ?? options.slug,
    scrapedAt: new Date().toISOString(),
    extraction: {
      authenticated: true,
      method: 'curl-cffi-authenticated-entity-fetch-no-browser',
    },
    organization,
  } satisfies ScrapeResult)
}

function validateResult(rawResult: string, expectedSlug: string) {
  let result: ScrapeResult

  try {
    result = JSON.parse(rawResult) as ScrapeResult
  } catch (error) {
    throw new Error(`Crunchbase transport returned invalid JSON: ${String(error)}`)
  }

  const identifier = result.organization?.properties?.identifier
  const canonicalSlugMatch = new URL(result.sourceUrl).pathname.match(
    /^\/organization\/([^/]+)\/?$/,
  )
  const canonicalSlug = canonicalSlugMatch
    ? decodeURIComponent(canonicalSlugMatch[1])
    : undefined
  if (
    identifier?.permalink !== expectedSlug &&
    identifier?.permalink !== canonicalSlug
  ) {
    throw new Error(
      `Crunchbase returned the wrong organization payload: ${identifier?.permalink ?? 'missing permalink'}`,
    )
  }

  if (!result.extraction?.authenticated) {
    throw new Error('The result was not captured from a confirmed authenticated session')
  }

  if (Object.keys(result.organization.cards ?? {}).length === 0) {
    throw new Error('Crunchbase returned an incomplete organization payload with no data cards')
  }

  return result
}

function insightsPathFor(rawOutputPath: string) {
  return rawOutputPath.endsWith('.json')
    ? `${rawOutputPath.slice(0, -'.json'.length)}.insights.json`
    : `${rawOutputPath}.insights.json`
}

async function scrapeOrganization(options: ScrapeOptions) {
  const rawResult = await runAuthenticatedHttp(options)
  const result = validateResult(rawResult, options.slug)
  const insights = buildCrunchbaseInsights(result)
  assertInsightsAreClean(insights)
  const insightsOutputPath = insightsPathFor(options.outputPath)

  await mkdir(dirname(options.outputPath), { recursive: true })
  await writeFile(
    options.outputPath,
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  )
  await writeFile(
    insightsOutputPath,
    `${JSON.stringify(insights, null, 2)}\n`,
    'utf8',
  )

  return { insightsOutputPath, result }
}

async function writeJsonAtomically(path: string, value: unknown) {
  const temporaryPath = `${path}.${process.pid}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    temporaryPath,
    `${JSON.stringify(value, null, 2)}\n`,
    'utf8',
  )
  await rename(temporaryPath, path)
}

async function writeManifest(path: string, manifest: ScrapeManifest) {
  manifest.updatedAt = new Date().toISOString()
  await writeJsonAtomically(path, manifest)
}

async function writeFailedScrapes(
  path: string,
  manifest: ScrapeManifest,
) {
  const entries = manifest.entries
    .filter(
      (entry): entry is ManifestEntry & { error: string; failedAt: string } =>
        entry.status === 'failed' &&
        Boolean(entry.error) &&
        Boolean(entry.failedAt),
    )
    .map((entry) => ({
      attempts: entry.attempts,
      error: entry.error,
      failedAt: entry.failedAt,
      index: entry.index,
      lastAttemptAt: entry.lastAttemptAt,
      requestedSlug: entry.requestedSlug,
      requestedUrl: entry.requestedUrl,
    }))
  const failedScrapes: FailedScrapes = {
    entries,
    generatedAt: new Date().toISOString(),
    total: entries.length,
    version: 1,
  }
  await writeJsonAtomically(path, failedScrapes)
}

async function writeBatchState(
  options: CliOptions,
  manifest: ScrapeManifest,
) {
  await writeManifest(options.manifestPath, manifest)
  await writeFailedScrapes(options.failedPath, manifest)
}

function wait(milliseconds: number) {
  return new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds)
  })
}

async function loadLinks(inputPath: string) {
  const parsed = JSON.parse(await readFile(inputPath, 'utf8')) as unknown
  if (
    !Array.isArray(parsed) ||
    parsed.some((value) => typeof value !== 'string')
  ) {
    throw new Error('The input must be a JSON array of URL strings')
  }
  return parsed as string[]
}

function newManifest(inputPath: string, links: string[]): ScrapeManifest {
  const now = new Date().toISOString()
  return {
    createdAt: now,
    entries: links.map((requestedUrl, offset) => ({
      attempts: 0,
      index: offset + 1,
      requestedSlug: parseTarget(requestedUrl).slug,
      requestedUrl,
      status: 'pending',
    })),
    inputPath,
    totalLinks: links.length,
    updatedAt: now,
    version: 1,
  }
}

async function loadOrCreateManifest(
  manifestPath: string,
  inputPath: string,
  links: string[],
) {
  let manifest: ScrapeManifest
  try {
    manifest = JSON.parse(
      await readFile(manifestPath, 'utf8'),
    ) as ScrapeManifest
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    manifest = newManifest(inputPath, links)
    await writeManifest(manifestPath, manifest)
    return manifest
  }

  if (manifest.version !== 1) {
    throw new Error('Unsupported manifest version')
  }

  const inputMatches =
    manifest.totalLinks === links.length &&
    manifest.entries.length === links.length &&
    manifest.entries.every(
      (entry, offset) =>
        entry.index === offset + 1 && entry.requestedUrl === links[offset],
    )
  if (!inputMatches) {
    const existingByUrl = new Map(
      manifest.entries.map((entry) => [entry.requestedUrl, entry]),
    )
    const fresh = newManifest(inputPath, links)
    manifest.entries = fresh.entries.map((entry) => {
      const existing = existingByUrl.get(entry.requestedUrl)
      return existing ? { ...existing, index: entry.index } : entry
    })
    manifest.inputPath = inputPath
    manifest.totalLinks = links.length
    manifest.updatedAt = new Date().toISOString()
    await writeManifest(manifestPath, manifest)
    console.log(
      `Reconciled manifest by URL: ${existingByUrl.size} previous, ${links.length} current`,
    )
  }
  return manifest
}

async function recoverExistingOutput(
  entry: ManifestEntry,
  options: ScrapeOptions,
) {
  try {
    const rawResult = await readFile(options.outputPath, 'utf8')
    const result = validateResult(rawResult, options.slug)
    const insightsOutputPath = insightsPathFor(options.outputPath)
    const insights = JSON.parse(await readFile(insightsOutputPath, 'utf8'))
    assertInsightsAreClean(insights)
    const canonicalSlug = result.organization.properties?.identifier?.permalink
    Object.assign(entry, {
      canonicalSlug,
      completedAt: result.scrapedAt,
      error: undefined,
      failedAt: undefined,
      insightsPath: insightsOutputPath,
      outputPath: options.outputPath,
      recoveredAt: entry.attempts === 0
        ? new Date().toISOString()
        : entry.recoveredAt,
      status: 'success' satisfies ManifestStatus,
    })
    return true
  } catch {
    return false
  }
}

async function runBatch(options: CliOptions) {
  if (!options.inputPath) throw new Error('Batch input path is missing')
  if (options.keepOpen) {
    throw new Error('--keep-open cannot be used with batch mode')
  }

  const links = await loadLinks(options.inputPath)
  const manifest = await loadOrCreateManifest(
    options.manifestPath,
    options.inputPath,
    links,
  )
  const interruptedEntries = manifest.entries.filter(
    (entry) => entry.status === 'in_progress',
  )
  for (const entry of interruptedEntries) {
    entry.error = 'Previous batch stopped before this entry completed'
    entry.status = 'pending'
  }
  if (interruptedEntries.length) {
    await writeManifest(options.manifestPath, manifest)
  }
  await writeFailedScrapes(options.failedPath, manifest)
  const endIndex = Math.min(
    links.length,
    options.limit ? options.start + options.limit - 1 : links.length,
  )

  let recovered = 0
  let skipped = 0
  let scraped = 0
  let unresolved = 0

  for (let index = options.start; index <= endIndex; index += 1) {
    const entry = manifest.entries[index - 1]
    const target = parseTarget(
      entry.requestedUrl,
      undefined,
      false,
      options.timeoutMs,
      options.outputDir,
    )

    const wasSuccessful = entry.status === 'success'
    const needsRecoveryStamp =
      wasSuccessful && entry.attempts === 0 && !entry.recoveredAt
    if (await recoverExistingOutput(entry, target)) {
      if (wasSuccessful) {
        skipped += 1
        if (needsRecoveryStamp) {
          await writeBatchState(options, manifest)
        }
        console.log(`[${index}/${links.length}] Skipped ${entry.requestedSlug} (verified success)`)
      } else {
        recovered += 1
        await writeBatchState(options, manifest)
        console.log(`[${index}/${links.length}] Recovered ${entry.requestedSlug} from verified outputs`)
      }
      continue
    }

    for (
      let attemptInRun = 1;
      attemptInRun <= options.maxAttempts;
      attemptInRun += 1
    ) {
      entry.attempts += 1
      entry.canonicalSlug = undefined
      entry.completedAt = undefined
      entry.error = undefined
      entry.failedAt = undefined
      entry.insightsPath = undefined
      entry.lastAttemptAt = new Date().toISOString()
      entry.outputPath = undefined
      entry.recoveredAt = undefined
      entry.status = 'in_progress'
      await writeBatchState(options, manifest)
      console.log(
        `[${index}/${links.length}] Scraping ${entry.requestedUrl} ` +
        `(attempt ${attemptInRun}/${options.maxAttempts}, ${entry.attempts} total)`,
      )

      try {
        const { insightsOutputPath, result } = await scrapeOrganization(target)
        entry.canonicalSlug =
          result.organization.properties?.identifier?.permalink
        entry.completedAt = new Date().toISOString()
        entry.error = undefined
        entry.failedAt = undefined
        entry.insightsPath = insightsOutputPath
        entry.outputPath = target.outputPath
        entry.status = 'success'
        scraped += 1
        await writeBatchState(options, manifest)
        break
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error)
        const isRateLimited = /rate limit|error 1015/i.test(entry.error)
        const isAppleEventsJavascriptDisabled =
          /Allow JavaScript from Apple Events/i.test(entry.error)

        if (isAppleEventsJavascriptDisabled) {
          entry.failedAt = undefined
          entry.status = 'pending'
          await writeBatchState(options, manifest)
          throw new Error(
            'Brave Browser has JavaScript from Apple Events disabled; ' +
            'enable View > Developer > Allow JavaScript from Apple Events, then resume',
          )
        }

        if (isRateLimited) {
          entry.failedAt = undefined
          entry.status = 'pending'
          await writeBatchState(options, manifest)
          console.error(
            `[${index}/${links.length}] Crunchbase rate limit detected for ` +
            `${entry.requestedSlug}; sleeping ${options.rateLimitDelayMs}ms ` +
            'before retrying the same entry',
          )
          if (options.rateLimitDelayMs > 0) {
            await wait(options.rateLimitDelayMs)
          }
          attemptInRun -= 1
          continue
        }

        if (attemptInRun < options.maxAttempts) {
          await writeManifest(options.manifestPath, manifest)
          console.error(
            `[${index}/${links.length}] Attempt ${attemptInRun} failed for ` +
            `${entry.requestedSlug}: ${entry.error}`,
          )
          if (options.retryDelayMs > 0) await wait(options.retryDelayMs)
          continue
        }

        entry.failedAt = new Date().toISOString()
        entry.status = 'failed'
        unresolved += 1
        await writeBatchState(options, manifest)
        console.error(
          `[${index}/${links.length}] Added ${entry.requestedSlug} to ` +
          `${options.failedPath} after ${options.maxAttempts} attempts this run`,
        )
      }
    }

    if (index < endIndex && options.requestDelayMs > 0) {
      await wait(options.requestDelayMs)
    }
  }

  console.log(`Batch complete for input indices ${options.start}-${endIndex}`)
  console.log(
    `Scraped: ${scraped}; recovered: ${recovered}; ` +
    `skipped: ${skipped}; unresolved: ${unresolved}`,
  )
  console.log(`Manifest: ${options.manifestPath}`)
  console.log(`Failed retry list: ${options.failedPath}`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.help) {
    console.log(usage())
    return
  }

  if (options.inputPath) {
    await runBatch(options)
    closeHttpWorker()
    return
  }

  const target = parseTarget(
    options.requestedUrl,
    options.outputPath,
    options.keepOpen,
    options.timeoutMs,
  )
  const { insightsOutputPath, result } = await scrapeOrganization(target)

  const identifier = result.organization.properties?.identifier
  const cardCount = Object.keys(result.organization.cards ?? {}).length

  console.log(`Saved ${identifier?.value ?? target.slug}`)
  console.log(`Output: ${target.outputPath}`)
  console.log(`Insights: ${insightsOutputPath}`)
  console.log(`UUID: ${identifier?.uuid ?? 'not provided'}`)
  console.log(`Cards: ${cardCount}`)
  console.log(
    `Authenticated Crunchbase session: ${result.extraction.authenticated ? 'yes' : 'not confirmed'}`,
  )
  closeHttpWorker()
}

main().catch((error: unknown) => {
  closeHttpWorker()
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
