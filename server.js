const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

// Allow requests from any frontend (CORS)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─────────────────────────────────────────────
// LAYER 1: Minnehaha County GIS REST API
// Returns: owner name, mailing address, zoning,
//          acreage, legal description, parcel ID
// ─────────────────────────────────────────────
async function fetchGisData(mapId) {
  const fields = [
    'MRRDID', 'MRTNM1', 'MRTNM2', 'MRTADR',
    'MRTCTY', 'MRTSTATE', 'MRTZPC', 'FULL_ADDRESS',
    'MRZON1', 'TOTAL_ACREAGE', 'LEGAL_DESC', 'MAP_ID'
  ].join(',');

  const where = encodeURIComponent(`TAG='${mapId.toUpperCase()}'`);
  const url = `https://gis.minnehahacounty.org/minnemap/rest/services/Parcels/MapServer/0/query` +
              `?where=${where}&outFields=${fields}&returnGeometry=false&f=json`;

  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LandProspector/1.0)' },
    timeout: 10000
  });

  if (!response.ok) {
    throw new Error(`GIS API returned status ${response.status}`);
  }

  const data = await response.json();

  if (!data.features || data.features.length === 0) {
    return null; // Map ID not found
  }

  return data.features[0].attributes;
}

// ─────────────────────────────────────────────
// LAYER 2: Beacon (Schneider Corp) scraper
// Returns: assessed value, market value,
//          deed year, tax delinquency status
// Beacon URL for Minnehaha County SD: AppID=1180
// ─────────────────────────────────────────────
async function fetchBeaconData(parcelId) {
  if (!parcelId) return null;

  // Step 1: Search for the parcel by its Parcel ID (MRRDID)
  const searchUrl = `https://beacon.schneidercorp.com/Application.aspx` +
                    `?AppID=1180&LayerID=35026&PageTypeID=4&KeyValue=${encodeURIComponent(parcelId)}`;

  const searchResp = await fetch(searchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeout: 15000,
    redirect: 'follow'
  });

  if (!searchResp.ok) return null;

  const html = await searchResp.text();
  const $ = cheerio.load(html);

  // Extract assessed value
  let assessedVal = null;
  $('td, span, div').each((_, el) => {
    const text = $(el).text().trim();
    if (/assessed\s*value/i.test(text)) {
      // Look at the next sibling for the dollar amount
      const next = $(el).next().text().trim();
      const match = next.match(/\$?([\d,]+)/);
      if (match) assessedVal = parseInt(match[1].replace(/,/g, ''));
    }
  });

  // Extract market/appraised value
  let marketVal = null;
  $('td, span, div').each((_, el) => {
    const text = $(el).text().trim();
    if (/appraised\s*value|market\s*value/i.test(text)) {
      const next = $(el).next().text().trim();
      const match = next.match(/\$?([\d,]+)/);
      if (match) marketVal = parseInt(match[1].replace(/,/g, ''));
    }
  });

  // Extract deed/sale year from sales history table
  let deedYear = null;
  $('table').each((_, table) => {
    const headers = $(table).find('th').map((_, th) => $(th).text().toLowerCase()).get();
    if (headers.some(h => h.includes('sale') || h.includes('deed'))) {
      // Get the most recent (first) row
      const firstRow = $(table).find('tr').eq(1);
      const dateCell = firstRow.find('td').first().text().trim();
      const yearMatch = dateCell.match(/(\d{4})/);
      if (yearMatch) deedYear = parseInt(yearMatch[1]);
    }
  });

  // Extract tax delinquency - look for delinquent/past due language
  let taxDelinquent = false;
  let taxYearsOwed = 0;
  const fullText = $('body').text();
  if (/delinquent|past\s*due|tax\s*lien|unpaid\s*tax/i.test(fullText)) {
    taxDelinquent = true;
    // Try to count years mentioned
    const yearMatches = fullText.match(/(\d+)\s*year/gi);
    if (yearMatches) taxYearsOwed = parseInt(yearMatches[0]);
  }

  return {
    assessedVal,
    marketVal,
    deedYear,
    taxDelinquent,
    taxYearsOwed,
    beaconUrl: searchUrl
  };
}

// ─────────────────────────────────────────────
// MAIN ROUTE: GET /parcel?id=38500
// Fetches both layers and returns combined JSON
// ─────────────────────────────────────────────
app.get('/parcel', async (req, res) => {
  const mapId = (req.query.id || '').trim().toUpperCase();

  if (!mapId) {
    return res.status(400).json({ error: 'Missing required parameter: id (Map ID)' });
  }

  console.log(`[${new Date().toISOString()}] Looking up Map ID: ${mapId}`);

  try {
    // Fetch both layers in parallel where possible
    const gisData = await fetchGisData(mapId);

    if (!gisData) {
      return res.status(404).json({
        error: 'Parcel not found',
        mapId,
        hint: 'Double-check the Map ID against the Minnehaha County GIS viewer at gis.minnehahacounty.org'
      });
    }

    // Fetch Beacon data using the Parcel ID from GIS
    let beaconData = null;
    try {
      beaconData = await fetchBeaconData(gisData.MRRDID);
    } catch (beaconErr) {
      console.warn(`Beacon fetch failed for ${mapId}: ${beaconErr.message}`);
      // Non-fatal — return GIS data even if Beacon fails
    }

    // Combine both sources into one clean response
    const result = {
      mapId,
      source: beaconData ? 'gis+beacon' : 'gis-only',

      // Layer 1: GIS data (always live when this proxy is used)
      parcelId:     gisData.MRRDID || null,
      ownerName:    gisData.MRTNM1 || null,
      ownerName2:   gisData.MRTNM2 || null,
      mailingStreet: gisData.MRTADR || null,
      mailingCity:  gisData.MRTCTY || null,
      mailingState: gisData.MRTSTATE || null,
      mailingZip:   gisData.MRTZPC || null,
      propertyAddress: gisData.FULL_ADDRESS || null,
      zoning:       gisData.MRZON1 || null,
      acres:        gisData.TOTAL_ACREAGE || null,
      legalDesc:    gisData.LEGAL_DESC || null,

      // Layer 2: Beacon data (null values if Beacon unavailable)
      assessedVal:    beaconData?.assessedVal  ?? null,
      marketVal:      beaconData?.marketVal    ?? null,
      deedYear:       beaconData?.deedYear     ?? null,
      taxDelinquent:  beaconData?.taxDelinquent ?? false,
      taxYearsOwed:   beaconData?.taxYearsOwed  ?? 0,
      beaconUrl:      beaconData?.beaconUrl    ?? null,

      // Derived fields
      outOfState: gisData.MRTSTATE
        ? gisData.MRTSTATE.toUpperCase() !== 'SD'
        : null,
      yearsHeld: beaconData?.deedYear
        ? new Date().getFullYear() - beaconData.deedYear
        : null,
      marketVsAssessedGapPct: (beaconData?.marketVal && beaconData?.assessedVal)
        ? Math.round((beaconData.marketVal - beaconData.assessedVal) / beaconData.marketVal * 100)
        : null,
    };

    res.json(result);

  } catch (err) {
    console.error(`Error looking up ${mapId}:`, err.message);
    res.status(500).json({ error: 'Lookup failed', detail: err.message });
  }
});

// ─────────────────────────────────────────────
// HEALTH CHECK: GET /
// Render uses this to confirm the service is up
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Minnehaha County Land Prospector Proxy',
    endpoints: {
      lookup: '/parcel?id=<MAP_ID>',
      example: '/parcel?id=38500'
    }
  });
});

app.listen(PORT, () => {
  console.log(`Minnehaha proxy running on port ${PORT}`);
});
