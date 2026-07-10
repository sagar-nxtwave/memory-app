// Business/semantic layer for the Salesforce org. describe() gives field NAMES and TYPES but
// not MEANING — this glossary encodes how THIS business interprets its data so the planner
// builds business-correct queries and answers don't mislead (e.g. "Closed Lost" is not always
// a failed sale). Extend this as new domain docs arrive — no code change, no per-question
// patching. This is the scalable answer to "users can ask anything".
//
// Seeded from the client's "Customer and Property Information" documentation (2026-07).

export const SALESFORCE_GLOSSARY = `
BUSINESS RULES (Nshama — real-estate developer). Apply these when building SOQL:

OBJECT MODEL — how "units"/"properties" relate to sales (this is the association graph; use it instead of guessing):
- Property_Inventory__c = the MASTER list of every physical unit (~17,000 records) — sold, available, or rented. This is the object for "how many units", "list units", "available units" questions that are NOT about a specific sale.
- Opportunity = one sale/deal. Each Opportunity roughly corresponds to one unit transaction, and carries its own summary fields (Building_Name__c, Actual_Building_Community__c, Amount).
- Opportunity_Property__c = the DETAILED transaction record for a sold unit. It links OUT to both: cm_Opportunity__c -> Opportunity (the deal), and cm_Property_Inventory__c -> Property_Inventory__c (the master unit record). Use this object when a question needs the fuller unit/transaction detail (selling price per sq ft, area breakdown, order status) rather than just the Opportunity's own fields.
- To go from a sold unit's detail to its buyer: Opportunity_Property__c.cm_Opportunity__r.Account.Name (double relationship hop). To go from a master inventory unit to whether/how it sold, you'd need Opportunity_Property__c WHERE cm_Property_Inventory__c = '<id>' (Property_Inventory__c has no direct outbound link to Opportunity/Account).
- "Show me units data" / "units for [building/account]" is ambiguous between these three objects — pick Property_Inventory__c for general inventory questions, Opportunity for sale-summary questions, Opportunity_Property__c for sold-unit transaction detail. If genuinely ambiguous, prefer Opportunity (it already has community/building fields and is usually what "which units sold" means).

WHAT AN OPPORTUNITY IS
- Each Opportunity = one property/unit transaction. StageName ALONE is not enough — also consider Order_Stattus__c (note the org's spelling: "Order_Stattus__c").

TRANSACTION STATUS (StageName) + ORDER STATUS (Order_Stattus__c):
- "Closed Won" = the customer successfully ACQUIRED the unit:
    • Order_Stattus__c = 'SOLD'       → bought directly from the developer.
    • Order_Stattus__c = 'TRANSFERED' → acquired via ownership transfer from another customer.
- "Closed Lost" does NOT always mean a failed sale:
    • Order_Stattus__c = 'BOOKED_CANCELLED' → booked then cancelled before completing (a genuine non-sale).
    • Order_Stattus__c = 'SMT_CANCELLED'    → the customer PREVIOUSLY OWNED the unit and later resold/transferred it out (the original purchase DID happen).

DEFINITION OF A SALE (use this unless the user explicitly asks about cancellations/losses):
- A completed sale = StageName = 'Closed Won' AND Order_Stattus__c IN ('SOLD','TRANSFERED'). Apply BOTH conditions for "sales", "units sold", "how much sold", "sales value", etc.
- "direct developer sales" → Order_Stattus__c = 'SOLD'. "resale/transfer in" → 'TRANSFERED'.
- "cancelled bookings" → Order_Stattus__c = 'BOOKED_CANCELLED'. "resales/owner transfers out" → 'SMT_CANCELLED'.
- Do NOT report raw "Closed Lost" as "lost/failed deals" without checking Order_Stattus__c.

SALES DATES:
- Order_Date__c = the purchase / booking date. USE Order_Date__c for time filters like "last month", "this quarter", "in 2025" — NOT CloseDate — when the question is about when a sale/booking happened.
- Example: "how much sale happened last month" → WHERE Order_Date__c = LAST_MONTH AND StageName = 'Closed Won' AND Order_Stattus__c IN ('SOLD','TRANSFERED').

SALES VALUE:
- Sale/booking value = the Net_Amount__c field (a SINGLE field — do NOT combine it with Amount via COALESCE/CASE; SOQL doesn't support those). "Total sales by X" = SUM(Net_Amount__c) over completed sales, grouped by Account.Name (buyer), Actual_Building_Community__c (community), or Owner.Name / cm_Sales_Person__r.Name (salesperson).
- CRITICAL: Net_Amount__c is NULL on some records, and SOQL orders NULLS FIRST by default — so ALWAYS add "AND Net_Amount__c != null" whenever you SUM/AVG or ORDER BY it, otherwise null-amount catch-all accounts (e.g. "Miscellaneous Expression of Interest") wrongly rank at the top.

DEDUP:
- The SAME unit can appear as multiple Opportunity rows (re-booking, cancellation, resale, transfer). When counting UNITS/PROPERTIES, prefer COUNT(DISTINCT <unit field, e.g. Name>). When counting TRANSACTIONS, COUNT(Id) is correct. State which you used.
`.trim()

// Short interpretation note appended to the answer context so the final response explains
// status nuances correctly (kept brief to not bloat every answer).
export const SALESFORCE_ANSWER_NOTE = `Interpretation: "Closed Won" = completed acquisition (direct SOLD or TRANSFERED). "Closed Lost" may be a cancelled booking (BOOKED_CANCELLED) OR a later resale of a completed unit (SMT_CANCELLED) — do not call the latter a failed sale. The same unit can appear in multiple rows. If the headline total is empty/zero but a BREAKDOWN is provided, do NOT just say "no data" — state the zero clearly AND summarise what exists (e.g. "0 completed sales last month; 19 deals in progress — 13 pending approval, 6 generating offer").`
