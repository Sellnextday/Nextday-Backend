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
// ATTOM HELPERS  (2 calls max per run)
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
    address:       prop.address?.oneLine,
    sqft:          sqftRaw ? parseInt(sqftRaw) : null,
    beds:          parseInt(prop.building?.rooms?.beds)       || null,
    baths:         parseInt(prop.building?.rooms?.bathstotal) || null,
    halfBaths:     parseInt(prop.building?.rooms?.bathshalf)  || 0,
    garageSpaces:  parseInt(prop.building?.parking?.prkgSpaces || prop.building?.parking?.parkingSpaceNo || 0) || 0,
    pool:          !!(prop.building?.pool?.poolInd === 'Y' || prop.lot?.poolType),
    lotSize:       parseFloat(prop.lot?.lotsize1) || null,
    yearBuilt:     parseInt(prop.summary?.yearbuilt) || null,
    lat:           parseFloat(prop.location?.latitude),
    lon:           parseFloat(prop.location?.longitude),
    propertyType:  prop.summary?.proptype || prop.summary?.propSubType || 'SFR',
    lastSoldPrice: parseFloat(prop.sale?.amount?.saleamt) || null,
    lastSoldDate:  prop.sale?.saleTransDate || prop.sale?.salesearchdate || null
  };
}

const fmtDate = d => (d instanceof Date ? d : new Date(d)).toISOString().split('T')[0];

async function attomSaleComps(lat, lon, radiusMiles) {
  // No sqft or date filters sent to ATTOM — pull everything, filter client-side
  let res;
  try {
    res = await axios.get(
      'https://api.gateway.attomdata.com/propertyapi/v1.0.0/sale/snapshot',
      {
        headers: { apikey: ATTOM_KEY, Accept: 'application/json' },
        params:  { latitude: lat, longitude: lon, radius: radiusMiles, pagesize: 50 },
        timeout: 15000
      }
    );
  } catch (err) {
    console.warn('[attomSaleComps]', err.message);
    return [];
  }

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 15);

  return (res.data?.property || [])
    .filter(p => {
      if (!p.sale?.amount?.saleamt || parseFloat(p.sale.amount.saleamt) <= 0) return false;
      const sd = p.sale?.saleTransDate || p.sale?.salesearchdate;
      return sd && new Date(sd) >= cutoff;
    })
    .map(p => {
      const sqftComp  = parseInt(p.building?.size?.universalsize || p.building?.size?.livingsize || 0) || null;
      const saleAmt   = parseFloat(p.sale.amount.saleamt);
      const saleDateR = p.sale?.saleTransDate || p.sale?.salesearchdate;
      const saleDate  = saleDateR ? new Date(saleDateR) : null;
      const monthsOld = saleDate ? (Date.now() - saleDate.getTime()) / (1000 * 60 * 60 * 24 * 30.44) : 15;
      const cLat = parseFloat(p.location?.latitude);
      const cLon = parseFloat(p.location?.longitude);
      return {
        address:       p.address?.oneLine
                    || [p.address?.line1, p.address?.line2].filter(Boolean).join(', ')
                    || null,
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
        lat: cLat, lon: cLon,
        distanceMi: (lat && lon && cLat && cLon)
          ? Math.round(haversine(lat, lon, cLat, cLon) * 100) / 100 : null
      };
    });
}

// ═══════════════════════════════════════════════════════════════
// PURE HELPERS
// ═══════════════════════════════════════════════════════════════

function haversine(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function poolValueByState(s) {
  const warm = ['FL','TX','AZ','NV','CA','HI','NM','GA','SC','NC','LA','MS','AL','AR'];
  const mild = ['TN','VA','OK','KY','MO','KS','CO','UT','OR','WA','MD','DE','DC'];
  if (!s) return 10000;
  const u = s.toUpperCase();
  return warm.includes(u) ? 15000 : mild.includes(u) ? 10000 : 5000;
}

function extractStateFromAddress(addr) {
  if (!addr) return null;
  const m = addr.match(/\b([A-Z]{2})\s+\d{5}/);
  return m ? m[1] : null;
}

function applyTimeAdjustment(saleAmt, monthsOld) {
  return monthsOld <= 3 ? saleAmt : saleAmt * (1 + 0.003 * (monthsOld - 3));
}

function applyPropertyAdjustments(comp, subject, stateCode) {
  let adj = 0;
  if (subject.beds !== null && comp.beds !== null)
    adj += (subject.beds - comp.beds) * 5000;
  if (subject.baths !== null && comp.baths !== null) {
    const sf = (subject.baths||0) - (subject.halfBaths||0)*0.5;
    const cf = (comp.baths||0)    - (comp.halfBaths||0)*0.5;
    adj += (sf - cf) * 4000;
  }
  adj += ((subject.garageSpaces||0) - (comp.garageSpaces||0)) * 8000;
  if (subject.pool !== comp.pool) adj += subject.pool ? poolValueByState(stateCode) : -poolValueByState(stateCode);
  if (subject.lotSize && comp.lotSize) {
    const r = comp.lotSize / subject.lotSize;
    if (r > 2 || r < 0.5) adj += (subject.lotSize - comp.lotSize) * 43560 * 1.5;
  }
  if (subject.yearBuilt && comp.yearBuilt)
    adj += ((subject.yearBuilt - comp.yearBuilt) / 10) * 500;
  return Math.round(Math.max(-comp.saleAmt*0.25, Math.min(comp.saleAmt*0.25, adj)));
}

function detectFlip(comp) {
  if (!comp.priorSaleAmt || !comp.priorSaleDate) return false;
  const months = (new Date(comp.saleDate) - new Date(comp.priorSaleDate)) / (1000*60*60*24*30.44);
  return months <= 6 && comp.saleAmt >= comp.priorSaleAmt * 1.15;
}

function domIcon(dom) {
  if (!dom && dom !== 0) return '';
  return dom < 30 ? '⚡' : dom > 90 ? '🐢' : '';
}

function stdDev(vals) {
  if (vals.length < 2) return 0;
  const mean = vals.reduce((a,b)=>a+b,0)/vals.length;
  return Math.sqrt(vals.reduce((s,v)=>s+(v-mean)**2,0)/vals.length);
}

function diagnoseOutlier(comp, subject) {
  const tags = [];
  if (comp.yearBuilt && subject.yearBuilt && comp.yearBuilt - subject.yearBuilt > 15) tags.push(`newer build ${comp.yearBuilt}`);
  if (comp.pool && !subject.pool) tags.push('has pool');
  if ((comp.garageSpaces||0) > (subject.garageSpaces||0)+1) tags.push('extra garage');
  if (comp.lotSize && subject.lotSize && comp.lotSize > subject.lotSize*2) tags.push('larger lot');
  if ((comp.beds||0) > (subject.beds||0)+1) tags.push(`${comp.beds}bd`);
  return tags.length ? tags.join(', ') : 'verify — reason unclear';
}

function calculateCertaintyScore(usableComps, subject, maxRadius) {
  let score = 0;
  const n = usableComps.length;
  score += n >= 6 ? 25 : n >= 4 ? 20 : n >= 3 ? 12 : 0;
  score += maxRadius <= 0.5 ? 25 : maxRadius <= 1 ? 20 : maxRadius <= 2 ? 15 : maxRadius <= 5 ? 8 : 3;
  const ppsfVals = usableComps.filter(c=>c.adjPpsf).map(c=>c.adjPpsf);
  if (ppsfVals.length >= 2) {
    const mean = ppsfVals.reduce((a,b)=>a+b,0)/ppsfVals.length;
    const cv   = mean > 0 ? stdDev(ppsfVals)/mean : 1;
    score += cv < 0.10 ? 20 : cv < 0.20 ? 15 : cv < 0.30 ? 8 : 3;
  } else { score += 5; }
  const avgAge = usableComps.length ? usableComps.reduce((s,c)=>s+(c.monthsOld||15),0)/usableComps.length : 15;
  score += avgAge <= 3 ? 15 : avgAge <= 6 ? 12 : avgAge <= 12 ? 8 : 4;
  let dq = 15;
  if (!subject.sqft) dq -= 6; if (!subject.yearBuilt) dq -= 3;
  if (!subject.beds)  dq -= 3; if (!subject.baths)     dq -= 3;
  score += Math.max(0, dq);
  const label = score >= 85 ? 'High' : score >= 65 ? 'Moderate' : score >= 45 ? 'Low' : 'Thin data';
  return { score, label };
}

// ═══════════════════════════════════════════════════════════════
// COMP PROCESSING — splits usable vs incomplete
// ═══════════════════════════════════════════════════════════════

function processComps(rawComps, subject, sqft, stateCode) {
  // Split immediately: usable = has sqft AND within ±500 sqft range
  const SQFT_BUFFER = 500;
  const usableRaw    = rawComps.filter(c => c.sqft && (!sqft || (c.sqft >= sqft - SQFT_BUFFER && c.sqft <= sqft + SQFT_BUFFER)));
  const incompleteRaw = rawComps.filter(c => !c.sqft); // no sqft — cannot compute $/sqft

  if (usableRaw.length === 0) {
    return {
      usable: [], incomplete: incompleteRaw, asIsValue: null, avgPpsf: null,
      ppsfRange: null, certainty: { score: 0, label: 'No usable comps' },
      maxRadius: 0, avgDom: null, flips: 0, outliers: 0, notes: []
    };
  }

  // Apply time + property adjustments to usable comps
  const processed = usableRaw.map(c => {
    const timeAdj = applyTimeAdjustment(c.saleAmt, c.monthsOld);
    const propAdj = applyPropertyAdjustments(c, subject, stateCode);
    const adjAmt  = timeAdj + propAdj;
    const adjPpsf = Math.round(adjAmt / c.sqft);
    return { ...c, timeAdj: Math.round(timeAdj), propAdj, adjAmt: Math.round(adjAmt),
             adjPpsf, isFlip: detectFlip(c) };
  });

  // Outlier detection on adjPpsf (>2 std devs)
  const ppsfVals = processed.map(c => c.adjPpsf);
  const meanPpsf = ppsfVals.reduce((a,b)=>a+b,0)/ppsfVals.length;
  const sdPpsf   = stdDev(ppsfVals);

  const tagged = processed.map(c => {
    const isOutlier = sdPpsf > 0 && Math.abs(c.adjPpsf - meanPpsf) > 2 * sdPpsf;
    return { ...c, isOutlier, outlierNote: isOutlier ? diagnoseOutlier(c, subject) : null };
  });

  // Core comps: non-outliers — used for as-is value
  const core = tagged.filter(c => !c.isOutlier);

  let wSum = 0, wTotal = 0;
  core.forEach(c => {
    const w = c.isFlip ? 1.5 : 1.0;
    wSum += c.adjPpsf * w; wTotal += w;
  });

  const avgPpsf    = wTotal > 0 ? Math.round(wSum / wTotal) : null;
  const asIsValue  = avgPpsf && subject.sqft ? Math.round(avgPpsf * subject.sqft / 1000) * 1000 : null;
  const ppsfRange  = ppsfVals.length ? { min: Math.min(...ppsfVals), max: Math.max(...ppsfVals) } : null;
  const maxRadius  = Math.round(Math.max(...rawComps.map(c=>c.distanceMi||0)) * 10) / 10;
  const certainty  = calculateCertaintyScore(core, subject, maxRadius);
  const flipsCount = tagged.filter(c=>c.isFlip).length;
  const outCount   = tagged.filter(c=>c.isOutlier).length;
  const domComps   = core.filter(c=>c.dom);
  const avgDom     = domComps.length ? Math.round(domComps.reduce((s,c)=>s+c.dom,0)/domComps.length) : null;

  const notes = [];
  if (flipsCount > 0) notes.push(`${flipsCount} flip-confirmed sale${flipsCount>1?'s':''}`);
  if (outCount > 0)   notes.push(`${outCount} outlier${outCount>1?'s':''} excluded from avg`);
  if (incompleteRaw.length > 0) notes.push(`${incompleteRaw.length} comp${incompleteRaw.length>1?'s':''} missing sqft — not used in calc`);

  return { usable: tagged, incomplete: incompleteRaw, asIsValue, avgPpsf, ppsfRange,
           certainty, maxRadius, avgDom, flips: flipsCount, outliers: outCount, notes };
}

// ═══════════════════════════════════════════════════════════════
// COMP TIER PULL
// ═══════════════════════════════════════════════════════════════

async function pullCompsWithTiers(lat, lon, propType, sqft) {
  const STEP = 0.5, MAX = 10, MIN_USABLE = 3;
  let allComps = [], radius = 0;

  for (radius = STEP; radius <= MAX; radius += STEP) {
    const raw = await attomSaleComps(lat, lon, radius);

    // Property type filter (fall back to all if filtered set is too small)
    let pool = raw;
    if (propType && raw.length > 0) {
      const norm  = propType.toLowerCase().replace(/[^a-z]/g,'').slice(0,5);
      const typed = raw.filter(c => !c.propType || c.propType.toLowerCase().replace(/[^a-z]/g,'').includes(norm));
      if (typed.length >= 2) pool = typed;
    }

    allComps = pool;
    const usableCount = pool.filter(c => c.sqft && (!sqft || Math.abs(c.sqft - sqft) <= 500)).length;
    if (usableCount >= MIN_USABLE) break;
  }

  return { comps: allComps, radius: Math.min(radius, MAX), flagged: radius > MAX };
}

// ═══════════════════════════════════════════════════════════════
// NARRATIVE AGENT — plain text, no JSON parsing risk
// ═══════════════════════════════════════════════════════════════

const NARRATIVE_SYSTEM = `You are JARVIS, a sharp real estate investment analyst briefing an experienced investor.
Be direct. No fluff. Write exactly 4 lines with no labels, headers, or prefixes:
Line 1: 2-sentence market read — what the comps signal, DOM velocity, any flip activity
Line 2: One sentence on whether this looks like a solid novation candidate and why
Line 3: Biggest risk or concern on this deal. If none write: No major flags.
Line 4: What one piece of info would most sharpen this number. If solid write: Data looks complete.
Never invent numbers. Use only what is provided.`;

async function narrativeAgent(subject, compData, formulaData, callNotes) {
  const compLines = compData.usable.slice(0,6).map((c,i) =>
    `${i+1}. ${c.address||'unknown'} | ${c.sqft}sf ${c.beds||'?'}bd/${c.baths||'?'}ba built ${c.yearBuilt||'?'} ${c.distanceMi!==null?c.distanceMi+'mi':''} $${c.saleAmt.toLocaleString()} ${c.saleDate} DOM:${c.dom||'?'} $${c.adjPpsf}/sf`
    + (c.isFlip?' [FLIP]':'') + (c.isOutlier?` [OUTLIER:${c.outlierNote}]`:'')
  ).join('\n');

  const user =
`Property: ${subject.address} | ${subject.sqft}sqft | ${subject.beds||'?'}bd/${subject.baths||'?'}ba | Built ${subject.yearBuilt||'?'} | ${subject.propertyType}
Usable comps: ${compData.usable.length} (full data) + ${compData.incomplete.length} incomplete (no sqft)
Radius: ${compData.maxRadius}mi · Avg $${compData.avgPpsf||'?'}/sqft · Range $${compData.ppsfRange?.min||'?'}–$${compData.ppsfRange?.max||'?'}/sqft · Avg DOM ${compData.avgDom||'?'}
Flips: ${compData.flips}

Comps:
${compLines||'None with full data'}

As-Is Market Value: $${formulaData.asIsValue?.toLocaleString()||'N/A'}
Novation MAO: $${formulaData.novationMao?.toLocaleString()||'N/A'}
Certainty: ${compData.certainty?.score||0}% (${compData.certainty?.label||'?'})
Call notes: ${callNotes||'none'}`;

  try {
    const res = await axios({
      method: 'post', url: 'https://api.anthropic.com/v1/messages', timeout: 60000,
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      data: { model: MODEL, max_tokens: 300, system: NARRATIVE_SYSTEM, messages: [{ role:'user', content: user }] }
    });
    const text  = (res.data.content?.find(b=>b.type==='text')?.text||'').trim();
    const lines = text.split('\n').map(l=>l.trim()).filter(Boolean);
    return { marketRead: lines[0]||null, candidate: lines[1]||null, risk: lines[2]||null, sharpen: lines[3]||null };
  } catch (err) {
    console.warn('[narrativeAgent]', err.message);
    return { marketRead: null, candidate: null, risk: null, sharpen: null };
  }
}

// ═══════════════════════════════════════════════════════════════
// SLACK FORMATTER — novation only
// ═══════════════════════════════════════════════════════════════

function formatSlackOutput(subject, compData, formulaData, narrative) {
  const f = n => n !== null && n !== undefined ? '$' + Math.round(n).toLocaleString() : 'N/A';
  const L = [];

  // Header
  L.push(`📍 *${subject.address||'Unknown'}*`);
  L.push(`${subject.propertyType||'Property'} · ${subject.sqft?subject.sqft.toLocaleString()+' sqft':'sqft unknown'} · ${subject.beds||'?'}bd/${subject.baths||'?'}ba · Built ${subject.yearBuilt||'?'}`);
  L.push('');

  // Novation offer block
  L.push(`💰 *NOVATION OFFER*`);
  if (formulaData.asIsValue) {
    L.push(`As-Is Market Value: *${f(formulaData.asIsValue)}*`);
    L.push(`Offer seller: *${f(formulaData.novationMao)}*`);
    L.push(`List at: ${f(formulaData.novationListPrice)}`);
    L.push(`Your fee: ~$25,000`);
  } else {
    L.push(`As-Is Value: N/A — not enough usable comp data`);
  }
  L.push(`Certainty: *${compData.certainty?.score||0}%* — ${compData.certainty?.label||'?'}`);
  L.push('');

  // Market snapshot
  const usableCount = compData.usable.length;
  const incompleteCount = compData.incomplete.length;
  L.push(`📊 *MARKET* (${usableCount} usable comp${usableCount!==1?'s':''} · ${compData.maxRadius}mi · 15mo)`);
  if (compData.avgPpsf) {
    L.push(`Avg $${compData.avgPpsf}/sqft · Range $${compData.ppsfRange?.min}–$${compData.ppsfRange?.max}/sqft${compData.avgDom?' · Avg DOM '+compData.avgDom:''}`);
  } else {
    L.push(`Insufficient sqft data to compute market value`);
  }
  if (compData.flips > 0) L.push(`⚡ ${compData.flips} flip-confirmed sale${compData.flips>1?'s':''}`);
  if (compData.outliers > 0) L.push(`⚠️ ${compData.outliers} outlier${compData.outliers>1?'s':''} — shown below, excluded from avg`);
  L.push('');

  // Usable comps
  if (compData.usable.length > 0) {
    L.push(`📋 *COMPS — FULL DATA* (${usableCount})`);
    compData.usable.slice(0,7).forEach((c,i) => {
      const tags = [c.isFlip?'⚡':'', c.isOutlier?`⚠️(${c.outlierNote?.split(',')[0]})`:'' , domIcon(c.dom)].filter(Boolean).join(' ');
      L.push(
        `${i+1}. ${c.address||'—'} | ${c.sqft}sf ${c.beds||'?'}bd/${c.baths||'?'}ba ${c.yearBuilt||'?'} ` +
        `${c.distanceMi!==null?c.distanceMi+'mi':''} · ${f(c.saleAmt)} ${c.saleDate} · DOM:${c.dom||'?'} · $${c.adjPpsf}/sf adj ${tags}`.trim()
      );
    });
    L.push('');
  }

  // Incomplete comps (no sqft — not used in calc)
  if (compData.incomplete.length > 0) {
    L.push(`⚠️ *INCOMPLETE — sqft not in county records* (${incompleteCount}, not used in calc)`);
    compData.incomplete.slice(0,4).forEach((c,i) => {
      L.push(`${i+1}. ${c.address||'—'} · ${f(c.saleAmt)} ${c.saleDate} · ${c.distanceMi!==null?c.distanceMi+'mi':''}`);
    });
    L.push('');
  }

  // JARVIS narrative
  if (narrative.marketRead) L.push(`💡 *JARVIS:* ${narrative.marketRead}`);
  if (narrative.candidate)  L.push(`🎯 ${narrative.candidate}`);
  if (narrative.risk && narrative.risk !== 'No major flags.') L.push(`⚠️ ${narrative.risk}`);

  // Flags
  const flags = [
    ...(compData.notes||[]),
    ...(compData.maxRadius > 5 ? [`Comps spread to ${compData.maxRadius}mi`] : [])
  ];
  if (flags.length) L.push(`🚩 ${flags.join(' · ')}`);

  // Sharpen
  if (narrative.sharpen && narrative.sharpen !== 'Data looks complete.') L.push(`📎 ${narrative.sharpen}`);

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

    // 2. Subject property
    let subject;
    try {
      subject = await attomPropertyDetail(address1, address2);
      console.log(`[subject] ${subject.sqft}sqft ${subject.beds}bd/${subject.baths}ba ${subject.propertyType}`);
    } catch (err) {
      return res.status(500).json({ error: `Could not locate property: ${err.message}` });
    }

    // 3. Sqft override from notes
    if (!subject.sqft && callNotes) {
      const m = callNotes.match(/\b(\d{3,4})\s*sq(?:\.?\s*ft|uare\s*f(?:eet|t)?)/i);
      if (m) { subject.sqft = parseInt(m[1]); console.log('[sqft override]', subject.sqft); }
    }

    // 4. Ask for sqft if unknown
    if (!subject.sqft) {
      return res.json({
        needs_sqft: true,
        message: `Found *${subject.address||address}* (${subject.propertyType||'property'}) but ATTOM doesn't have the square footage on record. What's the sqft? Reply with the address again and include it (e.g., "1,450 sqft").`
      });
    }

    // 5. Pull comps (one ATTOM call, tiered by radius)
    const stateCode = extractStateFromAddress(subject.address);
    const { comps: rawComps, radius: finalRadius, flagged } =
      await pullCompsWithTiers(subject.lat, subject.lon, subject.propertyType, subject.sqft);
    console.log(`[comps] ${rawComps.length} raw at ${finalRadius}mi`);

    // 6. Process — split usable vs incomplete
    const compData = processComps(rawComps, subject, subject.sqft, stateCode);
    if (flagged) compData.notes.push(`Expanded to ${finalRadius}mi to find comps`);

    console.log(`[comps] ${compData.usable.length} usable, ${compData.incomplete.length} incomplete`);

    // 7. Novation formula — pure code, no LLM
    const asIsValue        = compData.asIsValue;
    const novationMao      = asIsValue !== null ? Math.round(asIsValue * 0.93 - 50000) : null;
    const novationListPrice = asIsValue;
    const formulaData = { asIsValue, novationMao, novationListPrice };

    console.log(`[formula] As-Is:${asIsValue} Novation MAO:${novationMao}`);

    // 8. JARVIS narrative (1 Anthropic call)
    const narrative = await narrativeAgent(subject, compData, formulaData, callNotes);

    // 9. Format Slack output
    const slackMessage = formatSlackOutput(subject, compData, formulaData, narrative);
    return res.json({ response: slackMessage });

  } catch (err) {
    console.error('[analyze error]', err.message);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
});

app.get('/health', (req, res) =>
  res.json({ status: 'ok', version: '3.0-novation', attom: !!ATTOM_KEY, anthropic: !!ANTHROPIC_KEY })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Deal Analyzer v3.0 (novation-only) on :${PORT}`));
