export default {
  async fetch(request, env) {

    // CORS headers on every response
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    // Health check — GET any path returns OK
    if (request.method === 'GET') {
      return new Response(JSON.stringify({ status: 'ALD Worker live', path: url.pathname }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // POST /api/chat — Claude concierge
    if (request.method === 'POST' && url.pathname === '/api/chat') {

      let body;
      try {
        body = await request.json();
      } catch(e) {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const { messages, system } = body;

      if (!messages || !Array.isArray(messages)) {
        return new Response(JSON.stringify({ error: 'messages array required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      try {
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
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

      } catch(e) {
        return new Response(JSON.stringify({ error: 'Claude API error', detail: e.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // POST /api/sponsor — Sponsor data capture
    if (request.method === 'POST' && url.pathname === '/api/sponsor') {

      let sponsorData;
      try {
        sponsorData = await request.json();
      } catch(e) {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // Write to Airtable Sponsors table
      let airtableRecordId = null;
      let existingRecords = [];

      // Check for existing company records
      if (sponsorData.company && env.AIRTABLE_API_KEY && env.AIRTABLE_BASE_ID) {
        try {
          const searchRes = await fetch(
            `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/Sponsors?filterByFormula=${encodeURIComponent(`{Company}="${sponsorData.company}"`)}`,
            { headers: { 'Authorization': `Bearer ${env.AIRTABLE_API_KEY}` } }
          );
          const searchData = await searchRes.json();
          if (searchData.records) existingRecords = searchData.records;
        } catch(e) { /* non-fatal */ }
      }

      // Write new record
      if (env.AIRTABLE_API_KEY && env.AIRTABLE_BASE_ID) {
        try {
          const airtableRes = await fetch(
            `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/Sponsors`,
            {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${env.AIRTABLE_API_KEY}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                fields: {
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
                  'Notes': existingRecords.length > 0
                    ? `Linked to ${existingRecords.length} existing ${sponsorData.company} record(s).`
                    : '',
                }
              })
            }
          );
          const airtableData = await airtableRes.json();
          airtableRecordId = airtableData.id || null;
        } catch(e) { /* non-fatal */ }
      }

      // Generate proposal via Claude
      let proposalText = '';
      try {
        const level = (sponsorData.organizational_level || '').toUpperCase();
        const isVP = level === 'VP' || level === 'DIRECTOR' || level === 'C-SUITE';
        const isRegional = level === 'REGIONAL';

        const briefType = isVP ? 'STRATEGIC BRIEF' : isRegional ? 'TERRITORY BRIEF' : 'FIELD BRIEF';

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
              content: `Write a ${briefType} for ${sponsorData.name || 'a sponsor'} at ${sponsorData.company || 'their company'}.
Brand: ${sponsorData.brand || ''}. Territory: ${sponsorData.territory || ''}.
Product priority: ${sponsorData.product_priority || ''}.

ALD is a private dinner series — 15 practitioners, one sponsor, no pitches, no panels.
Voice: confident, specific, no marketing language, no exclamation points.
Maximum 300 words. No headers. No bullet points. Flowing paragraphs only.
Sign off as: The ALD Team — concierge@aestheticleadersdinner.com`
            }]
          })
        });

        const proposalData = await proposalRes.json();
        proposalText = proposalData.content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('');

      } catch(e) { /* non-fatal */ }

      // Fire Klaviyo event if email present
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
                  }
                }
              }
            })
          });
        } catch(e) { /* non-fatal */ }
      }

      return new Response(JSON.stringify({
        success: true,
        record_id: airtableRecordId,
        linked_records: existingRecords.length,
        proposal_generated: proposalText.length > 0,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Default 404
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
};
