import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const FUNDED_1000_SCOPE = process.argv.includes('--funded-1000')
const OUTPUT_DIR = resolve(
  FUNDED_1000_SCOPE
    ? 'outputs/middle-east-jordan-funding-1000-plus'
    : 'outputs/middle-east-crunchbase-2005-present',
)
const CHECKPOINT_PATH = resolve(OUTPUT_DIR, 'collector-checkpoint.json')
const INVENTORY_PATH = resolve(OUTPUT_DIR, 'companies.json')
const LINKS_PATH = resolve(OUTPUT_DIR, 'crunchbase-links.json')
const PARTITIONS_PATH = resolve(OUTPUT_DIR, 'partitions.json')
const COLLECTOR_REQUEST_DELAY_MS = 8_000
const COLLECTOR_JITTER_MS = 1_000
const SPLIT_THRESHOLD = 950
const PAGE_SIZE = 50

type CountryName =
  | 'Saudi Arabia'
  | 'United Arab Emirates'
  | 'Qatar'
  | 'Kuwait'
  | 'Bahrain'
  | 'Oman'
  | 'Egypt'
  | 'Jordan'

const BASE_COUNTRIES: CountryName[] = [
  'Saudi Arabia',
  'United Arab Emirates',
  'Qatar',
  'Kuwait',
  'Bahrain',
  'Oman',
  'Egypt',
]
const COUNTRIES: CountryName[] = FUNDED_1000_SCOPE
  ? [...BASE_COUNTRIES, 'Jordan']
  : BASE_COUNTRIES

type SearchEntity = {
  uuid: string
  properties: {
    founded_on?: { precision?: string; value?: string }
    identifier?: { location_type?: string; permalink?: string; value?: string }
    location_type?: string
    location_identifiers?: Array<{
      location_type?: string
      permalink?: string
      uuid?: string
      value?: string
    }>
  }
}

type Company = {
  country: CountryName
  crunchbaseUrl: string
  foundedOn?: string
  foundedOnPrecision?: string
  name: string
  permalink: string
  sourcePartition: string
  uuid: string
}

type Partition = {
  afterId?: string
  collected: number
  country: CountryName
  countryUuid: string
  count?: number
  end?: string
  key: string
  includeNullRanks?: boolean
  pages: number
  rankMax?: number
  rankMin?: number
  start?: string
  status: 'pending' | 'collecting' | 'success' | 'unsplittable'
}

type Checkpoint = {
  completedAt?: string
  countries: Partial<Record<CountryName, string>>
  createdAt: string
  lastError?: string
  requests: number
  status: 'collecting' | 'complete'
  updatedAt: string
  version: 1
}

type Inventory = {
  companies: Company[]
  updatedAt: string
  version: 1
}

type SearchResponse = { count: number; entities: SearchEntity[] }

const appleScript = String.raw`
on run argv
  set endpointPath to item 1 of argv
  set requestBody to item 2 of argv
  set marker to "__CODEX_CB_MENA_COLLECTOR__"
  set markerURL to "https://www.crunchbase.com/discover/organization.companies"
  set targetTab to missing value
  set targetWindow to missing value

  tell application "Brave Browser"
    repeat with candidateWindow in windows
      repeat with candidateTab in tabs of candidateWindow
        set isCollectorTab to false
        if title of candidateTab is marker then set isCollectorTab to true
        try
          if (execute candidateTab javascript "window.name") is marker then set isCollectorTab to true
        end try
        if isCollectorTab then
          set targetTab to candidateTab
          set targetWindow to candidateWindow
          exit repeat
        end if
      end repeat
      if targetTab is not missing value then exit repeat
    end repeat

    if targetTab is missing value then
      if (count of windows) is 0 then error "Brave Browser must already be running"
      set targetWindow to last window
      set targetTab to make new tab at end of tabs of targetWindow with properties {URL:markerURL}
      delay 5
      execute targetTab javascript "window.name='" & marker & "';document.title='" & marker & "';'ok'"
    end if

    set requestJavascript to "(() => {" & ¬
      "const xhr = new XMLHttpRequest();" & ¬
      "xhr.open('POST', " & quoted form of endpointPath & ", false);" & ¬
      "xhr.setRequestHeader('content-type', 'application/json');" & ¬
      "xhr.send(" & quoted form of requestBody & ");" & ¬
      "return JSON.stringify({status:xhr.status,body:xhr.responseText});" & ¬
      "})()"
    return execute targetTab javascript requestJavascript
  end tell
end run
`

function execAppleScript(endpoint: string, body: unknown) {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      '/usr/bin/osascript',
      ['-e', appleScript, endpoint, JSON.stringify(body)],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000 },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(new Error(stderr.trim() || error.message))
          return
        }
        resolvePromise(stdout.trim())
      },
    )
  })
}

async function request<T>(endpoint: string, body: unknown): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const outer = JSON.parse(await execAppleScript(endpoint, body)) as {
        body: string
        status: number
      }
      if (outer.status === 429 || /rate limit|error 1015/i.test(outer.body)) {
        const cooldownMs = Math.min(3_600_000, 900_000 * attempt)
        console.error(
          `Rate limited; cooling down for ${cooldownMs / 60_000} minutes ` +
          `(attempt ${attempt})`,
        )
        await delay(cooldownMs)
        continue
      }
      if (outer.status !== 200) {
        throw new Error(`Crunchbase HTTP ${outer.status}: ${outer.body.slice(0, 800)}`)
      }
      return JSON.parse(outer.body) as T
    } catch (error) {
      const waitMs = Math.min(300_000, 10_000 * attempt)
      console.error(`Request failed: ${String(error)}; retrying in ${waitMs}ms`)
      await delay(waitMs)
    }
  }
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

async function writeJsonAtomically(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, path)
}

async function waitBetweenCollectorRequests() {
  const jitter = Math.floor(
    Math.random() * (COLLECTOR_JITTER_MS * 2 + 1),
  ) - COLLECTOR_JITTER_MS
  await delay(COLLECTOR_REQUEST_DELAY_MS + jitter)
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10)
}

function partitionKey(
  country: CountryName,
  start?: string,
  end?: string,
  rankMin?: number,
  rankMax?: number,
  includeNullRanks?: boolean,
) {
  const countryKey = country.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const dateKey = start && end ? `${countryKey}:${start}:${end}` : countryKey
  return rankMin === undefined && rankMax === undefined
    ? dateKey
    : `${dateKey}:rank-${rankMin ?? 'min'}-${rankMax ?? 'max'}${includeNullRanks ? '-with-nulls' : ''}`
}

function splitPartition(partition: Partition): [Partition, Partition] | undefined {
  const make = (
    rangeStart: string | undefined,
    rangeEnd: string | undefined,
    rankMin = partition.rankMin,
    rankMax = partition.rankMax,
    includeNullRanks = partition.includeNullRanks,
  ): Partition => ({
    collected: 0,
    country: partition.country,
    countryUuid: partition.countryUuid,
    end: rangeEnd,
    includeNullRanks,
    key: partitionKey(
      partition.country,
      rangeStart,
      rangeEnd,
      rankMin,
      rankMax,
      includeNullRanks,
    ),
    pages: 0,
    rankMax,
    rankMin,
    start: rangeStart,
    status: 'pending',
  })
  if (partition.start && partition.end) {
    const start = new Date(`${partition.start}T00:00:00Z`)
    const end = new Date(`${partition.end}T00:00:00Z`)
    const days = Math.round((end.getTime() - start.getTime()) / 86_400_000)
    if (days >= 1 && partition.start.endsWith('-01-01')) {
      const dayAfterStart = new Date(start.getTime() + 86_400_000)
      return [
        make(partition.start, partition.start),
        make(isoDate(dayAfterStart), partition.end),
      ]
    }
    if (days >= 1) {
      const midpoint = new Date(start.getTime() + Math.floor(days / 2) * 86_400_000)
      const rightStart = new Date(midpoint.getTime() + 86_400_000)
      return [make(partition.start, isoDate(midpoint)), make(isoDate(rightStart), partition.end)]
    }
  }

  // Crunchbase normalizes year-precision dates to January 1, so a single day
  // can still exceed the UI's 1,000-row ceiling. Split that bucket by the
  // deterministic company-rank field instead of accepting a capped result.
  const rankMin = partition.rankMin ?? 0
  const rankMax = partition.rankMax ?? 10_000_000
  if (rankMin >= rankMax) return undefined
  const rankMidpoint = Math.floor((rankMin + rankMax) / 2)
  return [
    make(
      partition.start,
      partition.end,
      rankMin,
      rankMidpoint,
      partition.includeNullRanks ?? true,
    ),
    make(partition.start, partition.end, rankMidpoint + 1, rankMax, false),
  ]
}

function organizationQuery(partition: Partition) {
  const query: Array<Record<string, unknown>> = [
    {
      field_id: 'location_identifiers',
      operator_id: 'includes',
      type: 'predicate',
      values: [partition.countryUuid],
    },
  ]
  if (FUNDED_1000_SCOPE) {
    query.push({
      field_id: 'funding_total',
      operator_id: 'gte',
      type: 'predicate',
      values: [1_000],
    })
  }
  if (partition.start && partition.end) {
    query.push(
      {
        field_id: 'founded_on',
        operator_id: 'gte',
        type: 'predicate',
        values: [partition.start],
      },
      {
        field_id: 'founded_on',
        operator_id: 'lte',
        type: 'predicate',
        values: [partition.end],
      },
    )
  }
  if (partition.rankMin !== undefined && partition.rankMin > 0) {
    query.push({
      field_id: 'rank_org_company',
      operator_id: 'gte',
      type: 'predicate',
      values: [partition.rankMin],
    })
  }
  if (partition.rankMax !== undefined) {
    query.push({
      field_id: 'rank_org_company',
      include_nulls: partition.includeNullRanks === true,
      operator_id: 'lte',
      type: 'predicate',
      values: [partition.rankMax],
    })
  }
  return query
}

async function resolveCountryUuid(country: CountryName) {
  const response = await request<SearchResponse>('/v4/data/searches/locations', {
    field_ids: ['identifier', 'location_type'],
    limit: 20,
    query: [
      {
        field_id: 'identifier',
        operator_id: 'contains',
        type: 'predicate',
        values: [country],
      },
    ],
  })
  const match = response.entities.find(
    (entity) =>
      entity.properties.identifier?.value === country &&
      (entity.properties.location_type === 'country' ||
        entity.properties.identifier?.location_type === 'country'),
  )
  if (!match) throw new Error(`Could not resolve Crunchbase country: ${country}`)
  return match.uuid
}

async function save(
  checkpoint: Checkpoint,
  inventory: Inventory,
  partitions: Partition[],
) {
  checkpoint.updatedAt = new Date().toISOString()
  inventory.updatedAt = checkpoint.updatedAt
  const links = [...new Set(inventory.companies.map((company) => company.crunchbaseUrl))].sort()
  await writeJsonAtomically(INVENTORY_PATH, inventory)
  await writeJsonAtomically(LINKS_PATH, links)
  await writeJsonAtomically(PARTITIONS_PATH, partitions)
  await writeJsonAtomically(CHECKPOINT_PATH, checkpoint)
}

async function main() {
  const now = new Date()
  const createdAt = now.toISOString()
  const checkpoint = await readJson<Checkpoint>(CHECKPOINT_PATH, {
    countries: {},
    createdAt,
    requests: 0,
    status: 'collecting',
    updatedAt: createdAt,
    version: 1,
  })
  const inventory = await readJson<Inventory>(INVENTORY_PATH, {
    companies: [],
    updatedAt: createdAt,
    version: 1,
  })
  let partitions = await readJson<Partition[]>(PARTITIONS_PATH, [])

  // An earlier resolver accepted the first exact-name location without
  // checking its type. Crunchbase has a non-country location named Egypt,
  // which yielded only one company. Remove only that bad slice and replay it
  // with the strict country resolver while preserving all other progress.
  const egyptCompanyCount = inventory.companies.filter(
    (company) => company.country === 'Egypt',
  ).length
  if (!FUNDED_1000_SCOPE && checkpoint.countries.Egypt && egyptCompanyCount <= 1) {
    delete checkpoint.countries.Egypt
    inventory.companies = inventory.companies.filter(
      (company) => company.country !== 'Egypt',
    )
    partitions = partitions.filter((partition) => partition.country !== 'Egypt')
    checkpoint.status = 'collecting'
    checkpoint.completedAt = undefined
    checkpoint.lastError = undefined
    await save(checkpoint, inventory, partitions)
  }

  // v1 rank partitions initially omitted blank rank values. Replay only the
  // lowest numeric child with include_nulls so the rank children reconcile
  // exactly to their unsplit parent without overlapping each other.
  let migratedRankPartitions = false
  for (const partition of partitions) {
    if (
      partition.rankMin === 0 &&
      partition.rankMax !== undefined &&
      partition.includeNullRanks !== true
    ) {
      partition.includeNullRanks = true
      partition.key = partitionKey(
        partition.country,
        partition.start,
        partition.end,
        partition.rankMin,
        partition.rankMax,
        true,
      )
      partition.afterId = undefined
      partition.collected = 0
      partition.count = undefined
      partition.pages = 0
      partition.status = 'pending'
      migratedRankPartitions = true
    }
  }
  if (migratedRankPartitions) {
    await save(checkpoint, inventory, partitions)
  }

  if (checkpoint.status === 'complete') {
    console.log(`Collector already complete with ${inventory.companies.length} companies`)
    return
  }

  for (const country of COUNTRIES) {
    if (!checkpoint.countries[country]) {
      checkpoint.countries[country] = await resolveCountryUuid(country)
      checkpoint.requests += 1
      await save(checkpoint, inventory, partitions)
      await waitBetweenCollectorRequests()
    }
  }

  if (partitions.length === 0) {
    const currentYear = now.getUTCFullYear()
    const today = isoDate(now)
    for (const country of COUNTRIES) {
      const countryUuid = checkpoint.countries[country]
      if (!countryUuid) throw new Error(`Missing UUID for ${country}`)
      if (FUNDED_1000_SCOPE) {
        partitions.push({
          collected: 0,
          country,
          countryUuid,
          key: partitionKey(country),
          pages: 0,
          status: 'pending',
        })
      } else {
        for (let year = 2005; year <= currentYear; year += 1) {
          const start = `${year}-01-01`
          const end = year === currentYear ? today : `${year}-12-31`
          partitions.push({
            collected: 0,
            country,
            countryUuid,
            end,
            key: partitionKey(country, start, end),
            pages: 0,
            start,
            status: 'pending',
          })
        }
      }
    }
    await save(checkpoint, inventory, partitions)
  }

  // A repaired or newly added country may be missing from a pre-existing
  // checkpoint even though other countries already have partitions.
  const currentYear = now.getUTCFullYear()
  const today = isoDate(now)
  for (const country of COUNTRIES) {
    if (partitions.some((partition) => partition.country === country)) continue
    const countryUuid = checkpoint.countries[country]
    if (!countryUuid) throw new Error(`Missing UUID for ${country}`)
    if (FUNDED_1000_SCOPE) {
      partitions.push({
        collected: 0,
        country,
        countryUuid,
        key: partitionKey(country),
        pages: 0,
        status: 'pending',
      })
    } else {
      for (let year = 2005; year <= currentYear; year += 1) {
        const start = `${year}-01-01`
        const end = year === currentYear ? today : `${year}-12-31`
        partitions.push({
          collected: 0,
          country,
          countryUuid,
          end,
          key: partitionKey(country, start, end),
          pages: 0,
          start,
          status: 'pending',
        })
      }
    }
  }
  await save(checkpoint, inventory, partitions)

  const companies = new Map(inventory.companies.map((company) => [company.uuid, company]))

  while (true) {
    const index = partitions.findIndex(
      (partition) => partition.status === 'pending' || partition.status === 'collecting',
    )
    if (index === -1) break
    const partition = partitions[index]
    partition.status = 'collecting'

    const body: Record<string, unknown> = {
      field_ids: ['identifier', 'founded_on', 'location_identifiers'],
      limit: PAGE_SIZE,
      order: [{ field_id: 'rank_org_company', sort: 'asc' }],
      query: organizationQuery(partition),
    }
    if (partition.afterId) body.after_id = partition.afterId

    const response = await request<SearchResponse>(
      '/v4/data/searches/organization.companies?source=collection_advanced_search',
      body,
    )
    checkpoint.requests += 1
    partition.count = response.count

    if (!partition.afterId && response.count >= SPLIT_THRESHOLD) {
      const children = splitPartition(partition)
      if (children) {
        console.log(`Splitting ${partition.key} (${response.count} results)`)
        partitions.splice(index, 1, ...children)
        await save(checkpoint, inventory, partitions)
        await waitBetweenCollectorRequests()
        continue
      }
      partition.status = 'unsplittable'
      checkpoint.lastError = `${partition.key} has ${response.count} results on one day`
    }

    for (const entity of response.entities) {
      const identifier = entity.properties.identifier
      if (!identifier?.permalink || !identifier.value) continue
      companies.set(entity.uuid, {
        country: partition.country,
        crunchbaseUrl: `https://www.crunchbase.com/organization/${encodeURIComponent(identifier.permalink)}`,
        foundedOn: entity.properties.founded_on?.value,
        foundedOnPrecision: entity.properties.founded_on?.precision,
        name: identifier.value,
        permalink: identifier.permalink,
        sourcePartition: partition.key,
        uuid: entity.uuid,
      })
    }
    inventory.companies = [...companies.values()].sort((left, right) =>
      left.country.localeCompare(right.country) || left.name.localeCompare(right.name),
    )
    partition.pages += 1
    partition.collected += response.entities.length
    partition.afterId = response.entities.at(-1)?.uuid

    if (
      response.entities.length === 0 ||
      response.entities.length < PAGE_SIZE ||
      partition.collected >= response.count
    ) {
      partition.status = partition.status === 'unsplittable' ? 'unsplittable' : 'success'
      console.log(
        `Completed ${partition.key}: ${partition.collected}/${response.count}; ` +
        `${inventory.companies.length} unique total`,
      )
    } else {
      console.log(
        `Collecting ${partition.key}: ${partition.collected}/${response.count}; ` +
        `${inventory.companies.length} unique total`,
      )
    }
    await save(checkpoint, inventory, partitions)
    await waitBetweenCollectorRequests()
  }

  checkpoint.status = 'complete'
  checkpoint.completedAt = new Date().toISOString()
  await save(checkpoint, inventory, partitions)
  console.log(`Collector complete: ${inventory.companies.length} unique companies`)
}

main().catch(async (error) => {
  console.error(error)
  process.exitCode = 1
})
