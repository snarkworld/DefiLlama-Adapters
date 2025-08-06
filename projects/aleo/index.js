// projects/aleo-native-stake/index.js
//
// Native staking adapter (committee-based).
// 1) Fetch the current committee.
// 2) If stake is provided there, sum it.
// 3) Else, fetch bonded rows at latest height and sum only committee addresses.
//
// ENV (optional):
//   NEXT_PUBLIC_API_ROOT: defaults to https://api.explorer.provable.com/v1
//   ALEO_NETWORK:         defaults to 'mainnet'

const { get } = require('../helper/http')

const DEFAULT_API_ROOT = 'https://api.explorer.provable.com/v1'
const API_ROOT = process.env.NEXT_PUBLIC_API_ROOT || DEFAULT_API_ROOT
const NETWORK  = process.env.ALEO_NETWORK || 'mainnet'

function parseMicros(raw) {
  if (raw == null) return 0n
  if (typeof raw === 'number') return BigInt(raw)
  if (typeof raw === 'bigint') return raw
  const s = String(raw)
  // accepts "microcredits: 123", "123u64", "123", etc.
  const m = s.match(/(\d+)/)
  return BigInt(m ? m[1] : '0')
}

async function fetchCommittee() {
  const urls = [
    `${API_ROOT}/${NETWORK}/latest/committee`,
    `${API_ROOT}/${NETWORK}/committee`,
  ]
  let data
  for (const url of urls) {
    try { data = await get(url); if (data) break } catch {}
  }
  if (!data) throw new Error('committee endpoint unavailable')

  // Normalize into { address, stakeMicro? }
  const rows = Array.isArray(data?.committee) ? data.committee : Array.isArray(data) ? data : []
  const committee = []
  for (const row of rows) {
    if (Array.isArray(row)) {
      // e.g., [address, "microcredits: 123..."]
      const [address, stakeLike] = row
      committee.push({ address, stakeMicro: parseMicros(stakeLike) })
    } else if (row && typeof row === 'object') {
      const address = row.address || row.validator || row.owner || row[0]
      const stakeLike = row.stake ?? row.power ?? row.bonded ?? row[1]
      committee.push({ address, stakeMicro: parseMicros(stakeLike) })
    } else if (typeof row === 'string') {
      committee.push({ address: row })
    }
  }
  // Filter out empties / duplicates
  const seen = new Set()
  return committee.filter(x => x.address && !seen.has(x.address) && seen.add(x.address))
}

function toHeightResp(x) {
  if (x && typeof x === 'object' && 'height' in x) return Number(x.height)
  return Number(x)
}

async function latestHeight() {
  const resp = await get(`${API_ROOT}/${NETWORK}/latest/height`)
  return toHeightResp(resp)
}

async function bondedAtHeight(height) {
  // returns e.g. [ [validatorAddress, "microcredits: <num>"], ... ]
  return get(`${API_ROOT}/${NETWORK}/block/${height}/history/bonded`)
}

async function staking(api) {
  const committee = await fetchCommittee()

  // If committee already includes stake values, prefer those.
  let totalMicro = committee.reduce((acc, x) => acc + (x.stakeMicro || 0n), 0n)

  if (totalMicro === 0n) {
    // Fallback path: read bonded rows at latest height and keep only committee addrs.
    const height = await latestHeight()
    const rows = await bondedAtHeight(height)
    const allow = new Set(committee.map(x => x.address))
    for (const [addr, raw] of rows) {
      if (!allow.has(addr)) continue
      totalMicro += parseMicros(raw)
    }
  }

  // Report as ALEO (6 decimals).
  if (typeof api.addCGToken === 'function') {
    api.addCGToken('aleo', totalMicro)
  } else if (typeof api.addGasToken === 'function') {
    api.addGasToken('aleo', totalMicro, { decimals: 6 })
  } else {
    api.add('coingecko:aleo', Number(totalMicro) / 1e6)
  }
}

// Alias staking to tvl if you want it to appear as core TVL.
// If reviewers prefer staking-only, export { aleo: { staking } } without the alias.
const tvl = staking

module.exports = {
  methodology:
    'Fetches current committee and sums bonded ALEO (microcredits). Falls back to latest bonded-by-validator filtered to committee addresses.',
  aleo: { tvl, staking },
}
