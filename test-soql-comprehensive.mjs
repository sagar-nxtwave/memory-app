/**
 * Comprehensive SOQL NOT LIKE Verification Suite
 * Tests every pattern we teach the LLM in prompts.
 * 
 * Run: node test-soql-comprehensive.mjs
 */
import { readFileSync } from 'fs';
const envText = readFileSync('.env.local', 'utf8');
for (const line of envText.split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i === -1) continue;
  const k = t.slice(0, i).trim();
  const v = t.slice(i + 1).trim();
  if (!process.env[k]) process.env[k] = v;
}

const TOKEN_URL = process.env.SALESFORCE_LOGIN_URL + '/services/oauth2/token';
const MCP_URL = process.env.SALESFORCE_MCP_URL;
let sessionId = null;
let passed = 0, failed = 0, total = 0;

async function getToken() {
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: process.env.SALESFORCE_MCP_CLIENT_ID, client_secret: process.env.SALESFORCE_MCP_CLIENT_SECRET }) });
  return (await res.json()).access_token;
}

async function mcp(token, body) {
  const h = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (sessionId) h['mcp-session-id'] = sessionId;
  const res = await fetch(MCP_URL, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const ns = res.headers.get('mcp-session-id');
  if (ns) sessionId = ns;
  const text = await res.text();
  let r; try { r = JSON.parse(text) } catch { r = text; }
  return r;
}

async function test(token, category, label, q, expectSuccess = true) {
  total++;
  const r = await mcp(token, { jsonrpc: '2.0', id: Math.floor(Math.random() * 99999), method: 'tools/call', params: { name: 'soqlQuery', arguments: { q } } });
  const c = (r?.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  const ok = !r?.result?.isError;
  const match = ok === expectSuccess;

  if (match) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}`);
    console.log(`     Expected: ${expectSuccess ? 'SUCCESS' : 'FAILURE'}`);
    console.log(`     Got: ${ok ? 'SUCCESS' : 'FAILURE'}`);
    console.log(`     Error: ${c.slice(0, 250)}`);
  }
  console.log(`     SQL: ${q.slice(0, 150)}${q.length > 150 ? '...' : ''}`);
  console.log();
  await new Promise(r => setTimeout(r, 300));
  return match;
}

async function main() {
  console.log('=== Comprehensive SOQL NOT LIKE Verification Suite ===\n');
  const token = await getToken();
  await mcp(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } } });
  await mcp(token, { jsonrpc: '2.0', method: 'notifications/initialized' });

  // =====================================================
  // CATEGORY 1: Basic NOT LIKE syntax patterns
  // =====================================================
  console.log('--- Category 1: Basic NOT LIKE syntax ---');

  // 1a: WHERE NOT LIKE (first condition, no AND before)
  await test(token, 'basic', '1a: WHERE NOT Name LIKE (no AND)',
    "SELECT COUNT(Id) cnt FROM Opportunity WHERE NOT Name LIKE '%Miscellaneous%'");

  // 1b: WHERE x AND (NOT LIKE) - THE CRITICAL FIX
  await test(token, 'basic', '1b: WHERE x AND (NOT Name LIKE) - with parens',
    "SELECT COUNT(Id) cnt FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' AND (NOT Name LIKE '%Miscellaneous%')");

  // 1c: WHERE x AND NOT LIKE - WITHOUT parens (should fail per our testing)
  await test(token, 'basic', '1c: WHERE x AND NOT Name LIKE - without parens',
    "SELECT COUNT(Id) cnt FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' AND NOT Name LIKE '%Miscellaneous%'", false);

  // 1d: Multiple AND (NOT LIKE) conditions
  await test(token, 'basic', '1d: Multiple AND (NOT LIKE) conditions',
    "SELECT COUNT(Id) cnt FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND (NOT Name LIKE '%PK%')");

  // 1e: WHERE NOT x AND NOT y (without leading condition)
  await test(token, 'basic', '1e: WHERE NOT x AND NOT y (no leading AND)',
    "SELECT COUNT(Id) cnt FROM Opportunity WHERE NOT Name LIKE '%Miscellaneous%' AND NOT Name LIKE '%RTL%'");

  // =====================================================
  // CATEGORY 2: Prompts SOQL_MECHANICS examples
  // =====================================================
  console.log('--- Category 2: SOQL_MECHANICS prompt examples ---');

  // 2a: Line 130 example (current prompt teaches this)
  await test(token, 'prompt', '2a: SOQL_MECHANICS line 130 (current)',
    "SELECT COUNT(Id) cnt FROM Opportunity WHERE NOT Name LIKE '%Miscellaneous%' AND NOT Name LIKE '%RTL%'");

  // 2b: Line 131 example
  await test(token, 'prompt', '2b: SOQL_MECHANICS line 131',
    "SELECT COUNT(Id) cnt FROM Opportunity WHERE NOT Building_Name__c LIKE '%Al Qudra%'");

  // 2c: Line 143 example with mixed conditions
  await test(token, 'prompt', '2c: SOQL_MECHANICS line 143 (mixed conditions)',
    "SELECT COUNT(Id) cnt FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' AND (NOT Name LIKE '%pattern%') AND Amount > 100");

  // =====================================================
  // CATEGORY 3: FIELD_HINTS mandatory exclusions (schema.ts line 93)
  // =====================================================
  console.log('--- Category 3: FIELD_HINTS mandatory exclusions ---');

  // 3a: All 7 exclusions combined
  await test(token, 'fieldhints', '3a: All 7 mandatory exclusions',
    "SELECT COUNT(Id) cnt FROM Opportunity WHERE (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND (NOT Name LIKE '%PK%') AND (NOT Name LIKE '%Plot%') AND (NOT Building_Community__c LIKE '%Al Qudra%') AND (NOT Building_Name__c LIKE '%Al Qudra%') AND (NOT Building_Name__c LIKE '%parking%')");

  // 3b: Exclusions with other conditions
  await test(token, 'fieldhints', '3b: Exclusions + Sold_By_Nshama + dates',
    "SELECT COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' AND Order_Date__c >= 2026-01-01 AND Order_Date__c <= 2026-12-31 AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND (NOT Name LIKE '%PK%') AND (NOT Name LIKE '%Plot%') AND (NOT Building_Name__c LIKE '%Al Qudra%') AND (NOT Building_Name__c LIKE '%Alqudra%') AND (NOT Building_Name__c LIKE '%ALQDR%') AND (NOT Building_Name__c LIKE '%parking%') AND Amount != 1 AND CloseDate != 2032-12-28");

  // =====================================================
  // CATEGORY 4: DATA_QUALITY Account exclusions (mcp-query.ts line 236)
  // =====================================================
  console.log('--- Category 4: Account exclusion patterns ---');

  // 4a: Account exclusions alone
  await test(token, 'account', '4a: Account exclusions (4 NOT LIKE)',
    "SELECT COUNT(Id) cnt FROM Account WHERE (NOT Name LIKE 'Test%') AND (NOT Name LIKE 'Do not update%') AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%Contractor%')");

  // 4b: Account exclusions with other conditions
  await test(token, 'account', '4b: Account exclusions + Industry',
    "SELECT COUNT(Id) cnt FROM Account WHERE Industry = 'Real Estate' AND (NOT Name LIKE 'Test%') AND (NOT Name LIKE 'Do not update%') AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%Contractor%')");

  // =====================================================
  // CATEGORY 5: Cross-check queries (cross-check.ts line 53)
  // =====================================================
  console.log('--- Category 5: Cross-check Account query ---');

  // 5a: Exact cross-check query
  await test(token, 'crosscheck', '5a: Cross-check Account query',
    "SELECT COUNT(Id) cnt FROM Account WHERE (NOT Name LIKE 'Test%') AND (NOT Name LIKE 'Do not update%') AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%Contractor%')");

  // =====================================================
  // CATEGORY 6: Query builder output patterns
  // =====================================================
  console.log('--- Category 6: Query builder patterns ---');

  // 6a: buildOpportunityQuery default filters
  await test(token, 'builder', '6a: buildOpportunityQuery full defaults',
    "SELECT COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND (NOT Name LIKE '%PK%') AND (NOT Name LIKE '%Plot%') AND (NOT Building_Name__c LIKE '%Al Qudra%') AND (NOT Building_Name__c LIKE '%Alqudra%') AND (NOT Building_Name__c LIKE '%ALQDR%') AND (NOT Building_Name__c LIKE '%parking%') AND Amount != 1 AND CloseDate != 2032-12-28");

  // 6b: buildOpportunityQuery with date range
  await test(token, 'builder', '6b: Builder + date range',
    "SELECT COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' AND Order_Date__c >= 2026-01-01 AND Order_Date__c <= 2026-12-31 AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND (NOT Name LIKE '%PK%') AND (NOT Name LIKE '%Plot%') AND (NOT Building_Name__c LIKE '%Al Qudra%') AND (NOT Building_Name__c LIKE '%parking%')");

  // =====================================================
  // CATEGORY 7: Complex real-world queries
  // =====================================================
  console.log('--- Category 7: Complex real-world queries ---');

  // 7a: Sales summary with all exclusions + GROUP BY
  await test(token, 'complex', '7a: Sales by building with exclusions + GROUP BY',
    "SELECT Building_Name__c, COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND (NOT Name LIKE '%PK%') AND (NOT Name LIKE '%Plot%') AND (NOT Building_Name__c LIKE '%Al Qudra%') AND (NOT Building_Name__c LIKE '%parking%') AND Amount != 1 AND CloseDate != 2032-12-28 AND Building_Name__c != null GROUP BY Building_Name__c ORDER BY SUM(Net_Amount__c) DESC");

  // 7b: Sales with IN clause + NOT LIKE
  await test(token, 'complex', '7b: IN clause + NOT LIKE',
    "SELECT COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' AND StageName IN ('Closed Won', 'Closed Lost') AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND (NOT Name LIKE '%PK%') AND (NOT Name LIKE '%Plot%')");

  // 7c: Sales with OR condition + NOT LIKE
  await test(token, 'complex', '7c: OR + NOT LIKE',
    "SELECT COUNT(Id) cnt FROM Opportunity WHERE (Building_Name__c LIKE '%Tower%' OR Building_Community__c LIKE '%Tower%') AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND IsWon = true");

  // 7d: Sales with subquery-like conditions + NOT LIKE
  await test(token, 'complex', '7d: Multiple date fields + NOT LIKE',
    "SELECT COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' AND Property_Booked_Date__c >= 2026-01-01 AND Property_Booked_Date__c <= 2026-12-31 AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND (NOT Name LIKE '%PK%') AND (NOT Name LIKE '%Plot%') AND (NOT Building_Name__c LIKE '%Al Qudra%') AND (NOT Building_Name__c LIKE '%parking%') AND Amount != 1");

  // 7e: Case query with NOT IN + NOT LIKE combo
  await test(token, 'complex', '7e: NOT IN + NOT LIKE combo',
    "SELECT COUNT(Id) cnt FROM Case WHERE Type != 'Other' AND (NOT Subject LIKE '%test%') AND (NOT Subject LIKE '%Test%')");

  // 7f: Account with relationship traversal + NOT LIKE
  await test(token, 'complex', '7f: Relationship + NOT LIKE',
    "SELECT COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE Account.Name LIKE '%Nshama%' AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND Sold_By_Nshama__c = 'NEW SALE'");

  // 7g: Aggregate with HAVING + NOT LIKE
  await test(token, 'complex', '7g: HAVING + NOT LIKE',
    "SELECT Building_Name__c, COUNT(Id) cnt FROM Opportunity WHERE (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND (NOT Building_Name__c LIKE '%Al Qudra%') AND Building_Name__c != null GROUP BY Building_Name__c HAVING COUNT(Id) > 5 ORDER BY COUNT(Id) DESC");

  // 7h: Complex date functions + NOT LIKE
  await test(token, 'complex', '7h: CALENDAR_YEAR + NOT LIKE',
    "SELECT CALENDAR_YEAR(Order_Date__c) year, COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND (NOT Name LIKE '%PK%') AND (NOT Name LIKE '%Plot%') AND (NOT Building_Name__c LIKE '%Al Qudra%') AND (NOT Building_Name__c LIKE '%parking%') AND Amount != 1 AND CloseDate != 2032-12-28 GROUP BY CALENDAR_YEAR(Order_Date__c) ORDER BY CALENDAR_YEAR(Order_Date__c)");

  // 7i: Exactly reproducing the user's failing query
  await test(token, 'reproduce', '7i: EXACT failing query from user logs (with parens)',
    "SELECT COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' AND Order_Date__c >= 2026-01-01 AND Order_Date__c <= 2026-12-31 AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND (NOT Name LIKE '%PK%') AND (NOT Name LIKE '%Plot%') AND (NOT Building_Name__c LIKE '%Al Qudra%') AND (NOT Building_Name__c LIKE '%Alqudra%') AND (NOT Building_Name__c LIKE '%ALQDR%') AND (NOT Building_Name__c LIKE '%parking%') AND Amount != 1 AND CloseDate != 2032-12-28");

  // =====================================================
  // CATEGORY 8: Edge cases
  // =====================================================
  console.log('--- Category 8: Edge cases ---');

  // 8a: Building_Name__c NOT LIKE with parentheses
  await test(token, 'edge', '8a: Building_Name exclusions only',
    "SELECT COUNT(Id) cnt FROM Opportunity WHERE (NOT Building_Name__c LIKE '%Al Qudra%') AND (NOT Building_Name__c LIKE '%Alqudra%') AND (NOT Building_Name__c LIKE '%ALQDR%') AND (NOT Building_Name__c LIKE '%parking%')");

  // 8b: Mix of NOT LIKE and NOT IN
  await test(token, 'edge', '8b: NOT LIKE + NOT IN mix',
    "SELECT COUNT(Id) cnt FROM Opportunity WHERE (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND StageName NOT IN ('Prospecting', 'Qualification')");

  // 8c: NOT LIKE with single quotes in pattern
  await test(token, 'edge', '8c: NOT LIKE with special pattern',
    "SELECT COUNT(Id) cnt FROM Opportunity WHERE (NOT Name LIKE '%test record%') AND (NOT Name LIKE '%demo%')");

  // 8d: Very long chain of NOT LIKE
  await test(token, 'edge', '8d: 10 NOT LIKE conditions',
    "SELECT COUNT(Id) cnt FROM Opportunity WHERE (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND (NOT Name LIKE '%PK%') AND (NOT Name LIKE '%Plot%') AND (NOT Name LIKE '%test%') AND (NOT Name LIKE '%demo%') AND (NOT Name LIKE '%sample%') AND (NOT Name LIKE '%dummy%') AND (NOT Name LIKE '%old%') AND (NOT Name LIKE '%archive%')");

  // 8e: NOT LIKE with LIKE in same query (both directions)
  await test(token, 'edge', '8e: LIKE + NOT LIKE mixed',
    "SELECT COUNT(Id) cnt FROM Opportunity WHERE Building_Name__c LIKE '%Tower%' AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%')");

  // =====================================================
  // RESULTS
  // =====================================================
  console.log('========================================');
  console.log(`RESULTS: ${passed}/${total} passed, ${failed} failed`);
  console.log('========================================');

  if (failed > 0) {
    console.log('\n⚠️  Some tests failed. These patterns need adjustment.');
  } else {
    console.log('\n✅ All patterns verified against live Salesforce.');
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
