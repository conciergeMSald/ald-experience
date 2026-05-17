/**
 * ALD Cloudflare Worker — Updated
 * Version 2.0
 *
 * Routes:
 *   POST /api/chat    — Guest and partner concierge agent (existing)
 *   POST /api/sponsor — Sponsor data capture → Airtable → proposal trigger
 *
 * Environment secrets required (Cloudflare Workers → Settings → Variables):
 *   ANTHROPIC_API_KEY   — sk-ant-... from console.anthropic.com
 *   AIRTABLE_API_KEY    — from airtable.com/account → API section
 *   AIRTABLE_BASE_ID    — from airtable.com/api → your ALD Master base ID
 *   KLAVIYO_API_KEY     — from klaviyo.com → Settings → API Keys
 */

export default {
  async fetch(request, env) {

    const ALLOWED_ORIGIN = '*';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    const url = new URL(request.url);

    // ─────────────────────────────────────
    // ROUTE 1: /api/chat
    // Guest concierge + partner concierge
    // ─────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/chat') {

      let body;
      try {
        body = await request.json();
      } catch {
        return new Response('Bad request.', { status: 400 });
      }

      const { messages, system } = body;

      if (!messages || !Array.isArray(messages)) {
        return new Response('Invalid payload.', { status: 400 });
      }

      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          system: system || '',
          messages: messages,
        }),
      });

      const data = await anthropicRes.json();

      return new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        },
      });
    }

    // ─────────────────────────────────────
    // ROUTE 2: /api/sponsor
    // Receives sponsor conversation data
    // Writes to Airtable Sponsors table
    // Triggers proposal generation via Claude
    // Fires Klaviyo proposal delivery
    // ─────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/sponsor') {

      let sponsorData;
      try {
        sponsorData = await request.json();
      } catch {
        return new Response('Bad request.', { status: 400 });
      }

      // Step 1 — Check for existing company records in Airtable
      // This powers the organizational linking / referral chain logic
      let existingRecords = [];
      let linkedRecordIds = [];

      if (sponsorData.company && env.AIRTABLE_API_KEY && env.AIRTABLE_BASE_ID) {
        try {
          const searchRes = await fetch(
            `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/Sponsors?filterByFormula=${encodeURIComponent(`{Company}="${sponsorData.company}"`)}`,
            {
              headers: {
                'Authorization': `Bearer ${env.AIRTABLE_API_KEY}`,
                'Content-Type': 'application/json',
              }
            }
          );
          const searchData = await searchRes.json();
          if (searchData.records && searchData.records.length > 0) {
            existingRecords = searchData.records;
            linkedRecordIds = searchData.records.map(r => r.id);
          }
        } catch(e) {
          // Non-fatal — continue without linking
          console.log('Airtable search note:', e.message);
        }
      }

      // Step 2 — Write sponsor record to Airtable
      let airtableRecordId = null;
      const referralChainNote = existingRecords.length > 0
        ? `Linked to ${existingRecords.length} existing ${sponsorData.company} record(s) in system.`
        : '';

      if (env.AIRTABLE_API_KEY && env.AIRTABLE_BASE_ID) {
        try {
          const airtableFields = {
            'Name': sponsorData.name || '',
            'Company': sponsorData.company || '',
            'Brand': sponsorData.brand || '',
            'Organizational Level': sponsorData.organizational_level || '',
            'Product Priority': sponsorData.product_priority || '',
            'Territory': sponsorData.territory || '',
            'Team Size': sponsorData.team_size || '',
            'Target Accounts': Array.isArray(sponsorData.target_accounts)
              ? sponsorData.target_accounts.join(', ')
              : sponsorData.target_accounts || '',
            'Competitive Intelligence': sponsorData.competitive_intelligence || '',
            'Budget Type': sponsorData.budget_type || '',
            'Approval Chain': sponsorData.approval_chain || '',
            'Who Else Sees Proposal': sponsorData.who_else_sees_proposal || '',
            'Email': sponsorData.email || '',
            'Proposal Type': sponsorData.proposal_type || '',
            'Approval Status': 'Outreach',
            'Notes': referralChainNote,
          };

          const airtableRes = await fetch(
            `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/Sponsors`,
            {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${env.AIRTABLE_API_KEY}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ fields: airtableFields })
            }
          );

          const airtableData = await airtableRes.json();
          airtableRecordId = airtableData.id || null;

        } catch(e) {
          console.log('Airtable write note:', e.message);
        }
      }

      // Step 3 — Generate custom proposal via Claude
      // Selects the correct proposal type based on organizational level
      const proposalPrompt = buildProposalPrompt(sponsorData, existingRecords);
      let proposalText = '';

      try {
        const proposalRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1000,
            messages: [{
              role: 'user',
              content: proposalPrompt
            }]
          })
        });

        const proposalData = await proposalRes.json();
        proposalText = proposalData.content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('');

      } catch(e) {
        console.log('Proposal generation note:', e.message);
      }

      // Step 4 — Fire Klaviyo proposal email (if email provided)
      if (sponsorData.email && proposalText && env.KLAVIYO_API_KEY) {
        try {
          await fetch('https://a.klaviyo.com/api/events/', {
            method: 'POST',
            headers: {
              'Authorization': `Klaviyo-API-Key ${env.KLAVIYO_API_KEY}`,
              'Content-Type': 'application/json',
              'revision': '2023-10-15',
            },
            body: JSON.stringify({
              data: {
                type: 'event',
                attributes: {
                  metric: { data: { type: 'metric', attributes: { name: 'ALD Sponsor Proposal Ready' } } },
                  profile: { data: { type: 'profile', attributes: { email: sponsorData.email } } },
                  properties: {
                    proposal_type: sponsorData.proposal_type || 'FIELD BRIEF',
                    proposal_text: proposalText,
                    company: sponsorData.company || '',
                    organizational_level: sponsorData.organizational_level || '',
                    territory: sponsorData.territory || '',
                    brand: sponsorData.brand || '',
                    referral_chain_note: referralChainNote,
                    existing_records_count: existingRecords.length,
                    airtable_record_id: airtableRecordId || '',
                  }
                }
              }
            })
          });
        } catch(e) {
          console.log('Klaviyo trigger note:', e.message);
        }
      }

      // Return success — silent to the front end
      return new Response(JSON.stringify({
        success: true,
        record_id: airtableRecordId,
        linked_records: linkedRecordIds.length,
        proposal_generated: proposalText.length > 0,
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        }
      });
    }

    // ─────────────────────────────────────
    // 404 — All other routes
    // ─────────────────────────────────────
    return new Response('Not found.', {
      status: 404,
      headers: { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN }
    });
  }
};

// ─────────────────────────────────────────────────────
// PROPOSAL GENERATION PROMPT BUILDER
// Selects the correct brief type based on org level
// ─────────────────────────────────────────────────────
function buildProposalPrompt(data, existingRecords) {

  const level = (data.organizational_level || '').toUpperCase();
  const isRep = level === 'REP';
  const isRegional = level === 'REGIONAL';
  const isVP = level === 'VP' || level === 'DIRECTOR';
  const isCsuite = level === 'C-SUITE' || level === 'CSUITE';

  const referralLine = existingRecords.length > 0
    ? `Note: ${existingRecords.length} other member(s) of the ${data.company} organization have already engaged with ALD. Include this naturally in the proposal — position it as ALD bringing them the full picture, not as a pressure tactic.`
    : '';

  const baseContext = `
You are writing a private proposal document on behalf of Aesthetic Leaders Dinner (ALD).
ALD runs intimate private dinners — 15 practitioners, one sponsor, no pitches, no panels.
The sponsor's brief moment with the room is the only brand interaction.
The dinner is the event. The room is the product.

Voice: confident, specific, no marketing language, no exclamation points.
Short paragraphs. Direct. Written like a briefing document, not a sales deck.
Maximum 400 words total. No headers. No bullet points. Flowing paragraphs only.
Sign off as: The ALD Team — concierge@aestheticleadersdinner.com

Recipient details:
Name: ${data.name || 'there'}
Company: ${data.company || ''}
Brand/Division: ${data.brand || ''}
Territory: ${data.territory || ''}
Product priority: ${data.product_priority || ''}
Target accounts (if shared): ${Array.isArray(data.target_accounts) ? data.target_accounts.join(', ') : data.target_accounts || 'not shared'}
Budget type: ${data.budget_type || ''}
Who else sees this: ${data.who_else_sees_proposal || ''}
${referralLine}
`;

  if (isRep) {
    return baseContext + `
Write a FIELD BRIEF — one page, formatted to show a manager.
Open with one sentence that names their territory and acknowledges what they're trying to do.
Explain what ALD is in exactly two sentences. No more.
Address the access problem directly — the practitioners who matter most are not at the big dinners anymore. ALD builds the room they will say yes to.
Reference their target accounts obliquely if they shared them: "The practitioners on your priority list are exactly the profile we build rooms around."
Close with the proposal for their specific market and a line about what happens next.
Do not include pricing. Do not include a call to action. End with a period.`;
  }

  if (isRegional) {
    return baseContext + `
Write a TERRITORY BRIEF — formatted to be attached to an internal email.
Open with a sentence that names their geography and the problem they described.
Describe ALD in two sentences from a territory activation perspective — not a dinner, a field tool.
Address the rep performance angle: the rooms that are still producing outcomes are the ones that feel fundamentally different from what reps have been running.
Include a paragraph on how ALD works at the territory level — multiple dinners per city cycle, market by market.
Reference any underperforming markets they mentioned specifically.
End with what the regional would tell their team and a line about the next step.
Include one sentence acknowledging who else will need to see this.
No pricing. No call to action. End with a period.`;
  }

  if (isVP || isCsuite) {
    const label = isCsuite ? 'EXECUTIVE SUMMARY' : 'STRATEGIC BRIEF';
    return baseContext + `
Write a ${label} — written for the conversation they are about to have internally.
Open with the problem: traditional HCP dinner programs have been declining in ROI for three years. The format is tired. The industry scaled itself into irrelevance with the practitioners who matter most.
Position ALD as the format that fills the gap — not a better version of what exists, but a fundamentally different approach. Fifteen practitioners. Genuine clinical authority. One sponsor. The room is the product.
Include the national footprint angle: ALD operates across 20 markets. The practitioner database is tiered, scored, and city-tagged. A sponsor at the national level gets access to a relationship infrastructure that took years to build.
Address competitive positioning: the brands already in these rooms are not announcing it. That is the point.
Reference the organizational intelligence obliquely if multiple records exist: "The conversation inside your organization has already started."
Close with one sentence about what a national partnership looks like and one sentence about next steps.
No pricing. No call to action. End with a period.`;
  }

  // Default — generic brief if level unclear
  return baseContext + `
Write a concise partnership brief — two paragraphs.
First paragraph: what ALD is and why the format matters right now.
Second paragraph: what a sponsorship looks like and why the room is the product.
No pricing. No call to action. End with a period.`;
}
