import snapshot from '@snapshot-labs/snapshot.js'
import { Networks } from './entities/Networks'
import { SnapshotSpace } from './interfaces/GovernanceProposal'
import { DelegationInfo, MemberInfo, STRATEGIES, Vote } from './interfaces/Members'
import { fetchDelegations, fetchGraphQL, flattenArray, parseVP, saveToCSV, saveToJSON, snapshotUrl, splitArray } from './utils'

const MAX_RETRIES = 10

const space = SnapshotSpace.DCL
const network = Networks.getEth().id.toString()

/*
* Until Snapshot makes it possible to obtain the delegated VP in a more optimal way, 
* the requests has to be done one at a time.
*/
async function fetchSnapshotScores(addresses: string[], jobId: number) {
  const snapshotScores: Record<string, number>[] = [{}, {}, {}, {}, {}, {}]
  let addressesToRetry: string[] = []
  let retries = MAX_RETRIES
  do {
    const list = [...(addressesToRetry.length > 0 ? addressesToRetry : addresses)]
    addressesToRetry = []

    for (const address of list) {
      try {
        const score = await snapshot.utils.getScores(space, STRATEGIES, network, [address])
        for (const idx in score) {
          snapshotScores[idx] = { ...snapshotScores[idx], ...score[idx] }
        }
      } catch (error) {
        addressesToRetry.push(address)
      }
    }

    if (addressesToRetry.length > 0) {
      console.log(`Job: ${jobId} - Retrying score fetch. ${addressesToRetry.length} addresses left...`)
      retries--
    }
  }
  while (addressesToRetry.length > 0 && retries > 0)

  if (retries <= 0 && addressesToRetry.length > 0) {
    throw new Error("Could not fetch snapshot scores")
  }

  return snapshotScores
}

async function getMembersInfo(addresses: string[], jobId: number) {
  console.log('Started job:', jobId)
  let snapshotScores: Record<string, number>[] = []
  let delegations: DelegationInfo = {
    givenDelegations: [],
    receivedDelegations: []
  }
  let retries = MAX_RETRIES
  do {
    try {
      const unresolvedSnapshotScores = fetchSnapshotScores(addresses, jobId)
      const unresolvedDelegations = fetchDelegations(addresses, space)

      const [snapshotScoresResult, delegationsResult] = await Promise.all([unresolvedSnapshotScores, unresolvedDelegations])
      snapshotScores = snapshotScoresResult
      delegations = delegationsResult
    } catch (e) {
      retries -= 1
      console.log('Error', e)
      console.log(`Job: ${jobId} - Retrying score fetch. Retries left ${retries}...`)
    }
  } while (snapshotScores.length === 0 && retries > 0)

  if (retries <= 0) {
    throw new Error("Could not fetch scores")
  }

  const info: MemberInfo[] = []

  for (const address of addresses) {
    const scores = [0, 0, 0, 0, 0, 0]

    for (const idx in snapshotScores) {
      scores[idx] = snapshotScores[idx][address] || 0
    }

    const delegate = delegations.givenDelegations.find(delegation => delegation.delegator.toLowerCase() === address.toLowerCase())
    const delegators = delegations.receivedDelegations.find(delegation => delegation.delegate.toLowerCase() === address.toLowerCase())

    info.push({
      address,
      avatarPreview: `https://wearable-preview.decentraland.org/?profile=${address}`,
      ...parseVP(scores),
      hasDelegated: !!delegate,
      hasDelegators: !!delegators,
      delegate: delegate?.delegate,
      delegators: delegators?.delegators,
      delegatorsAmount: delegators?.delegators.length || 0
    })
  }

  console.log(`Job: ${jobId} - Fetched: ${info.length}`)
  return info
}

async function main() {
  // Fetch Snapshot Votes
  const url = snapshotUrl()
  const where = `space_in: ["${space}"], vp_gt: 1`
  const votes = await fetchGraphQL<Vote>(url, 'votes', where, 'created', 'voter', 20000)

  const members = new Set(votes.map(v => v.voter.toLowerCase())) // Unique addresses
  console.log('Total Members:', members.size)

  const dividedAddresses = splitArray(Array.from(members), 50)
  const info = flattenArray(await Promise.all(dividedAddresses.map(getMembersInfo)))

  saveToJSON('members.json', info)
  saveToCSV('members.csv', info, [
    { id: 'address', title: 'Member' },
    { id: 'totalVP', title: 'Total VP' },
    { id: 'manaVP', title: 'MANA VP' },
    { id: 'landVP', title: 'LAND VP' },
    { id: 'namesVP', title: 'NAMES VP' },
    { id: 'delegatedVP', title: 'Delegated VP' },
    { id: 'hasDelegated', title: 'Has Delegated' },
    { id: 'delegate', title: 'Delegate' },
    { id: 'hasDelegators', title: 'Has Delegators' },
    { id: 'delegatorsAmount', title: 'Delegators Amount' },
    { id: 'delegators', title: 'Delegators' },
    { id: 'avatarPreview', title: 'Avatar Preview' }
  ])
}

main()