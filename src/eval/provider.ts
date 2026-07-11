// Promptfoo custom provider — calls the tool matcher directly.
// Promptfoo expects: function with callApi + id property.

import { matchTool } from '../salesforce/tool-matcher'

async function callApi(prompt: string): Promise<{ output: string }> {
  const result = await matchTool(prompt)
  return { output: JSON.stringify(result) }
}

// Export as a function with id property
const provider = callApi as any
provider.id = 'salesforce-tool-matcher'

export default provider
