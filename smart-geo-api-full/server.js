const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const bodyParser = require('body-parser');
const turf = require('@turf/turf');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

const SHEET_ID = '1YdkA4i_v_t54hetZ7uQlZAevZmuDLiqjjQBu6GgNWKs';
const RANGE_LATEST = 'latest!A2:E';
const RANGE_PREVIOUS = 'previous!A2:E';

const auth = new google.auth.GoogleAuth({
  keyFile: 'credentials.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });

async function getSheetClient() {
  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

function parseRow([id, name, geometry, type, year]) {
  return {
    type: 'Feature',
    geometry: JSON.parse(geometry),
    properties: { id, name, type, year: parseInt(year) }
  };
}

app.get('/features', async (req, res) => {
  const sheet = await getSheetClient();
  const response = await sheet.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: RANGE_LATEST,
  });
  const rows = response.data.values || [];
  const features = rows.map(parseRow);
  res.json({ type: 'FeatureCollection', features });
});

app.get('/detect-changes', async (req, res) => {
  const sheet = await getSheetClient();
  const latestRows = (await sheet.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: RANGE_LATEST })).data.values || [];
  const previousRows = (await sheet.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: RANGE_PREVIOUS })).data.values || [];

  const latest = Object.fromEntries(latestRows.map(r => [r[0], parseRow(r)]));
  const previous = Object.fromEntries(previousRows.map(r => [r[0], parseRow(r)]));

  const changes = [];

  for (const id in latest) {
    if (previous[id]) {
      const a = latest[id];
      const b = previous[id];
      const diff = turf.difference(turf.polygon(a.geometry.coordinates), turf.polygon(b.geometry.coordinates));
      if (diff) {
        const areaA = turf.area(a);
        const areaB = turf.area(b);
        const delta = ((areaA - areaB) / areaB) * 100;
        changes.push({
          id,
          name: a.properties.name,
          change: `Area changed by ${delta.toFixed(1)}%`,
          changed: true,
          geometry: a.geometry,
          properties: a.properties
        });
      }
    }
  }

  res.json({ type: 'FeatureCollection', features: changes });
});

app.post('/smart-query', async (req, res) => {
  const { query } = req.body;

  // Mock NLP logic (you can plug OpenAI here)
  const keywords = query.toLowerCase();
  const wantsChange = keywords.includes("change") || keywords.includes("updated");
  const wantsType = keywords.includes("park") ? "park" : null;
  const wantsYear = keywords.includes("2022") ? 2022 : null;

  const sheet = await getSheetClient();
  const latestRows = (await sheet.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: RANGE_LATEST })).data.values || [];
  const previousRows = (await sheet.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: RANGE_PREVIOUS })).data.values || [];

  const latest = Object.fromEntries(latestRows.map(r => [r[0], parseRow(r)]));
  const previous = Object.fromEntries(previousRows.map(r => [r[0], parseRow(r)]));

  const results = [];

  for (const id in latest) {
    const feature = latest[id];
    let match = true;
    if (wantsType && feature.properties.type !== wantsType) match = false;
    if (wantsYear && feature.properties.year < wantsYear) match = false;

    if (match && wantsChange && previous[id]) {
      const prev = previous[id];
      const diff = turf.difference(turf.polygon(feature.geometry.coordinates), turf.polygon(prev.geometry.coordinates));
      if (diff) {
        const areaA = turf.area(feature);
        const areaB = turf.area(prev);
        const delta = ((areaA - areaB) / areaB) * 100;
        results.push({
          ...feature,
          properties: {
            ...feature.properties,
            change: `Area changed by ${delta.toFixed(1)}%`
          }
        });
      }
    } else if (match && !wantsChange) {
      results.push(feature);
    }
  }

  res.json({ type: 'FeatureCollection', features: results });
});

app.listen(PORT, () => console.log(`Smart GeoAPI running on port ${PORT}`));