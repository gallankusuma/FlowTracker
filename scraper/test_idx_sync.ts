import * as Sync from '@app/Backend/Sync/index.ts'

const today = new Date()
const y = today.getFullYear()
const m = String(today.getMonth() + 1).padStart(2, '0')
const d = String(today.getDate()).padStart(2, '0')
const dateStr = y.toString() + m + d

const yesterday = new Date(today)
yesterday.setDate(yesterday.getDate() - 1)
const yy = yesterday.getFullYear()
const ym = String(yesterday.getMonth() + 1).padStart(2, '0')
const ydd = String(yesterday.getDate()).padStart(2, '0')
const yd = yy.toString() + ym + ydd

console.log('=== IDX-API Test Sync ===')
console.log('Today:', dateStr, 'Yesterday:', yd)

// Step 1: Sync company profiles first
console.log('\n[1/5] Syncing company profiles...')
try { await Sync.syncCompanyProfile(); console.log('  OK') } catch(e: unknown) { console.log('  FAIL', (e as Error).message) }

// Step 2: Sync broker participants
console.log('\n[2/5] Syncing broker participants...')
try { await Sync.syncBrokerParticipant(); console.log('  OK') } catch(e: unknown) { console.log('  FAIL', (e as Error).message) }

// Step 3: Sync stock summary for today
console.log('\n[3/5] Syncing stock summary for', dateStr, '...')
try { await Sync.syncStockSummary(dateStr); console.log('  OK') } catch(e: unknown) { console.log('  FAIL', (e as Error).message) }

// Step 4: Try yesterday too
console.log('\n[4/5] Syncing stock summary for', yd, '...')
try { await Sync.syncStockSummary(yd); console.log('  OK') } catch(e: unknown) { console.log('  FAIL', (e as Error).message) }

// Step 5: Sync broker summary
console.log('\n[5/5] Syncing broker summary for', yd, '...')
try { await Sync.syncBrokerSummary(yd); console.log('  OK') } catch(e: unknown) { console.log('  FAIL', (e as Error).message) }

console.log('\n=== Done! ===')
