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
// DEAL MEMORY — stores last analysis for JARVIS follow-up
// ══════════════════════════════════════════════════════
let lastDeal = null;

// ══════════════════════════════════════════════════════
// NON-DISCLOSURE STATES — ATTOM has no sale price data
// ══════════════════════════════════════════════════════
const NON_DISCLOSURE_STATES = new Set([
  'TX','AK','ID','KS','LA','MS','MT','ND','NM','UT','WY','MO','WI','SD'
]);

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

  // Fallback sqft: bare number after dash/space with no unit (e.g. "- 1776" or "address 1776")
  // Accepts 400–9999, excludes year-range numbers (1800–2030)
  if (!specs.sqft) {
    const bareM = text.match(/[-–\s](\d{3,4})(?:\s|$)/g);
    if (bareM) {
      for (const chunk of bareM) {
        const n = parseInt(chunk.match(/\d+/)[0]);
        if (n >= 400 && n <= 9999 && !(n >= 1800 && n <= 2030)) {
          specs.sqft = n;
          break;
        }
      }
    }
  }

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
  // Strip specs appended after em-dash or en-dash (e.g. "913 W La Rua St, Pensacola FL 32501 — 4bd 3ba 1460sf")
  const clean = address.split(/\s*[—–]\s*/)[0].trim();

  // Pattern 1: ", City, ST 12345"  (two commas — e.g. "109 Washington Ave, East Gadsden, AL 35903")
  const m1 = clean.match(/,\s*([^,]+),\s*([A-Z]{2})\s+\d{5}/);
  if (m1) return `${m1[1].trim()}, ${m1[2]}`;

  // Pattern 2: ", City ST 12345"  (no comma between city and state — e.g. "913 W La Rua St, Pensacola FL 32501")
  const m2 = clean.match(/,\s*([^,\d]+?)\s+([A-Z]{2})\s+\d{5}/);
  if (m2) return `${m2[1].trim()}, ${m2[2]}`;

  // Pattern 3: "City, ST" anywhere
  const m3 = clean.match(/([^,\d]+),\s*([A-Z]{2})\b/);
  if (m3) return `${m3[1].trim()}, ${m3[2]}`;

  return clean;
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
      const amt = parseFloat(p.sale?.amount?.saleamt);
      if (!amt || amt <= 0) return false; // data sanity only — real distress filtering is IQR-based in processComps
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
      lon:         p.longitude || null,
      // sold_price_usd is the direct field; fall back to legacy field names
      saleAmt:     p.sold_price_usd || p.price || p.last_sold_price || p.sold_price || p.last_sale_price || null,
      saleDate:    p.sold_date || p.last_sold_date || p.date_sold || p.last_sale_date || null,
      dom:         p.days_on_market || null,
      imgUrl:      p.photos?.[0] || null,
      zillowUrl:   p.url || null
    }));
  } catch (err) {
    console.warn('[zillowSold] ERROR:', err.message, err.response?.status, JSON.stringify(err.response?.data||{}).slice(0,200));
    return [];
  }
}

// ══════════════════════════════════════════════════════
// NON-DISCLOSURE FALLBACK — convert Zillow sold items
// (with price) into ATTOM-compatible comp objects
// ══════════════════════════════════════════════════════

function zillowSoldAsComps(zillowData, subjectLat, subjectLon) {
  const now     = Date.now();
  const cutoff  = now - 15 * 30.44 * 24 * 60 * 60 * 1000; // 15 months
  return zillowData
    .filter(p => p.saleAmt && p.saleAmt > 50000) // must have a plausible price
    .map(p => {
      const saleDate  = p.saleDate ? new Date(p.saleDate) : null;
      if (saleDate && saleDate.getTime() < cutoff) return null; // too old
      const monthsOld = saleDate
        ? (now - saleDate.getTime()) / (1000 * 60 * 60 * 24 * 30.44)
        : 8; // assume 8mo if no date — conservative, not penalizing or boosting
      const dist = (subjectLat && subjectLon && p.lat && p.lon)
        ? Math.round(haversine(subjectLat, subjectLon, p.lat, p.lon) * 100) / 100
        : null;
      const fmtSaleDate = p.saleDate
        ? (p.saleDate.length === 10 ? p.saleDate : new Date(p.saleDate).toISOString().slice(0,10))
        : null;
      return {
        address:      p.address || null,
        sqft:         p.sqft    || null,
        beds:         p.beds    || null,
        baths:        p.baths   || null,
        halfBaths:    0,
        garageSpaces: 0,
        pool:         false,
        lotSize:      null,
        yearBuilt:    null,
        propType:     null,
        saleAmt:      p.saleAmt,
        saleDate:     fmtSaleDate,
        monthsOld:    Math.round(monthsOld * 10) / 10,
        dom:          p.dom     || null,
        priorSaleAmt: null,
        priorSaleDate:null,
        lat:          p.lat,
        lon:          p.lon,
        distanceMi:   dist,
        zillowEnriched: false,
        zillowSource:   true  // marks these as Zillow-primary (not ATTOM)
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.distanceMi || 99) - (b.distanceMi || 99));
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
    const forSaleRaw = allItems.filter(p => p.status === 'FOR_SALE' && p.list_price_usd);

    // Deduplicate: same list price + sqft within 5sf = same property listed twice
    const seen = new Set();
    const forSale = forSaleRaw.filter(p => {
      const key = `${p.list_price_usd}_${Math.round(p.sqft||0)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    console.log(`[zillowActive] HTTP ${res.status} → ${allItems.length} total, ${forSale.length} FOR_SALE | bounds: ${JSON.stringify(bounds)}`);
    if (!allItems.length) console.log('[zillowActive] raw response:', JSON.stringify(res.data).slice(0, 400));
    return forSale.map(p => ({
      address:   p.address || '',
      beds:      p.beds    || null,
      baths:     p.baths   || null,
      sqft:      p.sqft    || null,
      listPrice: p.list_price_usd || null,
      dom:       p.days_on_market ?? null,
      propType:  p.property_type  || null,
      yearBuilt: p.year_built || p.yearBuilt || p.built_year || null,
      ppsf:      (p.list_price_usd && p.sqft) ? Math.round(p.list_price_usd / p.sqft) : null,
      imgUrl:    p.photos?.[0] || null,
      zillowUrl: p.url || null
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

const ENRICH_DIST_MI = 0.03; // ~50 meters — same property threshold

function enrichCompsWithZillow(attomComps, zillowData) {
  return attomComps.map(comp => {
    // PRIMARY: lat/lon proximity match (most reliable — bypasses address formatting differences)
    let match = null;
    if (comp.lat && comp.lon) {
      match = zillowData.find(z =>
        z.lat && z.lon && haversine(comp.lat, comp.lon, z.lat, z.lon) <= ENRICH_DIST_MI
      );
    }

    // FALLBACK: address string match if no lat/lon match found
    if (!match && comp.address) {
      const normA    = normalizeStreet(comp.address);
      const numMatch = normA.match(/^(\d+)/);
      if (numMatch) {
        const houseNum = numMatch[1];
        match = zillowData.find(z => {
          const normZ = normalizeStreet(z.address);
          if (!normZ.startsWith(houseNum + ' ')) return false;
          const wordsA = normA.split(' ').slice(1, 4).join(' ');
          const wordsZ = normZ.split(' ').slice(1, 4).join(' ');
          return wordsA && wordsZ && (wordsZ.startsWith(wordsA.slice(0,6)) || wordsA.startsWith(wordsZ.slice(0,6)));
        });
      }
    }

    if (!match) return comp;
    const wasEnriched = (!comp.beds && match.beds) || (!comp.baths && match.baths) || (!comp.sqft && match.sqft);
    return {
      ...comp,
      beds:           comp.beds  || match.beds,
      baths:          comp.baths || match.baths,
      sqft:           comp.sqft  || match.sqft,
      zillowEnriched: !!wasEnriched
    };
  });
}

// ══════════════════════════════════════════════════════
// ACTIVE MARKET PULSE
// ══════════════════════════════════════════════════════

function buildMarketPulse(listings, avgSoldPpsf, subjectSqft = null, subjectYearBuilt = null) {
  if (!listings.length) return null;

  // Pre-filter: remove multi-family, units, and commercial listings
  // - "219-221 Main St" style (address range) = multi-unit building
  // - "#221" / "Apt 3" / "Unit B" in address = individual unit in multi-family
  // - propType signals non-SFR
  const isSFR = l => {
    const addr = (l.address || '').trim();
    if (/\s#\d/i.test(addr))          return false; // has unit # → condo/apt
    if (/\bUnit\b|\bApt\b|\bSte\b/i.test(addr)) return false;
    if (/^\d+-\d+\s/.test(addr))      return false; // "219-221 Main St" = multi-unit range
    if (l.propType && /multi|duplex|condo|apt|townhome|townhouse/i.test(l.propType)) return false;
    return true;
  };
  const sfr = listings.filter(isSFR);
  const excludedCount = listings.length - sfr.length;
  if (excludedCount) console.log(`[pulse] excluded ${excludedCount} non-SFR listing(s) from active market`);

  const withPpsf    = sfr.filter(l => l.ppsf);
  const avgListPpsf = withPpsf.length ? Math.round(withPpsf.reduce((s,l)=>s+l.ppsf,0)/withPpsf.length) : null;
  const withDom     = sfr.filter(l => l.dom !== null && l.dom !== undefined);
  const avgDom      = withDom.length ? Math.round(withDom.reduce((s,l)=>s+l.dom,0)/withDom.length) : null;
  const flipListings = avgSoldPpsf ? sfr.filter(l => l.ppsf && l.ppsf >= avgSoldPpsf * 1.15) : [];

  // Identify new builds:
  //   - year_built captured from API AND built within last 8 years (or 15+ years newer than subject)
  //   - OR no year_built but $/sqft > 1.4× the group median (price premium = likely renovated/new)
  const currentYear = new Date().getFullYear();
  const newBuildYearCutoff = subjectYearBuilt
    ? Math.max(subjectYearBuilt + 15, currentYear - 8)  // 15yr newer than subject OR last 8 years
    : currentYear - 8;
  const ppsfMedian = withPpsf.length ? [...withPpsf].sort((a,b)=>a.ppsf-b.ppsf)[Math.floor(withPpsf.length/2)].ppsf : null;
  const isNewBuild = l =>
    (l.yearBuilt && l.yearBuilt >= newBuildYearCutoff) ||
    (!l.yearBuilt && ppsfMedian && l.ppsf && l.ppsf >= ppsfMedian * 1.40);

  // Stale listing: 90+ days = seller is overpriced, price will slide
  // Realistic price at 90% of list — what it would need to drop to to move
  const isStale = l => l.dom != null && l.dom >= 90;

  // Display-comparable: ±45% of subject sqft (looser than proxy calc so smaller same-era homes show)
  // This includes a 1,000sf house near a 1,750sf subject but still excludes 880sf commercial lots
  const comparable = subjectSqft
    ? withPpsf.filter(l => !l.sqft || (l.sqft >= subjectSqft * 0.55 && l.sqft <= subjectSqft * 1.45))
    : withPpsf;
  const compPool = comparable.length >= 3 ? comparable : withPpsf;

  // Split: new builds go to their own section; everything else = standard comps
  const standardComps  = compPool.filter(l => !isNewBuild(l));
  const newBuildComps  = compPool.filter(l =>  isNewBuild(l));

  // Top standard comparable listings (exclude new builds so they don't inflate the ceiling)
  const topByPpsf = [...standardComps]
    .sort((a, b) => b.ppsf - a.ppsf)
    .slice(0, 5)
    .map(l => ({
      address:        l.address,
      sqft:           l.sqft,
      listPrice:      l.listPrice,
      ppsf:           l.ppsf,
      dom:            l.dom,
      yearBuilt:      l.yearBuilt,
      stale:          isStale(l),
      realisticPrice: isStale(l) && l.listPrice ? Math.round(l.listPrice * 0.90 / 1000) * 1000 : null,
      condition:      l.condition     || null,
      conditionNote:  l.conditionNote || null,
      zillowUrl:      l.zillowUrl     || null
    }));

  // Top new build listings (separate ceiling section)
  const newBuildListings = [...newBuildComps]
    .sort((a, b) => b.ppsf - a.ppsf)
    .slice(0, 3)
    .map(l => ({ address: l.address, sqft: l.sqft, listPrice: l.listPrice, ppsf: l.ppsf, dom: l.dom, yearBuilt: l.yearBuilt }));

  return {
    count:           sfr.length,           // SFR-only count (after removing multi-family/units)
    totalRaw:        listings.length,       // raw count before filtering
    avgListPpsf,
    avgDom,
    flipListings:    flipListings.length,
    highPpsf:        withPpsf.length ? Math.max(...withPpsf.map(l=>l.ppsf)) : null,
    lowPpsf:         withPpsf.length ? Math.min(...withPpsf.map(l=>l.ppsf)) : null,
    topByPpsf,
    newBuildListings,
    comparableCount: compPool.length
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
  // Year-built adjustment — tiered scaling, stronger for large vintage gaps
  // A 1976 home vs 2000-built comps needs a meaningful discount (~$23K), not $1,600
  if (subject.yearBuilt && comp.yearBuilt) {
    const gapYrs = subject.yearBuilt - comp.yearBuilt;
    const absGap = Math.abs(gapYrs);
    let yrAdj = 0;
    if (absGap <= 10)       yrAdj = absGap * 500;                                     // $500yr
    else if (absGap <= 20) yrAdj = 5000  + (absGap - 10) * 1000;                    // $1,000/yr
    else if (absGap <= 30) yrAdj = 15000 + (absGap - 20) * 2000;                    // $2,000/yr
    else                   yrAdj = 35000 + (absGap - 30) * 3000;                    // $3,000/yr
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

  // Sqft filter
  const sqftFiltered  = rawComps.filter(c => c.sqft && (!sqft || (c.sqft >= sqft-BUF && c.sqft <= sqft+BUF)));
  const incompleteRaw = rawComps.filter(c => !c.sqft);

  // Area-calibrated distress pre-filter using median $/sqft.
  // All comps at this stage have sqft (required by sqftFiltered), so we can compute
  // raw $/sqft for every comp. Remove anything below 30% of the local median $/sqft.
  // This is NO hard floor — it scales with the local market automatically:
  //   Birmingham $90/sqft median → fence $27/sqft → catches $2.50 deed transfer ✅
  //   Rural $55/sqft market     → fence $16.50/sqft → keeps $40K legit cheap sale ✅
  //   $200K suburb $130/sqft    → fence $39/sqft → catches $3K and $12K distress ✅
  const rawPpsfVals = sqftFiltered
    .filter(c => c.saleAmt && c.sqft)
    .map(c => c.saleAmt / c.sqft)
    .sort((a, b) => a - b);
  let sanityChecked = sqftFiltered;
  if (rawPpsfVals.length >= 2) {
    const mid        = Math.floor(rawPpsfVals.length / 2);
    const medianPpsf = rawPpsfVals.length % 2 !== 0
      ? rawPpsfVals[mid]
      : (rawPpsfVals[mid - 1] + rawPpsfVals[mid]) / 2;
    const ppsfFence  = medianPpsf * 0.30;  // 30% of median = area-calibrated distress floor
    sanityChecked = sqftFiltered.filter(c => {
      if (!c.saleAmt || !c.sqft) return true; // no price — keep, handled as incomplete later
      return (c.saleAmt / c.sqft) >= ppsfFence;
    });
    const distressRemoved = sqftFiltered.length - sanityChecked.length;
    if (distressRemoved > 0) {
      console.log(`[processComps] $/sqft pre-filter removed ${distressRemoved} distress comp(s) below $${Math.round(ppsfFence)}/sqft (30% of local median $${Math.round(medianPpsf)}/sqft)`);
    }
  }

  // Era-gap split: for aged subjects (≤ 1990), comps 25+ yr NEWER are modern-market,
  // not true comparables. Separate them so they don't inflate the avg ppsf.
  let usableRaw  = sanityChecked;
  let modernPool = [];
  if (subject.yearBuilt && subject.yearBuilt <= 1990) {
    const modern  = sanityChecked.filter(c => c.yearBuilt && (c.yearBuilt - subject.yearBuilt) > 25);
    const sameEra = sanityChecked.filter(c => !c.yearBuilt || (c.yearBuilt - subject.yearBuilt) <= 25);
    if (sameEra.length >= 2) {
      usableRaw  = sameEra;
      modernPool = modern;
      console.log(`[processComps] era-gap: ${modern.length} modern comp(s) removed from avg (25yr+ newer), using ${sameEra.length} same-era comp(s)`);
    } else {
      console.log(`[processComps] era-gap: only ${sameEra.length} same-era comp(s) found — using all ${sanityChecked.length} comps (vintage adj applied)`);
    }
  }

  if (!usableRaw.length) {
    const maxR = rawComps.length ? Math.max(...rawComps.map(c=>c.distanceMi||0)) : 0;
    return { usable: [], incomplete: incompleteRaw, modernPool, asIsValue: null, avgPpsf: null,
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

  // Process modern-era comps separately (for display as ceiling reference)
  const modernPoolProcessed = modernPool.map(c => {
    const tAdj   = timeAdj(c.saleAmt, c.monthsOld);
    const pAdj   = propAdj(c, subject, stateCode);
    const adjAmt = tAdj + pAdj;
    return { ...c, propAdj: pAdj, adjAmt: Math.round(adjAmt),
             adjPpsf: c.sqft ? Math.round(adjAmt / c.sqft) : null, flipComp: isFlip(c) };
  });

  return { usable: tagged, incomplete: incompleteRaw, modernPool: modernPoolProcessed, asIsValue, avgPpsf, ppsfRange,
           certainty: cert, maxRadius, avgDom, flips: flipCount, outliers: outCount,
           notes, avgCompVintage, vintageGap };
}

// ══════════════════════════════════════════════════════
// PROPSTREAM COMP CONVERTER
// Converts PropStream internal API comp format → internal comp format
// Used when bookmarklet sends comps directly, bypassing ATTOM
// ══════════════════════════════════════════════════════

function propstreamCompsToInternal(psComps) {
  const now = Date.now();
  return (psComps || []).map(c => {
    const saleDateMs = typeof c.saleDate === 'number' ? c.saleDate
                     : (c.saleDate ? new Date(c.saleDate).getTime() : null);
    const monthsOld  = saleDateMs
      ? Math.round((now - saleDateMs) / (1000 * 60 * 60 * 24 * 30.44) * 10) / 10
      : null;
    const saleDate   = saleDateMs ? new Date(saleDateMs).toISOString().split('T')[0] : null;
    const addrObj    = c.address || {};
    const streetAddr = addrObj.streetAddress || (typeof c.address === 'string' ? c.address : '');
    const city       = addrObj.cityName || addrObj.city || '';
    const state      = addrObj.stateCode || addrObj.state || '';
    const fullAddr   = [streetAddr, city, state].filter(Boolean).join(', ');
    const landUse    = c.landUse || '';
    const propType   = landUse.toLowerCase().includes('single') ? 'SFR'
                     : landUse.toLowerCase().includes('condo')  ? 'CONDO'
                     : landUse.toLowerCase().includes('multi')  ? 'MULTI_FAMILY'
                     : 'SFR';
    return {
      address:          fullAddr,
      sqft:             c.squareFeet  || c.sqft   || null,
      beds:             c.bedrooms    || c.beds    || null,
      baths:            c.bathrooms   || c.baths   || null,
      yearBuilt:        c.yearBuilt   || null,
      saleAmt:          c.saleAmount  || c.saleAmt || null,
      saleDate,
      monthsOld,
      distanceMi:       c.distanceFromSubject || c.distance || null,
      propType,
      lat:              c.latitude    || null,
      lon:              c.longitude   || null,
      priorSaleAmt:     null,
      priorSaleDate:    null,
      dom:              null,
      zillowEnriched:   false,
      propstreamSource: true
    };
  }).filter(c => c.saleAmt && c.sqft && c.saleAmt > 10000);
}

// ══════════════════════════════════════════════════════
// PULL COMPS — 1 ATTOM call at max radius, filter client-side
// ══════════════════════════════════════════════════════

async function pullComps(lat, lon, propType, sqft, subjectYearBuilt) {
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

  // NEW CONSTRUCTION COMPS: filter from full pool for same-era builds (within 10 years of subject)
  // Uses ±800sqft buffer (more forgiving — new construction beats vintage regardless of sqft diff)
  let newConstrComps = [];
  if (subjectYearBuilt && subjectYearBuilt >= new Date().getFullYear() - 10) {
    const cutoffYr = subjectYearBuilt - 8;
    newConstrComps = pool
      .filter(c => c.yearBuilt && c.yearBuilt >= cutoffYr && c.sqft
               && (!sqft || Math.abs(c.sqft - sqft) <= 800))
      .sort((a, b) => (a.distanceMi||99) - (b.distanceMi||99))
      .slice(0, 10);
    console.log(`[newConstr] ${newConstrComps.length} same-era comps (built ${cutoffYr}+) in 10mi pool`);
  }

  return { comps: pool, flagged, newConstrComps };
}

// ══════════════════════════════════════════════════════
// PHOTO CONDITION ASSESSMENT — Haiku vision, batched
// Classifies active listing photos as Updated / Partial / Dated
// Returns { [address]: { condition, note } }
// ══════════════════════════════════════════════════════

async function assessConditionFromPhotos(listings) {
  const withPhotos = listings.filter(l => l.imgUrl).slice(0, 5);
  if (!withPhotos.length) return {};
  console.log(`[photoCondition] assessing ${withPhotos.length} listing photos`);

  try {
    // Build interleaved text + image content
    const content = [
      {
        type: 'text',
        text: [
          `You are reviewing ${withPhotos.length} property listing photo(s) to assess renovation condition.`,
          `Classify each as exactly one of:`,
          `• "Updated" — modern finishes clearly visible: new kitchen cabinets/counters, renovated bath, LVP/hardwood flooring, fresh neutral paint, updated fixtures`,
          `• "Partial" — mix of old and new: maybe one room updated, rest original; or cosmetic updates only (paint) with dated mechanicals visible`,
          `• "Dated" — clearly original/unrenovated: old carpet, oak cabinets, laminate counters, popcorn ceiling, dated fixtures, no visible updates`,
          ``,
          `Reply ONLY with a JSON array, one object per photo:`,
          `[{"index":0,"condition":"Updated","note":"granite counters, white shaker cabinets, LVP floors visible"},...]`,
          `Be specific in the note — say what you actually see, not just the label.`
        ].join('\n')
      }
    ];

    withPhotos.forEach((l, i) => {
      content.push({ type: 'text', text: `Photo ${i} — ${l.address || 'Property ' + i}:` });
      content.push({ type: 'image', source: { type: 'url', url: l.imgUrl } });
    });

    const res = await axios({
      method: 'post', url: 'https://api.anthropic.com/v1/messages', timeout: 30000,
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      data: { model: 'claude-haiku-4-5-20251001', max_tokens: 600, messages: [{ role: 'user', content }] }
    });

    const raw  = res.data.content?.find(b => b.type === 'text')?.text || '[]';
    const arr  = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] || '[]');
    const map  = {};
    arr.forEach(r => {
      if (r.index != null && withPhotos[r.index]) {
        map[withPhotos[r.index].address] = { condition: r.condition, note: r.note };
      }
    });
    console.log(`[photoCondition] results: ${JSON.stringify(map)}`);
    return map;
  } catch (err) {
    console.warn('[photoCondition] ERROR:', err.message);
    return {};
  }
}

// ══════════════════════════════════════════════════════
// DAMAGE / CONDITION EXTRACTION — parses call notes for
// damage signals and repair cost estimates
// ══════════════════════════════════════════════════════

function extractConditionNotes(callNotes) {
  if (!callNotes) return { hasDamage: false, damageTypes: [], estRepairCost: null };

  const damageTypes = [];

  if (/water\s*damage|flooded?|flood\s*damage|wet\s*basement|moisture|seep/i.test(callNotes))
    damageTypes.push('water damage');
  if (/fire\s*damage|burnt?\s*(?:out|down)?|burned|smoke\s*damage/i.test(callNotes))
    damageTypes.push('fire damage');
  if (/foundation|structural|sinking|settling|crack\s*in\s*(?:the\s*)?(?:found|wall|slab)/i.test(callNotes))
    damageTypes.push('foundation issues');
  if (/(?:needs?\s*(?:new\s*)?|old\s*|bad\s*|leaking?\s*)roof|roof\s*(?:damage|replace|repair|issue|bad|old)/i.test(callNotes))
    damageTypes.push('roof issues');
  if (/mold|mildew/i.test(callNotes))
    damageTypes.push('mold');
  if (/busted?\s*pipes?|broken\s*pipes?|pipes?\s*burst|no\s*(?:running\s*)?water|plumbing\s*(?:issue|problem|damage)/i.test(callNotes))
    damageTypes.push('plumbing / pipes');
  if (/\bhvac\b|(?:no|broken?|bad)\s*(?:heat|a\/c|ac|air\s*cond)|furnace\s*(?:out|broken|bad|dead)/i.test(callNotes))
    damageTypes.push('HVAC');
  if (/electrical|wiring|(?:no|bad)\s*power|meter\s*pull|\bpanel\b/i.test(callNotes))
    damageTypes.push('electrical');
  if (/hoard|trash\s*(?:out|inside)|full\s*of\s*(?:trash|junk|stuff)|cleanout/i.test(callNotes))
    damageTypes.push('cleanout needed');

  // Extract repair cost: "$40k repair", "needs $40,000 work", "estimate 40k", etc.
  const repairPatterns = [
    /\$([\d,]+)\s*k\+?\s*(?:repair|rehab|work|fix|reno(?:vation)?|estimate|clean)/i,
    /\$([\d,]+)\s*(?:,000)?\s*(?:repair|rehab|work|fix|reno(?:vation)?|estimate|clean)/i,
    /needs?\s*(?:about|around|approx(?:imately)?)?\s*\$([\d,]+)\s*k/i,
    /(?:repair|rehab|work|estimate)s?\s*(?:is|are|of|about|around)?\s*\$([\d,]+)\s*k/i,
    /\b([\d,]+)\s*k\s*(?:repair|rehab|work|fix|reno(?:vation)?|estimate|in\s*work)/i
  ];
  let estRepairCost = null;
  for (const pat of repairPatterns) {
    const m = callNotes.match(pat);
    if (m) {
      const raw    = parseFloat(m[1].replace(/,/g, ''));
      const matchStr = m[0].toLowerCase();
      // Determine if the number is already in thousands or needs k-multiplier
      const hasK   = /\dk\b/.test(matchStr) || /k\+?/.test(matchStr.replace(/[^k]/g,'k').slice(0,5));
      estRepairCost = (hasK || raw < 500) ? raw * 1000 : raw;
      break;
    }
  }

  return { hasDamage: damageTypes.length > 0, damageTypes, estRepairCost };
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
    ? `Active market (2mi): ${pulse.count} listings · avg list $${pulse.avgListPpsf||'?'}/sqft · avg DOM ${pulse.avgDom??'?'} · ${pulse.flipListings} flip-priced listings · Top ceiling: $${pulse.topByPpsf?.[0]?.ppsf||'?'}/sqft`
    : 'Active listing data unavailable';

  const ncComps = compData.newConstrComps || [];
  const ncText  = ncComps.length
    ? `Same-era comp sales (built within 8yr of subject, up to 10mi): ${ncComps.length} found · avg $${Math.round(ncComps.filter(c=>c.adjPpsf).reduce((s,c)=>s+c.adjPpsf,0)/Math.max(1,ncComps.filter(c=>c.adjPpsf).length))}/sqft adj`
    : 'No same-era comp sales found in 10mi ATTOM pool';

  const userMsg =
`Property: ${subject.address} | ${subject.sqft||'?'}sqft | ${subject.beds||'?'}bd/${subject.baths||'?'}ba | Built ${subject.yearBuilt||'?'} | ${subject.propertyType||'SFR'} | specs from ${subject.specsSource}
Usable comps: ${compData.usable.length} (full data) + ${compData.incomplete.length} incomplete (no sqft)
Radius: ${compData.maxRadius}mi · Avg $${compData.avgPpsf||'?'}/sqft · Range $${compData.ppsfRange?.min||'?'}–$${compData.ppsfRange?.max||'?'}/sqft · Avg DOM ${compData.avgDom||'?'}
${pulseText}
${ncText}

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

  // Non-disclosure state warning
  if (compData.certainty?.label === 'Active proxy only') {
    L.push(`⚠️ *NON-DISCLOSURE STATE — ESTIMATE ONLY*`);
    L.push(compData.notes[0] || 'No sale price data available — using active listing proxy.');
    L.push(`_Numbers below are derived from active listing prices × 0.97. Confirm with your agent before presenting._`);
    L.push('');
  } else if (compData.notes?.[0]?.includes('non-disclosure') || compData.notes?.[0]?.includes('Zillow MLS')) {
    L.push(`⚠️ *NON-DISCLOSURE STATE*`);
    L.push(compData.notes[0]);
    L.push('');
  }

  // Multi-family / duplex warning — SFR comps don't reflect income value
  if (subject.propertyType === 'MULTI_FAMILY') {
    L.push(`🚨 *DUPLEX / MULTI-FAMILY — COMPS ARE SFR*`);
    L.push(`SFR sold comps were used because no multi-family comps were found nearby. Value is likely overstated.`);
    L.push(`_Multi-family pricing uses income approach (monthly rent × GRM). Verify with your agent before presenting any offer._`);
    L.push('');
  }

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

  // Damage / condition warning
  if (formulaData.damageTypes?.length) {
    L.push(`🚨 *DAMAGE DETECTED IN CALL NOTES*`);
    L.push(`Issues: ${formulaData.damageTypes.join(', ')}`);
    if (formulaData.estRepairCost && formulaData.damageAdjValue != null) {
      L.push(`Est. repair cost: *$${formulaData.estRepairCost.toLocaleString()}*`);
      L.push(`Damage-adjusted As-Is: *${f(formulaData.damageAdjValue)}* _(comps value minus repair estimate)_`);
      L.push(`_MAO should be based on damage-adj value, not the comps-only As-Is above._`);
    } else {
      L.push(`_No repair estimate in notes — get contractor bid before finalizing offer._`);
    }
    L.push('');
  }

  // Active market pulse (Zillow)
  if (pulse) {
    const flipNote = pulse.flipListings > 0 ? ` · ⚡ ${pulse.flipListings} flip-priced` : '';
    L.push(`🏠 *ACTIVE MARKET* (${pulse.count} listings · 2mi)`);
    L.push(`Avg list $${pulse.avgListPpsf||'?'}/sqft · DOM ${pulse.avgDom??'?'}${flipNote}`);

    // Standard comparable listings (same era, sqft-comparable, non-stale)
    if (pulse.topByPpsf?.length) {
      L.push(`📈 *Comparable active listings:*`);
      pulse.topByPpsf.forEach((l, i) => {
        const addr      = l.address ? l.address.split(',')[0] : '—';
        const staleTag  = l.stale
          ? ` ⚠️ ${l.dom}+ DOM${l.realisticPrice ? ` — needs ~${f(l.realisticPrice)} to move` : ' — price likely dropping'}`
          : '';
        const yrTag     = l.yearBuilt ? ` built ${l.yearBuilt}` : '';
        const condIcon  = l.condition === 'Updated' ? '✅' : l.condition === 'Partial' ? '🔶' : l.condition === 'Dated' ? '🔴' : '';
        const condTag   = l.condition ? ` · ${condIcon} ${l.condition}` : '';
        const arvSuffix = l.condition === 'Updated' ? ' — renovated/ARV-priced; as-is subject likely worth less' : '';
        const condNote  = (l.conditionNote || arvSuffix)
          ? `\n      _↳ ${l.conditionNote || ''}${arvSuffix}_`
          : '';
        L.push(`  ${i+1}. ${addr} | ${l.sqft?l.sqft.toLocaleString()+'sf':'?sf'}${yrTag} · ${f(l.listPrice)} · $${l.ppsf}/sqft · DOM ${l.dom??'?'}${staleTag}${condTag}${condNote}`);
      });

      // Warn if all assessed comps appear updated — subject may be worth less
      const assessed = pulse.topByPpsf.filter(l => l.condition);
      const updatedCount = assessed.filter(l => l.condition === 'Updated').length;
      if (assessed.length >= 3 && updatedCount === assessed.length) {
        L.push(`  _⚠️ All comparable listings appear renovated — if subject is dated/original, actual As-Is value may be lower than estimated_`);
      }
    }

    // New builds in the area — shown separately as a ceiling, NOT used in price estimate
    if (pulse.newBuildListings?.length) {
      L.push(`🏗️ *New builds in area* _(ceiling only — not used in As-Is estimate for older homes)_`);
      pulse.newBuildListings.forEach((l, i) => {
        const addr  = l.address ? l.address.split(',')[0] : '—';
        const yrTag = l.yearBuilt ? ` built ${l.yearBuilt}` : '';
        L.push(`  ${i+1}. ${addr} | ${l.sqft?l.sqft.toLocaleString()+'sf':'?sf'}${yrTag} · ${f(l.listPrice)} · $${l.ppsf}/sqft · DOM ${l.dom??'?'}`);
      });
      L.push(`  _These are listed at new-construction prices — comparable as ceiling, not baseline_`);
    }
    L.push('');
  }

  // Sold comps section — different display for active-proxy vs real comps
  if (compData.certainty?.label === 'Active proxy only') {
    // Non-disclosure with no sold data — show this clearly as a proxy, not sold comps
    L.push(`📊 *ACTIVE PRICE PROXY* _(no sold data available — TX non-disclosure state)_`);
    L.push(`Est. As-Is PPSF: ~$${compData.avgPpsf}/sqft _(sqft-comparable active listings × 0.97 sold-to-list)_`);
    L.push(`_How we got As-Is Value: avg list price of comparable active listings → apply 97% sold-to-list ratio → multiply by subject sqft_`);
    L.push(`_Your novation formula then runs on top: As-Is × 0.93 − $50K = MAO_`);
    L.push('');
  } else {
    const compSourceLabel = compData.usable.some(c => c.zillowSource)
      ? 'Zillow MLS · 15mo'
      : 'ATTOM County · 15mo';
    L.push(`📊 *SOLD COMPS* (${compData.usable.length} usable · ${compData.maxRadius}mi · ${compSourceLabel})`);
    if (compData.avgPpsf) {
      L.push(`Avg $${compData.avgPpsf}/sqft · Range $${compData.ppsfRange?.min}–$${compData.ppsfRange?.max}/sqft${compData.avgDom?' · DOM avg '+compData.avgDom:''}`);
    } else {
      L.push(`Insufficient data to calculate avg $/sqft`);
    }
    if (compData.flips)    L.push(`⚡ ${compData.flips} flip-confirmed sale${compData.flips>1?'s':''}`);
    if (compData.outliers) L.push(`⚠️ ${compData.outliers} outlier${compData.outliers>1?'s':''} — excluded from avg`);
    L.push('');
  }

  // Comp list with reasoning
  if (compData.usable.length) {
    L.push(`📋 *COMPS — FULL DATA* (${compData.usable.length})`);
    compData.usable.slice(0,8).forEach((c,i) => {
      const sourceTag   = c.zillowSource ? ' _[Zillow MLS]_' : c.zillowEnriched ? ' _[County+Zillow]_' : ' _[County]_';
      const flipTag     = c.flipComp ? ' ⚡FLIP' : '';
      const outTag      = c.isOutlier ? ` ⚠️(${c.outlierNote?.split(',')[0]})` : '';
      const vintageYrs  = (subject.yearBuilt && c.yearBuilt) ? subject.yearBuilt - c.yearBuilt : 0;
      const vintageTag  = vintageYrs >= 25 ? ` 📅-${vintageYrs}yr` : '';

      // Reasoning notes — why this comp was used / what to watch
      const reasons = [];
      if (subject.sqft && c.sqft) {
        const diff = c.sqft - subject.sqft;
        if (Math.abs(diff) <= 150)       reasons.push(`similar sqft`);
        else if (diff > 0)               reasons.push(`+${diff}sf vs subject — adj applied`);
        else                             reasons.push(`${diff}sf vs subject — adj applied`);
        // Flag: small homes carry higher $/sqft — their adj ppsf inflates the avg for larger subjects
        if (c.sqft < subject.sqft * 0.80) reasons.push(`⚠️ significantly smaller — $/sqft premium baked in`);
      }
      if (subject.yearBuilt && c.yearBuilt) {
        const gap = subject.yearBuilt - c.yearBuilt;
        if (Math.abs(gap) <= 5)           reasons.push(`same era`);
        else if (gap > 15)                reasons.push(`comp is ${gap}yr older`);
        else if (gap < -10)               reasons.push(`comp is ${Math.abs(gap)}yr newer`);
      }
      const reasonTag = reasons.length ? `\n      _↳ ${reasons.join(' · ')}_` : '';

      L.push(
        `${i+1}. ${c.address||'—'} | ${c.sqft}sf ${c.beds||'?'}bd/${c.baths||'?'}ba ${c.yearBuilt||'?'} ` +
        `${c.distanceMi!=null?c.distanceMi+'mi':''} · ${f(c.saleAmt)} ${c.saleDate} · DOM:${c.dom||'?'} · $${c.adjPpsf}/sf adj${sourceTag}${flipTag}${outTag}${vintageTag}${reasonTag}`
      );
    });
    L.push('_Source: County = ATTOM county records  ·  County+Zillow = county records + Zillow enrichment  ·  Zillow MLS = non-disclosure state fallback_');
    if (compData.vintageGap >= 25) L.push('_📅 = years older than subject — adjustment applied but value is approximate_');
    L.push('');
  }

  // Modern-era sold comps — 25+ yr newer than subject, excluded from As-Is avg, shown as ceiling
  const mPool = compData.modernPool || [];
  if (mPool.length > 0 && subject.yearBuilt) {
    const mPpsf = mPool.filter(c => c.adjPpsf).map(c => c.adjPpsf);
    const mAvg  = mPpsf.length ? Math.round(mPpsf.reduce((a, b) => a + b, 0) / mPpsf.length) : null;
    L.push(`🏗️ *MODERN SOLD COMPS* _(25+ yr newer than subject — excluded from As-Is avg, ceiling reference only)_`);
    if (mAvg) L.push(`Avg $${mAvg}/sqft adj — _these newer homes trade at a premium over the ${subject.yearBuilt} subject_`);
    mPool.slice(0, 4).forEach((c, i) => {
      const srcTag = c.zillowEnriched ? ' _[County+Zillow]_' : ' _[County]_';
      L.push(
        `${i+1}. ${c.address||'—'} | ${c.sqft}sf ${c.beds||'?'}bd/${c.baths||'?'}ba built ${c.yearBuilt||'?'} ` +
        `${c.distanceMi != null ? c.distanceMi+'mi' : ''} · ${f(c.saleAmt)} ${c.saleDate} · $${c.adjPpsf}/sf adj${srcTag}`
      );
    });
    L.push('');
  }

  // New construction reference comps (same era, wider radius)
  const nc = compData.newConstrComps || [];
  if (nc.length) {
    const ncPpsf = nc.filter(c=>c.adjPpsf).map(c=>c.adjPpsf);
    const ncAvg  = ncPpsf.length ? Math.round(ncPpsf.reduce((a,b)=>a+b,0)/ncPpsf.length) : null;
    L.push(`🏗️ *NEW CONSTRUCTION REFERENCE COMPS* (${nc.length} same-era sales · up to 10mi)`);
    if (ncAvg) L.push(`Avg $${ncAvg}/sqft adj — _use this alongside vintage comps for new-build pricing_`);
    nc.slice(0,5).forEach((c,i) => {
      const sourceTag = c.zillowEnriched ? ' _[County+Zillow]_' : ' _[County]_';
      L.push(
        `${i+1}. ${c.address||'—'} | ${c.sqft}sf ${c.beds||'?'}bd/${c.baths||'?'}ba built ${c.yearBuilt} ` +
        `${c.distanceMi!=null?c.distanceMi+'mi':''} · ${f(c.saleAmt)} ${c.saleDate} · $${c.adjPpsf}/sf adj${sourceTag}`
      );
    });
    L.push('');
  } else if (subject.yearBuilt && subject.yearBuilt >= new Date().getFullYear() - 10) {
    L.push(`🏗️ *NEW CONSTRUCTION REFERENCE COMPS* — None found within 10mi in ATTOM`);
    L.push(`_Active listing ceiling above is your best new-construction price signal_`);
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

  // Flags (skip the non-disclosure note — already shown as a banner above)
  const isNdBanner = compData.certainty?.label === 'Active proxy only'
    || compData.notes?.[0]?.includes('non-disclosure')
    || compData.notes?.[0]?.includes('Zillow MLS');
  const flagNotes = (compData.notes||[]).filter((n, i) => !(i === 0 && isNdBanner));
  const flags = [
    ...flagNotes,
    ...(compData.maxRadius > 5 ? [`Comps spread to ${compData.maxRadius}mi`] : [])
  ];
  if (flags.length) L.push(`\n🚩 ${flags.join(' · ')}`);

  return L.join('\n');
}

// ══════════════════════════════════════════════════════
// MAIN ROUTE
// ══════════════════════════════════════════════════════

app.post('/analyze', async (req, res) => {
  const { address, callNotes, propstreamSubject, propstreamComps: psComps } = req.body || {};
  if (!address) return res.status(400).json({ error: 'address required' });
  const hasPropstream = psComps && psComps.length > 0;
  console.log('[analyze]', address, hasPropstream ? `(PropStream: ${psComps.length} comps)` : '(ATTOM)');

  try {
    // 1. Parse subject specs from call notes
    const parsed = parseSubjectSpecs((callNotes || '') + ' ' + address);

    // 1b. Fill missing specs from PropStream subject data (bookmarklet sends this)
    if (propstreamSubject) {
      if (!parsed.sqft      && propstreamSubject.sqft)      parsed.sqft      = propstreamSubject.sqft;
      if (!parsed.beds      && propstreamSubject.beds)      parsed.beds      = propstreamSubject.beds;
      if (!parsed.baths     && propstreamSubject.baths)     parsed.baths     = propstreamSubject.baths;
      if (!parsed.yearBuilt && propstreamSubject.yearBuilt) parsed.yearBuilt = propstreamSubject.yearBuilt;
      console.log(`[propstream-subject] sqft=${parsed.sqft} beds=${parsed.beds} baths=${parsed.baths} yr=${parsed.yearBuilt}`);
    }

    // 2. Ask for specs if sqft is missing — sqft is required, everything else sharpens the number
    if (!parsed.sqft) {
      return res.json({
        needs_sqft: true,
        message: [
          `Got *${address}*. Before I run the numbers — do you have the property specs from the call?`,
          ``,
          `The more you give me, the tighter the estimate:`,
          `• *Square footage* — required to calculate As-Is Value (e.g. \`1849sf\` or \`1849 sqft\`)`,
          `• *Beds / baths* — used to adjust comps (e.g. \`3bd 2ba\`)`,
          `• *Year built* — flags vintage gaps vs comps (e.g. \`built 1996\`)`,
          ``,
          `Reply with the address + whatever you have, e.g.:`,
          `_129 E Beshoar Dr, Pueblo CO — 3bd 2ba 1849sf built 1996_`
        ].join('\n')
      });
    }

    // 2b. Extract damage / condition signals from call notes (no API call — pure text parsing)
    const conditionInfo = extractConditionNotes(callNotes);
    if (conditionInfo.hasDamage) {
      console.log(`[damage] detected: ${conditionInfo.damageTypes.join(', ')} | estRepairCost: ${conditionInfo.estRepairCost}`);
    }

    // 2c. Note any missing specs so the user knows adjustments are partial
    const missingSpecs = [
      !parsed.beds      ? 'beds'       : null,
      !parsed.baths     ? 'baths'      : null,
      !parsed.yearBuilt ? 'year built' : null,
    ].filter(Boolean);

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

    const isNonDisclosure = NON_DISCLOSURE_STATES.has(stateCode);
    if (isNonDisclosure) console.log(`[nonDisclosure] ${stateCode} is a non-disclosure state`);

    // 4. Comps + Zillow — use PropStream if bookmarklet sent them, else fall back to ATTOM
    let compResult, zillowSoldData, activeListings;
    if (hasPropstream) {
      const internalComps = propstreamCompsToInternal(psComps);
      compResult = { comps: internalComps, newConstrComps: [], flagged: internalComps.length < 3 };
      [zillowSoldData, activeListings] = await Promise.all([
        zillowSold(cityState),
        zillowActiveListings(geo.lat, geo.lon, 2)
      ]);
      console.log(`[data] PropStream:${internalComps.length} ZillowSold:${zillowSoldData.length} Active:${activeListings.length}`);
    } else {
      [compResult, zillowSoldData, activeListings] = await Promise.all([
        pullComps(geo.lat, geo.lon, subject.propertyType, subject.sqft, subject.yearBuilt),
        zillowSold(cityState),
        zillowActiveListings(geo.lat, geo.lon, 2)
      ]);
      console.log(`[data] ATTOM:${compResult.comps.length} ZillowSold:${zillowSoldData.length} Active:${activeListings.length}`);
    }

    // 5. Cross-reference: fill in missing beds/baths/sqft from Zillow
    let enriched = enrichCompsWithZillow(compResult.comps, zillowSoldData);
    const enrichCount = enriched.filter(c=>c.zillowEnriched).length;
    if (enrichCount) console.log(`[enrich] ${enrichCount} comps enriched from Zillow`);

    // 5b. Enrich new construction comps too
    const newConstrEnriched = enrichCompsWithZillow(compResult.newConstrComps || [], zillowSoldData);

    // ── NON-DISCLOSURE STATE FALLBACK ────────────────────────────────────────
    // In TX and other non-disclosure states, ATTOM returns deed-transfer records
    // with $0 or nominal prices ($7,000 etc.) — not real arm's-length sales.
    // Trigger the fallback when the state is non-disclosure AND there are no
    // ATTOM comps with a plausible sale price (> $50k). This catches both the
    // "0 records" case and the "records exist but all are transfers" case.
    //   1. Zillow sold items that do carry a price (MLS-reported or estimate)
    //   2. Active listing PPSF proxy (list × 0.97 sold-to-list ratio) when
    //      absolutely no sold price data is available from any source.
    let nonDisclosureMode = null; // 'zillow-sold' | 'active-proxy' | 'no-data'

    const meaningfulAttomComps = compResult.comps.filter(c => c.saleAmt && c.saleAmt > 50000);
    console.log(`[nonDisclosure check] state=${stateCode} isND=${isNonDisclosure} attomTotal=${compResult.comps.length} meaningful=${meaningfulAttomComps.length}`);

    if (isNonDisclosure && meaningfulAttomComps.length === 0) {
      const zillowComps = zillowSoldAsComps(zillowSoldData, geo.lat, geo.lon);
      console.log(`[nonDisclosure] Zillow sold with prices: ${zillowComps.length}`);

      if (zillowComps.length >= 1) {
        // Use Zillow sold comps as primary source
        enriched = zillowComps;
        nonDisclosureMode = 'zillow-sold';
        console.log(`[nonDisclosure] Using ${zillowComps.length} Zillow-sourced sold comps`);
      } else {
        // No sold prices anywhere — compute active listing proxy
        // Step 1: sqft-comparable (±35%), non-stale (DOM < 150), exclude new builds
        const _sqftMin  = subject.sqft ? subject.sqft * 0.65 : 0;
        const _sqftMax  = subject.sqft ? subject.sqft * 1.35 : Infinity;
        const _curYear  = new Date().getFullYear();
        const _nbCutoff = subject.yearBuilt ? Math.max(subject.yearBuilt + 15, _curYear - 8) : _curYear - 8;
        const _sqftComp = activeListings.filter(l =>
          l.ppsf &&
          (!l.sqft || (l.sqft >= _sqftMin && l.sqft <= _sqftMax)) && // sqft-comparable
          (l.dom == null || l.dom < 150) &&                           // not stale
          (!l.yearBuilt || l.yearBuilt < _nbCutoff)                  // not new build
        );
        const _rawPpsf  = (_sqftComp.length >= 3 ? _sqftComp : activeListings.filter(l => l.ppsf)).map(l => l.ppsf);
        // Step 2: outlier-filter (±2 SD)
        const _mean     = _rawPpsf.length ? _rawPpsf.reduce((a,b)=>a+b,0)/_rawPpsf.length : 0;
        const _sd       = _rawPpsf.length >= 2
          ? Math.sqrt(_rawPpsf.reduce((s,v)=>s+(v-_mean)**2,0)/_rawPpsf.length) : 0;
        const _filtered = _rawPpsf.filter(v => Math.abs(v-_mean) <= 2*_sd);
        const _vals     = _filtered.length ? _filtered : _rawPpsf;
        const avgActivePpsf = _vals.length
          ? Math.round(_vals.reduce((a,b)=>a+b,0)/_vals.length)
          : null;

        if (avgActivePpsf) {
          nonDisclosureMode = 'active-proxy';
          console.log(`[nonDisclosure] Active proxy: $${avgActivePpsf}/sqft | sqft-comparable: ${_sqftComp.length} | after outlier filter: ${_vals.length}`);
        } else {
          nonDisclosureMode = 'no-data';
          console.log(`[nonDisclosure] No sold or active price data found`);
        }
      }
    }

    // 6. Process comps (or synthesize from active-listing proxy)
    let compData;
    if (nonDisclosureMode === 'active-proxy') {
      // Derive As-Is PPSF from active listings using a 97% sold-to-list ratio (TX typical)
      // Step 1: sqft-comparable (±35%), non-stale (DOM < 150), exclude new builds
      const sqftMin        = subject.sqft ? subject.sqft * 0.65 : 0;
      const sqftMax        = subject.sqft ? subject.sqft * 1.35 : Infinity;
      const curYear        = new Date().getFullYear();
      const nbYearCutoff   = subject.yearBuilt ? Math.max(subject.yearBuilt + 15, curYear - 8) : curYear - 8;
      const sqftCompList   = activeListings.filter(l =>
        l.ppsf &&
        (!l.sqft || (l.sqft >= sqftMin && l.sqft <= sqftMax)) &&
        (l.dom == null || l.dom < 150) &&
        (!l.yearBuilt || l.yearBuilt < nbYearCutoff)
      );
      const baseList       = sqftCompList.length >= 3 ? sqftCompList : activeListings.filter(l => l.ppsf && (l.dom == null || l.dom < 150));
      // Step 2: outlier-filter (±2 SD)
      const rawActivePpsf  = baseList.map(l => l.ppsf);
      const ppsfMeanRaw    = rawActivePpsf.reduce((a,b)=>a+b,0) / rawActivePpsf.length;
      const ppsfSd         = Math.sqrt(rawActivePpsf.reduce((s,v)=>s+(v-ppsfMeanRaw)**2,0)/rawActivePpsf.length);
      const activePpsfVals = rawActivePpsf.filter(v => Math.abs(v - ppsfMeanRaw) <= 2 * ppsfSd);
      const usedCount      = activePpsfVals.length || rawActivePpsf.length;
      const avgActivePpsf  = Math.round((activePpsfVals.length ? activePpsfVals : rawActivePpsf).reduce((a,b)=>a+b,0) / usedCount);
      const outlierCount   = rawActivePpsf.length - activePpsfVals.length;
      console.log(`[nonDisclosure] active proxy: sqft-comp=${sqftCompList.length} base=${baseList.length} outliers=${outlierCount} used=${usedCount} avg=$${avgActivePpsf}/sqft`);
      const estPpsf        = Math.round(avgActivePpsf * 0.97);
      const estAsIs        = subject.sqft ? Math.round(estPpsf * subject.sqft / 1000) * 1000 : null;
      const lowPpsf        = activePpsfVals.length ? Math.round(Math.min(...activePpsfVals) * 0.97) : estPpsf;
      const highPpsf       = activePpsfVals.length ? Math.round(Math.max(...activePpsfVals) * 0.97) : estPpsf;

      compData = {
        usable: [], incomplete: [],
        asIsValue:   estAsIs,
        avgPpsf:     estPpsf,
        ppsfRange:   { min: lowPpsf, max: highPpsf },
        certainty:   { score: 20, label: 'Active proxy only' },
        maxRadius:   2,
        avgDom:      null,
        flips: 0, outliers: 0,
        notes: [
          `⚠️ ${stateCode} non-disclosure — ATTOM has no sale data, no Zillow sold prices found. ` +
          `As-Is estimate derived from ${usedCount} active listings (list × 0.97 sold-to-list ratio)` +
          `${outlierCount ? `; ${outlierCount} outlier(s) removed` : ''}. ` +
          `VERIFY WITH AGENT before presenting offer.`
        ],
        newConstrComps:  [],
        vintageGap:      0,
        avgCompVintage:  null
      };
    } else {
      compData = processComps(enriched, subject, subject.sqft, stateCode);
      if (compResult.flagged && nonDisclosureMode !== 'zillow-sold') {
        compData.notes.push('Fewer than 3 usable comps found — treat with caution');
      }
      compData.newConstrComps = newConstrEnriched;

      if (hasPropstream) {
        compData.notes.unshift(
          `✅ PropStream MLS comps: ${psComps.length} pulled, ${compData.usable.length} passed quality filters`
        );
      }

      if (nonDisclosureMode === 'zillow-sold') {
        compData.notes.unshift(
          `⚠️ ${stateCode} non-disclosure state — ATTOM has no sale data. ` +
          `Using ${enriched.length} Zillow MLS-reported sold comps instead.`
        );
      } else if (nonDisclosureMode === 'no-data') {
        compData.notes.push(
          `⚠️ ${stateCode} non-disclosure state — no sale prices found in ATTOM or Zillow`
        );
      }
    }

    // 7. Market pulse (pass subject sqft + yearBuilt so topByPpsf filters correctly)
    const pulse = buildMarketPulse(activeListings, compData.avgPpsf, subject.sqft, subject.yearBuilt);

    // 8. Novation formula (pure code)
    const asIsValue        = compData.asIsValue;
    const novationMao      = asIsValue ? Math.round(asIsValue * 0.93 - 50000) : null;
    const novationListPrice = asIsValue;
    const formulaData      = { asIsValue, novationMao, novationListPrice };
    console.log(`[formula] AsIs:${asIsValue} MAO:${novationMao} nonDisclosureMode:${nonDisclosureMode||'none'}`);

    // 8b. Pricing sanity check — compare list price against stale active comps
    // If our As-Is Value is within 10% of a listing that's been sitting 60+ days,
    // that's a market signal the price is too high for the area to absorb.
    const staleComparables = activeListings.filter(l =>
      l.listPrice && l.dom != null && l.dom >= 60 &&
      formulaData.asIsValue &&
      Math.abs(l.listPrice - formulaData.asIsValue) / formulaData.asIsValue <= 0.10
    );
    if (staleComparables.length) {
      const sc = staleComparables[0];
      compData.notes.push(
        `⚠️ Pricing alert: list price ($${formulaData.asIsValue?.toLocaleString()}) is within 10% of ` +
        `${sc.address?.split(',')[0] || 'a nearby listing'} ($${sc.listPrice?.toLocaleString()}, ${sc.dom} DOM) — ` +
        `that property is already stale at this price. Consider pricing below it.`
      );
    }

    // 8b. Warn when key subject specs are missing — adjustments will be less precise
    if (missingSpecs.length > 0) {
      compData.notes.push(
        `ℹ️ Subject missing: ${missingSpecs.join(', ')} — comp adjustments less accurate. ` +
        `Next time include them, e.g. _3bd 2ba built 1996_ in your message.`
      );
    }

    // 8c. Damage warning from call notes — adjust As-Is downward and flag prominently
    if (conditionInfo.hasDamage) {
      const dmgList = conditionInfo.damageTypes.join(', ');
      if (conditionInfo.estRepairCost) {
        const dmgAdjValue = asIsValue ? Math.round((asIsValue - conditionInfo.estRepairCost) / 1000) * 1000 : null;
        compData.notes.push(
          `🚨 DAMAGE in call notes: ${dmgList}. ` +
          `Est. repair: $${conditionInfo.estRepairCost.toLocaleString()} → ` +
          `Damage-adj As-Is: ${dmgAdjValue != null ? '$' + dmgAdjValue.toLocaleString() : 'N/A'} ` +
          `(comps value minus repair estimate). MAO should reflect full repair cost.`
        );
        formulaData.damageTypes     = conditionInfo.damageTypes;
        formulaData.estRepairCost   = conditionInfo.estRepairCost;
        formulaData.damageAdjValue  = dmgAdjValue;
      } else {
        compData.notes.push(
          `⚠️ DAMAGE noted in call notes: ${dmgList}. ` +
          `No repair estimate given — get contractor bid before finalizing offer.`
        );
        formulaData.damageTypes = conditionInfo.damageTypes;
      }
    }

    // 9. Narrative + photo condition assessment — run in parallel (both are Anthropic calls)
    const [narrative, conditionMap] = await Promise.all([
      narrativeAgent(subject, compData, formulaData, pulse, callNotes),
      assessConditionFromPhotos(activeListings)
    ]);

    // 9b. Attach condition tags to active listings, then rebuild pulse so topByPpsf carries them
    activeListings.forEach(l => {
      const c = conditionMap[l.address];
      if (c) { l.condition = c.condition; l.conditionNote = c.note; }
    });
    const pulseWithConditions = buildMarketPulse(activeListings, compData.avgPpsf, subject.sqft, subject.yearBuilt);

    // 10. Format and return
    const slackMessage = formatSlack(subject, compData, formulaData, narrative, pulseWithConditions);

    // 11. Store deal in memory so JARVIS can answer follow-up questions
    lastDeal = {
      address:        subject.address,
      analyzedAt:     new Date().toISOString(),
      subject: {
        sqft:         subject.sqft,
        beds:         subject.beds,
        baths:        subject.baths,
        yearBuilt:    subject.yearBuilt,
        propertyType: subject.propertyType
      },
      asIsValue:      formulaData.asIsValue,
      novationMao:    formulaData.novationMao,
      listPrice:      formulaData.novationListPrice,
      avgPpsf:        compData.avgPpsf,
      ppsfRange:      compData.ppsfRange,
      certainty:      compData.certainty,
      compCount:      compData.usable.length,
      maxRadius:      compData.maxRadius,
      avgDom:         compData.avgDom,
      vintageGap:     compData.vintageGap,
      avgCompVintage: compData.avgCompVintage,
      flips:          compData.flips,
      outliers:       compData.outliers,
      notes:          compData.notes,
      comps: compData.usable.slice(0, 10).map(c => ({
        address:    c.address,
        sqft:       c.sqft,
        beds:       c.beds,
        baths:      c.baths,
        yearBuilt:  c.yearBuilt,
        saleAmt:    c.saleAmt,
        saleDate:   c.saleDate,
        adjPpsf:    c.adjPpsf,
        distanceMi: c.distanceMi,
        flipComp:   c.flipComp,
        isOutlier:  c.isOutlier,
        source:     c.propstreamSource ? 'PropStream' : (c.zillowEnriched ? 'County+Zillow' : 'County')
      })),
      pulse: pulse ? {
        count:       pulse.count,
        avgListPpsf: pulse.avgListPpsf,
        avgDom:      pulse.avgDom,
        flipListings: pulse.flipListings,
        topByPpsf:   pulse.topByPpsf
      } : null,
      narrative
    };

    return res.json({ response: slackMessage });

  } catch (err) {
    console.error('[analyze error]', err.message, err.stack);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
});

// Last deal — JARVIS calls this for follow-up questions about a deal
app.get('/last-deal', (req, res) => {
  if (!lastDeal) return res.json({ error: 'No deal analyzed yet this session' });
  res.json(lastDeal);
});

// ── Temporary schema probe — hit /debug-zillow?lat=29.79&lon=-94.79 to see raw Zillow fields ──
app.get('/debug-zillow', async (req, res) => {
  const lat = parseFloat(req.query.lat || '29.79');
  const lon = parseFloat(req.query.lon || '-94.79');
  const dLat = 0.02898, dLon = 0.033;
  try {
    const r = await axios.post(
      `https://${ZILLOW_HOST}/zillow/v1/search_by_coordinates`,
      { map_bounds: { west: lon-dLon, east: lon+dLon, south: lat-dLat, north: lat+dLat } },
      { headers: { 'Content-Type':'application/json', 'x-rapidapi-host': ZILLOW_HOST, 'x-rapidapi-key': RAPIDAPI_KEY }, timeout: 20000 }
    );
    const items = r.data?.data?.items || [];
    const first = items[0] || null;
    res.json({ count: items.length, fields: first ? Object.keys(first) : [], firstItem: first });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Same probe for sold endpoint ──
app.get('/debug-zillow-sold', async (req, res) => {
  const location = req.query.location || 'Liberty, TX';
  try {
    const r = await axios.post(
      `https://${ZILLOW_HOST}/zillow/v1/sold`,
      { location },
      { headers: { 'Content-Type':'application/json', 'x-rapidapi-host': ZILLOW_HOST, 'x-rapidapi-key': RAPIDAPI_KEY }, timeout: 20000 }
    );
    const items = r.data?.data?.items || [];
    const first = items[0] || null;
    res.json({ count: items.length, fields: first ? Object.keys(first) : [], firstItem: first });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) =>
  res.json({
    status: 'ok', version: '3.6',
    attom: !!ATTOM_KEY, zillow: !!RAPIDAPI_KEY, anthropic: !!ANTHROPIC_KEY,
    lastDeal: lastDeal ? { address: lastDeal.address, analyzedAt: lastDeal.analyzedAt } : null
  })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Deal Analyzer v3.6 (IQR distress filter, era-gap comp split, damage extraction, stronger vintage adj, stale DOM 90d, ARV flag) on :${PORT}`));
