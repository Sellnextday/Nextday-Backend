const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ATTOM_KEY = process.env.ATTOM_API_KEY;
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 8192;
const MAX_ITERATIONS = 15;

// ─────────────────────────────────────────────
// ATTOM HELPERS
// ─────────────────────────────────────────────

async function attomPropertyDetail(address1, address2) {
  let res;
  try {
    res = await axios.get(
      'https://api.gateway.attomdata.com/propertyapi/v1.0.0/property/detail',
      {
        headers: { apikey: ATTOM_KEY, Accept: 'application/json' },
        params: { address1, address2 },
        timeout: 15000
      }
    );
  } catch (axiosErr) {
    const status  = axiosErr.response?.status;
    const detail  = axiosErr.response?.data?.status?.msg || axiosErr.response?.data?.message || axiosErr.message;
    throw new Error(`ATTOM HTTP ${status || 'error'}: ${detail}`);
  }
  const prop = res.data.property?.[0];
  if (!prop) {
    const msg = res.data?.status?.msg || 'no property record returned';
    throw new Error(`ATTOM: property not found — ${msg}`);
  }
  const sqft = prop.building?.size?.universalsize || prop.building?.size?.livingsize || null;
  return {
    address:       prop.address?.oneLine,
    sqft:          sqft ? parseInt(sqft) : null,
    beds:          prop.building?.rooms?.beds,
    baths:         prop.building?.rooms?.bathstotal,
    lotSize:       prop.lot?.lotsize1,
    yearBuilt:     prop.summary?.yearbuilt,
    lat:           parseFloat(prop.location?.latitude),
    lon:           parseFloat(prop.location?.longitude),
    lastSoldPrice: prop.sale?.amount?.saleamt   || null,
    lastSoldDate:  prop.sale?.saleTransDate      || prop.sale?.salesearchdate || null,
    propertyType:  prop.summary?.proptype        || null
  };
}

async function attomSaleComps(lat, lon, radiusMiles, sqft, sqftBuffer) {
  const res = await axios.get(
    'https://api.gateway.attomdata.com/propertyapi/v1.0.0/sale/snapshot',
    {
      headers: { apikey: ATTOM_KEY, Accept: 'application/json' },
      params: {
        latitude:   lat,
        longitude:  lon,
        radius:     radiusMiles,
        minsqsize:  sqft - sqftBuffer,
        maxsqsize:  sqft + sqftBuffer,
        pagesize:   50
      },
      timeout: 15000
    }
  );

  const props = res.data.property || [];

  // 15-month hard stop — filter client-side using saleTransDate
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 15);

  return props
    .filter(p => {
      const saleDate = p.sale?.saleTransDate || p.sale?.salesearchdate;
      if (!saleDate) return false;
      if (new Date(saleDate) < cutoff) return false;
      if (!p.sale?.amount?.saleamt) return false;          // must have a recorded sale price
      if (!p.building?.size?.universalsize) return false;  // must have sqft
      return true;
    })
    .map(p => ({
      address:    p.address?.oneLine,
      beds:       p.building?.rooms?.beds,
      baths:      p.building?.rooms?.bathstotal,
      sqft:       p.building?.size?.universalsize,
      lotSize:    p.lot?.lotsize1,
      salePrice:  p.sale?.amount?.saleamt,
      saleDate:   p.sale?.saleTransDate || p.sale?.salesearchdate,
      ppsf:       Math.round(p.sale.amount.saleamt / p.building.size.universalsize),
      source:     'ATTOM (county recorded)'
    }));
}

// Tiered expansion — mirrors the locked comp criteria
async function pullCompsWithTiers(lat, lon, sqft) {
  const tiers = [
    { radius: 1,  sqftBuffer: 500  },
    { radius: 2,  sqftBuffer: 750  },
    { radius: 3,  sqftBuffer: 1000 },
    { radius: 3,  sqftBuffer: 1500 }
  ];

  let comps = [];
  let tierUsed = null;

  for (const tier of tiers) {
    comps = await attomSaleComps(lat, lon, tier.radius, sqft, tier.sqftBuffer);
    tierUsed = tier;
    if (comps.length >= 3) break;
  }

  return { comps, tierUsed };
}

// ─────────────────────────────────────────────
// JSON EXTRACTOR
// ─────────────────────────────────────────────

function extractJSON(text) {
  text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
  const first = text.indexOf('{');
  const last  = text.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    return text.substring(first, last + 1);
  }
  return text.trim();
}

// ─────────────────────────────────────────────
// SHARED AGENT RUNNER (no web search needed — data pre-loaded from ATTOM)
// ─────────────────────────────────────────────

async function runAgent(systemPrompt, userPrompt) {
  let messages = [{ role: 'user', content: userPrompt }];
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const apiResponse = await axios({
      method: 'post',
      url: 'https://api.anthropic.com/v1/messages',
      timeout: 180000,
      headers: {
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json'
      },
      data: {
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        system:     systemPrompt,
        messages
      }
    });

    const stopReason = apiResponse.data.stop_reason;
    const content    = apiResponse.data.content;
    messages.push({ role: 'assistant', content });

    if (stopReason === 'end_turn') {
      const textBlock = content.find(b => b.type === 'text');
      if (!textBlock?.text) throw new Error('Agent returned no text');
      const jsonStr = extractJSON(textBlock.text);
      JSON.parse(jsonStr); // validate — throws if bad
      return JSON.parse(jsonStr);
    }
  }
  throw new Error('Agent did not complete in max iterations');
}

// ─────────────────────────────────────────────
// SYSTEM PROMPTS
// ─────────────────────────────────────────────

const COMP_AGENT_SYSTEM = `You are the Comp Agent for Next Day Home Buyers LLC, a wholesale real estate company.

You will receive:
1. Subject property details pulled from ATTOM (county-recorded data)
2. A list of candidate comparable sales pulled from ATTOM within the search radius
3. Acquisition call notes from the seller conversation

YOUR JOB: Evaluate the candidate comps against the locked comp criteria and identify the best qualifying ones. You are NOT searching the internet — the data is already in front of you.

LOCKED COMP CRITERIA:
- Bathrooms: within ±2 of subject
- Square footage: within the tier buffer already applied (comps were pre-filtered)
- Lot size: within 50% of subject lot size
- Property type: stick-built only (unless subject is manufactured, then manufactured only)
- Sold date: within 15 months of today — already filtered, but verify dates are reasonable
- Exclude: distressed/foreclosure sales (price far below market), flips held < 90 days, non-arm's-length transactions

COMP POOL RULES:
- 3+ qualifying comps → run normally
- 1–2 qualifying comps → flag 🟡 "LIMITED COMP DATA — verify manually"
- 0 qualifying comps → flag 🔴 "Insufficient Comp Data — Run Manually"

OUTPUT: Return a JSON object with this exact structure:
{
  "verified": true,
  "qualifying_comps": [...],
  "excluded_comps": [...with reason...],
  "avg_ppsf": 0,
  "median_dom": 0,
  "comp_count": 0,
  "tier_used": "...",
  "data_quality_flag": null or "LIMITED COMP DATA" or "Insufficient Comp Data",
  "subject_last_sold": { "price": 0, "date": "..." },
  "active_listings": [],
  "mls_cap_price": null
}`;

const DISCOUNT_AGENT_SYSTEM = `You are the Discount Agent for Next Day Home Buyers LLC.

You will receive subject property details and acquisition call notes. Extract every condition mentioned and apply the locked discount table.

LOCKED DISCOUNT TABLE:

PER SQFT (minor / major):
- HVAC old: $3 / $4 per sqft
- Flooring replacement: $3 / $4 per sqft
- Kitchen dated: $3 / $4 per sqft
- Kitchen full update: $7 / $8 per sqft
- Siding paint/minor: $1 / $2 per sqft
- Siding full replacement: $3 / $5 per sqft

FLAT DISCOUNTS (minor / major):
- Foundation issues: $20,000 flat (both)
- Roof 20yr+: $8,000 / $15,000
- Original windows: $3,000 / $6,000
- Water heater 12yr+: $1,000 / $2,500
- Kitchen appliances: $4,000 flat (both)
- Tenant occupied: $3,000 / $7,000
- HOA over $150/mo: $4,000 / $8,000
- Electrical old panel: $3,000 flat (both)
- Knob & tube wiring: $8,000 flat (both)
- Plumbing issues: $2,000 / $10,000

PER BATH:
- Bathrooms dated: $2,000 per bath
- Bathrooms full update: $6,000 per bath

RED FLAGS TO CHECK:
- Deed issues (ex-spouse, trust, multiple owners, only one spouse on deed)
- Active MLS or FSBO listing
- Septic + well combination
- Small market under 1,000 population
- Roof 18yr+ (financing issues for end buyers)
- Seller owes more than MAO (short sale needed)
NOTE: Manufactured/mobile homes are NOT a red flag — we buy these.

SELF-VERIFY: Before returning, confirm every condition from the notes is accounted for. Sum your discounts and verify the math.

OUTPUT: Return a JSON object:
{
  "verified": true,
  "subject_sqft": 0,
  "bath_count": 0,
  "discounts": [
    { "item": "...", "severity": "minor|major", "type": "per_sqft|flat|per_bath", "amount": 0 }
  ],
  "total_discount": 0,
  "red_flags": [],
  "occupancy": "owner|tenant|vacant",
  "unmatched_conditions": []
}`;

const FORMULA_AGENT_SYSTEM = `You are the Formula Agent for Next Day Home Buyers LLC. You run the locked 7-step formula and SELF-VERIFY your math before returning anything.

THE LOCKED FORMULA — follow exactly, no exceptions:

Step 1: Comp Avg $/sqft = average of qualifying comp $/sqft values
Step 2: Retail ARV = Comp Avg $/sqft × Subject Sqft
Step 3: As-Is Value = Retail ARV − Total Discount
Step 4: List Price = As-Is Value × 0.90
Step 5: MAO = List Price − (List Price × 0.05) − (List Price × 0.02) − $25,000
        Anchor Price = MAO × 0.85

NOVATION PATH (run simultaneously):
Novation List Price = Retail ARV − $30,000
Novation MAO = Novation List Price − (Novation List Price × 0.05) − (Novation List Price × 0.02) − $25,000

MLS CAP RULE: If mls_cap_price exists → Wholesale MAO = MIN(calculated MAO, mls_cap_price)
LIQUIDITY DISCOUNT: If median DOM ≥ 45 days → apply additional 3% discount to As-Is Value before formula

Step 6: Timeline = median DOM from comps + red flag adjustments
Step 7: Verdict = 🟢 Green / 🟡 Yellow / 🔴 Red — based on NUMBERS ONLY, never seller situation

SELF-VERIFY: After calculating, re-derive MAO and Anchor from scratch using your own output numbers. They must match. If they don't, recalculate before returning.

OUTPUT: Return a JSON object:
{
  "verified": true,
  "retail_arv": 0,
  "total_discount": 0,
  "liquidity_discount_applied": false,
  "as_is_value": 0,
  "list_price": 0,
  "mao": 0,
  "anchor_price": 0,
  "novation_list_price": 0,
  "novation_mao": 0,
  "mls_cap_applied": false,
  "timeline_days": "...",
  "verdict": "🟢|🟡|🔴",
  "verdict_reason": "...",
  "self_verification": {
    "mao_recalculated": 0,
    "anchor_recalculated": 0,
    "novation_mao_recalculated": 0,
    "match": true
  }
}`;

const OUTPUT_AGENT_SYSTEM = `You are the Output Agent for Next Day Home Buyers LLC. You receive results from three verified agents and assemble the final JSON for the frontend. Do NOT recalculate anything — use the numbers as given.

OUTPUT: Return this exact JSON structure (no extra fields, no nulls):
{
  "verdict": "🟢|🟡|🔴",
  "verdict_reason": "...",
  "retail_arv": 0,
  "total_discounts": 0,
  "as_is_value": 0,
  "list_price": 0,
  "mao": 0,
  "anchor_price": 0,
  "novation_list_price": 0,
  "novation_mao": 0,
  "timeline": "...",
  "subject_last_sold": { "price": 0, "date": "..." },
  "comparable_sales": [
    { "address": "...", "beds": 0, "baths": 0, "sqft": 0, "sale_price": 0, "ppsf": 0, "sale_date": "..." }
  ],
  "active_listings": [],
  "red_flags": [],
  "discounts_breakdown": [],
  "negotiation_strategy": "...",
  "notes": "..."
}`;

// ─────────────────────────────────────────────
// MAIN ANALYZE ENDPOINT
// ─────────────────────────────────────────────

app.post('/analyze', async (req, res) => {
  const { address, callNotes } = req.body;

  if (!address || !callNotes) {
    return res.status(400).json({ error: 'Missing address or callNotes' });
  }

  try {
    // Parse address into address1 / address2
    // Expected format: "123 Main St, City, ST 12345"
    const commaIdx = address.indexOf(',');
    const address1 = commaIdx > -1 ? address.substring(0, commaIdx).trim() : address;
    const address2 = commaIdx > -1 ? address.substring(commaIdx + 1).trim() : '';

    console.log(`[ATTOM] Fetching property detail for: ${address1}, ${address2}`);

    // ── STEP 1: Pull subject property from ATTOM ──────────────────────
    let subject;
    try {
      subject = await attomPropertyDetail(address1, address2);
      console.log(`[ATTOM] Subject: ${subject.sqft} sqft, ${subject.beds}bd/${subject.baths}ba, lat:${subject.lat} lon:${subject.lon}`);
    } catch (attomErr) {
      console.error('[ATTOM] Property detail failed:', attomErr.message);
      return res.status(500).json({ error: `Could not locate property in ATTOM: ${attomErr.message}` });
    }

    // ── STEP 2: Pull comps with tiered expansion ──────────────────────
    let comps = [], tierUsed = { radius: 3, sqftBuffer: 1500 };
    if (!subject.sqft) {
      console.warn('[ATTOM] sqft missing for subject — skipping comp pull, agents will flag');
    } else {
      try {
        ({ comps, tierUsed } = await pullCompsWithTiers(subject.lat, subject.lon, subject.sqft));
        console.log(`[ATTOM] ${comps.length} comps found at radius ${tierUsed.radius}mi / ±${tierUsed.sqftBuffer}sqft`);
      } catch (compErr) {
        console.error('[ATTOM] Comp pull failed:', compErr.message);
        // Non-fatal — proceed with empty comps, agent will flag it
      }
    }

    // ── AGENT 1: Comp Agent ───────────────────────────────────────────
    console.log('[AGENT 1] Running Comp Agent...');
    const compPrompt = `
SUBJECT PROPERTY (from ATTOM county records):
${JSON.stringify(subject, null, 2)}

CANDIDATE COMPARABLE SALES (from ATTOM, pre-filtered to ${tierUsed?.radius || 3}mi radius / ±${tierUsed?.sqftBuffer || 1500}sqft / 15 months):
${JSON.stringify(comps, null, 2)}

ACQUISITION CALL NOTES:
${callNotes}

Evaluate these comps against the locked criteria. Identify qualifying comps, exclude outliers with reasons, and calculate avg $/sqft. Return your JSON.`;

    const compResult = await runAgent(COMP_AGENT_SYSTEM, compPrompt);
    if (!compResult.verified) {
      return res.status(500).json({ error: 'Comp Agent failed verification' });
    }

    // ── AGENT 2: Discount Agent ───────────────────────────────────────
    console.log('[AGENT 2] Running Discount Agent...');
    const discountPrompt = `
SUBJECT PROPERTY:
${JSON.stringify(subject, null, 2)}

ACQUISITION CALL NOTES:
${callNotes}

Extract all conditions from the call notes and apply the locked discount table. Return your JSON.`;

    const discountResult = await runAgent(DISCOUNT_AGENT_SYSTEM, discountPrompt);
    if (!discountResult.verified) {
      return res.status(500).json({ error: 'Discount Agent failed verification' });
    }

    // ── AGENT 3: Formula Agent ────────────────────────────────────────
    console.log('[AGENT 3] Running Formula Agent...');
    const formulaPrompt = `
COMP AGENT RESULTS:
${JSON.stringify(compResult, null, 2)}

DISCOUNT AGENT RESULTS:
${JSON.stringify(discountResult, null, 2)}

SUBJECT SQFT: ${subject.sqft}

Run the locked 7-step formula for both wholesale and novation paths. Self-verify your math. Return your JSON.`;

    const formulaResult = await runAgent(FORMULA_AGENT_SYSTEM, formulaPrompt);
    if (!formulaResult.verified || !formulaResult.self_verification?.match) {
      return res.status(500).json({ error: 'Formula Agent self-verification failed — numbers did not match' });
    }

    // ── AGENT 4: Output Agent ─────────────────────────────────────────
    console.log('[AGENT 4] Running Output Agent...');
    const outputPrompt = `
COMP RESULTS:
${JSON.stringify(compResult, null, 2)}

DISCOUNT RESULTS:
${JSON.stringify(discountResult, null, 2)}

FORMULA RESULTS:
${JSON.stringify(formulaResult, null, 2)}

Assemble the final frontend JSON. Return ONLY the JSON object.`;

    const finalResult = await runAgent(OUTPUT_AGENT_SYSTEM, outputPrompt);

    console.log(`[DONE] Verdict: ${finalResult.verdict} | MAO: $${finalResult.mao} | Novation MAO: $${finalResult.novation_mao}`);
    return res.json({ response: JSON.stringify(finalResult) });

  } catch (err) {
    console.error('[ERROR]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'ok', attom: !!ATTOM_KEY, anthropic: !!ANTHROPIC_KEY }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
