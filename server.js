const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─────────────────────────────────────────────
// LAYER 1: Minnehaha County GIS REST API
// ─────────────────────────────────────────────

async function queryGis(whereClause) {
  const fields = 'MRRDID,MRTNM1,MRTNM2,MRTADR,MRTCTY,MRTSTATE,MRTZPC,FULL_ADDRESS,MRZON1,TOTAL_ACREAGE,LEGAL_DESC,MAP_ID,TAG';
  const url = `https://gis.minnehahacounty.org/minnemap/rest/services/Parcels/MapServer/0/query` +
              `?where=${encodeURIComponent(whereClause)}&outFields=${fields}&returnGeometry=false&f=json`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LandProspector/1.0)' },
    timeout: 10000
  });
  if (!response.ok) throw new Error(`GIS API returned status ${response.status}`);
  const data = await response.json();
  if (data.features && data.features.length > 0) return data.features[0].attributes;
  return null;
}

async function fetchGisData(mapId) {
  const id = mapId.trim().toUpperCase();
  const numOnly = id.replace(/[^0-9]/g, '');

  // Try several format variants — the viewer shows "01-07-15-400-004-000"
  // but the TAG field may be stored without dashes or in a shorter format
  const tagVariants = new Set([
    id,
    id.replace(/-/g, ''),
    numOnly,
  ]);

  console.log(`Trying TAG variants for "${id}":`, [...tagVariants]);
  for (const v of tagVariants) {
    const result = await queryGis(`TAG='${v}'`);
    if (result) { console.log(`  Found with TAG='${v}'`); return result; }
  }

  // Try MAP_ID field (may store the long dashed format)
  for (const v of [id, id.replace(/-/g, '.')]) {
    const result = await queryGis(`MAP_ID='${v}'`);
    if (result) { console.log(`  Found with MAP_ID='${v}'`); return result; }
  }

  // Try MRRDID — the County Parcel number (e.g. "18135") shown in the popup
  if (numOnly.length > 0) {
    const result = await queryGis(`MRRDID='${numOnly}'`);
    if (result) { console.log(`  Found with MRRDID='${numOnly}'`); return result; }
  }

  return null;
}

// ─────────────────────────────────────────────
// LAYER 2: Beacon scraper
// ─────────────────────────────────────────────

async function fetchBeaconData(parcelId) {
  if (!parcelId) return null;
  const searchUrl = `https://beacon.schneidercorp.com/Application.aspx` +
                    `?AppID=1180&LayerID=35026&PageTypeID=4&KeyValue=${encodeURIComponent(parcelId)}`;
  const searchResp = await fetch(searchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    timeout: 15000,
    redirect: 'follow'
  });
  if (!searchResp.ok) return null;
  const html = await searchResp.text();
  const $ = cheerio.load(html);

  let assessedVal = null, marketVal = null, deedYear = null;
  let taxDelinquent = false, taxYearsOwed = 0;

  $('td, span, div').each((_, el) => {
    const text = $(el).text().trim();
    if (/assessed\s*value/i.test(text)) {
      const match = $(el).next().text().match(/\$?([\d,]+)/);
      if (match) assessedVal = parseInt(match[1].replace(/,/g, ''));
    }
    if (/appraised\s*value|market\s*value/i.test(text)) {
      const match = $(el).next().text().match(/\$?([\d,]+)/);
      if (match) marketVal = parseInt(match[1].replace(/,/g, ''));
    }
  });

  $('table').each((_, table) => {
    const headers = $(table).find('th').map((_, th) => $(th).text().toLowerCase()).get();
    if (headers.some(h => h.includes('sale') || h.includes('deed'))) {
      const dateCell = $(table).find('tr').eq(1).find('td').first().text().trim();
      const yearMatch = dateCell.match(/(\d{4})/);
      if (yearMatch) deedYear = parseInt(yearMatch[1]);
    }
  });

  if (/delinquent|past\s*due|tax\s*lien|unpaid\s*tax/i.test($('body').text())) {
    taxDelinquent = true;
    const m = $('body').text().match(/(\d+)\s*year/gi);
    if (m) taxYearsOwed = parseInt(m[0]);
  }

  return { assessedVal, marketVal, deedYear, taxDelinquent, taxYearsOwed, beaconUrl: searchUrl };
}

// ─────────────────────────────────────────────
// MAIN ROUTE: GET /parcel?id=...
// ─────────────────────────────────────────────
app.get('/parcel', async (req, res) => {
  const mapId = (req.query.id || '').trim().toUpperCase();
  if (!mapId) return res.status(400).json({ error: 'Missing required parameter: id' });

  console.log(`[${new Date().toISOString()}] Looking up: ${mapId}`);

  try {
    const gisData = await fetchGisData(mapId);
    if (!gisData) {
      return res.status(404).json({
        error: 'Parcel not found',
        mapId,
        hint: 'Visit /debug?id=' + encodeURIComponent(mapId) + ' to see sample TAG formats from this county'
      });
    }

    let beaconData = null;
    try { beaconData = await fetchBeaconData(gisData.MRRDID); }
    catch (e) { console.warn(`Beacon failed: ${e.message}`); }

    res.json({
      mapId,
      source:          beaconData ? 'gis+beacon' : 'gis-only',
      parcelId:        gisData.MRRDID || null,
      tagField:        gisData.TAG || null,
      mapIdField:      gisData.MAP_ID || null,
      ownerName:       gisData.MRTNM1 || null,
      ownerName2:      gisData.MRTNM2 || null,
      mailingStreet:   gisData.MRTADR || null,
      mailingCity:     gisData.MRTCTY || null,
      mailingState:    gisData.MRTSTATE || null,
      mailingZip:      gisData.MRTZPC || null,
      propertyAddress: gisData.FULL_ADDRESS || null,
      zoning:          gisData.MRZON1 || null,
      acres:           gisData.TOTAL_ACREAGE || null,
      legalDesc:       gisData.LEGAL_DESC || null,
      assessedVal:     beaconData?.assessedVal ?? null,
      marketVal:       beaconData?.marketVal ?? null,
      deedYear:        beaconData?.deedYear ?? null,
      taxDelinquent:   beaconData?.taxDelinquent ?? false,
      taxYearsOwed:    beaconData?.taxYearsOwed ?? 0,
      beaconUrl:       beaconData?.beaconUrl ?? null,
      outOfState:      gisData.MRTSTATE ? gisData.MRTSTATE.toUpperCase() !== 'SD' : null,
      yearsHeld:       beaconData?.deedYear ? new Date().getFullYear() - beaconData.deedYear : null,
      marketVsAssessedGapPct: (beaconData?.marketVal && beaconData?.assessedVal)
        ? Math.round((beaconData.marketVal - beaconData.assessedVal) / beaconData.marketVal * 100)
        : null,
    });

  } catch (err) {
    console.error(`Error for ${mapId}:`, err.message);
    res.status(500).json({ error: 'Lookup failed', detail: err.message });
  }
});

// ─────────────────────────────────────────────
// DEBUG ROUTE: GET /debug?id=...
// Shows raw API responses and 3 real sample
// records so we can see what TAG format is used
// ─────────────────────────────────────────────
app.get('/debug', async (req, res) => {
  const id = (req.query.id || '').trim().toUpperCase();
  if (!id) return res.status(400).json({ error: 'Missing id parameter' });

  const results = {};
  const variants = [id, id.replace(/-/g, ''), id.replace(/[^0-9]/g, '')];

  for (const v of variants) {
    try {
      const url = `https://gis.minnehahacounty.org/minnemap/rest/services/Parcels/MapServer/0/query` +
        `?where=${encodeURIComponent(`TAG='${v}'`)}&outFields=TAG,MAP_ID,MRRDID,MRTNM1,FULL_ADDRESS&returnGeometry=false&f=json`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
      const data = await r.json();
      results[`TAG='${v}'`] = { featureCount: data.features?.length || 0, firstFeature: data.features?.[0]?.attributes || null };
    } catch(e) { results[`TAG='${v}'`] = { error: e.message }; }
  }

  try {
    const url = `https://gis.minnehahacounty.org/minnemap/rest/services/Parcels/MapServer/0/query` +
      `?where=${encodeURIComponent(`MAP_ID='${id}'`)}&outFields=TAG,MAP_ID,MRRDID,MRTNM1&returnGeometry=false&f=json`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
    const data = await r.json();
    results[`MAP_ID='${id}'`] = { featureCount: data.features?.length || 0, firstFeature: data.features?.[0]?.attributes || null };
  } catch(e) { results[`MAP_ID='${id}'`] = { error: e.message }; }

  // Pull 3 real records — this shows us what TAG values actually look like
  try {
    const url = `https://gis.minnehahacounty.org/minnemap/rest/services/Parcels/MapServer/0/query` +
      `?where=1%3D1&outFields=TAG,MAP_ID,MRRDID,MRTNM1&resultRecordCount=3&f=json`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
    const data = await r.json();
    results['_sampleRecords_showRealTagFormat'] = data.features?.map(f => f.attributes) || [];
  } catch(e) { results['_sampleRecords_showRealTagFormat'] = { error: e.message }; }

  res.json(results);
});

// ─────────────────────────────────────────────
// HEALTH CHECK: GET /
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Minnehaha County Land Prospector Proxy',
    endpoints: {
      lookup: '/parcel?id=<MAP_ID>',
      debug:  '/debug?id=<MAP_ID>',
      example: '/parcel?id=01-07-15-400-004-000'
    }
  });
});

app.listen(PORT, () => {
  console.log(`Minnehaha proxy running on port ${PORT}`);
});
