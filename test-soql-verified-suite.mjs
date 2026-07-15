/**
 * Comprehensive SOQL Query Verification Suite
 * Tests every complex pattern the LLM would generate.
 * Each query is tagged as VALID (should succeed) or INVALID (should fail).
 *
 * Run: node test-soql-verified-suite.mjs
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

async function test(token, category, label, q, expectSuccess) {
  total++;
  const r = await mcp(token, { jsonrpc: '2.0', id: Math.floor(Math.random() * 99999), method: 'tools/call', params: { name: 'soqlQuery', arguments: { q } } });
  const c = (r?.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  const ok = !r?.result?.isError;
  const match = ok === expectSuccess;
  const icon = match ? '✅' : '❌';

  if (match) passed++; else failed++;
  console.log(`  ${icon} [${category}] ${label}`);
  if (!match) {
    console.log(`     Expected: ${expectSuccess ? 'SUCCESS' : 'FAILURE'}`);
    console.log(`     Got: ${ok ? 'SUCCESS' : 'FAILURE'}`);
    console.log(`     Error: ${c.slice(0, 200)}`);
  }
  await new Promise(r => setTimeout(r, 250));
  return match;
}

async function main() {
  console.log('=== Verified SOQL Query Suite ===\n');
  const token = await getToken();
  await mcp(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } } });
  await mcp(token, { jsonrpc: '2.0', method: 'notifications/initialized' });

  // ============================================================
  // SECTION A: VALID QUERIES (should succeed)
  // ============================================================
  console.log('--- A: VALID Complex Queries ---');

  // A1: Sales summary with all exclusions + date range (the "sales of 2026" query)
  await test(token, 'VALID', 'A1: Sales 2026 with all exclusions',
    "SELECT COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' AND Order_Date__c >= 2026-01-01 AND Order_Date__c <= 2026-12-31 AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND (NOT Name LIKE '%PK%') AND (NOT Name LIKE '%Plot%') AND (NOT Building_Name__c LIKE '%Al Qudra%') AND (NOT Building_Name__c LIKE '%Alqudra%') AND (NOT Building_Name__c LIKE '%ALQDR%') AND (NOT Building_Name__c LIKE '%parking%') AND Amount != 1 AND CloseDate != 2032-12-28", true);

  // A2: Sales by building with GROUP BY + exclusions
  await test(token, 'VALID', 'A2: Sales by building (GROUP BY)',
    "SELECT Building_Name__c, COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND (NOT Name LIKE '%PK%') AND (NOT Name LIKE '%Plot%') AND (NOT Building_Name__c LIKE '%Al Qudra%') AND (NOT Building_Name__c LIKE '%parking%') AND Amount != 1 AND CloseDate != 2032-12-28 AND Building_Name__c != null GROUP BY Building_Name__c ORDER BY SUM(Net_Amount__c) DESC", true);

  // A3: Sales by salesperson with exclusions
  await test(token, 'VALID', 'A3: Sales by salesperson (GROUP BY)',
    "SELECT cm_Sales_Person__r.Name, COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND (NOT Name LIKE '%PK%') AND (NOT Name LIKE '%Plot%') AND (NOT Building_Name__c LIKE '%Al Qudra%') AND (NOT Building_Name__c LIKE '%parking%') AND Amount != 1 AND CloseDate != 2032-12-28 AND cm_Sales_Person__r.Name != null GROUP BY cm_Sales_Person__r.Name ORDER BY SUM(Net_Amount__c) DESC", true);

  // A4: Customer lookup with relationship traversal
  await test(token, 'VALID', 'A4: Customer lookup (Account.Name)',
    "SELECT Name, Account.Name, Account.Phone, Account.Email__c, Net_Amount__c, Order_Date__c, Milestone_Current_Status__c FROM Opportunity WHERE Building_Name__c LIKE '%Tower%' AND Name LIKE '%TH-V-6%' AND IsWon = true", true);

  // A5: Sales with IN clause + NOT LIKE
  await test(token, 'VALID', 'A5: IN clause + NOT LIKE',
    "SELECT COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' AND StageName IN ('Closed Won', 'Closed Lost') AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND (NOT Name LIKE '%PK%') AND (NOT Name LIKE '%Plot%')", true);

  // A6: OR condition + NOT LIKE
  await test(token, 'VALID', 'A6: OR + NOT LIKE',
    "SELECT COUNT(Id) cnt FROM Opportunity WHERE (Building_Name__c LIKE '%Tower%' OR Building_Community__c LIKE '%Tower%') AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND IsWon = true", true);

  // A7: HAVING clause
  await test(token, 'VALID', 'A7: HAVING + NOT LIKE',
    "SELECT Building_Name__c, COUNT(Id) cnt FROM Opportunity WHERE (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND (NOT Building_Name__c LIKE '%Al Qudra%') AND Building_Name__c != null GROUP BY Building_Name__c HAVING COUNT(Id) > 5 ORDER BY COUNT(Id) DESC", true);

  // A8: CALENDAR_YEAR aggregation
  await test(token, 'VALID', 'A8: CALENDAR_YEAR + NOT LIKE',
    "SELECT CALENDAR_YEAR(Order_Date__c) year, COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND (NOT Name LIKE '%PK%') AND (NOT Name LIKE '%Plot%') AND (NOT Building_Name__c LIKE '%Al Qudra%') AND (NOT Building_Name__c LIKE '%parking%') AND Amount != 1 AND CloseDate != 2032-12-28 GROUP BY CALENDAR_YEAR(Order_Date__c) ORDER BY CALENDAR_YEAR(Order_Date__c)", true);

  // A9: CALENDAR_MONTH aggregation
  await test(token, 'VALID', 'A9: CALENDAR_MONTH trends',
    "SELECT CALENDAR_MONTH(Order_Date__c) month, COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' AND CALENDAR_YEAR(Order_Date__c) = 2026 AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND (NOT Name LIKE '%PK%') AND (NOT Name LIKE '%Plot%') AND (NOT Building_Name__c LIKE '%Al Qudra%') AND (NOT Building_Name__c LIKE '%parking%') AND Amount != 1 AND CloseDate != 2032-12-28 GROUP BY CALENDAR_MONTH(Order_Date__c) ORDER BY CALENDAR_MONTH(Order_Date__c)", true);

  // A10: Account exclusion query (cross-check)
  await test(token, 'VALID', 'A10: Account exclusions',
    "SELECT COUNT(Id) cnt FROM Account WHERE (NOT Name LIKE 'Test%') AND (NOT Name LIKE 'Do not update%') AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%Contractor%')", true);

  // A11: Account with Industry filter
  await test(token, 'VALID', 'A11: Account + Industry',
    "SELECT COUNT(Id) cnt FROM Account WHERE Industry = 'Real Estate' AND (NOT Name LIKE 'Test%') AND (NOT Name LIKE 'Do not update%') AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%Contractor%')", true);

  // A12: Property_Inventory__c community list
  await test(token, 'VALID', 'A12: Property communities (GROUP BY)',
    "SELECT Building_Community__c, COUNT(Id) cnt FROM Property_Inventory__c WHERE Building_Community__c != null GROUP BY Building_Community__c ORDER BY COUNT(Id) DESC", true);

  // A13: Case summary
  await test(token, 'VALID', 'A13: Case summary',
    "SELECT COUNT(Id) cnt FROM Case", true);

  // A14: Case by Type
  await test(token, 'VALID', 'A14: Case by Type (GROUP BY)',
    "SELECT Type, COUNT(Id) cnt FROM Case WHERE Type != null GROUP BY Type ORDER BY COUNT(Id) DESC", true);

  // A15: Case DLP with electrical
  await test(token, 'VALID', 'A15: DLP cases (Subject LIKE)',
    "SELECT COUNT(Id) cnt FROM Case WHERE Subject LIKE '%DLP%' AND Electrical_Sub_Category__c != null", true);

  // A16: Transfer analysis
  await test(token, 'VALID', 'A16: Transfer analysis',
    "SELECT COUNT(Id) cnt FROM Opportunity WHERE Order_Stattus__c = 'TRANSFERED' AND Sold_By_Nshama__c = 'NEW SALE' AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%')", true);

  // A17: Cancellation analysis
  await test(token, 'VALID', 'A17: Cancellation analysis',
    "SELECT COUNT(Id) cnt FROM Opportunity WHERE Order_Stattus__c IN ('SMT_CANCELLED', 'PMT_CANCELLED', 'BOOKED_CANCELLED', 'RESERVED_CANCELLED', 'CANCELLED') AND Sold_By_Nshama__c = 'NEW SALE' AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%')", true);

  // A18: Sales by bedroom type
  await test(token, 'VALID', 'A18: Sales by Sales_Room__c',
    "SELECT Sales_Room__c, COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' AND Sales_Room__c != null AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND Amount != 1 AND CloseDate != 2032-12-28 GROUP BY Sales_Room__c ORDER BY SUM(Net_Amount__c) DESC", true);

  // A19: Simple count (no exclusions needed for non-Opportunity)
  await test(token, 'VALID', 'A19: Simple Property count',
    "SELECT COUNT(Id) cnt FROM Property_Inventory__c", true);

  // A20: Property by status
  await test(token, 'VALID', 'A20: Property by status',
    "SELECT Property_Status__c, COUNT(Id) cnt FROM Property_Inventory__c WHERE Property_Status__c != null GROUP BY Property_Status__c ORDER BY COUNT(Id) DESC", true);

  // A21: Lead by source
  await test(token, 'VALID', 'A21: Lead by source',
    "SELECT LeadSource, COUNT(Id) cnt FROM Lead WHERE LeadSource != null GROUP BY LeadSource ORDER BY COUNT(Id) DESC", true);

  // A22: Task summary
  await test(token, 'VALID', 'A22: Task summary',
    "SELECT COUNT(Id) cnt FROM Task", true);

  // A23: 10 NOT LIKE conditions (maximum exclusions)
  await test(token, 'VALID', 'A23: 10 NOT LIKE conditions',
    "SELECT COUNT(Id) cnt FROM Opportunity WHERE (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND (NOT Name LIKE '%PK%') AND (NOT Name LIKE '%Plot%') AND (NOT Name LIKE '%test%') AND (NOT Name LIKE '%demo%') AND (NOT Name LIKE '%sample%') AND (NOT Name LIKE '%dummy%') AND (NOT Name LIKE '%old%') AND (NOT Name LIKE '%archive%')", true);

  // A24: Building exclusion only (no Name exclusions)
  await test(token, 'VALID', 'A24: Building exclusions only',
    "SELECT COUNT(Id) cnt FROM Opportunity WHERE (NOT Building_Name__c LIKE '%Al Qudra%') AND (NOT Building_Name__c LIKE '%Alqudra%') AND (NOT Building_Name__c LIKE '%ALQDR%') AND (NOT Building_Name__c LIKE '%parking%')", true);

  // A25: Mixed LIKE and NOT LIKE
  await test(token, 'VALID', 'A25: LIKE + NOT LIKE mixed',
    "SELECT COUNT(Id) cnt FROM Opportunity WHERE Building_Name__c LIKE '%Tower%' AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%')", true);

  // A26: NOT LIKE + NOT IN combo
  await test(token, 'VALID', 'A26: NOT LIKE + NOT IN',
    "SELECT COUNT(Id) cnt FROM Opportunity WHERE (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND StageName NOT IN ('Prospecting', 'Qualification')", true);

  // A27: Fuzzy search pattern
  await test(token, 'VALID', 'A27: Fuzzy search (Name LIKE)',
    "SELECT Name, Account.Name, Net_Amount__c, Order_Date__c FROM Opportunity WHERE Name LIKE '%TH-V-6%' AND IsWon = true", true);

  // A28: Milestone status
  await test(token, 'VALID', 'A28: Milestone status',
    "SELECT Milestone_Current_Status__c, COUNT(Id) cnt FROM Opportunity WHERE Milestone_Current_Status__c != null AND IsWon = true GROUP BY Milestone_Current_Status__c ORDER BY COUNT(Id) DESC", true);

  // A29: Sales by community via Property_Inventory__c
  await test(token, 'VALID', 'A29: Sales by community (Property_Inventory)',
    "SELECT Building_Community__c, COUNT(Id) cnt FROM Property_Inventory__c WHERE Building_Community__c != null GROUP BY Building_Community__c ORDER BY Building_Community__c", true);

  // A30: Opportunity IsWon summary
  await test(token, 'VALID', 'A30: IsWon summary',
    "SELECT IsWon, COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE IsClosed = true GROUP BY IsWon", true);

  // ============================================================
  // SECTION B: INVALID QUERIES (should fail — these are what the LLM must NOT generate)
  // ============================================================
  console.log('\n--- B: INVALID Queries (should fail) ---');

  // B1: Name NOT LIKE (wrong syntax)
  await test(token, 'INVALID', 'B1: Name NOT LIKE (wrong syntax)',
    "SELECT COUNT(Id) cnt FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' AND Name NOT LIKE '%Miscellaneous%'", false);

  // B2: LIMIT on aggregate without GROUP BY
  await test(token, 'INVALID', 'B2: LIMIT on aggregate',
    "SELECT COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' LIMIT 10", false);

  // B3: WHERE AND
  await test(token, 'INVALID', 'B3: WHERE AND (stray AND)',
    "SELECT COUNT(Id) cnt FROM Opportunity WHERE AND Sold_By_Nshama__c = 'NEW SALE'", false);

  // B4: Double WHERE
  await test(token, 'INVALID', 'B4: Double WHERE',
    "SELECT COUNT(Id) cnt FROM Opportunity WHERE WHERE Sold_By_Nshama__c = 'NEW SALE'", false);

  // B5: Building_Community__c GROUP BY on Opportunity (platform restriction)
  await test(token, 'INVALID', 'B5: Building_Community GROUP BY Opportunity',
    "SELECT Building_Community__c, COUNT(Id) cnt FROM Opportunity WHERE Building_Community__c != null GROUP BY Building_Community__c", false);

  // B6: Quoted date literal (must be unquoted)
  await test(token, 'INVALID', 'B6: Quoted date literal',
    "SELECT COUNT(Id) cnt FROM Opportunity WHERE Order_Date__c >= '2026-01-01'", false);

  // B7: NOT LIKE with AND (no parens, multiple conditions)
  await test(token, 'INVALID', 'B7: AND NOT LIKE (no parens, multiple)',
    "SELECT COUNT(Id) cnt FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' AND NOT Name LIKE '%Miscellaneous%' AND NOT Name LIKE '%RTL%'", false);

  // B8: WHERE NOT x AND NOT y (no leading AND, multiple NOT LIKE)
  await test(token, 'INVALID', 'B8: WHERE NOT x AND NOT y (no parens)',
    "SELECT COUNT(Id) cnt FROM Opportunity WHERE NOT Name LIKE '%Miscellaneous%' AND NOT Name LIKE '%RTL%'", false);

  console.log('\n========================================');
  console.log(`RESULTS: ${passed}/${total} passed, ${failed} failed`);
  console.log('========================================');

  if (failed > 0) {
    console.log('\n⚠️  Some tests failed. Check the patterns above.');
  } else {
    console.log('\n✅ All patterns verified against live Salesforce.');
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
