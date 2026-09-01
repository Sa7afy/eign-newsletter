import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const FUNDED_1000_SCOPE = process.argv.includes('--funded-1000')
const OUTPUT_DIR = resolve(
  FUNDED_1000_SCOPE
    ? 'outputs/middle-east-jordan-funding-1000-plus'
    : 'outputs/middle-east-crunchbase-2005-present',
)
const STATUS_PATH = resolve(OUTPUT_DIR, 'watchdog-status.json')
const COLLECTOR_CHECKPOINT = resolve(OUTPUT_DIR, 'collector-checkpoint.json')
const LINKS_PATH = resolve(OUTPUT_DIR, 'crunchbase-links.json')
const MANIFEST_PATH = resolve(OUTPUT_DIR, 'scrape-manifest.json')
const FAILED_PATH = resolve(OUTPUT_DIR, 'failed.json')
const SCRAPES_DIR = resolve(OUTPUT_DIR, 'companies')
const RUNTIME_NODE =
  '/Users/sa7afy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'
const TSX_CLI = resolve('node_modules/tsx/dist/cli.mjs')

type WatchdogStatus = {
  childExitCode?: number | null
  lastError?: string
  phase: 'collecting_links' | 'scraping' | 'complete'
  restarts: number
  scraper: 'waiting' | 'running normally' | 'complete'
  startedAt: string
  updatedAt: string
  version: 1
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function writeJsonAtomically(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, path)
}

async function runChild(script: string, args: string[]) {
  return new Promise<number | null>((resolvePromise) => {
    const child = spawn(RUNTIME_NODE, [TSX_CLI, script, ...args], {
      cwd: process.cwd(),
      stdio: 'inherit',
    })
    child.once('exit', (code) => resolvePromise(code))
  })
}

async function closeAutomationTabs() {
  return new Promise<void>((resolvePromise) => {
    const script = String.raw`
tell application "Brave Browser"
  repeat with candidateWindow in windows
    repeat with tabIndex from (count of tabs of candidateWindow) to 1 by -1
      set candidateTab to tab tabIndex of candidateWindow
      set candidateURL to URL of candidateTab
      set candidateTitle to title of candidateTab
      if candidateURL contains "__CODEX_CB_MENA_COLLECTOR__" or candidateTitle is "__CODEX_CB_MENA_COLLECTOR__" or candidateTitle is "__CODEX_CRUNCHBASE_SCRAPER__" then
        close candidateTab
      end if
    end repeat
  end repeat
end tell
`
    const child = spawn('/usr/bin/osascript', ['-e', script], {
      cwd: process.cwd(),
      stdio: 'inherit',
    })
    child.once('exit', () => resolvePromise())
  })
}

async function scrapeCounts() {
  const manifest = await readJson<{ entries: Array<{ status: string }> }>(MANIFEST_PATH)
  if (!manifest) return { failed: 0, pending: 0, success: 0, total: 0 }
  return manifest.entries.reduce(
    (counts, entry) => {
      counts.total += 1
      if (entry.status === 'success') counts.success += 1
      else if (entry.status === 'failed') counts.failed += 1
      else counts.pending += 1
      return counts
    },
    { failed: 0, pending: 0, success: 0, total: 0 },
  )
}

async function main() {
  const startedAt = new Date().toISOString()
  const status: WatchdogStatus = {
    phase: 'collecting_links',
    restarts: 0,
    scraper: 'waiting',
    startedAt,
    updatedAt: startedAt,
    version: 1,
  }

  while (true) {
    const collector = await readJson<{ status?: string }>(COLLECTOR_CHECKPOINT)
    if (collector?.status !== 'complete') {
      status.phase = 'collecting_links'
      status.scraper = 'waiting'
      status.updatedAt = new Date().toISOString()
      await writeJsonAtomically(STATUS_PATH, status)
      const code = await runChild(
        'scripts/collect-middle-east-crunchbase-links.ts',
        FUNDED_1000_SCOPE ? ['--funded-1000'] : [],
      )
      status.childExitCode = code
      if (code !== 0) {
        status.restarts += 1
        status.lastError = `Collector exited with code ${code}`
        status.updatedAt = new Date().toISOString()
        await writeJsonAtomically(STATUS_PATH, status)
        await delay(30_000)
        continue
      }
    }

    const before = await scrapeCounts()
    if (before.total > 0 && before.success === before.total) {
      status.phase = 'complete'
      status.scraper = 'complete'
      status.updatedAt = new Date().toISOString()
      await writeJsonAtomically(STATUS_PATH, status)
      await closeAutomationTabs()
      return
    }

    status.phase = 'scraping'
    status.scraper = 'running normally'
    status.updatedAt = new Date().toISOString()
    await writeJsonAtomically(STATUS_PATH, status)
    const code = await runChild('scripts/scrape-crunchbase.ts', [
      '--input',
      LINKS_PATH,
      '--output-dir',
      SCRAPES_DIR,
      '--manifest',
      MANIFEST_PATH,
      '--failed',
      FAILED_PATH,
      '--request-delay',
      '3000',
      '--retry-delay',
      '5000',
      '--rate-limit-delay',
      '300000',
      '--max-attempts',
      '3',
    ])
    status.childExitCode = code
    const after = await scrapeCounts()
    if (after.total > 0 && after.success === after.total) {
      status.phase = 'complete'
      status.scraper = 'complete'
      status.updatedAt = new Date().toISOString()
      await writeJsonAtomically(STATUS_PATH, status)
      await closeAutomationTabs()
      return
    }
    status.restarts += 1
    status.lastError = `Scraper exited with code ${code}; ${after.failed} failed and ${after.pending} pending`
    status.updatedAt = new Date().toISOString()
    await writeJsonAtomically(STATUS_PATH, status)
    await delay(30_000)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
