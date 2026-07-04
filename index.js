import express from 'express';
import axios   from 'axios';
import cors    from 'cors';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ATTOM_KEY     = process.env.ATTOM_API_KEY;
const MODEL         = 'claude-sonnet-4-6';

// ═══════════════════════════════════════════════════════════════
// ATTOM HELPERS
// ═══════════════════════════════════════════════════════════════

async function attomPropertyDetail(address1, address2) {
  let res;
  try {
    res = await axios.get(
      'https://api.gateway.attomdata.com/propertyapi/v1.0.0/property/detail',
      {
        headers: { apikey: ATTOM_KEY, Accept: 'application/json' },
        params:  { address1, address2 },
        timeout: 15000
      }
    );
  } catch (axiosErr) {
    const status = axiosErr.response?.status;
    const detail = axiosErr.response?.data?.status?.msg
                || axiosErr.response?.data?.message
                || axiosErr.message;
    throw new Error(`ATTOM HTTP ${status || 'error'}: ${detail}`);
  }

  const prop = res.data.property?.[0];
  if (!prop) {
    const msg = res.data?.status?.msg || 'no property record returned';
    throw new Error(`ATTOM: property not found — ${msg}`);
  }

  const sqftRaw = prop.building?.size?.universalsize || prop.building?.size?.livingsize;
  return {
    attomId:       prop.identifier?.attomId,
    address:       prop.address?.oneLine,
    sqft:          sqftRaw ? parseInt(sqftRaw) : null,
    beds:          parseInt(prop.building?.rooms?.beds)         || null,
    baths:         parseInt(prop.building?.rooms?.bathstotal)   || null,
    halfBaths:     parseInt(prop.building?.rooms?.bathshalf)    || 0,
    garageSpaces:  parseInt(prop.building?.parking?.prkgSpaces || prop.building?.parking?.parkingSpaceNo || 0) || 0,
    pool:          !!(prop.building?.pool?.poolInd === 'Y' || prop.lot?.poolType),
    lotSize:       parseFloat(prop.lot?.lotsize1)              || null,  // acres
    yearBuilt:     parseInt(prop.summary?.yearbuilt)           || null,
    lat:           parseFloat(prop.location?.latitude),
    lon:           parseFloat(prop.location?.longitude),
    propertyType:  prop.summary?.proptype || prop.summary?.propSubType || 'SFR',
    lastSoldPrice: parseFloat(prop.sale?.amount?.saleamt)      || null,
    lastSoldDate:  prop.sale?.saleTransDate || prop.sale?.salesearchdate || null
  };
}

const fmtDate = d => (d instanceof Date ? d : new Date(d)).toISOString().split('T')[0];

async function attomSaleComps(lat, lon, radiusMiles, sqft, sqftBuffer) {
  // Do NOT pass date params to ATTOM — sale/snapshot ignores them inconsistently.
  // Pull all results and filter client-side (15-month cutoff applied below).
  const params = {
    latitude:  lat,
    longitude: lon,
    radius:    radiusMiles,
    pagesize:  50
  };
  if (sqft) {
    params.minsqsize = Math.max(1, sqft - sqftBuffer);
    params.maxsqsize = sqft + sqftBuffer;
  }

  let res;
  try {
    res = await axios.get(
      'https://api.gateway.attomdata.com/propertyapi/v1.0.0/sale/snapshot',
      { headers: { apikey: ATTOM_KEY, Accept: 'application/json' }, params, timeout: 15000 }
    );
  } catch (err) {
    console.warn('[attomSaleComps]', err.message);
    return [];
  }

  // 15-month cutoff — filter client-side
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 15);

  return (res.data?.property || [])
    .filter(p => {
      if (!p.sale?.amount?.saleamt || parseFloat(p.sale.amount.saleamt) <= 0) return false;
      const saleDate = p.sale?.saleTransDate || p.sale?.salesearchdate;
      if (!saleDate) return false;
      if (new Date(saleDate) < cutoff) return false;
      return true;
    })
    .map(p => {
      const sqftComp  = parseInt(p.building?.size?.universalsize || p.building?.size?.livingsize || 0) || null;
      const saleAmt   = parseFloat(p.sale.amount.saleamt);
      const rawPpsf   = sqftComp ? Math.round(saleAmt / sqftComp) : null;
      const saleDateR = p.sale?.saleTransDate || p.sale?.salesearchdate;
      const saleDate  = saleDateR ? new Date(saleDateR) : null;
      const monthsOld = saleDate ? (Date.now() - saleDate.getTime()) / (1000 * 60 * 60 * 24 * 30.44) : 15;
      const cLat = parseFloat(p.location?.latitude);
      const cLon = parseFloat(p.location?.longitude);
      return {
        address:       p.address?.oneLine || p.address?.line1,
        sqft:          sqftComp,
        beds:          parseInt(p.building?.rooms?.beds)       || null,
        baths:         parseInt(p.building?.rooms?.bathstotal) || null,
        halfBaths:     parseInt(p.building?.rooms?.bathshalf)  || 0,
        garageSpaces:  parseInt(p.building?.parking?.prkgSpaces || 0) || 0,
        pool:          !!(p.building?.pool?.poolInd === 'Y' || p.lot?.poolType),
        lotSize:       parseFloat(p.lot?.lotsize1) || null,
        yearBuilt:     parseInt(p.summary?.yearbuilt) || null,
        propType:      p.summary?.proptype || null,
        saleAmt,
        saleDate:      saleDateR ? fmtDate(saleDate) : null,
        monthsOld:     Math.round(monthsOld * 10) / 10,
        dom:           parseInt(p.sale?.amount?.dom) || null,
        priorSaleAmt:  parseFloat(p.sale?.amount?.priorSaleAmt) || null,
        priorSaleDate: p.sale?.priorSaleTransDate || null,
        rawPpsf,
        lat: cLat,
        lon: cLon,
        distanceMi: (lat && lon && cLat && cLon)
          ? Math.round(haversine(lat, lon, cLat, cLon) * 100) / 100
          : null
      };
    });
}

// ═══════════════════════════════════════════════════════════════
// PURE CODE HELPERS
// ═══════════════════════════════════════════════════════════════

function haversine(lat1, lon1, lat2, lon2) {
  const R    = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
          * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function poolValueByState(stateCode) {
  const warm = ['FL','TX','AZ','NV','CA','HI','NM','GA','SC','NC','LA','MS','AL','AR'];
  const mild = ['TN','VA','OK','KY','MO','KS','CO','UT','OR','WA','MD','DE','DC'];
  if (!stateCode) return 10000;
  const s = stateCode.toUpperCase();
  if (warm.includes(s)) return 15000;
  if (mild.includes(s)) return 10000;
  return 5000;
}

function extractStateFromAddress(address) {
  if (!address) return null;
  const m = address.match(/\b([A-Z]{2})\s+\d{5}/);
  return m ? m[1] : null;
}

// 0.3%/month for comps older than 3 months
function applyTimeAdjustment(saleAmt, monthsOld) {
  if (monthsOld <= 3) return saleAmt;
  return saleAmt * (1 + 0.003 * (monthsOld - 3));
}

// FNMA appraisal adjustments — all math, no LLM
function applyPropertyAdjustments(comp, subject, stateCode) {
  let adj = 0;

  // Beds: ±$5,000/bedroom
  if (subject.beds !== null && comp.beds !== null) {
    adj += (subject.beds - comp.beds) * 5000;
  }

  // Full baths: ±$4,000 | Half baths: ±$2,000
  if (subject.baths !== null && comp.baths !== null) {
    const subFull = (subject.baths || 0) - (subject.halfBaths || 0) * 0.5;
    const cmpFull = (comp.baths    || 0) - (comp.halfBaths    || 0) * 0.5;
    adj += (subFull - cmpFull) * 4000;
  }

  // Garage: ±$8,000/space
  const subGar = subject.garageSpaces || 0;
  const cmpGar = comp.garageSpaces    || 0;
  if (subGar !== cmpGar) adj += (subGar - cmpGar) * 8000;

  // Pool: state-based value
  if (subject.pool !== comp.pool) {
    const pv = poolValueByState(stateCode);
    adj += subject.pool ? pv : -pv;
  }

  // Lot: only adjust if 2× different (in acres)
  if (subject.lotSize && comp.lotSize) {
    const ratio = comp.lotSize / subject.lotSize;
    if (ratio > 2 || ratio < 0.5) {
      const lotDiffSqft = (subject.lotSize - comp.lotSize) * 43560;
      adj += lotDiffSqft * 1.5;  // $1.50/sqft lot excess
    }
  }

  // Year built: ±$500 per decade
  if (subject.yearBuilt && comp.yearBuilt) {
    adj += ((subject.yearBuilt - comp.yearBuilt) / 10) * 500;
  }

  // Cap total adjustment at ±25% of sale price (prevents runaway stacking)
  const cap = comp.saleAmt * 0.25;
  adj = Math.max(-cap, Math.min(cap, adj));

  return Math.round(adj);
}

// Flip: resold 15%+ higher within 6 months of prior purchase
function detectFlip(comp) {
  if (!comp.priorSaleAmt || !comp.priorSaleDate) return false;
  const months = (new Date(comp.saleDate) - new Date(comp.priorSaleDate))
               / (1000 * 60 * 60 * 24 * 30.44);
  return months <= 6 && comp.saleAmt >= comp.priorSaleAmt * 1.15;
}

function domIcon(dom) {
  if (dom === null || dom === undefined) return '';
  if (dom < 30)  return '⚡';  // fast
  if (dom <= 90) return '';    // normal
  return '🐢';                 // slow
}

function stdDev(vals) {
  if (vals.length < 2) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
}

// Explain WHY a comp is an outlier rather than just flagging it
function diagnoseOutlier(comp, subject) {
  const tags = [];
  if (comp.yearBuilt && subject.yearBuilt && comp.yearBuilt - subject.yearBuilt > 15)
    tags.push(`newer build ${comp.yearBuilt}`);
  if (comp.pool && !subject.pool)       tags.push('has pool');
  if ((comp.garageSpaces || 0) > (subject.garageSpaces || 0) + 1) tags.push('extra garage');
  if (comp.lotSize && subject.lotSize && comp.lotSize > subject.lotSize * 2)
    tags.push('larger lot');
  if ((comp.beds || 0) > (subject.beds || 0) + 1)
    tags.push(`${comp.beds}bd vs ${subject.beds}bd`);
  if (comp.sqft && subject.sqft && comp.sqft > subject.sqft * 1.3)
    tags.push('larger home');
  return tags.length ? tags.join(', ') : 'verify — reason unclear';
}

// 0–100 certainty score
function calculateCertaintyScore(coreComps, subject, maxRadius) {
  let score = 0;
  const n = coreComps.length;

  // Volume (25 pts)
  score += n >= 6 ? 25 : n >= 4 ? 20 : n >= 3 ? 12 : 0;

  // Proximity (25 pts)
  score += maxRadius <= 0.5 ? 25
         : maxRadius <= 1   ? 20
         : maxRadius <= 2   ? 15
         : maxRadius <= 5   ? 8
         :                    3;

  // Price tightness (20 pts)
  const ppsfVals = coreComps.filter(c => c.adjPpsf).map(c => c.adjPpsf);
  if (ppsfVals.length >= 2) {
    const mean = ppsfVals.reduce((a, b) => a + b, 0) / ppsfVals.length;
    const cv   = mean > 0 ? stdDev(ppsfVals) / mean : 1;
    score += cv < 0.10 ? 20 : cv < 0.20 ? 15 : cv < 0.30 ? 8 : 3;
  } else {
    score += 5;
  }

  // Recency (15 pts)
  const avgAge = coreComps.length
    ? coreComps.reduce((s, c) => s + (c.monthsOld || 15), 0) / coreComps.length
    : 15;
  score += avgAge <= 3 ? 15 : avgAge <= 6 ? 12 : avgAge <= 12 ? 8 : 4;

  // Subject data quality (15 pts)
  let dq = 15;
  if (!subject.sqft)      dq -= 6;
  if (!subject.yearBuilt) dq -= 3;
  if (!subject.beds)      dq -= 3;
  if (!subject.baths)     dq -= 3;
  score += Math.max(0, dq);

  const label = score >= 85 ? 'High'
              : score >= 65 ? 'Moderate'
              : score >= 45 ? 'Low'
              :               'Thin data';
  return { score, label };
}

// ═══════════════════════════════════════════════════════════════
// COMP PROCESSING  (pure code — no LLM)
// ═══════════════════════════════════════════════════════════════

function processComps(rawComps, subject, stateCode) {
  if (!rawComps || rawComps.length === 0) {
    return { comps: [], flips: 0, outliers: 0, arv: null, avgPpsf: null,
             ppsfRange: null, certainty: { score: 0, label: 'No comps' },
             maxRadius: 0, avgDom: null, notes: [] };
  }

  // Step 1: time + property adjustments on every comp
  const processed = rawComps.map(c => {
    const timeAdj = applyTimeAdjustment(c.saleAmt, c.monthsOld);
    const propAdj = applyPropertyAdjustments(c, subject, stateCode);
    const adjAmt  = timeAdj + propAdj;
    const adjPpsf = c.sqft ? Math.round(adjAmt / c.sqft) : null;
    return { ...c, timeAdj: Math.round(timeAdj), propAdj, adjAmt: Math.round(adjAmt),
             adjPpsf, isFlip: detectFlip(c) };
  });

  // Step 2: outlier detection on adjPpsf (>2 std devs)
  const ppsfAll  = processed.filter(c => c.adjPpsf).map(c => c.adjPpsf);
  const meanPpsf = ppsfAll.length ? ppsfAll.reduce((a, b) => a + b, 0) / ppsfAll.length : 0;
  const sdPpsf   = stdDev(ppsfAll);

  const tagged = processed.map(c => {
    const isOutlier   = c.adjPpsf !== null && sdPpsf > 0
                      && Math.abs(c.adjPpsf - meanPpsf) > 2 * sdPpsf;
    const outlierNote = isOutlier ? diagnoseOutlier(c, subject) : null;
    return { ...c, isOutlier, outlierNote };
  });

  // Step 3: core comps = non-outliers with a valid adjPpsf
  const core = tagged.filter(c => !c.isOutlier && c.adjPpsf);

  // Weighted avg $/sqft — flip-confirmed sales get 1.5× weight (best ARV signal)
  let wSum = 0, wTotal = 0;
  core.forEach(c => {
    const w  = c.isFlip ? 1.5 : 1.0;
    wSum    += c.adjPpsf * w;
    wTotal  += w;
  });
  const avgPpsf = wTotal > 0 ? Math.round(wSum / wTotal) : null;
  const arv     = avgPpsf && subject.sqft
    ? Math.round(avgPpsf * subject.sqft / 1000) * 1000
    : null;

  const ppsfRange = ppsfAll.length
    ? { min: Math.round(Math.min(...ppsfAll)), max: Math.round(Math.max(...ppsfAll)) }
    : null;

  const maxRadius  = Math.round(Math.max(...rawComps.map(c => c.distanceMi || 0)) * 10) / 10;
  const certainty  = calculateCertaintyScore(core, subject, maxRadius);
  const flipsCount = tagged.filter(c => c.isFlip).length;
  const outCount   = tagged.filter(c => c.isOutlier).length;
  const domComps   = core.filter(c => c.dom);
  const avgDom     = domComps.length
    ? Math.round(domComps.reduce((s, c) => s + c.dom, 0) / domComps.length)
    : null;

  const notes = [];
  if (flipsCount > 0)
    notes.push(`${flipsCount} flip-confirmed renovated sale${flipsCount > 1 ? 's' : ''}`);
  if (outCount > 0)
    notes.push(`${outCount} outlier${outCount > 1 ? 's' : ''} — shown, excluded from avg`);

  return { comps: tagged, flips: flipsCount, outliers: outCount, arv, avgPpsf,
           ppsfRange, certainty, maxRadius, avgDom, notes };
}

// ═══════════════════════════════════════════════════════════════
// COMP TIER PULL
// ═══════════════════════════════════════════════════════════════

async function pullCompsWithTiers(lat, lon, propType, sqft) {
  const STEP      = 0.5;
  const MAX       = 10;
  const MIN_COMPS = 3;

  let comps = [], radius = 0;
  for (radius = STEP; radius <= MAX; radius += STEP) {
    const raw = await attomSaleComps(lat, lon, radius, sqft, 500);

    // Match to subject property type when possible
    let pool = raw;
    if (propType && raw.length > 0) {
      const norm  = propType.toLowerCase().replace(/[^a-z]/g, '').slice(0, 5);
      const typed = raw.filter(c =>
        !c.propType || c.propType.toLowerCase().replace(/[^a-z]/g, '').includes(norm)
      );
      pool = typed.length >= MIN_COMPS ? typed : raw;
    }

    comps = pool;
    if (comps.length >= MIN_COMPS) break;
  }

  return { comps, radius: Math.min(radius, MAX), flagged: radius > MAX };
}

// ═══════════════════════════════════════════════════════════════
// JSON EXTRACTOR  (8-step repair)
// ═══════════════════════════════════════════════════════════════

function extractJSON(raw) {
  if (!raw) return null;
  let s = raw;
  s = s.replace(/```(?:json)?[\r\n]?([\s\S]*?)```/gi, '$1').trim();
  const st = s.indexOf('{'), en = s.lastIndexOf('}');
  if (st !== -1 && en !== -1) s = s.slice(st, en + 1);
  s = s.replace(/([^:])\/\/[^\n]*/g, '$1');
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');
  s = s.replace(/,(\s*[}\]])/g, '$1');
  s = s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*):/g, '$1"$2"$3:');
  s = s.replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, '"$1"');
  let out = '', inStr = false, esc = false;
  for (const ch of s) {
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\' && inStr) { out += ch; esc = true; continue; }
    if (ch === '"') { out += ch; inStr = !inStr; continue; }
    if (inStr && ch.charCodeAt(0) < 32) {
      if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else out += ' ';
      continue;
    }
    out += ch;
  }
  try { return JSON.parse(out); } catch (e) {
    console.warn('[extractJSON] parse failed:', e.message, '| sample:', out.slice(0, 120));
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// LLM CALLER (Anthropic)
// ═══════════════════════════════════════════════════════════════

async function callClaude(systemPrompt, userPrompt, maxTokens = 800) {
  const res = await axios({
    method: 'post',
    url:    'https://api.anthropic.com/v1/messages',
    timeout: 60000,
    headers: {
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type':      'application/json'
    },
    data: {
      model:      MODEL,
      max_tokens: maxTokens,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }]
    }
  });
  const text = res.data.content?.find(b => b.type === 'text')?.text || '';
  return extractJSON(text);
}

// ═══════════════════════════════════════════════════════════════
// AGENT 1: DISCOUNT AGENT
// Parse call notes → itemized repair estimate
// ═══════════════════════════════════════════════════════════════

const DISCOUNT_SYSTEM = `You are a real estate investment underwriter estimating repair costs.
Given property details and seller call notes, identify every repair or condition item and price it conservatively (lean toward the higher end).

DISCOUNT TABLE:
Per-sqft items (minor/major): HVAC old $3/$4 · Flooring $3/$4 · Kitchen dated $3/$4 · Kitchen full $7/$8 · Siding minor $1/$2 · Siding full $3/$5
Flat items: Foundation $20k flat · Roof 20yr+ $8k/$15k · Windows original $3k/$6k · Water heater 12yr+ $1k/$2.5k · Kitchen appliances $4k · Old electrical panel $3k · Knob & tube $8k · Plumbing issues $2k/$10k · Tenant occupied $3k/$7k
Per bath: Dated $2k · Full update $6k

RED FLAGS (note only — do not add to repair cost): deed issues · active MLS listing · septic+well combo · small market · seller owes more than likely offer
NOTE: Manufactured/mobile homes are valid property types — not a red flag.

Return ONLY valid JSON:
{
  "repairEstimate": <total dollars>,
  "repairBreakdown": ["<item: $amount>"],
  "repairNotes": "<one concise sentence>",
  "conditionLevel": "move-in-ready|cosmetic|moderate|full-rehab|major-issues",
  "redFlags": ["<flag>"]
}`;

async function discountAgent(subject, callNotes) {
  if (!callNotes || callNotes.trim().length < 15) {
    return { repairEstimate: 0, repairBreakdown: [], repairNotes: 'Not provided',
             conditionLevel: 'unknown', redFlags: [], hasNotes: false };
  }
  const user = `Subject: ${subject.address} | ${subject.sqft || '?'}sqft | ${subject.beds || '?'}bd/${subject.baths || '?'}ba | Built ${subject.yearBuilt || '?'}
Call notes: ${callNotes}`;
  try {
    const result = await callClaude(DISCOUNT_SYSTEM, user, 600);
    if (!result) throw new Error('no JSON');
    return { ...result, hasNotes: true };
  } catch (err) {
    console.warn('[discountAgent]', err.message);
    return { repairEstimate: 0, repairBreakdown: [], repairNotes: 'Could not parse — review manually',
             conditionLevel: 'unknown', redFlags: [], hasNotes: true };
  }
}

// ═══════════════════════════════════════════════════════════════
// AGENT 2: NARRATIVE AGENT
// JARVIS read + exit recommendation — 2–3 sentences max
// ═══════════════════════════════════════════════════════════════

const NARRATIVE_SYSTEM = `You are JARVIS, a sharp real estate investment analyst briefing an experienced investor.
Be direct. No fluff. No "Based on my analysis" preamble.
Comment on: what the comps are saying, market velocity (DOM), flipper activity if present, which exit looks better and why.
Never invent numbers — only reference what's provided.

Return ONLY valid JSON:
{
  "jarvisRead": "<2-3 tight sentences>",
  "exitRecommendation": "wholesale|novation|either|neither",
  "exitReason": "<one sentence>",
  "needsInfo": ["<what would sharpen this analysis>"]
}`;

async function narrativeAgent(subject, compData, repairData, formulaData, callNotes) {
  const compLines = (compData.comps || []).slice(0, 6).map((c, i) =>
    `${i+1}. ${c.sqft || '?'}sf ${c.beds || '?'}bd/${c.baths || '?'}ba ` +
    `${c.yearBuilt || '?'} ${c.distanceMi !== null ? c.distanceMi + 'mi' : ''} ` +
    `$${c.saleAmt?.toLocaleString()} ${c.saleDate} DOM:${c.dom || '?'} adj$${c.adjPpsf || '?'}/sf` +
    (c.isFlip ? ' FLIP' : '') + (c.isOutlier ? ` OUTLIER(${c.outlierNote})` : '')
  ).join('\n');

  const user =
`Property: ${subject.address} | ${subject.sqft}sqft | ${subject.beds}bd/${subject.baths}ba | Built ${subject.yearBuilt} | ${subject.propertyType}

Market: ${compData.comps.length} comps · ${compData.maxRadius}mi · avg $${compData.avgPpsf}/sqft` +
` · range $${compData.ppsfRange?.min || '?'}–$${compData.ppsfRange?.max || '?'}/sqft` +
(compData.avgDom ? ` · avg DOM ${compData.avgDom}` : '') +
(compData.flips > 0 ? ` · ${compData.flips} flip-confirmed sales` : '') + `

Comps:
${compLines || 'None'}

Numbers:
ARV $${formulaData.arv?.toLocaleString() || 'N/A'} · As-Is $${formulaData.asIsValue?.toLocaleString() || 'N/A'}
Repairs $${formulaData.repairEstimate?.toLocaleString() || '0'} (${repairData.repairNotes || 'not provided'})
Wholesale MAO $${formulaData.wholesaleMao?.toLocaleString() || 'N/A'} · Anchor $${formulaData.anchor?.toLocaleString() || 'N/A'}
Novation MAO $${formulaData.novationMao?.toLocaleString() || 'N/A'} · List at $${formulaData.novationListPrice?.toLocaleString() || 'N/A'}
Certainty: ${compData.certainty?.score || 0}% (${compData.certainty?.label || '?'})

Call notes: ${callNotes || 'none'}`;

  try {
    const r = await callClaude(NARRATIVE_SYSTEM, user, 500);
    return r || { jarvisRead: 'See numbers above.', exitRecommendation: 'either', exitReason: null, needsInfo: [] };
  } catch (err) {
    console.warn('[narrativeAgent]', err.message);
    return { jarvisRead: 'Analysis complete.', exitRecommendation: 'either', exitReason: null, needsInfo: [] };
  }
}

// ═══════════════════════════════════════════════════════════════
// SLACK OUTPUT FORMATTER
// ═══════════════════════════════════════════════════════════════

function formatSlackOutput(subject, compData, repairData, formulaData, narrative) {
  const f = n => (n !== null && n !== undefined) ? '$' + Math.round(n).toLocaleString() : 'N/A';
  const L = [];

  // Header
  L.push(`📍 *${subject.address || 'Unknown address'}*`);
  L.push(`${subject.propertyType || 'Property'} · ${subject.sqft ? subject.sqft.toLocaleString() + ' sqft' : 'sqft unknown'} · ${subject.beds || '?'}bd/${subject.baths || '?'}ba · Built ${subject.yearBuilt || '?'}`);
  L.push('');

  // Offer block
  L.push(`🔢 *WHAT I'D OFFER*`);
  if (formulaData.wholesaleMao !== null) {
    L.push(`Wholesale: open at *${f(formulaData.anchor)}* → up to *${f(formulaData.wholesaleMao)}*`);
  } else {
    L.push(`Wholesale: N/A (no comp data)`);
  }
  if (formulaData.novationMao !== null) {
    L.push(`Novation: *${f(formulaData.novationMao)}* (list as-is at ${f(formulaData.novationListPrice)})`);
  } else {
    L.push(`Novation: N/A`);
  }
  if (repairData.hasNotes && repairData.repairEstimate > 0) {
    L.push(`Repairs: ${f(repairData.repairEstimate)} — ${repairData.repairNotes}`);
  } else if (!repairData.hasNotes) {
    L.push(`Repairs: Not provided — adjust MAO if rehab is needed`);
  }
  L.push(`Certainty: *${compData.certainty?.score || 0}%* — ${compData.certainty?.label || '?'}`);
  if (narrative.exitReason) {
    L.push(`Best exit: ${narrative.exitRecommendation} — ${narrative.exitReason}`);
  }
  L.push('');

  // Market snapshot
  L.push(`📊 *MARKET* (${compData.comps.length} comps · ${compData.maxRadius}mi · 15mo)`);
  if (compData.avgPpsf) {
    L.push(
      `Avg $${compData.avgPpsf}/sqft · Range $${compData.ppsfRange?.min || '?'}–$${compData.ppsfRange?.max || '?'}/sqft` +
      (compData.avgDom ? ` · Avg DOM ${compData.avgDom}` : '')
    );
  } else {
    L.push('Insufficient comp data — cannot compute ARV');
  }
  if (compData.flips > 0)
    L.push(`⚡ ${compData.flips} flip-confirmed renovated sale${compData.flips > 1 ? 's' : ''} — strongest ARV signal`);
  if (compData.outliers > 0)
    L.push(`⚠️ ${compData.outliers} outlier${compData.outliers > 1 ? 's' : ''} detected — shown below, excluded from average`);
  L.push('');

  // Comp detail
  if (compData.comps.length > 0) {
    L.push(`📋 *COMPS*`);
    compData.comps.slice(0, 7).forEach((c, i) => {
      const tags = [
        c.isFlip    ? '⚡'                                      : '',
        c.isOutlier ? `⚠️(${c.outlierNote?.split(',')[0]})` : '',
        domIcon(c.dom)
      ].filter(Boolean).join(' ');
      const dist   = c.distanceMi !== null ? `${c.distanceMi}mi` : '';
      const domStr = c.dom !== null ? `DOM:${c.dom}` : '';
      L.push(
        `${i+1}. ${c.sqft || '?'}sf ${c.beds || '?'}bd/${c.baths || '?'}ba ` +
        `${c.yearBuilt || '?'} ${dist} · ${f(c.saleAmt)} ${c.saleDate || ''} ` +
        `· ${domStr} · $${c.adjPpsf || '?'}/sf adj ${tags}`.trim()
      );
    });
    L.push('');
  }

  // JARVIS read
  if (narrative.jarvisRead) {
    L.push(`💡 *JARVIS:* ${narrative.jarvisRead}`);
  }

  // Flags
  const allFlags = [
    ...(repairData.redFlags || []),
    ...(compData.notes || []),
    ...(compData.maxRadius > 5 ? [`Comps spread to ${compData.maxRadius}mi — thin market data`] : [])
  ];
  if (allFlags.length > 0) L.push(`🚩 ${allFlags.join(' · ')}`);

  // What would sharpen it
  if (narrative.needsInfo && narrative.needsInfo.length > 0) {
    L.push(`📎 Would sharpen this: ${narrative.needsInfo.join(', ')}`);
  }

  return L.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// MAIN ROUTE
// ═══════════════════════════════════════════════════════════════

app.post('/analyze', async (req, res) => {
  const { address, callNotes } = req.body || {};
  if (!address) return res.status(400).json({ error: 'address required' });

  console.log('[analyze]', address);

  try {
    // 1. Parse address
    const commaIdx = address.indexOf(',');
    const address1 = commaIdx > -1 ? address.slice(0, commaIdx).trim() : address.trim();
    const address2 = commaIdx > -1 ? address.slice(commaIdx + 1).trim() : '';

    // 2. Subject property from ATTOM
    let subject;
    try {
      subject = await attomPropertyDetail(address1, address2);
      console.log(`[subject] ${subject.sqft}sqft ${subject.beds}bd/${subject.baths}ba ${subject.propertyType}`);
    } catch (err) {
      return res.status(500).json({ error: `Could not locate property: ${err.message}` });
    }

    // 3. Sqft override: check if caller included it in the notes
    if (!subject.sqft && callNotes) {
      const m = callNotes.match(/\b(\d{3,4})\s*sq(?:\.?\s*ft|uare\s*f(?:eet|t)?)/i);
      if (m) { subject.sqft = parseInt(m[1]); console.log('[subject] sqft override:', subject.sqft); }
    }

    // 4. Stop and ask if sqft still unknown
    if (!subject.sqft) {
      return res.json({
        needs_sqft: true,
        message: `Found *${subject.address || address}* (${subject.propertyType || 'property'}) but ATTOM doesn't have the square footage on record for this one — common with older or rural properties. What's the sqft? Reply with the address again and include it (e.g., "1,450 sqft").`
      });
    }

    // 5. Pull comps with 0.5mi tier expansion
    const stateCode = extractStateFromAddress(subject.address);
    const { comps: rawComps, radius: finalRadius, flagged } =
      await pullCompsWithTiers(subject.lat, subject.lon, subject.propertyType, subject.sqft);
    console.log(`[comps] ${rawComps.length} at ${finalRadius}mi ${flagged ? '⚠️' : ''}`);

    if (rawComps.length === 0) {
      return res.json({
        needs_info: true,
        message: `No county-recorded comps found within 10mi for *${subject.address}* (${subject.propertyType} · ${subject.sqft.toLocaleString()}sqft). ATTOM may have limited sales data for this area or the sqft filter is too tight. Want me to try without the sqft filter? Or drop any comps you know of and I'll work from those.`
      });
    }

    // 6. Process comps — pure code (adjustments, flips, outliers, ARV, certainty)
    const compData = processComps(rawComps, subject, stateCode);
    if (flagged) compData.notes.push(`Expanded to ${finalRadius}mi to find enough comps`);

    // 7. Repair estimate from call notes
    const repairData = await discountAgent(subject, callNotes);

    // 8. Formula math — all in code, no LLM
    const arv               = compData.arv;
    const repairEstimate    = repairData.repairEstimate || 0;
    const asIsValue         = arv !== null ? Math.round(arv - repairEstimate) : null;
    const wholesaleMao      = arv !== null ? Math.round(arv * 0.70 - repairEstimate) : null;
    const anchor            = wholesaleMao !== null ? Math.round(wholesaleMao * 0.85) : null;
    const novationListPrice = asIsValue;
    // Novation MAO = As-Is × 0.93 − $50k (7% commissions+closing + $25k buffer + $25k fee)
    const novationMao       = asIsValue !== null ? Math.round(asIsValue * 0.93 - 50000) : null;
    const formulaData = { arv, asIsValue, wholesaleMao, anchor, novationMao, novationListPrice, repairEstimate };

    console.log(`[formula] ARV:${arv} W-MAO:${wholesaleMao} N-MAO:${novationMao}`);

    // 9. JARVIS narrative
    const narrative = await narrativeAgent(subject, compData, repairData, formulaData, callNotes);

    // 10. Format Slack message
    const slackMessage = formatSlackOutput(subject, compData, repairData, formulaData, narrative);

    return res.json({ response: slackMessage });

  } catch (err) {
    console.error('[analyze error]', err.message);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
});

app.get('/health', (req, res) =>
  res.json({ status: 'ok', version: '2.0', attom: !!ATTOM_KEY, anthropic: !!ANTHROPIC_KEY })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Deal Analyzer v2.0 on :${PORT}`));
