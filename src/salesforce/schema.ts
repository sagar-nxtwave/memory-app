// Compact catalog of the Salesforce objects/fields the planner may query. Keeping this
// explicit (rather than a live describe() call per question) keeps the planner prompt small
// and stops it inventing field names. Extend as new objects/fields are needed.
//
// Org-specific note: this org's Opportunity.StageName values include
// "Prospecting", "Pending Approval", "Generating Sales Offer", "Closed Won", "Closed Lost".

export const SALESFORCE_SCHEMA = `
Opportunity — sales deals/pipeline. This is a real-estate developer, so each Opportunity is a unit/property sale.
  Fields: Id, Name, StageName, Amount, CloseDate, Probability, Type, LeadSource, AccountId, OwnerId, IsClosed, IsWon, CreatedDate, LastModifiedDate
  Location/community/project fields (real estate):
    - Actual_Building_Community__c — the community/location/area of the sold unit. USE THIS for "which location/community/area/project has more/most …" questions (e.g. Al Qudra, Hayat Townhouse, Zahra Apartments). Groupable.
    - Plot_Area_Sq_Ft__c — plot area. Address__c — unit address.
  For the buyer's company/city, join to Account (Opportunity.Account.BillingCity / Account.BillingCountry).
  Common StageName values: 'Prospecting', 'Pending Approval', 'Generating Sales Offer', 'Closed Won', 'Closed Lost'

Account — companies/customers.
  Fields: Id, Name, Type, Industry, BillingCity, BillingCountry, Phone, OwnerId, CreatedDate

Contact — people at accounts.
  Fields: Id, Name, FirstName, LastName, Email, Phone, Title, AccountId, OwnerId, CreatedDate

Lead — unconverted prospects.
  Fields: Id, Name, Company, Status, Email, Phone, LeadSource, IsConverted, ConvertedAccountId, ConvertedOpportunityId, OwnerId, CreatedDate

Task — activities/to-dos/calls (Activity).
  Fields: Id, Subject, Status, Priority, ActivityDate, WhatId (Account/Opportunity/Case), WhoId (Contact/Lead), OwnerId, CreatedDate, IsClosed

Case — support/service cases.
  Fields: Id, CaseNumber, Subject, Status, Priority, AccountId, ContactId, OwnerId, CreatedDate
`.trim()

// Objects the planner is allowed to query — used to validate generated SOQL.
export const ALLOWED_OBJECTS = [
  'Opportunity', 'Account', 'Contact', 'Lead', 'Task', 'Case',
  'Opportunity_Property__c', 'Property_Inventory__c',
]

// Curated semantic hints per object — maps everyday words to the CORRECT field when the live
// describe list alone would mislead the planner (e.g. "location" literally matches an
// undertaker-address field, but the business-meaningful location is the unit community). These
// are shown as PREFERRED mappings ahead of the full describe list. Extend as questions reveal
// gaps; the describe list still covers everything not listed here (and custom orgs).
export const FIELD_HINTS: Record<string, string> = {
  Opportunity: [
    'location / community / area / project / where the unit is → Actual_Building_Community__c',
    'deal value / price / amount → Amount',
    'stage → StageName (values: Prospecting, Pending Approval, Generating Sales Offer, Closed Won, Closed Lost)',
    'won deals → StageName = \'Closed Won\' (or IsWon = true); lost → StageName = \'Closed Lost\'',
    'when closed / sold → CloseDate; created → CreatedDate',
    'salesperson / owner → OwnerId (name via Owner.Name); buyer company → AccountId (name via Account.Name)',
    'which account/customer has most sales/value → query Opportunity, GROUP BY Account.Name, SUM(Amount), usually WHERE StageName = \'Closed Won\'',
    'sales by salesperson → GROUP BY Owner.Name; sales by community → GROUP BY Actual_Building_Community__c',
  ].join('\n'),
  Account: [
    'location / city → BillingCity; country → BillingCountry',
    'company name → Name; industry → Industry',
  ].join('\n'),
  Property_Inventory__c: [
    'unit/property identifier → Name; unit status (sold/available/rented) → check the picklist fields on this object via describe (do not guess a field name — look for one whose label matches "status")',
    'rent → Actual_Rent_Aed__c (current) / Advertised_Rent_Aed__c (listed); cost → Actual_Cost__c',
    'area → Assignable_Area__c and the DLD_* Attribute fields (DLD Plot/Unit/Balcony/Garage/Total Area — check labels via describe, field names are generic Attribute20__c-style)',
    'address → Address__c / Address_Line_1__c..4__c',
    'to link a unit to its buyer/sale, join via Opportunity_Property__c.cm_Property_Inventory__c (this object has no direct Opportunity/Account lookup)',
  ].join('\n'),
  Opportunity_Property__c: [
    'this is a specific SOLD/booked unit\'s transaction detail — links to the sale via cm_Opportunity__c (-> Opportunity) and to the master unit record via cm_Property_Inventory__c (-> Property_Inventory__c)',
    'selling price → cm_Selling_Price__c; price per sq ft → cm_Selling_Price_Per_Sq_Ft__c; order amount → ns_Order_Amount__c',
    'unit identifier → cm_Unit__c; property name → cm_Property_Name__c; property status → cm_Property_Status__c / Property_Sale_status__c',
    'order status → cm_Order_Status__c; order date → cm_Order_Date__c',
    'area breakdown → Plot_Area__c, Saleable_Leasable_Area__c, Balcony_Area__c, Terrace_Area__c, Garage_Area__c, Total_Area__c',
    'deposit → Deposit_Recieved__c / Deposit_Amount__c',
    'building/community (also duplicated here) → Building_Name__c',
    'to find the buyer, traverse cm_Opportunity__r.Account.Name (Opportunity_Property__c -> Opportunity -> Account)',
  ].join('\n'),
  Lead: [
    'status → Status; converted? → IsConverted; source → LeadSource; company → Company',
  ].join('\n'),
  Task: [
    'activity/task subject → Subject; status → Status; date → ActivityDate; owner → OwnerId',
  ].join('\n'),
  Case: [
    'status → Status; priority → Priority; number → CaseNumber; account → AccountId',
  ].join('\n'),
}
