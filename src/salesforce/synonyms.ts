// Semantic synonym dictionary — maps user terms to Salesforce field names and values.
// The LLM never needs to know field names; it works with natural language terms.

export interface SynonymEntry {
  field: string
  value?: string
  object?: string
  description: string
}

export const SYNONYMS: Record<string, SynonymEntry> = {
  // Community/Location
  'hayat': { field: 'Building_Community__c', value: 'Hayat Townhouses', object: 'Opportunity', description: 'Hayat Townhouses community' },
  'shams': { field: 'Building_Community__c', value: 'Shams Townhouses', object: 'Opportunity', description: 'Shams Townhouses community' },
  'hillcrest': { field: 'Building_Community__c', value: 'Hillcrest', object: 'Opportunity', description: 'Hillcrest community' },
  'community': { field: 'Building_Community__c', object: 'Opportunity', description: 'community/location of the unit' },
  'location': { field: 'Building_Community__c', object: 'Opportunity', description: 'community/location of the unit' },
  'project': { field: 'Building_Community__c', object: 'Opportunity', description: 'community/location of the unit' },

  // Building
  'building': { field: 'Building_Name__c', object: 'Opportunity', description: 'building name' },
  'building name': { field: 'Building_Name__c', object: 'Opportunity', description: 'building name' },

  // Salesperson
  'salesperson': { field: 'cm_Sales_Person__r.Name', object: 'Opportunity', description: 'salesperson name' },
  'sales person': { field: 'cm_Sales_Person__r.Name', object: 'Opportunity', description: 'salesperson name' },
  'agent': { field: 'cm_Sales_Person__r.Name', object: 'Opportunity', description: 'salesperson/agent name' },
  'who sold': { field: 'cm_Sales_Person__r.Name', object: 'Opportunity', description: 'salesperson who made the sale' },
  'who sold it': { field: 'cm_Sales_Person__r.Name', object: 'Opportunity', description: 'salesperson who made the sale' },
  'sold by': { field: 'cm_Sales_Person__r.Name', object: 'Opportunity', description: 'salesperson who made the sale' },

  // Salesperson names (from real data)
  'latifa': { field: 'cm_Sales_Person__r.Name', value: 'Latifa Mohamed', object: 'Opportunity', description: 'Latifa Mohamed salesperson' },
  'kamil': { field: 'cm_Sales_Person__r.Name', value: 'Kamil Mirzoyev', object: 'Opportunity', description: 'Kamil Mirzoyev salesperson' },
  'sidharth': { field: 'cm_Sales_Person__r.Name', value: 'Sidharth Mishra', object: 'Opportunity', description: 'Sidharth Mishra salesperson' },

  // Lead Channel
  'channel': { field: 'cm_Lead_Channel__c', object: 'Opportunity', description: 'lead channel' },
  'lead channel': { field: 'cm_Lead_Channel__c', object: 'Opportunity', description: 'lead channel' },
  'how did they find us': { field: 'cm_Lead_Channel__c', object: 'Opportunity', description: 'lead channel' },
  'source': { field: 'cm_Lead_Channel__c', object: 'Opportunity', description: 'lead channel' },
  'direct sale': { field: 'cm_Lead_Channel__c', value: 'Direct Sale', object: 'Opportunity', description: 'direct sale channel' },
  'agent sale': { field: 'cm_Lead_Channel__c', value: 'Agent Sale', object: 'Opportunity', description: 'agent sale channel' },

  // Bedroom
  'bedroom': { field: 'Sales_Room__c', object: 'Opportunity', description: 'bedroom count' },
  'bedrooms': { field: 'Sales_Room__c', object: 'Opportunity', description: 'bedroom count' },
  'room': { field: 'Sales_Room__c', object: 'Opportunity', description: 'bedroom count' },

  // Stage
  'stage': { field: 'StageName', object: 'Opportunity', description: 'deal stage' },
  'pipeline': { field: 'StageName', object: 'Opportunity', description: 'deal stage' },
  'won': { field: 'StageName', value: 'Closed Won', object: 'Opportunity', description: 'closed won deals' },
  'lost': { field: 'StageName', value: 'Closed Lost', object: 'Opportunity', description: 'closed lost deals' },
  'closed won': { field: 'StageName', value: 'Closed Won', object: 'Opportunity', description: 'closed won deals' },
  'closed lost': { field: 'StageName', value: 'Closed Lost', object: 'Opportunity', description: 'closed lost deals' },
  'open': { field: 'IsClosed', value: 'false', object: 'Opportunity', description: 'open deals' },
  'open deals': { field: 'IsClosed', value: 'false', object: 'Opportunity', description: 'open deals' },
  'in progress': { field: 'IsClosed', value: 'false', object: 'Opportunity', description: 'open deals' },
  'prospecting': { field: 'StageName', value: 'Prospecting', object: 'Opportunity', description: 'prospecting stage' },
  'pending approval': { field: 'StageName', value: 'Pending Approval', object: 'Opportunity', description: 'pending approval stage' },
  'generating sales offer': { field: 'StageName', value: 'Generating Sales Offer', object: 'Opportunity', description: 'generating sales offer stage' },

  // Order Status
  'cancelled': { field: 'Order_Stattus__c', value: 'BOOKED_CANCELLED', object: 'Opportunity', description: 'cancelled bookings' },
  'canceled': { field: 'Order_Stattus__c', value: 'BOOKED_CANCELLED', object: 'Opportunity', description: 'cancelled bookings' },
  'transferred': { field: 'Order_Stattus__c', value: 'TRANSFERED', object: 'Opportunity', description: 'transferred units' },
  'sold status': { field: 'Order_Stattus__c', value: 'SOLD', object: 'Opportunity', description: 'sold units' },
  'booked': { field: 'Order_Stattus__c', value: 'BOOKED_CANCELLED', object: 'Opportunity', description: 'booked units' },

  // Amount/Revenue
  'amount': { field: 'Amount', object: 'Opportunity', description: 'deal amount' },
  'revenue': { field: 'Amount', object: 'Opportunity', description: 'deal amount' },
  'value': { field: 'Amount', object: 'Opportunity', description: 'deal amount' },
  'price': { field: 'Amount', object: 'Opportunity', description: 'deal amount' },
  'how much': { field: 'Amount', object: 'Opportunity', description: 'deal amount' },

  // Date
  'last month': { field: 'CloseDate', object: 'Opportunity', description: 'deals from last month' },
  'this month': { field: 'CloseDate', object: 'Opportunity', description: 'deals from this month' },
  'this quarter': { field: 'CloseDate', object: 'Opportunity', description: 'deals from this quarter' },
  'last quarter': { field: 'CloseDate', object: 'Opportunity', description: 'deals from last quarter' },
  'this year': { field: 'CloseDate', object: 'Opportunity', description: 'deals from this year' },
  'last year': { field: 'CloseDate', object: 'Opportunity', description: 'deals from last year' },
  'recent': { field: 'CreatedDate', object: 'Opportunity', description: 'recent deals' },
  'latest': { field: 'CreatedDate', object: 'Opportunity', description: 'latest deals' },

  // Customer/Account
  'customer': { field: 'Account.Name', object: 'Opportunity', description: 'customer/account name' },
  'buyer': { field: 'Account.Name', object: 'Opportunity', description: 'buyer/account name' },
  'company': { field: 'Account.Name', object: 'Opportunity', description: 'buyer company name' },
  'account': { field: 'Account.Name', object: 'Opportunity', description: 'account name' },

  // Property
  'property': { field: 'Building_Name__c', object: 'Opportunity', description: 'property/building name' },
  'unit': { field: 'Building_Name__c', object: 'Opportunity', description: 'unit/building name' },
  'units': { field: 'Building_Name__c', object: 'Opportunity', description: 'units/buildings' },

  // Count
  'how many': { field: 'COUNT(Id)', object: 'Opportunity', description: 'count of records' },
  'total': { field: 'COUNT(Id)', object: 'Opportunity', description: 'total count' },
  'number of': { field: 'COUNT(Id)', object: 'Opportunity', description: 'count of records' },

  // Case-specific
  'case type': { field: 'Type', object: 'Case', description: 'case type/category' },
  'types of cases': { field: 'Type', object: 'Case', description: 'case type breakdown' },
  'case status': { field: 'Status', object: 'Case', description: 'case status' },
  'open cases': { field: 'Status', object: 'Case', description: 'open cases' },
  'case priority': { field: 'Priority', object: 'Case', description: 'case priority' },
  'escalated': { field: 'Priority', value: 'High', object: 'Case', description: 'high priority cases' },

  // Lead-specific
  'lead source': { field: 'LeadSource', object: 'Lead', description: 'lead source' },
  'where leads come from': { field: 'LeadSource', object: 'Lead', description: 'lead source' },
  'unconverted': { field: 'IsConverted', value: 'false', object: 'Lead', description: 'unconverted leads' },
  'converted leads': { field: 'IsConverted', value: 'true', object: 'Lead', description: 'converted leads' },
  'lead status': { field: 'Status', object: 'Lead', description: 'lead status' },
  'lead pipeline': { field: 'Status', object: 'Lead', description: 'lead pipeline status' },
  'find lead': { field: 'Name', object: 'Lead', description: 'lead by name' },

  // Task-specific
  'pending': { field: 'Status', value: 'Not Started', object: 'Task', description: 'pending tasks' },
  'overdue': { field: 'ActivityDate', object: 'Task', description: 'overdue tasks' },
  'task status': { field: 'Status', object: 'Task', description: 'task status' },
  'tasks by owner': { field: 'OwnerId', object: 'Task', description: 'tasks by assignee' },
  'task priority': { field: 'Priority', object: 'Task', description: 'task priority' },
  'completed tasks': { field: 'Status', value: 'Completed', object: 'Task', description: 'completed tasks' },
  'activities': { field: 'Subject', object: 'Task', description: 'activities/tasks' },

  // Contact-specific
  'contact': { field: 'Name', object: 'Contact', description: 'contact person' },
  'contact email': { field: 'Email', object: 'Contact', description: 'contact email' },
  'contact phone': { field: 'Phone', object: 'Contact', description: 'contact phone' },
  'find contact': { field: 'Name', object: 'Contact', description: 'contact by name' },

  // Bedroom/unit type
  'unit type': { field: 'Sales_Room__c', object: 'Opportunity', description: 'unit type/bedroom count' },
  'bhk': { field: 'Sales_Room__c', object: 'Opportunity', description: 'bedroom count (BHK)' },

  // Mortgage
  'mortgage': { field: 'Current_Mortgage_Status__c', object: 'Opportunity', description: 'mortgage status' },
  'mortgaged': { field: 'Current_Mortgage_Status__c', value: 'Valid', object: 'Opportunity', description: 'active mortgage' },
  'not mortgaged': { field: 'Current_Mortgage_Status__c', value: 'Not Mortgaged', object: 'Opportunity', description: 'no mortgage' },
  'terminated mortgage': { field: 'Current_Mortgage_Status__c', value: 'Terminated', object: 'Opportunity', description: 'terminated mortgage' },

  // Milestone/Handover
  'milestone': { field: 'Milestone_Current_Status__c', object: 'Opportunity', description: 'handover milestone status' },
  'handover': { field: 'Milestone_Current_Status__c', object: 'Opportunity', description: 'handover milestone status' },
  'deep cleaning': { field: 'Milestone_Current_Status__c', value: 'Deep Cleaning Completed', object: 'Opportunity', description: 'deep cleaning completed' },
  'key release': { field: 'Milestone_Current_Status__c', value: 'Customer Key Release appointment scheduled', object: 'Opportunity', description: 'key release scheduled' },
  'blocked by legal': { field: 'Milestone_Current_Status__c', value: 'Blocked by Legal', object: 'Opportunity', description: 'blocked by legal' },
  'quality inspection': { field: 'Milestone_Current_Status__c', value: 'Quality inspection approved', object: 'Opportunity', description: 'quality inspection approved' },

  // Agency/Agent
  'agency': { field: 'cm_Agency_Name__r.Name', object: 'Opportunity', description: 'agency name' },
  'broker': { field: 'cm_Agent_Name__r.Name', object: 'Opportunity', description: 'external agent/broker name' },

  // Booking date
  'booking date': { field: 'Property_Booked_Date__c', object: 'Opportunity', description: 'property booking date' },
  'booked date': { field: 'Property_Booked_Date__c', object: 'Opportunity', description: 'property booking date' },

  // Net amount
  'net amount': { field: 'Net_Amount__c', object: 'Opportunity', description: 'net amount after adjustments' },
  'net value': { field: 'Net_Amount__c', object: 'Opportunity', description: 'net amount after adjustments' },

  // Case service
  'service category': { field: 'eService_Admin_Name__c', object: 'Case', description: 'eService service category' },
  'eservice': { field: 'eService_Admin_Name__c', object: 'Case', description: 'eService service category' },
  'registration': { field: 'eService_Admin_Name__c', value: 'Tenant Registration', object: 'Case', description: 'tenant registration case' },
  'transfer case': { field: 'eService_Admin_Name__c', value: 'Primary Market Transfer', object: 'Case', description: 'primary market transfer case' },
  'move-in': { field: 'eService_Admin_Name__c', value: 'Owner Move-in', object: 'Case', description: 'move-in request' },

  // Property inventory
  'available units': { field: 'Property_Status__c', value: 'Available', object: 'Property_Inventory__c', description: 'available units' },
  'sold units': { field: 'Property_Status__c', value: 'Sold', object: 'Property_Inventory__c', description: 'sold units' },
  'reserved units': { field: 'Property_Status__c', value: 'Reserved', object: 'Property_Inventory__c', description: 'reserved units' },
  'leased units': { field: 'Property_Status__c', value: 'Leased', object: 'Property_Inventory__c', description: 'leased units' },
  'villa': { field: 'Type__c', value: 'Villa', object: 'Property_Inventory__c', description: 'villa property type' },
  'apartment': { field: 'Type__c', value: 'Apartment', object: 'Property_Inventory__c', description: 'apartment property type' },
  'townhouse': { field: 'Type__c', value: 'Townhouse', object: 'Property_Inventory__c', description: 'townhouse property type' },
}

// Resolve user terms to field names and values
export function resolveSynonyms(query: string): SynonymEntry[] {
  const lower = query.toLowerCase()
  const matches: SynonymEntry[] = []
  const seen = new Set<string>()

  // Sort by key length descending so longer phrases match first
  const sortedKeys = Object.keys(SYNONYMS).sort((a, b) => b.length - a.length)

  for (const key of sortedKeys) {
    if (lower.includes(key)) {
      const entry = SYNONYMS[key]
      const fieldKey = `${entry.object || 'Opportunity'}.${entry.field}.${entry.value || ''}`
      if (!seen.has(fieldKey)) {
        seen.add(fieldKey)
        matches.push(entry)
      }
    }
  }

  return matches
}

// Get all unique field names that appear in synonyms
export function getAllSynonymFields(): string[] {
  const fields = new Set<string>()
  for (const entry of Object.values(SYNONYMS)) {
    fields.add(entry.field)
  }
  return Array.from(fields)
}
