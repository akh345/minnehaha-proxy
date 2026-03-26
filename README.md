# Minnehaha Land Prospector — Proxy Server

This is the "helper computer" that sits between your land prospecting tool
and the Minnehaha County data sources. It fetches parcel data from two places:

- **Layer 1** — Minnehaha County GIS REST API (owner, address, zoning, acreage)
- **Layer 2** — Beacon/qPublic (assessed value, deed year, tax status)

---

## How to deploy on Render (step by step)

### Step 1 — Put this code on GitHub

1. Go to https://github.com and sign in (or create a free account)
2. Click the **+** button in the top right → **New repository**
3. Name it: `minnehaha-proxy`
4. Leave everything else as default → click **Create repository**
5. On the next screen, click **uploading an existing file**
6. Drag and drop these three files:
   - `server.js`
   - `package.json`
   - `README.md`
7. Click **Commit changes**

### Step 2 — Deploy on Render

1. Go to https://render.com and create a free account
2. Click **New +** → **Web Service**
3. Click **Connect a repository** → select `minnehaha-proxy`
4. Fill in the form:
   - **Name**: `minnehaha-proxy` (or anything you like)
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. Click **Create Web Service**
6. Wait about 2 minutes while Render builds and starts it
7. At the top of the page you'll see a URL like:
   `https://minnehaha-proxy.onrender.com`

### Step 3 — Test it

Open your browser and visit:
```
https://minnehaha-proxy.onrender.com/parcel?id=38500
```

You should see a JSON response with parcel data. If you see `{"status":"ok"}`,
the service is running but needs a valid Map ID.

### Step 4 — Plug the URL into your prospecting tool

Copy your Render URL and paste it into the prospecting tool
when prompted. That's it — all lookups will now use live county data.

---

## API reference

### GET /parcel?id={MAP_ID}

Looks up a parcel by its Minnehaha County Map ID (TAG field).

**Example:**
```
GET /parcel?id=38500
```

**Response:**
```json
{
  "mapId": "38500",
  "source": "gis+beacon",
  "parcelId": "123456",
  "ownerName": "JAMES R WHITFIELD",
  "mailingStreet": "123 MAIN ST",
  "mailingCity": "SIOUX FALLS",
  "mailingState": "SD",
  "mailingZip": "57104",
  "propertyAddress": "456 COUNTY RD 5, MINNEHAHA COUNTY SD",
  "zoning": "A-1 AGRICULTURAL",
  "acres": 40.0,
  "legalDesc": "NE 1/4 SEC 12 TWP 101 RNG 49",
  "assessedVal": 120000,
  "marketVal": 210000,
  "deedYear": 1998,
  "taxDelinquent": false,
  "taxYearsOwed": 0,
  "outOfState": false,
  "yearsHeld": 27,
  "marketVsAssessedGapPct": 43
}
```

### GET /

Health check. Returns `{"status":"ok"}` if the service is running.

---

## Notes

- The free Render tier **spins down after 15 minutes of inactivity**.
  The first request after a period of no use may take 20–30 seconds to respond
  while Render wakes the service back up. Subsequent requests are fast.
- Beacon scraping may return `null` for some fields if the county's
  website layout changes. The GIS layer will always return data.
- To add more counties, duplicate the `fetchGisData` and `fetchBeaconData`
  functions with the new county's API endpoints and Beacon AppID.
