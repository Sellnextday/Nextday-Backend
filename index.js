import express from 'express';
import axios   from 'axios';
import cors    from 'cors';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ATTOM_KEY     = process.env.ATTOM_API_KEY;
const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY;
const MODEL         = 'claude-sonnet-4-6';
const ZILLOW_HOST   = 'zillow-real-estate-data-api.p.rapidapi.com';

// ══════════════════════════════════════════════════════
// SUBJECT PROPERTY — parsed from your call notes
// ══════════════════════════════════════════════════════

function parseSubjectSpecs(text) {
  if (!text) return {};
  const specs = {};

  // Beds: "4bd", "4 bed", "4 bedroom", "4/3" first number
  const bedsM = text.match(/\b(\d)\s*(?:bed(?:room)?s?|bd)\b/i) || text.match(/\b(\d)\s*\/\s*\d/);
  if (bedsM) specs.beds = parseInt(bedsM[1]);

  // Baths: "3ba", "3 bath", "4/3" second number
  const bathsM = text.match(/\b(\d(?:\.\d)?)\s*(?:bath(?:room)?s?|ba)\b/i) || text.match(/\b\d\s*\/\s*(\d)\b/);
  if (bathsM) specs.baths = parseFloat(bathsM[1]);

  // Sqft: "1460sf", "1,460 sqft", "1460 square feet"
  const sqftM = text.match(/\b([\d,]{3,6})\s*(?:sq\.?\s*ft\.?|sqft|sf|square\s*f(?:eet|t)?)\b/i);
  if (sqftM) specs.sqft = parseInt(sqftM[1].replace(/,/g, ''));

  // Property type keywords
  if (/manufactured|mobile\s*home/i.test(text))               specs.propertyType = 'MANUFACTURED';
  else if (/condo|condominium/i.test(text))                    specs.propertyType = 'CONDO';
  else if (/townhouse|townhome/i.test(text))                   specs.propertyType = 'TOWNHOUSE';
  else if (/multi.?family|duplex|triplex|quadplex|4.?plex/i.test(text)) specs.propertyType = 'MULTI_FAMILY';
  else if (/\bsfr\b|single.?family/i.test(text))              specs.propertyType = 'SFR';

  // Year built: "built 1992", "yr built 1992", "1992 build"
  const yrM = text.match(/(?:built|yr\.?\s*built|year\s*built)\s*:?\s*((?:19|20)\d{2})\b/i)
            || text.match(/\b((?:19|20)\d{2})\s*(?:build|built)/i);
  if (yrM) specs.yearBuilt = parseInt(yrM[1]);

  return specs;
}

function extractCityState(address) {
  const m = address.match(/,\s*([^,]+),\s*([A-Z]{2})\s+\d{5}/);
  if (m) return `${m[1].trim()}, ${m[2]}`;
  const m2 = address.match(/([^,]+),\s*([A-Z]{2})\b/);
  if (m2) return `${m2[1].trim()}, ${m2[2]}`;
  return address;
}

function extractStateCode(address) {
  const m = address.match(/\b([A-Z]{2})\s+\d{5}/);
  return m ? m[1] : null;
}

// ══════════════════════════════════════════════════════
// GEOCODING — Nominatim (free, no API key needed)
// 3-tier fallback: free-text → structured params → zip centroid
// ══════════════════════════════════════════════════════

function expandAbbreviations(addr) {
  return addr
    .replace(/\bW\b/g, 'West').replace(/\bE\b/g, 'East')
    .replace(/\bN\b/g, 'North').replace(/\bS\b/g, 'South')
    .replace(/\bNE\b/g, 'Northeast').replace(/\bNW\b/g, 'Northwest')
    .replace(/\bSE\b/g, 'Southeast').replace(/\bSW\b/g, 'Southwest')
    .replace(/\bSt\b/g, 'Street').replace(/\bAve\b/g, 'Avenue')
    .replace(/\bBlvd\b/g, 'Boulevard').replace(/\bDr\b/g, 'Drive')
    .replace(/\bRd\b/g, 'Road').replace(/\bLn\b/g, 'Lane')
    .replace(/\bCt\b/g, 'Court').replace(/\bPl\b/g, 'Place')
    .replace(/\bCir\b/g, 'Circle').replace(/\bTer\b/g, 'Terrace');
}

async function nominatimQuery(params) {
  const res = await axios.get('https://nominatim.openstreetmap.org/search', {
    params: { format: 'json', limit: 1, countrycodes: 'us', ...params },
    headers: { 'User-Agent': 'NextDayDealAnalyzer/3.1 (admin@sellnextday.com)' },
    timeout: 12000
  });
  return res.data || [];
}

async function geocodeAddress(address) {
  // Attempt 1: free-text, address as-is
  let results = await nominatimQuery({ q: address });
  if (results.length) {
    console.log(`[geo] free-text match: ${results[0].display_name}`);
    return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
  }

  // Attempt 2: expanded abbreviations free-text
  await new Promise(r => setTimeout(r, 1100)); // Nominatim rate limit
  const expanded = expandAbbreviations(address);
  if (expanded !== address) {
    results = await nominatimQuery({ q: expanded });
    if (results.length) {
      console.log(`[geo] expanded match: ${results[0].display_name}`);
      return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
    }
  }

  // Attempt 3: structured query — parse out street / city / state / zip
  await new Promise(r => setTimeout(r, 1100));
  const structMatch = address.match(/^(.*?),\s*([^,]+),\s*([A-Z]{2})\s+(\d{5})/);
  if (structMatch) {
    results = await nominatimQuery({
      street:     expandAbbreviations(structMatch[1].trim()),
      city:       structMatch[2].trim(),
      state:      structMatch[3],
      postalcode: structMatch[4],
      country:    'US'
    });
    if (results.length) {
      console.log(`[geo] structured match: ${results[0].display_name}`);
      return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
    }
  }

  // Attempt 4: zip code centroid (most reliable fallback — good enough for radius comps)
  await new Promise(r => setTimeout(r, 1100));
  const zip = address.match(/\b(\d{5})\b/)?.[1];
  if (zip) {
    results = await nominatimQuery({ q: zip });
    if (results.length) {
      console.log(`[geo] zip centroid fallback: ${results[0].display_name}`);
      return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
    }
  }

  throw new Error('Could not locate address — include full city, state, and ZIP (e.g., "913 W La Rua St, Pensacola, FL 32501")');
}

// ══════════════════════════════════════════════════════
// ATTOM — sold comps only, 1 call, pagesize 200
// ══════════════════════════════════════════════════════

const fmtDate = d => (d instanceof Date ? d : new Date(d)).toISOString().split('T')[0];

async function attomSaleComps(lat, lon, radiusMiles) {
  let res;
  try {
    res = await axios.get(
      'https://api.gateway.attomdata.com/propertyapi/v1.0.0/sale/snapshot',
      {
        headers: { apikey: ATTOM_KEY, Accept: 'application/json' },
        params:  { latitude: lat, longitude: lon, radius: radiusMiles, pagesize: 200 },
        timeout: 18000
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
      const sqft      = parseInt(p.building?.size?.universalsize || p.building?.size?.livingsize || 0) || null;
      const saleAmt   = parseFloat(p.sale.amount.saleamt);
      const saleRaw   = p.sale?.saleTransDate || p.sale?.salesearchdate;
      const saleDate  = saleRaw ? new Date(saleRaw) : null;
      const monthsOld = saleDate ? (Date.now() - saleDate.getTime()) / (1000*60*60*24*30.44) : 15;
      const cLat = parseFloat(p.location?.latitude);
      const cLon = parseFloat(p.location?.longitude);
      return {
        address:       p.address?.oneLine || [p.address?.line1, p.address?.line2].filter(Boolean).join(', ') || null,
        sqft,
        beds:          parseInt(p.building?.rooms?.beds) || null,
        baths:         parseInt(p.building?.rooms?.bathstotal) || null,
        halfBaths:     parseInt(p.building?.rooms?.bathshalf) || 0,
        garageSpaces:  parseInt(p.building?.parking?.prkgSpaces || 0) || 0,
        pool:          !!(p.building?.pool?.poolInd === 'Y'),
        lotSize:       parseFloat(p.lot?.lotsize1) || null,
        yearBuilt:     parseInt(p.summary?.yearbuilt) || null,
        propType:      p.summary?.proptype || null,
        saleAmt,
        saleDate:      saleRaw ? fmtDate(saleDate) : null,
        monthsOld:     Math.round(monthsOld * 10) / 10,
        dom:           parseInt(p.sale?.amount?.dom) || null,
        priorSaleAmt:  parseFloat(p.sale?.amount?.priorSaleAmt) || null,
        priorSaleDate: p.sale?.priorSaleTransDate || null,
        lat: cLat, lon: cLon,
        distanceMi:    (lat && lon && cLat && cLon) ? Math.round(haversine(lat, lon, cLat, cLon) * 100) / 100 : null,
        zillowEnriched: false
      };
    });
}

// ══════════════════════════════════════════════════════
// ZILLOW — recently sold (comp enrichment)
// ══════════════════════════════════════════════════════

async function zillowSold(cityState) {
  try {
    const res = await axios.post(
      `https://${ZILLOW_HOST}/zillow/v1/sold`,
      { location: cityState },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-rapidapi-host': ZILLOW_HOST,
          'x-rapidapi-key':  RAPIDAPI_KEY
        },
        timeout: 20000
      }
    );
    const items = res.data?.data?.items || [];
    console.log(`[zillowSold] HTTP ${res.status} → ${items.length} results for "${cityState}" | top-level keys: ${Object.keys(res.data||{}).join(',')}`);
    if (!items.length) console.log('[zillowSold] raw response:', JSON.stringify(res.data).slice(0, 400));
    return items.map(p => ({
      address:     (p.address || `${p.address_line||''} ${p.city||''} ${p.state_code||''}`).trim(),
      addressLine: (p.address_line || '').toLowerCase().trim(),
      beds:        p.beds   || null,
      baths:       p.baths  || null,
      sqft:        p.sqft   || null,
      lat:         p.latitude  || null,
      lon:         p.longitude || null
    }));
  } catch (err) {
    console.warn('[zillowSold] ERROR:', err.message, err.response?.status, JSON.stringify(err.response?.data||{}).slice(0,200));
    return [];
  }
}

// ══════════════════════════════════════════════════════
// ZILLOW — active listings (market pulse)
// ══════════════════════════════════════════════════════

async function zillowActiveListings(lat, lon, radiusMiles = 2) {
  const dLat = radiusMiles * 0.01449;
  const dLon = radiusMiles / (69.172 * Math.cos(lat * Math.PI / 180));
  const bounds = {
    west:  parseFloat((lon - dLon).toFixed(5)),
    east:  parseFloat((lon + dLon).toFixed(5)),
    south: parseFloat((lat - dLat).toFixed(5)),
    north: parseFloat((lat + dLat).toFixed(5))
  };
  try {
    const res = await axios.post(
      `https://${ZILLOW_HOST}/zillow/v1/search_by_coordinates`,
      { map_bounds: bounds },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-rapidapi-host': ZILLOW_HOST,
          'x-rapidapi-key':  RAPIDAPI_KEY
        },
        timeout: 20000
      }
    );
    const allItems = res.data?.data?.items || [];
    const forSale  = allItems.filter(p => p.status === 'FOR_SALE' && p.list_price_usd);
    console.log(`[zillowActive] HTTP ${res.status} → ${allItems.length} total, ${forSale.length} FOR_SALE | bounds: ${JSON.stringify(bounds)}`);
    if (!allItems.length) console.log('[zillowActive] raw response:', JSON.stringify(res.data).slice(0, 400));
    return forSale.map(p => ({
      address:   p.address || '',
      beds:      p.beds   || null,
      baths:     p.baths  || null,
      sqft:      p.sqft   || null,
      listPrice: p.list_price_usd || null,
      dom:       p.days_on_market ?? null,
      propType:  p.property_type  || null,
      ppsf:      (p.list_price_usd && p.sqft) ? Math.round(p.list_price_usd / p.sqft) : null
    }));
  } catch (err) {
    console.warn('[zillowActive] ERROR:', err.message, err.response?.status, JSON.stringify(err.response?.data||{}).slice(0,200));
    return [];
  }
}

// ══════════════════════════════════════════════════════
// CROSS-REFERENCE — fill in missing beds/baths/sqft from Zillow sold
// ══════════════════════════════════════════════════════

function normalizeStreet(addr) {
  if (!addr) return '';
  return addr.toLowerCase()
    .replace(/\bstreet\b/g,'st').replace(/\bavenue\b/g,'ave')
    .replace(/\bboulevard\b/g,'blvd').replace(/\bdrive\b/g,'dr')
    .replace(/\broad\b/g,'rd').replace(/\blane\b/g,'ln')
    .replace(/\bcourt\b/g,'ct').replace(/\bplace\b/g,'pl')
    .replace(/\bcircle\b/g,'cir').replace(/\bterrace\b/g,'ter')
    .replace(/[.,#]/g,'').replace(/\s+/g,' ').trim();
}

function enrichCompsWithZillow(attomComps, zillowData) {
  return attomComps.map(comp => {
    if (!comp.address) return comp;
    const normA    = normalizeStreet(comp.address);
    const numMatch = normA.match(/^(\d+)/);
    if (!numMatch) return comp;
    const houseNum = numMatch[1];

    const match = zillowData.find(z => {
      const normZ = normalizeStreet(z.address);
      if (!normZ.startsWith(houseNum + ' ')) return false;
      const wordsA = normA.split(' ').slice(1, 4).join(' ');
      const wordsZ = normZ.split(' ').slice(1, 4).join(' ');
      return wordsA && wordsZ && (wordsZ.startsWith(wordsA.slice(0, 6)) || wordsA.startsWith(wordsZ.slice(0, 6)));
    });

    if (!match) return comp;
    const wasEnriched = (!comp.beds && match.beds) || (!comp.baths && match.baths) || (!comp.sqft && match.sqft);
    return {
      ...comp,
      beds:          comp.beds  || match.beds,
      baths:         comp.baths || match.baths,
      sqft:          comp.sqft  || match.sqft,
      zillowEnriched: !!wasEnriched
    };
  });
}

// ══════════════════════════════════════════════════════
// ACTIVE MARKET PULSE
// ══════════════════════════════════════════════════════

function buildMarketPulse(listings, avgSoldPpsf) {
  if (!listings.length) return null;
  const withPpsf = listings.filter(l => l.ppsf);
  const avgListPpsf = withPpsf.length ? Math.round(withPpsf.reduce((s,l)=>s+l.ppsf,0)/withPpsf.length) : null;
  const withDom  = listings.filter(l => l.dom !== null && l.dom !== undefined);
  const avgDom   = withDom.length ? Math.round(withDom.reduce((s,l)=>s+l.dom,0)/withDom.length) : null;
  const flipListings = avgSoldPpsf ? listings.filter(l => l.ppsf && l.ppsf >= avgSoldPpsf * 1.15) : [];
  return {
    count: listings.length,
    avgListPpsf,
    avgDom,
    flipListings: flipListings.length,
    highPpsf: withPpsf.length ? Math.max(...withPpsf.map(l=>l.ppsf)) : null,
    lowPpsf:  withPpsf.length ? Math.min(...withPpsf.map(l=>l.ppsf)) : null
  };
}

// ══════════════════════════════════════════════════════
// PURE MATH HELPERS
// ══════════════════════════════════════════════════════

function haversine(lat1, lon1, lat2, lon2) {
  const R = 3958.8, toR = Math.PI/180;
  const dLat = (lat2-lat1)*toR, dLon = (lon2-lon1)*toR;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*toR)*Math.cos(lat2*toR)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function poolValue(s) {
  const warm = ['FL','TX','AZ','NV','CA','HI','NM','GA','SC','NC','LA','MS','AL','AR'];
  const mild = ['TN','VA','OK','KY','MO','KS','CO','UT','OR','WA','MD','DE','DC'];
  const u = (s||'').toUpperCase();
  return warm.includes(u) ? 15000 : mild.includes(u) ? 10000 : 5000;
}

function timeAdj(saleAmt, monthsOld) {
  return monthsOld <= 3 ? saleAmt : saleAmt * (1 + 0.003 * (monthsOld - 3));
}

function propAdj(comp, subject, stateCode) {
  let adj = 0;
  if (subject.beds  != null && comp.beds  != null) adj += (subject.beds  - comp.beds)  * 5000;
  if (subject.baths != null && comp.baths != null) {
    const sf = (subject.baths||0) - (subject.halfBaths||0)*0.5;
    const cf = (comp.baths||0)    - (comp.halfBaths||0)*0.5;
    adj += (sf - cf) * 4000;
  }
  adj += ((subject.garageSpaces||0) - (comp.garageSpaces||0)) * 8000;
  if (subject.pool !== comp.pool) adj += subject.pool ? poolValue(stateCode) : -poolValue(stateCode);
  if (subject.lotSize && comp.lotSize) {
    const r = comp.lotSize / subject.lotSize;
    if (r > 2 || r < 0.5) adj += (subject.lotSize - comp.lotSize) * 43560 * 1.5;
  }
  // Year-built adjustment — tiered scaling for large vintage gaps
  if (subject.yearBuilt && comp.yearBuilt) {
    const gapYrs = subject.yearBuilt - comp.yearBuilt;
    const absGap = Math.abs(gapYrs);
    let yrAdj = 0;
    if (absGap <= 20)      yrAdj = absGap / 10 * 500;
    else if (absGap <= 40) yrAdj = 20/10*500 + (absGap-20)/10 * 1500;
    else                   yrAdj = 20/10*500 + 20/10*1500 + (absGap-40)/10 * 3000;
    adj += Math.sign(gapYrs) * yrAdj;
  }
  return Math.round(Math.max(-comp.saleAmt*0.30, Math.min(comp.saleAmt*0.30, adj)));
}

function isFlip(comp) {
  if (!comp.priorSaleAmt || !comp.priorSaleDate) return false;
  const mo = (new Date(comp.saleDate) - new Date(comp.priorSaleDate)) / (1000*60*60*24*30.44);
  return mo <= 6 && comp.saleAmt >= comp.priorSaleAmt * 1.15;
}

function stdDev(vals) {
  if (vals.length < 2) return 0;
  const m = vals.reduce((a,b)=>a+b,0)/vals.length;
  return Math.sqrt(vals.reduce((s,v)=>s+(v-m)**2,0)/vals.length);
}

function outlierNote(comp, subject) {
  const t = [];
  if (comp.yearBuilt && subject.yearBuilt && comp.yearBuilt - subject.yearBuilt > 15) t.push(`newer build ${comp.yearBuilt}`);
  if (comp.pool && !subject.pool) t.push('has pool');
  if ((comp.garageSpaces||0) > (subject.garageSpaces||0)+1) t.push('extra garage');
  if (comp.lotSize && subject.lotSize && comp.lotSize > subject.lotSize*2) t.push('larger lot');
  if ((comp.beds||0) > (subject.beds||0)+1) t.push(`${comp.beds}bd`);
  return t.length ? t.join(', ') : 'verify — unclear';
}

function certaintyScore(coreComps, subject, maxRadius) {
  let s = 0;
  const n = coreComps.length;
  s += n >= 6 ? 25 : n >= 4 ? 20 : n >= 3 ? 12 : 0;
  s += maxRadius <= 0.5 ? 25 : maxRadius <= 1 ? 20 : maxRadius <= 2 ? 15 : maxRadius <= 5 ? 8 : 3;
  const ppsfVals = coreComps.map(c=>c.adjPpsf).filter(Boolean);
  if (ppsfVals.length >= 2) {
    const mean = ppsfVals.reduce((a,b)=>a+b,0)/ppsfVals.length;
    const cv   = mean > 0 ? stdDev(ppsfVals)/mean : 1;
    s += cv < 0.10 ? 20 : cv < 0.20 ? 15 : cv < 0.30 ? 8 : 3;
  } else s += 5;
  const avgAge = coreComps.length ? coreComps.reduce((a,c)=>a+(c.monthsOld||15),0)/coreComps.length : 15;
  s += avgAge <= 3 ? 15 : avgAge <= 6 ? 12 : avgAge <= 12 ? 8 : 4;
  let dq = 15;
  if (!subject.sqft) dq -= 6; if (!subject.yearBuilt) dq -= 3;
  if (!subject.beds) dq -= 3; if (!subject.baths)     dq -= 3;
  s += Math.max(0, dq);

  // Vintage penalty — new construction against aged inventory is unreliable
  if (subject.yearBuilt) {
    const compVintages = coreComps.filter(c=>c.yearBuilt).map(c=>c.yearBuilt);
    if (compVintages.length) {
      const avgVintage = compVintages.reduce((a,b)=>a+b,0)/compVintages.length;
      const gap = subject.yearBuilt - avgVintage;
      if (gap >= 40) s -= 25;
      else if (gap >= 25) s -= 15;
      else if (gap >= 15) s -= 8;
    }
  }

  s = Math.max(0, Math.min(100, s));
  const label = s >= 85 ? 'High' : s >= 65 ? 'Moderate' : s >= 45 ? 'Low' : 'Thin data';
  return { score: s, label };
}

// ══════════════════════════════════════════════════════
// COMP PROCESSING — split usable vs incomplete
// ══════════════════════════════════════════════════════

function processComps(rawComps, subject, sqft, stateCode) {
  const BUF = 500;
  const usableRaw    = rawComps.filter(c => c.sqft && (!sqft || (c.sqft >= sqft-BUF && c.sqft <= sqft+BUF)));
  const incompleteRaw = rawComps.filter(c => !c.sqft);

  if (!usableRaw.length) {
    const maxR = rawComps.length ? Math.max(...rawComps.map(c=>c.distanceMi||0)) : 0;
    return { usable: [], incomplete: incompleteRaw, asIsValue: null, avgPpsf: null,
             ppsfRange: null, certainty: { score: 0, label: 'No usable comps' },
             maxRadius: maxR, avgDom: null, flips: 0, outliers: 0, notes: [] };
  }

  const processed = usableRaw.map(c => {
    const tAdj   = timeAdj(c.saleAmt, c.monthsOld);
    const pAdj   = propAdj(c, subject, stateCode);
    const adjAmt = tAdj + pAdj;
    return { ...c, propAdj: pAdj, adjAmt: Math.round(adjAmt),
             adjPpsf: Math.round(adjAmt / c.sqft), flipComp: isFlip(c) };
  });

  const ppsfVals = processed.map(c=>c.adjPpsf);
  const meanP    = ppsfVals.reduce((a,b)=>a+b,0)/ppsfVals.length;
  const sdP      = stdDev(ppsfVals);

  const tagged = processed.map(c => {
    const isOut = sdP > 0 && Math.abs(c.adjPpsf - meanP) > 2 * sdP;
    return { ...c, isOutlier: isOut, outlierNote: isOut ? outlierNote(c, subject) : null };
  });

  const core = tagged.filter(c => !c.isOutlier);
  let wSum = 0, wTot = 0;
  core.forEach(c => { const w = c.flipComp ? 1.5 : 1.0; wSum += c.adjPpsf * w; wTot += w; });

  const avgPpsf   = wTot > 0 ? Math.round(wSum / wTot) : null;
  const asIsValue = avgPpsf && sqft ? Math.round(avgPpsf * sqft / 1000) * 1000 : null;
  const ppsfRange = ppsfVals.length ? { min: Math.min(...ppsfVals), max: Math.max(...ppsfVals) } : null;

  // Effective radius = farthest usable comp
  const usableDists = usableRaw.map(c=>c.distanceMi||0);
  const maxRadius   = Math.round(Math.max(...usableDists) * 10) / 10;

  const cert      = certaintyScore(core, subject, maxRadius);
  const flipCount = tagged.filter(c=>c.flipComp).length;
  const outCount  = tagged.filter(c=>c.isOutlier).length;
  const domVals   = core.filter(c=>c.dom).map(c=>c.dom);
  const avgDom    = domVals.length ? Math.round(domVals.reduce((a,b)=>a+b,0)/domVals.length) : null;

  // Vintage mismatch detection
  const compVintages = core.filter(c=>c.yearBuilt).map(c=>c.yearBuilt);
  const avgCompVintage = compVintages.length ? Math.round(compVintages.reduce((a,b)=>a+b,0)/compVintages.length) : null;
  const vintageGap = (subject.yearBuilt && avgCompVintage) ? subject.yearBuilt - avgCompVintage : 0;

  const notes = [];
  if (flipCount)             notes.push(`${flipCount} flip-confirmed sale${flipCount>1?'s':''}`);
  if (outCount)              notes.push(`${outCount} outlier${outCount>1?'s':''} excluded`);
  if (incompleteRaw.length)  notes.push(`${incompleteRaw.length} comp${incompleteRaw.length>1?'s':''} missing sqft — excluded`);
  if (vintageGap >= 25)      notes.push(`⚠️ Vintage gap ${vintageGap}yr — comps avg ${avgCompVintage}, subject built ${subject.yearBuilt}. Value likely understated.`);

  return { usable: tagged, incomplete: incompleteRaw, asIsValue, avgPpsf, ppsfRange,
           certainty: cert, maxRadius, avgDom, flips: flipCount, outliers: outCount,
           notes, avgCompVintage, vintageGap };
}

// ══════════════════════════════════════════════════════
// PULL COMPS — 1 ATTOM call at max radius, filter client-side
// ══════════════════════════════════════════════════════

async function pullComps(lat, lon, propType, sqft) {
  const raw = await attomSaleComps(lat, lon, 10); // 1 ATTOM call, pagesize 200

  // Property type filter (fall back to all if too few)
  let pool = raw;
  if (propType && raw.length > 0) {
    const norm  = propType.toLowerCase().replace(/[^a-z]/g,'').slice(0,5);
    const typed = raw.filter(c => !c.propType || c.propType.toLowerCase().replace(/[^a-z]/g,'').includes(norm));
    if (typed.length >= 2) pool = typed;
  }

  // Sort by distance
  pool.sort((a, b) => (a.distanceMi||99) - (b.distanceMi||99));

  // Check if we have enough usable comps
  const usable = pool.filter(c => c.sqft && (!sqft || Math.abs(c.sqft - sqft) <= 500));
  const flagged = usable.length < 3;

  return { comps: pool, flagged };
}

// ══════════════════════════════════════════════════════
// NARRATIVE AGENT
// ══════════════════════════════════════════════════════

const NARRATIVE_SYS = `You are JARVIS, a sharp real estate investment analyst briefing an experienced investor.
Be direct. No fluff. Write exactly 4 lines, no labels or prefixes:
Line 1: 2-sentence market read — sold comp velocity, DOM trend, flip activity visible
Line 2: One sentence on whether this is a strong novation candidate and the key reason
Line 3: Biggest risk on this deal. If none: No major flags.
Line 4: One piece of info that would most sharpen this number. If solid: Data looks complete.
Never invent numbers. Use only what is provided.`;

async function narrativeAgent(subject, compData, formulaData, pulse, callNotes) {
  const compLines = compData.usable.slice(0,6).map((c,i) =>
    `${i+1}. ${c.address||'?'} | ${c.sqft}sf ${c.beds||'?'}bd/${c.baths||'?'}ba yr${c.yearBuilt||'?'} ${c.distanceMi||'?'}mi · $${c.saleAmt?.toLocaleString()} ${c.saleDate} DOM:${c.dom||'?'} $${c.adjPpsf}/sf adj`
    + (c.flipComp?' [FLIP]':'') + (c.isOutlier?` [OUTLIER:${c.outlierNote}]`:'') + (c.zillowEnriched?' [Zillow-enriched]':'')
  ).join('\n');

  const pulseText = pulse
    ? `Active market (2mi): ${pulse.count} listings · avg list $${pulse.avgListPpsf||'?'}/sqft · avg DOM ${pulse.avgDom??'?'} · ${pulse.flipListings} flip-priced listings (list 15%+ above sold avg)`
    : 'Active listing data unavailable';

  const userMsg =
`Property: ${subject.address} | ${subject.sqft||'?'}sqft | ${subject.beds||'?'}bd/${subject.baths||'?'}ba | Built ${subject.yearBuilt||'?'} | ${subject.propertyType||'SFR'} | specs from ${subject.specsSource}
Usable comps: ${compData.usable.length} (full data) + ${compData.incomplete.length} incomplete (no sqft)
Radius: ${compData.maxRadius}mi · Avg $${compData.avgPpsf||'?'}/sqft · Range $${compData.ppsfRange?.min||'?'}–$${compData.ppsfRange?.max||'?'}/sqft · Avg DOM ${compData.avgDom||'?'}
${pulseText}

Comps:
${compLines || 'None with full data'}

As-Is Market Value: $${formulaData.asIsValue?.toLocaleString()||'N/A'}
Novation MAO: $${formulaData.novationMao?.toLocaleString()||'N/A'}
Certainty: ${compData.certainty?.score||0}% (${compData.certainty?.label})
${compData.vintageGap >= 25 ? `⚠️ VINTAGE MISMATCH: subject built ${subject.yearBuilt}, comps avg ${compData.avgCompVintage} (${compData.vintageGap}yr gap). No same-vintage comps found — value is a floor estimate, new construction premium unverified.` : ''}
Call notes: ${callNotes||'none'}`;

  try {
    const res = await axios({
      method: 'post', url: 'https://api.anthropic.com/v1/messages', timeout: 60000,
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      data: { model: MODEL, max_tokens: 350, system: NARRATIVE_SYS, messages: [{ role:'user', content: userMsg }] }
    });
    const lines = (res.data.content?.find(b=>b.type==='text')?.text||'').trim().split('\n').map(l=>l.trim()).filter(Boolean);
    return { marketRead: lines[0]||null, candidate: lines[1]||null, risk: lines[2]||null, sharpen: lines[3]||null };
  } catch (err) {
    console.warn('[narrativeAgent]', err.message);
    return { marketRead: null, candidate: null, risk: null, sharpen: null };
  }
}

// ══════════════════════════════════════════════════════
// SLACK FORMATTER — v3.1
// ══════════════════════════════════════════════════════

function formatSlack(subject, compData, formulaData, narrative, pulse) {
  const f = n => n != null ? '$' + Math.round(n).toLocaleString() : 'N/A';
  const L = [];

  // Header
  L.push(`📍 *${subject.address||'Unknown'}*`);
  const specTag = subject.specsSource === 'call notes' ? ' _(your call)_' : '';
  L.push(`${subject.propertyType||'SFR'} · ${subject.sqft?subject.sqft.toLocaleString()+' sqft':'sqft ?'} · ${subject.beds||'?'}bd/${subject.baths||'?'}ba · Built ${subject.yearBuilt||'?'}${specTag}`);
  L.push('');

  // New construction / vintage mismatch alert
  if (compData.vintageGap >= 25 && subject.yearBuilt) {
    L.push(`🚨 *NEW CONSTRUCTION ALERT*`);
    L.push(`Subject built ${subject.yearBuilt} — comps avg ${compData.avgCompVintage} (${compData.vintageGap}yr gap). No same-vintage sales found.`);
    L.push(`_Value below is a floor estimate. True ARV is likely $${Math.round(compData.avgPpsf * 1.20)}-$${Math.round(compData.avgPpsf * 1.35)}/sqft — verify with agent or Zillow estimate._`);
    L.push('');
  }

  // Offer block
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

  // Active market pulse (Zillow)
  if (pulse) {
    const flipNote = pulse.flipListings > 0 ? ` · ⚡ ${pulse.flipListings} flip-priced` : '';
    L.push(`🏠 *ACTIVE MARKET* (${pulse.count} listings · 2mi)`);
    L.push(`Avg list $${pulse.avgListPpsf||'?'}/sqft · DOM ${pulse.avgDom??'?'}${flipNote}`);
    L.push('');
  }

  // Sold comps summary
  L.push(`📊 *SOLD COMPS* (${compData.usable.length} usable · ${compData.maxRadius}mi · 15mo)`);
  if (compData.avgPpsf) {
    L.push(`Avg $${compData.avgPpsf}/sqft · Range $${compData.ppsfRange?.min}–$${compData.ppsfRange?.max}/sqft${compData.avgDom?' · DOM avg '+compData.avgDom:''}`);
  } else {
    L.push(`Insufficient data to calculate avg $/sqft`);
  }
  if (compData.flips)    L.push(`⚡ ${compData.flips} flip-confirmed sale${compData.flips>1?'s':''}`);
  if (compData.outliers) L.push(`⚠️ ${compData.outliers} outlier${compData.outliers>1?'s':''} — excluded from avg`);
  L.push('');

  // Comp list
  if (compData.usable.length) {
    L.push(`📋 *COMPS — FULL DATA* (${compData.usable.length})`);
    compData.usable.slice(0,8).forEach((c,i) => {
      const enrichTag   = c.zillowEnriched ? ' ✦' : '';
      const flipTag     = c.flipComp ? ' ⚡FLIP' : '';
      const outTag      = c.isOutlier ? ` ⚠️(${c.outlierNote?.split(',')[0]})` : '';
      const vintageYrs  = (subject.yearBuilt && c.yearBuilt) ? subject.yearBuilt - c.yearBuilt : 0;
      const vintageTag  = vintageYrs >= 25 ? ` 📅-${vintageYrs}yr` : '';
      L.push(
        `${i+1}. ${c.address||'—'} | ${c.sqft}sf ${c.beds||'?'}bd/${c.baths||'?'}ba ${c.yearBuilt||'?'} ` +
        `${c.distanceMi!=null?c.distanceMi+'mi':''} · ${f(c.saleAmt)} ${c.saleDate} · DOM:${c.dom||'?'} · $${c.adjPpsf}/sf adj${enrichTag}${flipTag}${outTag}${vintageTag}`
      );
    });
    if (compData.usable.some(c=>c.zillowEnriched)) L.push('_✦ bed/bath enriched from Zillow_');
    if (compData.vintageGap >= 25) L.push('_📅 = years older than subject — adjustment applied but value is approximate_');
    L.push('');
  }

  // Incomplete comps
  if (compData.incomplete.length) {
    L.push(`⚠️ *INCOMPLETE — sqft not in county records* (${compData.incomplete.length}, excluded)`);
    compData.incomplete.slice(0,4).forEach((c,i) => {
      L.push(`${i+1}. ${c.address||'—'} · ${f(c.saleAmt)} ${c.saleDate} · ${c.distanceMi!=null?c.distanceMi+'mi':''}`);
    });
    L.push('');
  }

  // JARVIS narrative
  if (narrative.marketRead) L.push(`💡 *JARVIS:* ${narrative.marketRead}`);
  if (narrative.candidate)  L.push(`🎯 ${narrative.candidate}`);
  if (narrative.risk && narrative.risk !== 'No major flags.')         L.push(`⚠️ ${narrative.risk}`);
  if (narrative.sharpen && narrative.sharpen !== 'Data looks complete.') L.push(`📎 ${narrative.sharpen}`);

  // Flags
  const flags = [
    ...(compData.notes||[]),
    ...(compData.maxRadius > 5 ? [`Comps spread to ${compData.maxRadius}mi`] : [])
  ];
  if (flags.length) L.push(`\n🚩 ${flags.join(' · ')}`);

  return L.join('\n');
}

// ══════════════════════════════════════════════════════
// MAIN ROUTE
// ══════════════════════════════════════════════════════

app.post('/analyze', async (req, res) => {
  const { address, callNotes } = req.body || {};
  if (!address) return res.status(400).json({ error: 'address required' });
  console.log('[analyze]', address);

  try {
    // 1. Parse subject specs from call notes
    const parsed = parseSubjectSpecs((callNotes || '') + ' ' + address);

    // 2. Ask for sqft if not in message
    if (!parsed.sqft) {
      return res.json({
        needs_sqft: true,
        message: `Got *${address}*. Need the square footage from the call — reply with the address and include it, e.g.:\n_913 W La Rua, Pensacola FL — 4bd 3ba 1460sf built 2024_`
      });
    }

    // 3. Geocode (Nominatim — free, no ATTOM call needed)
    let geo;
    try {
      geo = await geocodeAddress(address);
      console.log(`[geo] ${geo.lat}, ${geo.lon}`);
    } catch (err) {
      return res.status(500).json({ error: `Geocoding failed: ${err.message}` });
    }

    const stateCode = extractStateCode(address);
    const cityState = extractCityState(address);
    const subject = {
      address,
      sqft:         parsed.sqft,
      beds:         parsed.beds         || null,
      baths:        parsed.baths        || null,
      halfBaths:    0,
      garageSpaces: 0,
      pool:         false,
      lotSize:      null,
      yearBuilt:    parsed.yearBuilt    || null,
      propertyType: parsed.propertyType || 'SFR',
      lat: geo.lat, lon: geo.lon,
      specsSource:  'call notes'
    };
    console.log(`[subject] ${subject.sqft}sf ${subject.beds}bd/${subject.baths}ba ${subject.propertyType} built ${subject.yearBuilt}`);

    // 4. ATTOM (1 call) + Zillow sold + Zillow active — all in parallel
    const [compResult, zillowSoldData, activeListings] = await Promise.all([
      pullComps(geo.lat, geo.lon, subject.propertyType, subject.sqft),
      zillowSold(cityState),
      zillowActiveListings(geo.lat, geo.lon, 2)
    ]);
    console.log(`[data] ATTOM:${compResult.comps.length} ZillowSold:${zillowSoldData.length} Active:${activeListings.length}`);

    // 5. Cross-reference: fill in missing beds/baths/sqft from Zillow
    const enriched = enrichCompsWithZillow(compResult.comps, zillowSoldData);
    const enrichCount = enriched.filter(c=>c.zillowEnriched).length;
    if (enrichCount) console.log(`[enrich] ${enrichCount} comps enriched from Zillow`);

    // 6. Process comps
    const compData = processComps(enriched, subject, subject.sqft, stateCode);
    if (compResult.flagged) compData.notes.push('Fewer than 3 usable comps found — treat with caution');

    // 7. Market pulse
    const pulse = buildMarketPulse(activeListings, compData.avgPpsf);

    // 8. Novation formula (pure code)
    const asIsValue        = compData.asIsValue;
    const novationMao      = asIsValue ? Math.round(asIsValue * 0.93 - 50000) : null;
    const novationListPrice = asIsValue;
    const formulaData      = { asIsValue, novationMao, novationListPrice };
    console.log(`[formula] AsIs:${asIsValue} MAO:${novationMao}`);

    // 9. Narrative (1 Anthropic call)
    const narrative = await narrativeAgent(subject, compData, formulaData, pulse, callNotes);

    // 10. Format and return
    const slackMessage = formatSlack(subject, compData, formulaData, narrative, pulse);
    return res.json({ response: slackMessage });

  } catch (err) {
    console.error('[analyze error]', err.message, err.stack);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
});

app.get('/health', (req, res) =>
  res.json({ status: 'ok', version: '3.1', attom: !!ATTOM_KEY, zillow: !!RAPIDAPI_KEY, anthropic: !!ANTHROPIC_KEY })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Deal Analyzer v3.1 (ATTOM + Zillow enrichment) on :${PORT}`));
