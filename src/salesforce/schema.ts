// Compact catalog of the Salesforce objects/fields the planner may query. Keeping this
// explicit (rather than a live describe() call per question) keeps the planner prompt small
// and stops it inventing field names. Extend as new objects/fields are needed.
//
// Org-specific note: this org's Opportunity.StageName values include
// "Prospecting", "Pending Approval", "Generating Sales Offer", "Closed Won", "Closed Lost".

export const SALESFORCE_SCHEMA = `
Opportunity — sales deals/pipeline. This is a real-estate developer, so each Opportunity is a unit/property sale.
  Standard Fields: Id, Name, StageName, Amount, CloseDate, Probability, Type, LeadSource, AccountId, IsClosed, IsWon, CreatedDate, LastModifiedDate
  Location/community/project fields (real estate):
    - Building_Community__c — the community/location/area of the sold unit. USE THIS for "which location/community/area/project has more/most …" questions (e.g. Hayat Townhouses, Shams Townhouses, Hillcrest). Groupable.
    - Building_Name__c — the building name. Groupable.
    - Plot_Area_Sq_Ft__c — plot area. Address__c — unit address.
  Sales fields:
    - cm_Sales_Person__r.Name — the salesperson who made the sale (custom lookup to User). USE THIS instead of OwnerId for "who sold", "salesperson", "agent" questions.
    - cm_Lead_Channel__c — lead channel (Direct Sale, Agent Sale, and many more — see LeadSource picklist).
    - LeadSource — original source (Contact Centre, Events/Exhibition, Referral, Website, Walk in, Email, Social Media, WhatsApp, Google_Search, etc).
    - Sales_Room__c — sales room/branch/office location (NOT property location).
    - Order_Stattus__c — order status (SOLD, TRANSFERED, BOOKED_CANCELLED, SMT_CANCELLED).
    - Order_Date__c — formal order date (may differ from booking or close date).
  Financial fields:
    - Amount — gross opportunity value.
    - Net_Amount__c — net amount after adjustments (not amount paid or outstanding).
  Booking/milestone fields:
    - Property_Booked_Date__c — actual booking date (more accurate than CloseDate for booking trends).
    - Milestone_Current_Status__c — latest handover/construction milestone. Values include: Blocked by Legal, Pending with Projects, Ready for inspection, Quality inspection approved, Customer informed, Customer appointment scheduled, Deep Cleaning Pending/Completed, Handover Completed PHP, Handover completed, etc.
    - Current_Mortgage_Status__c — Not Mortgaged / Valid / Terminated.
  Agency/agent fields:
    - cm_Agency_Name__r.Name — associated agency name.
    - cm_Agent_Name__r.Name — associated broker/agent name (external, not internal salesperson).
  For the buyer's company/city, join to Account (Opportunity.Account.BillingCity / Account.BillingCountry).
  Common StageName values: 'Generating SalesOffer', 'Pending Admin Approval', 'Closed Won', 'Closed Lost'

Account — companies/customers.
  Fields: Id, Name, Type, Industry, BillingCity, BillingCountry, Phone, OwnerId, CreatedDate
  Extended: Display_Address__c, RecordType.Name (Individual/Corporate/Retail), cm_Nationality__pc, Age__c,
    Country_of_Residence_Billing_country__c, Primary_Contact__r.Name, Opportunity_Count__c

Contact — people at accounts.
  Fields: Id, Name, FirstName, LastName, Email, Phone, Title, AccountId, OwnerId, CreatedDate, MailingAddress

Lead — unconverted prospects.
  Fields: Id, Name, Company, Status, Email, Phone, LeadSource, IsConverted, ConvertedAccountId, ConvertedOpportunityId, OwnerId, CreatedDate

Task — activities/to-dos/calls (Activity).
  Fields: Id, Subject, Status, Priority, ActivityDate, WhatId (Account/Opportunity/Case), WhoId (Contact/Lead), OwnerId, CreatedDate, IsClosed

Case — support/service cases.
  Fields: Id, CaseNumber, Subject, Status, Type, Priority, Origin, AccountId, ContactId, OwnerId, CreatedDate, ClosedDate
  Extended: Case_Type__c (parent/child filter — count only parent Cases), eService_Admin_Name__c (service category),
    RecordType.Name (case classification), Opporutniy_Name__c (linked Opportunity)
  Type values vary by org — use describe() to get actual picklist values.
  IMPORTANT: For service request metrics, filter to parent Cases only (Case_Type__c = 'Parent' or use RecordType).
`.trim()

// Objects the planner is allowed to query — used to validate generated SOQL.
export const ALLOWED_OBJECTS = [
  'Opportunity', 'Account', 'Contact', 'Lead', 'Task', 'Case',
  'Opportunity_Property__c', 'Property_Inventory__c', 'User',
]

// Curated semantic hints per object — maps everyday words to the CORRECT field when the live
// describe list alone would mislead the planner (e.g. "location" literally matches an
// undertaker-address field, but the business-meaningful location is the unit community). These
// are shown as PREFERRED mappings ahead of the full describe list. Extend as questions reveal
// gaps; the describe list still covers everything not listed here (and custom orgs).
export const FIELD_HINTS: Record<string, string> = {
  Opportunity: [
    'location / community / area / project / where the unit is → Building_Community__c',
    'deal value / price / amount → Amount; net amount → Net_Amount__c',
    'stage → StageName (values: Generating SalesOffer, Pending Admin Approval, Closed Won, Closed Lost)',
    'won deals → StageName = \'Closed Won\' (or IsWon = true); lost → StageName = \'Closed Lost\'',
    'when closed / sold → CloseDate; booked → Property_Booked_Date__c; order date → Order_Date__c',
    'salesperson / agent → cm_Sales_Person__r.Name (NOT OwnerId); buyer company → AccountId (name via Account.Name)',
    'agency → cm_Agency_Name__r.Name; external broker/agent → cm_Agent_Name__r.Name',
    'which account/customer has most sales/value → query Opportunity, GROUP BY Account.Name, SUM(Amount), usually WHERE StageName = \'Closed Won\'',
    'sales by salesperson → GROUP BY cm_Sales_Person__r.Name; sales by community → GROUP BY Building_Community__c',
    'bedroom count → Sales_Room__c; order status → Order_Stattus__c; order date → Order_Date__c',
    'lead channel → cm_Lead_Channel__c; lead source → LeadSource',
    'average deal size → AVG(Amount); win rate → count won vs total; lost deals → WHERE IsClosed = true AND IsWon = false',
    'mortgage status → Current_Mortgage_Status__c (Not Mortgaged / Valid / Terminated)',
    'milestone / handover → Milestone_Current_Status__c (Blocked by Legal, Pending with Projects, Ready for inspection, Quality inspection approved, Customer informed, Deep Cleaning Completed, Handover Completed, etc)',
    'net amount → Net_Amount__c (net after adjustments, not amount paid)',
    'booking date → Property_Booked_Date__c (better than CloseDate for booking trends)',
  ].join('\n'),
  Account: [
    'location / city → BillingCity; country → BillingCountry',
    'company name → Name; industry → Industry',
    'total revenue from this customer → query Opportunity WHERE Account.Name = X AND IsWon = true, GROUP BY Account.Name, SUM(Amount)',
    'customer type → RecordType.Name (Individual / Corporate / Retail)',
    'nationality → cm_Nationality__pc; age → Age__c; country of residence → Country_of_Residence_Billing_country__c',
    'primary contact → Primary_Contact__r.Name; opportunity count → Opportunity_Count__c',
  ].join('\n'),
  Property_Inventory__c: [
    'unit/property identifier → Name; unit status (sold/available/rented) → Property_Status__c (Available, Reserved, Booked, Sold, Blocked, Leased, Online Blocked)',
    'property type (sale/rent) → Property_Type__c (Sale, Rent, Blocked); physical type → Type__c (Villa, Apartment, Townhouse)',
    'unit configuration → Type_of_Unit__c; unit view → Unit_View__c; unit position → Unit_Position__c',
    'rent → Actual_Rent_Aed__c (current) / Advertised_Rent_Aed__c (listed); cost → Actual_Cost__c',
    'area → Assignable_Area__c and the DLD_* Attribute fields (DLD Plot/Unit/Balcony/Garage/Total Area)',
    'address → Address__c / Address_Line_1__c..4__c; building location → Building_Location_Name__c',
    'selling price → Selling_Price__c; net selling price → Net_Selling_Price__c; price per sq ft → Selling_Price_Per_Sq_Ft__c',
    'base price → Penalty_Amount__c (confusing name but it IS the base price); strategic price → Strategic_Selling_Price__c',
    'estimated completion → Estimated_Completion_Date__c; property usage → Property_Usage__c (Residential, etc)',
    'to link a unit to its buyer/sale, join via Opportunity_Property__c.cm_Property_Inventory__c',
    'units by community → GROUP BY Building_Community__c; total units → COUNT(Id)',
    'units by status → GROUP BY Property_Status__c; units by type → GROUP BY Type__c',
  ].join('\n'),
  Opportunity_Property__c: [
    'this is a specific SOLD/booked unit\'s transaction detail — links to the sale via cm_Opportunity__c (-> Opportunity) and to the master unit record via cm_Property_Inventory__c (-> Property_Inventory__c)',
    'selling price → cm_Selling_Price__c; price per sq ft → cm_Selling_Price_Per_Sq_Ft__c; order amount → ns_Order_Amount__c',
    'net selling price → Net_Selling_Price__c; net amount → Net_Amount__c; net amount incl VAT → Net_Amount_including_VAT__c',
    'unit identifier → cm_Unit__c; property name → cm_Property_Name__c; property status → cm_Property_Status__c / Property_Sale_status__c',
    'order status → cm_Order_Status__c; order date → cm_Order_Date__c',
    'area breakdown → Plot_Area__c, Saleable_Leasable_Area__c, Balcony_Area__c, Terrace_Area__c, Garage_Area__c, Total_Area__c',
    'parking → Parking_Count__c; construction status → Property_Construction_Status__c',
    'receipt clearance → Total_Receipt_Cleared__c (%); cleared amount → Receipt_Cleared_Amount__c (currency)',
    'installment clearance → Total_Installment_Cleared__c (%); invoice clearance → Invoice_Cleared_Amount__c (%)',
    'deposit → Deposit_Recieved__c / Deposit_Amount__c',
    'building/community (also duplicated here) → Building_Name__c',
    'to find the buyer, traverse cm_Opportunity__r.Account.Name (Opportunity_Property__c -> Opportunity -> Account)',
  ].join('\n'),
  Lead: [
    'status → Status; converted? → IsConverted; source → LeadSource; company → Company',
    'unconverted leads → WHERE IsConverted = false; leads by source → GROUP BY LeadSource',
  ].join('\n'),
  Task: [
    'activity/task subject → Subject; status → Status; date → ActivityDate; owner → OwnerId',
    'overdue tasks → WHERE ActivityDate < TODAY AND Status != \'Completed\'; tasks by status → GROUP BY Status; pending → WHERE Status != \'Completed\'',
  ].join('\n'),
  Case: [
    'status → Status; priority → Priority; number → CaseNumber; account → AccountId; type → Type',
    'when opened → CreatedDate; when closed → ClosedDate; intake channel → Origin',
    'service category → eService_Admin_Name__c; record type → RecordType.Name; case type (parent/child) → Case_Type__c',
    'linked opportunity → Opporutniy_Name__c (note the typo in the API name)',
    'cases by type → GROUP BY Type; cases by status → GROUP BY Status; cases by priority → GROUP BY Priority; cases by origin → GROUP BY Origin',
    'cases by service category → GROUP BY eService_Admin_Name__c; cases by record type → GROUP BY RecordType.Name',
    'open cases → WHERE ClosedDate = null; closed cases → WHERE ClosedDate != null',
    'IMPORTANT: For service request metrics, count only parent Cases (Case_Type__c filter)',
  ].join('\n'),
}
